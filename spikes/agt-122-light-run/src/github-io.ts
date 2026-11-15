/**
 * AGT-122, a spike: a repository's files in and a change out, with no git in the runtime.
 *
 * **In** is what a scan already does (packages/github/src/contents.ts): the branch's head, its
 * whole tree in one request, and the text of the files, fifty blobs to a GraphQL request. That is
 * a shallow tree: every text file at one commit, no history. What is left out is listed, never
 * guessed at: symlinks, files over 256 KiB, and blobs GitHub calls binary or truncates.
 *
 * **Out** is the Git Data API. A manifest of the blob ids the files were loaded with says what
 * changed: a file whose bytes now hash to another id, a path that was not there, a path that is
 * gone. Those go into one tree made on top of the head's (`base_tree`), so a file this run never
 * read, binary or large, stays as it was. Then a commit, then a ref. Four requests however many
 * files changed, and none of them reads the repository again.
 */
import {
	API_URL,
	branchCommit,
	branchHead,
	createBranch,
	GitHubError,
	moveBranch,
	type RepositoryName,
	readTexts,
	readTree,
	TEXTS_PER_REQUEST,
} from "@gateweave/agents-github";
import { z } from "zod";

/** Where the repository's files go, as the sandbox's checkout does. */
export const REPO_ROOT = "/workspace/repo";

export const LOAD_LIMITS = {
	/** A file larger than this is left out, as the registry's blobs are. */
	fileBytes: 256 * 1024,
	/** Files loaded at most. Each fifty are one request to GitHub and fifty writes. */
	files: 5_000,
	/** GraphQL requests under way at once. */
	parallel: 6,
};

export type SkipReason = "symlink" | "large" | "binary" | "inexact" | "over-limit";

export interface Manifest {
	repository: RepositoryName;
	branch: string;
	/** The commit the files were read at, and its tree: the new commit's parent and base. */
	commit: string;
	tree: string;
	/** Each loaded file's Git blob id, by its path in the repository. */
	files: Record<string, string>;
	/** What the tree holds that was not loaded. A commit leaves these as they are. */
	skipped: { path: string; why: SkipReason }[];
	/** Requests made to GitHub, for the Worker's subrequest limit. */
	requests: number;
	/** The commit this run last put on its branch. Whoever commits keeps it up to date. */
	pushed?: string;
}

/** The part of `workspace.fs` this file uses, so a test can count what it is asked. */
export interface FileStore {
	readFile(path: string): Promise<ReadableStream<Uint8Array>>;
	writeFile(path: string, content: string): Promise<void>;
	mkdir(path: string, options: { recursive: boolean }): Promise<void>;
	find(
		directory: string,
		pattern?: string,
		options?: { limit?: number; offset?: number },
	): Promise<{ path: string; type: "file" | "dir" }[]>;
	lstat(path: string): Promise<{ isSymbolicLink: boolean; isFile: boolean }>;
}

/** Reads the branch's files into `fs` under `REPO_ROOT`. */
export async function loadRepository(
	fs: FileStore,
	token: string,
	repository: RepositoryName,
	branch: string,
): Promise<Manifest> {
	const head = await branchHead(token, repository, branch);
	const { files, truncated } = await readTree(token, repository, head.tree);
	if (truncated) {
		// Past 100,000 entries or 7 MB GitHub cuts the listing, and a commit made from part of a
		// tree would read as deleting the rest to anyone comparing. Such a repository needs a clone.
		throw new GitHubError(422, "The repository's tree is too large to list in one request.");
	}
	const manifest: Manifest = {
		repository,
		branch,
		commit: head.commit,
		tree: head.tree,
		files: {},
		skipped: [],
		requests: 2,
	};
	const wanted: typeof files = [];
	for (const file of files) {
		if (file.symlink) manifest.skipped.push({ path: file.path, why: "symlink" });
		else if (file.size > LOAD_LIMITS.fileBytes) {
			manifest.skipped.push({ path: file.path, why: "large" });
		} else if (wanted.length >= LOAD_LIMITS.files) {
			manifest.skipped.push({ path: file.path, why: "over-limit" });
		} else wanted.push(file);
	}

	// Fifty blobs to a request is the client's own batch; several batches go at once.
	const batches: (typeof files)[] = [];
	for (let start = 0; start < wanted.length; start += TEXTS_PER_REQUEST) {
		batches.push(wanted.slice(start, start + TEXTS_PER_REQUEST));
	}
	const folders = new Set<string>();
	let next = 0;
	const worker = async () => {
		for (let batch = batches[next++]; batch !== undefined; batch = batches[next++]) {
			const texts = await readTexts(
				token,
				repository,
				batch.map((file) => file.blob),
			);
			manifest.requests += 1;
			for (const file of batch) {
				const text = texts.get(file.blob);
				if (text === null || text === undefined) {
					manifest.skipped.push({ path: file.path, why: "binary" });
					continue;
				}
				// The text has to be the blob, byte for byte, or the file would look changed the
				// moment it is loaded and a commit would rewrite it. A byte order mark that the API
				// drops, or a byte it replaces, shows here and nowhere else.
				if ((await gitBlobId(new TextEncoder().encode(text))) !== file.blob) {
					manifest.skipped.push({ path: file.path, why: "inexact" });
					continue;
				}
				const path = `${REPO_ROOT}/${file.path}`;
				const folder = path.slice(0, path.lastIndexOf("/"));
				if (!folders.has(folder)) {
					await fs.mkdir(folder, { recursive: true });
					folders.add(folder);
				}
				await fs.writeFile(path, text);
				manifest.files[file.path] = file.blob;
			}
		}
	};
	await fs.mkdir(REPO_ROOT, { recursive: true });
	await Promise.all(Array.from({ length: LOAD_LIMITS.parallel }, worker));
	return manifest;
}

