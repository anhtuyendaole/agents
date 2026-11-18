/**
 * The git commands a sandbox proposes its work with, apart from the container that runs them
 * (`RunnerSandbox` in `./sandbox.ts`), so the tests can hold them to their rules with a git that
 * only records. The work is committed first and pushed after, as two steps: when the repository
 * has checks (`./checks.ts`), they run between the two, on the commit.
 */
import type { CommitAuthor, CommitResult } from "./pull-requests";
import type { CommandResult } from "./sandbox-tools";

/** Runs git in the checkout with these arguments, for at most `seconds`, with `env` added. */
export type Git = (
	args: string[],
	seconds?: number,
	env?: Record<string, string>,
) => Promise<CommandResult>;

/** A commit's id as `git rev-parse` prints it, in SHA-1 or SHA-256. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isCommitId(text: string): boolean {
	return COMMIT_ID.test(text);
}

/** The environment a commit is made with: the author, as both its author and its committer. */
export function commitEnvironment(author: CommitAuthor): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: author.name,
		GIT_AUTHOR_EMAIL: author.email,
		GIT_COMMITTER_NAME: author.name,
		GIT_COMMITTER_EMAIL: author.email,
	};
}

/**
 * Commits every change in the checkout with `message`, unless there are none to commit, and says
 * which commit the work is at. Refuses when the work has no commit the default branch does not.
 * It pushes nothing.
 */
export async function commitWork(
	git: Git,
	defaultBranch: string,
	message: string,
	author: CommitAuthor,
): Promise<CommitResult> {
	const added = await git(["add", "--all"]);
	if (added.exitCode !== 0) return { error: `The changes could not be added.\n${added.output}` };
	// Exits 1 when something is staged.
	const staged = await git(["diff", "--cached", "--quiet"]);
	if (staged.exitCode === 1) {
		// The repository's own hooks run, as they would for a person.
		const committed = await git(
			["commit", "--quiet", "--message", message],
			120,
			commitEnvironment(author),
		);
		if (committed.exitCode !== 0) {
			return { error: `The changes could not be committed.\n${committed.output}` };
		}
	} else if (staged.exitCode !== 0) {
		return { error: `The changes could not be read.\n${staged.output}` };
	}
	const base = `origin/${defaultBranch}`;
	const ahead = await git(["rev-list", "--count", `${base}..HEAD`]);
	if (ahead.exitCode !== 0) {
		return { error: `The work could not be compared with ${base}.\n${ahead.output}` };
	}
	if (Number.parseInt(ahead.output.trim(), 10) === 0) {
		return {
			error: `There is nothing to propose: the work has no commit that ${defaultBranch} does not.`,
		};
	}
	const head = (await git(["rev-parse", "HEAD"])).output.trim();
	if (!isCommitId(head)) return { error: "The work's commit could not be read." };
	return { head };
}

/**
 * The arguments of the push of the commit `head` to `branch`. It names the commit and not `HEAD`,
 * so a commit made in the checkout after `commitWork`, while the repository's checks ran, is not
 * in the push.
 */
export function pushArguments(branch: string, head: string): string[] {
	return ["push", "--porcelain", "origin", `${head}:refs/heads/${branch}`];
}
