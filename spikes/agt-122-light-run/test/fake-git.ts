/**
 * AGT-122, a spike. Stands in for api.github.com: one repository's branches, trees, blobs, commits
 * and pull requests, kept in memory. It refuses what GitHub refuses, since a fake that takes
 * anything proves nothing: a wrong token, a tree on a base it does not know, a path that climbs
 * out, an entry with both content and an id, deleting a path that is not there, a commit on an
 * unknown parent, a branch that exists, a move that is not a fast-forward.
 *
 * Blob ids are Git's own. Tree and commit ids are made up, from their content.
 */
import { gitBlobId } from "../src/github-io";

interface Entry {
	mode: string;
	blob: string;
}
type Tree = Map<string, Entry>;
interface Commit {
	tree: string;
	parents: string[];
	message: string;
	author?: { name: string; email: string };
}
interface Pull {
	number: number;
	title: string;
	body: string;
	head: string;
	base: string;
}

const MODES = new Set(["100644", "100755", "120000", "040000", "160000"]);

async function idOf(kind: string, value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(`${kind}\0${JSON.stringify(value)}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function refused(status: number, message: string): Response {
	return Response.json({ message }, { status });
}

export class FakeGit {
	readonly owner = "acme";
	readonly name = "site";
	readonly defaultBranch = "main";
	readonly token = "ghs_fake_installation_token";
	readonly blobs = new Map<string, Uint8Array>();
	readonly trees = new Map<string, Tree>();
	readonly commits = new Map<string, Commit>();
	readonly branches = new Map<string, string>();
	readonly pulls: Pull[] = [];
	/** Every request it answered, as `METHOD path`. */
	readonly requests: string[] = [];
	/** Blobs GraphQL calls binary, by id. */
	readonly binary = new Set<string>();
	/**
	 * Whether a blob's text comes without its byte order mark. Nobody checked which GitHub does,
	 * so a test can have it either way.
	 */
	dropsMark = false;

	/** Makes the default branch's first commit from these files. */
	async seed(
		files: Record<string, string | Uint8Array>,
		options: { symlinks?: Record<string, string>; executable?: string[] } = {},
	): Promise<string> {
		const tree: Tree = new Map();
		for (const [path, content] of Object.entries(files)) {
			const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
			const blob = await gitBlobId(bytes);
			this.blobs.set(blob, bytes);
			if (typeof content !== "string") this.binary.add(blob);
			tree.set(path, { mode: options.executable?.includes(path) ? "100755" : "100644", blob });
		}
		for (const [path, target] of Object.entries(options.symlinks ?? {})) {
			const bytes = new TextEncoder().encode(target);
			const blob = await gitBlobId(bytes);
			this.blobs.set(blob, bytes);
			tree.set(path, { mode: "120000", blob });
		}
		const commit = await this.#commit({
			tree: await this.#tree(tree),
			parents: [],
			message: "first",
		});
		this.branches.set(this.defaultBranch, commit);
		return commit;
	}

	/** A branch's files as text, by path: what a clone of it would hold. */
	filesAt(branch: string): Record<string, string> {
		const commit = this.commits.get(this.branches.get(branch) ?? "");
		const tree = this.trees.get(commit?.tree ?? "");
		if (!tree) throw new Error(`no branch ${branch}`);
		const files: Record<string, string> = {};
		for (const [path, entry] of tree) {
			files[path] = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
				this.blobs.get(entry.blob),
			);
		}
		return files;
	}

	modeAt(branch: string, path: string): string | undefined {
		const commit = this.commits.get(this.branches.get(branch) ?? "");
		return this.trees.get(commit?.tree ?? "")?.get(path)?.mode;
	}

	async #tree(tree: Tree): Promise<string> {
		const id = await idOf(
			"tree",
			[...tree].sort(([a], [b]) => (a < b ? -1 : 1)),
		);
		this.trees.set(id, tree);
		return id;
	}

	async #commit(commit: Commit): Promise<string> {
		const id = await idOf("commit", commit);
		this.commits.set(id, commit);
		return id;
	}

	#descends(commit: string, from: string): boolean {
		const queue = [commit];
		for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
			if (next === from) return true;
			queue.push(...(this.commits.get(next)?.parents ?? []));
		}
		return false;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.host !== "api.github.com") return refused(502, `not GitHub's API: ${url.host}`);
		this.requests.push(`${request.method} ${url.pathname}`);
		if (request.headers.get("authorization") !== `Bearer ${this.token}`) {
			return refused(401, "Bad credentials");
		}
		if (!request.headers.get("user-agent")) return refused(403, "Request forbidden: no user agent");
		const body =
			request.method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);

		if (request.method === "POST" && url.pathname === "/graphql") return this.#texts(body);

		const prefix = `/repos/${this.owner}/${this.name}/`;
		if (!url.pathname.startsWith(prefix)) return refused(404, "Not Found");
		const resource = url.pathname.slice(prefix.length);
		const method = request.method;

		const branch = resource.match(/^branches\/(.+)$/);
		if (method === "GET" && branch) {
			const at = this.branches.get(decodeURIComponent(branch[1] ?? ""));
			const commit = this.commits.get(at ?? "");
			if (!at || !commit) return refused(404, "Branch not found");
			return Response.json({ commit: { sha: at, commit: { tree: { sha: commit.tree } } } });
		}

		const listed = resource.match(/^git\/trees\/([0-9a-f]{40})$/);
		if (method === "GET" && listed) {
			const tree = this.trees.get(listed[1] ?? "");
			if (!tree) return refused(404, "Not Found");
			return Response.json({
				truncated: false,
				tree: [...tree].map(([path, entry]) => ({
					path,
					mode: entry.mode,
					type: "blob",
					sha: entry.blob,
					size: this.blobs.get(entry.blob)?.length ?? 0,
				})),
			});
		}

		if (method === "POST" && resource === "git/trees") return this.#makeTree(body);

		if (method === "POST" && resource === "git/commits") {
			const parents = body.parents as string[];
			if (!this.trees.has(String(body.tree))) return refused(422, "Tree SHA does not exist");
			if (!Array.isArray(parents) || !parents.every((parent) => this.commits.has(parent))) {
				return refused(422, "Parent SHA does not exist or is not a commit object");
			}
			const author = body.author as Commit["author"];
			if (author && (!author.name || !/^[^@\s]+@[^@\s]+$/.test(author.email))) {
				return refused(422, "Invalid author");
			}
			const sha = await this.#commit({
				tree: String(body.tree),
				parents,
				message: String(body.message),
				author,
			});
			return Response.json({ sha }, { status: 201 });
		}

		if (method === "POST" && resource === "git/refs") {
			const name = String(body.ref);
			if (!name.startsWith("refs/heads/")) return refused(422, "Reference name is not valid");
			const made = name.slice("refs/heads/".length);
			if (this.branches.has(made)) return refused(422, "Reference already exists");
			if (!this.commits.has(String(body.sha))) return refused(422, "Object does not exist");
			this.branches.set(made, String(body.sha));
			return Response.json({ ref: name, object: { sha: body.sha } }, { status: 201 });
		}

		const ref = resource.match(/^git\/refs?\/heads\/(.+)$/);
		if (ref) {
			const named = (ref[1] ?? "").split("/").map(decodeURIComponent).join("/");
			const at = this.branches.get(named);
			if (method === "GET" && resource.startsWith("git/ref/")) {
				if (at === undefined) return refused(404, "Not Found");
				return Response.json({ ref: `refs/heads/${named}`, object: { sha: at } });
			}
			if (method === "PATCH" && resource.startsWith("git/refs/")) {
				const to = String(body.sha);
				if (at === undefined) return refused(422, "Reference does not exist");
				if (!this.commits.has(to)) return refused(422, "Object does not exist");
				if (body.force !== true && !this.#descends(to, at)) {
					return refused(422, "Update is not a fast forward");
				}
				this.branches.set(named, to);
				return Response.json({ ref: `refs/heads/${named}`, object: { sha: to } });
			}
		}

		if (method === "POST" && resource === "pulls") {
			const head = this.branches.get(String(body.head));
			const base = this.branches.get(String(body.base));
			if (!head || !base) return refused(422, "Validation Failed: head or base is not a branch");
			if (head === base || !this.#descends(head, base)) {
				return refused(422, "No commits between base and head");
			}
			if (this.pulls.some((pull) => pull.head === body.head)) {
				return refused(422, "A pull request already exists for this branch");
			}
			const pull: Pull = {
				number: this.pulls.length + 1,
				title: String(body.title),
				body: String(body.body),
				head: String(body.head),
				base: String(body.base),
			};
			this.pulls.push(pull);
			return Response.json(
				{
					number: pull.number,
					html_url: `https://github.com/${this.owner}/${this.name}/pull/${pull.number}`,
					state: "open",
					merged: false,
					merged_at: null,
					head: { sha: head },
				},
				{ status: 201 },
			);
		}
		return refused(404, "Not Found");
	}

	async #makeTree(body: Record<string, unknown>): Promise<Response> {
		const base = this.trees.get(String(body.base_tree));
		if (!base) return refused(422, "base_tree is not a valid tree oid");
		const tree: Tree = new Map(base);
		const entries = body.tree as Record<string, unknown>[];
		if (!Array.isArray(entries) || entries.length === 0) return refused(422, "Invalid tree info");
		for (const entry of entries) {
			const path = String(entry.path ?? "");
			const parts = path.split("/");
			if (path === "" || parts.some((part) => part === "" || part === "." || part === "..")) {
				return refused(422, "tree.path contains a malformed path component");
			}
			if (parts[0] === ".git") return refused(422, "tree.path cannot be inside .git");
			if (!MODES.has(String(entry.mode)))
				return refused(422, `tree.mode is invalid: ${entry.mode}`);
			if (entry.type !== "blob") return refused(422, "this fake only takes blobs");
			const hasId = "sha" in entry;
			const hasContent = "content" in entry;
			if (hasId === hasContent) return refused(422, "tree.sha and tree.content are exclusive");
			if (hasContent) {
				if (typeof entry.content !== "string") return refused(422, "tree.content is not a string");
				const bytes = new TextEncoder().encode(entry.content);
				const blob = await gitBlobId(bytes);
				this.blobs.set(blob, bytes);
				tree.set(path, { mode: String(entry.mode), blob });
			} else if (entry.sha === null) {
				if (!tree.delete(path)) return refused(422, "GitRPC::BadObjectState: no such path");
			} else {
				if (!this.blobs.has(String(entry.sha))) return refused(422, "tree.sha is not a blob");
				tree.set(path, { mode: String(entry.mode), blob: String(entry.sha) });
			}
		}
		return Response.json(
			{ sha: await this.#tree(tree), truncated: false, tree: [] },
			{ status: 201 },
		);
	}

	/** The GraphQL query packages/github's `readTexts` sends: aliased blobs by id. */
	#texts(body: Record<string, unknown>): Response {
		const variables = body.variables as { owner?: string; name?: string };
		if (variables?.owner !== this.owner || variables?.name !== this.name) {
			return Response.json({ data: { repository: null }, errors: [{ message: "Not Found" }] });
		}
		const repository: Record<string, unknown> = {};
		const aliases = String(body.query).matchAll(/(\w+): object\(oid: "([0-9a-f]{40})"\)/g);
		for (const [, alias, id] of aliases) {
			const bytes = this.blobs.get(id ?? "");
			if (!alias) continue;
			if (!bytes) repository[alias] = null;
			else if (this.binary.has(id ?? "")) {
				repository[alias] = { text: null, isBinary: true, isTruncated: false };
			} else {
				repository[alias] = {
					text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: !this.dropsMark }).decode(
						bytes,
					),
					isBinary: false,
					isTruncated: false,
				};
			}
		}
		return Response.json({ data: { repository } });
	}
}