/** `git hash-object` of these bytes. */
export async function gitBlobId(bytes: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
	const whole = new Uint8Array(header.length + bytes.length);
	whole.set(header, 0);
	whole.set(bytes, header.length);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", whole));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface Changes {
	/** Files that are new or hold other bytes than the ones loaded, with their text. */
	written: { path: string; content: string }[];
	/** Loaded files that are gone. */
	deleted: string[];
	/** What cannot go into a commit this way, and why. A commit is refused while any is here. */
	problems: { path: string; why: string }[];
}

/** Compares what `fs` holds under `REPO_ROOT` with what was loaded. */
export async function findChanges(fs: FileStore, manifest: Manifest): Promise<Changes> {
	const changes: Changes = { written: [], deleted: [], problems: [] };
	const skipped = new Set(manifest.skipped.map((entry) => entry.path));
	const seen = new Set<string>();
	const page = 1_000;
	for (let offset = 0; ; offset += page) {
		const entries = await fs.find(REPO_ROOT, undefined, { limit: page, offset });
		for (const entry of entries) {
			if (entry.type !== "file") continue;
			const path = entry.path.slice(REPO_ROOT.length + 1);
			seen.add(path);
			if (skipped.has(path)) {
				// The tree holds something here that was never loaded, so this would overwrite a file
				// nobody read.
				changes.problems.push({ path, why: "the repository has a file here that was not loaded" });
				continue;
			}
			if ((await fs.lstat(entry.path)).isSymbolicLink) {
				changes.problems.push({ path, why: "a symlink cannot be committed this way" });
				continue;
			}
			const bytes = new Uint8Array(await new Response(await fs.readFile(entry.path)).arrayBuffer());
			if ((await gitBlobId(bytes)) === manifest.files[path]) continue;
			let content: string;
			try {
				// The mark stays in the text, so a file that begins with one is committed with it.
				content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			} catch {
				changes.problems.push({ path, why: "the file is not text" });
				continue;
			}
			changes.written.push({ path, content });
		}
		if (entries.length < page) break;
	}
	for (const path of Object.keys(manifest.files)) {
		if (!seen.has(path)) changes.deleted.push(path);
	}
	changes.written.sort((a, b) => a.path.localeCompare(b.path));
	changes.deleted.sort();
	return changes;
}

const objectId = z.string().regex(/^[0-9a-f]{40}$/);
const shaSchema = z.object({ sha: objectId });

async function post(path: string, token: string, body: unknown): Promise<unknown> {
	const response = await fetch(`${API_URL}${path}`, {
		method: "POST",
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"user-agent": "gateweave-agents",
			"x-github-api-version": "2022-11-28",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new GitHubError(
			response.status,
			`GitHub answered ${response.status}: ${text.slice(0, 200)}`,
		);
	}
	return response.json();
}

export interface CommitAuthor {
	name: string;
	email: string;
}

export type CommitResult =
	| { committed: true; commit: string; requests: number }
	| { committed: false; reason: string };

/**
 * Commits the changes on top of the commit they were made from and points `branch` at it. The
 * branch is made when it is new and moved only forward when it is not, so a commit someone else
 * pushed there is never dropped: GitHub refuses, and so does this.
 */
export async function commitChanges(
	token: string,
	manifest: Manifest,
	changes: Changes,
	input: { branch: string; message: string; author: CommitAuthor },
): Promise<CommitResult> {
	if (changes.problems.length > 0) {
		const first = changes.problems[0];
		return {
			committed: false,
			reason: `${first?.path}: ${first?.why}. This change needs a machine with git.`,
		};
	}
	if (changes.written.length === 0 && changes.deleted.length === 0) {
		return { committed: false, reason: "Nothing changed, so there is nothing to commit." };
	}
	const { owner, name } = manifest.repository;
	const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
	// The branch is this run's alone: it is either not there yet or at the commit this run last
	// made. Anything else is someone else's push, whose files the tree below would undo, so it is
	// refused, as the sandbox's push is. Between this read and the move, GitHub holds the same
	// line: the name is taken, or the move is not a fast-forward.
	const at = await branchCommit(token, manifest.repository, input.branch);
	if (at !== (manifest.pushed ?? null)) {
		return {
			committed: false,
			reason: `The branch ${input.branch} holds a commit this run did not make.`,
		};
	}
	const parent = at ?? manifest.commit;
	const tree = shaSchema.parse(
		await post(`${repo}/git/trees`, token, {
			// The head's tree, not the branch's: the files here are the head's with this run's
			// changes, and an earlier commit's changes are in them already.
			base_tree: manifest.tree,
			tree: [
				...changes.written.map((file) => ({
					path: file.path,
					mode: "100644",
					type: "blob",
					content: file.content,
				})),
				// A null id takes the path out of the tree.
				...changes.deleted.map((path) => ({ path, mode: "100644", type: "blob", sha: null })),
			],
		}),
	);
	const commit = shaSchema.parse(
		await post(`${repo}/git/commits`, token, {
			message: input.message,
			tree: tree.sha,
			parents: [parent],
			author: input.author,
			committer: input.author,
		}),
	);
	try {
		if (at === null) await createBranch(token, manifest.repository, input.branch, commit.sha);
		else await moveBranch(token, manifest.repository, input.branch, commit.sha, false);
	} catch (error) {
		if (error instanceof GitHubError && error.status === 422) {
			return { committed: false, reason: `The branch ${input.branch} moved: ${error.message}` };
		}
		throw error;
	}
	return { committed: true, commit: commit.sha, requests: 4 };
}
