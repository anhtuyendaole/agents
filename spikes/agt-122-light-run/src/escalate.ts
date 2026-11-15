/**
 * AGT-122, a spike: how a run that began without a container goes on in one.
 *
 * The container checks the repository out at the commit the files were loaded at, as it does
 * today, and then takes this run's changes: each written file through the port's `writeFile`,
 * each deleted one through one `rm`. After that the two hold the same files, the container has
 * git, and the light workspace is no longer written to. Nothing here starts a container; that is
 * the conversation's `withCheckout`, which this would follow.
 */
import { type FileStore, findChanges, type Manifest, REPO_ROOT } from "./github-io";
import type { SandboxPort } from "./light-sandbox";

export type HandOver =
	| { handedOver: true; written: number; deleted: number }
	| { handedOver: false; reason: string };

/** A path as one word of a bash command line. */
function quoted(path: string): string {
	return `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * Brings a machine that has `manifest.commit` checked out at `root` up to what `fs` holds.
 * A change a commit could not carry (`problems`) cannot be handed over either: it is a symlink or
 * bytes that are not text, and the port writes text.
 */
export async function handOver(
	fs: FileStore,
	manifest: Manifest,
	machine: SandboxPort,
	root = REPO_ROOT,
): Promise<HandOver> {
	const changes = await findChanges(fs, manifest);
	const problem = changes.problems[0];
	if (problem) return { handedOver: false, reason: `${problem.path}: ${problem.why}.` };
	for (const file of changes.written) {
		const result = await machine.writeFile(`${root}/${file.path}`, file.content);
		if ("error" in result) return { handedOver: false, reason: result.error };
	}
	// A few hundred paths at a time keep a command line under the port's limit.
	for (let start = 0; start < changes.deleted.length; start += 200) {
		const paths = changes.deleted
			.slice(start, start + 200)
			.map(quoted)
			.join(" ");
		const removed = await machine.run(`rm -f -- ${paths}`, root, 60);
		if (removed.exitCode !== 0) return { handedOver: false, reason: removed.output };
	}
	return { handedOver: true, written: changes.written.length, deleted: changes.deleted.length };
}
