/**
 * AGT-122, a spike: the three things the Gateweave engine's file tools ask of a sandbox
 * (`SandboxPort` in packages/runtime/src/sandbox-tools.ts), answered by a `Workspace` from
 * `@cloudflare/computer` instead of a container. Files are rows in the Durable Object's SQLite,
 * and a command line runs in just-bash inside a Dynamic Worker that has no network.
 *
 * The port's shape is restated here rather than imported, so that this package pulls in none of
 * the runtime.
 */
import type { Workspace } from "@cloudflare/computer";
import { needsMachine, type Refusal, refusalText } from "./refusals";

export interface CommandResult {
	exitCode: number;
	output: string;
	timedOut: boolean;
	/** Set when the command asked for something only a container has. */
	refused?: Refusal;
}

export type ReadResult = { content: string } | { error: string };
export type WriteResult = { written: number } | { error: string };

export interface SandboxPort {
	run(command: string, cwd: string, timeoutSeconds: number): Promise<CommandResult>;
	readFile(path: string): Promise<ReadResult>;
	writeFile(path: string, content: string): Promise<WriteResult>;
}

/** The exit code a shell gives a command it does not have. */
const NOT_FOUND = 127;
/** The exit code `timeout` gives, which the worker shell uses too. */
const TIMED_OUT = 124;

export class LightSandbox implements SandboxPort {
	readonly #workspace: Workspace;

	constructor(workspace: Workspace) {
		this.#workspace = workspace;
	}

	async run(command: string, cwd: string, timeoutSeconds: number): Promise<CommandResult> {
		// Decided before the shell starts: a refusal should cost nothing and read the same every
		// time, and "command not found" from a shell tells a model to try another spelling.
		const refused = needsMachine(command);
		if (refused) {
			return { exitCode: NOT_FOUND, output: refusalText(refused), timedOut: false, refused };
		}
		const handle = await this.#workspace.runtime.exec(command, {
			cwd,
			encoding: "utf8",
			timeoutMs: timeoutSeconds * 1000,
		});
		try {
			const result = await handle.result();
			const output = result.stdout + result.stderr;
			if (result.exitCode === NOT_FOUND) {
				// A command the list above did not know and the shell does not have.
				const missing: Refusal = { needs: "program", what: firstWord(command) };
				return {
					exitCode: NOT_FOUND,
					output: `${output}${refusalText(missing)}`,
					timedOut: false,
					refused: missing,
				};
			}
			return { exitCode: result.exitCode, output, timedOut: result.exitCode === TIMED_OUT };
		} finally {
			handle[Symbol.dispose]();
		}
	}

	async readFile(path: string): Promise<ReadResult> {
		try {
			// Not `readFile(path, "utf8")`, which drops a byte order mark: an edit is a read and a
			// write back, and the file would lose its mark on the way.
			const bytes = await new Response(await this.#workspace.fs.readFile(path)).arrayBuffer();
			return { content: new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes) };
		} catch (error) {
			return { error: `${path} could not be read: ${codeOf(error)}.` };
		}
	}

	async writeFile(path: string, content: string): Promise<WriteResult> {
		try {
			const folder = path.slice(0, path.lastIndexOf("/"));
			if (folder !== "") await this.#workspace.fs.mkdir(folder, { recursive: true });
			await this.#workspace.fs.writeFile(path, content);
			return { written: new TextEncoder().encode(content).length };
		} catch (error) {
			return { error: `${path} could not be written: ${codeOf(error)}.` };
		}
	}
}

function firstWord(command: string): string {
	return command.trim().split(/\s+/)[0] ?? "";
}

function codeOf(error: unknown): string {
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string") return code;
	return error instanceof Error ? error.message : String(error);
}
