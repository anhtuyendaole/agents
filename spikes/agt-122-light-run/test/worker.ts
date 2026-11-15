/**
 * AGT-122, a spike. The Worker the tests run in: one Durable Object that holds a `Workspace`
 * with the worker shell, reached over RPC. Nothing here is part of the app.
 */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Workspace, WorkspaceServiceProxy } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import curl from "@cloudflare/computer/shell/curl";
import { GitHubError, type RepositoryName } from "@gateweave/agents-github";
import {
	type CommandResult,
	type CommitAuthor,
	type CommitResult,
	commitChanges,
	findChanges,
	handOver,
	LightSandbox,
	loadRepository,
	type Manifest,
	type ReadResult,
	type SandboxPort,
	type WriteResult,
} from "../src";

// The shell's Dynamic Worker reaches the files through this entrypoint, which the backend finds
// in `ctx.exports`, so the Worker's main module has to export it.
export { WorkspaceServiceProxy };

export interface Timed<T> {
	value: T;
	ms: number;
}

async function timed<T>(work: () => Promise<T>): Promise<Timed<T>> {
	const start = performance.now();
	const value = await work();
	return { value, ms: performance.now() - start };
}

/**
 * Where a shell's requests go when a test lets them out, to show that the test for "no network"
 * can tell: the same `curl` that fails with egress off is answered here.
 */
export class RecordingGateway extends WorkerEntrypoint<Env> {
	override fetch(request: Request): Response {
		return new Response(`the gateway saw ${request.method} ${request.url}\n`);
	}
}

/** A machine with files in memory, standing in for the container a run is handed over to. */
class MemoryMachine implements SandboxPort {
	readonly files = new Map<string, string>();
	readonly commands: string[] = [];

	async run(command: string): Promise<CommandResult> {
		this.commands.push(command);
		return { exitCode: 0, output: "", timedOut: false };
	}

	async readFile(path: string): Promise<ReadResult> {
		const content = this.files.get(path);
		return content === undefined ? { error: `${path} does not exist.` } : { content };
	}

	async writeFile(path: string, content: string): Promise<WriteResult> {
		this.files.set(path, content);
		return { written: content.length };
	}
}

export class LightWorkspace extends DurableObject<Env> {
	readonly #workspace: Workspace;
	readonly #sandbox: LightSandbox;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// A test picks the shell by the object's name. Without a prefix it is the one a run would
		// have: the core commands and no network. The core has a `curl` that fails for want of its
		// module, which says nothing about the network, so `curl-` adds the module and still has no
		// network, and `gateway-` adds it and sends its requests to `RecordingGateway`.
		const name = ctx.id.name ?? "";
		const withCurl = name.startsWith("curl-") || name.startsWith("gateway-");
		this.#workspace = new Workspace({
			storage: ctx.storage,
			backends: [
				new WorkerShellBackend({
					loader: env.LOADER,
					workspace: { binding: "LIGHT", id: ctx.id.toString() },
					ctx,
					commands: withCurl ? [curl] : [],
					// "none" is the default, said out loud: the Dynamic Worker gets `globalOutbound: null`.
					egress: name.startsWith("gateway-")
						? {
								mode: "http-gateway",
								gateway: ctx.exports.RecordingGateway({ props: {} }),
								revision: "1",
							}
						: { mode: "none" },
				}),
			],
		});
		this.#sandbox = new LightSandbox(this.#workspace);
	}

	/** A command line straight to the shell, past `LightSandbox`'s refusals. */
	async rawRun(command: string, cwd = "/workspace", timeoutSeconds = 30) {
		return timed(async () => {
			const handle = await this.#workspace.runtime.exec(command, {
				cwd,
				encoding: "utf8",
				timeoutMs: timeoutSeconds * 1000,
			});
			try {
				const { exitCode, stdout, stderr } = await handle.result();
				return { exitCode, stdout, stderr };
			} finally {
				handle[Symbol.dispose]();
			}
		});
	}

	/** Hands the run's changes to a machine in memory, and says what it then holds. */
	async handOver() {
		const machine = new MemoryMachine();
		const result = await handOver(this.#workspace.fs, await this.#manifest(), machine);
		return { result, files: Object.fromEntries(machine.files), commands: machine.commands };
	}

	/** What `WorkspaceServiceProxy` calls to hand the shell its files. */
	async __getWorkspaceStub() {
		await this.#workspace.ready();
		return this.#workspace.stub();
	}

	run(command: string, cwd = "/workspace", timeoutSeconds = 120): Promise<Timed<CommandResult>> {
		return timed(() => this.#sandbox.run(command, cwd, timeoutSeconds));
	}

	readFile(path: string): Promise<Timed<ReadResult>> {
		return timed(() => this.#sandbox.readFile(path));
	}

	writeFile(path: string, content: string): Promise<Timed<WriteResult>> {
		return timed(() => this.#sandbox.writeFile(path, content));
	}

	/** Reads a branch's files in through GitHub's API and keeps the manifest of what it read. */
	async load(token: string, repository: RepositoryName, branch: string) {
		const loaded = await timed(() => loadRepository(this.#workspace.fs, token, repository, branch));
		await this.ctx.storage.put("manifest", loaded.value);
		const { files, skipped, requests, commit } = loaded.value;
		return { ms: loaded.ms, files: Object.keys(files).length, skipped, requests, commit };
	}

	/** What changed since `load`, by path. */
	async changes(): Promise<Timed<{ written: string[]; deleted: string[]; problems: string[] }>> {
		const manifest = await this.#manifest();
		return timed(async () => {
			const found = await findChanges(this.#workspace.fs, manifest);
			return {
				written: found.written.map((file) => file.path),
				deleted: found.deleted,
				problems: found.problems.map((problem) => `${problem.path}: ${problem.why}`),
			};
		});
	}

	/** Commits what changed onto `branch` through the Git Data API. */
	async commit(
		token: string,
		input: { branch: string; message: string; author: CommitAuthor },
	): Promise<Timed<CommitResult>> {
		const manifest = await this.#manifest();
		return timed(async () => {
			try {
				const changes = await findChanges(this.#workspace.fs, manifest);
				const result = await commitChanges(token, manifest, changes, input);
				if (result.committed) {
					await this.ctx.storage.put("manifest", { ...manifest, pushed: result.commit });
				}
				return result;
			} catch (error) {
				// An answer, as `applySetup`'s refusals are: an error loses its class on the way out.
				if (error instanceof GitHubError) return { committed: false, reason: error.message };
				throw error;
			}
		});
	}

	/** A search by the filesystem itself, in the Durable Object, with no shell. */
	grep(pattern: string, path: string): Promise<Timed<number>> {
		return timed(
			async () => (await this.#workspace.fs.grep(pattern, path, { limit: 10_000 })).length,
		);
	}

	/**
	 * What the files cost in storage: each table's rows, the indexes beside them, and the
	 * database's size. Cloudflare bills a row written once for the table and once more for each
	 * index it is in.
	 */
	storage(): { tables: Record<string, number>; indexes: Record<string, number>; bytes: number } {
		const sql = this.ctx.storage.sql;
		const tables: Record<string, number> = {};
		const indexes: Record<string, number> = {};
		const found = sql
			.exec<{ name: string; type: string; tbl_name: string }>(
				"SELECT name, type, tbl_name FROM sqlite_master WHERE type IN ('table', 'index')",
			)
			.toArray();
		for (const { name, type, tbl_name } of found) {
			if (name.startsWith("_cf_") || name.startsWith("sqlite_")) continue;
			if (type === "index") indexes[tbl_name] = (indexes[tbl_name] ?? 0) + 1;
			else {
				try {
					const counted = sql.exec<{ rows: number }>(`SELECT count(*) AS rows FROM "${name}"`);
					tables[name] = counted.one().rows;
				} catch {
					// A virtual table's shadow, which cannot be counted this way.
				}
			}
		}
		return { tables, indexes, bytes: sql.databaseSize };
	}

	async #manifest(): Promise<Manifest> {
		const manifest = await this.ctx.storage.get<Manifest>("manifest");
		if (!manifest) throw new Error("No repository was loaded.");
		return manifest;
	}

	/** Whether the clock moves while code runs, which decides what the timings here can mean. */
	clock(): { spun: number } {
		const start = performance.now();
		let total = 0;
		for (let index = 0; index < 20_000_000; index += 1) total += index % 7;
		return { spun: total > 0 ? performance.now() - start : 0 };
	}
}

export default {
	fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler<Env>;
