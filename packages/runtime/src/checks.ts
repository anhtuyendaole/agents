/**
 * A repository's checks before a pull request (AGT-142). When the repository an agent works on
 * has checks, `open_pull_request` commits the work, runs each command here, in the sandbox, on
 * the tree as committed, and only then pushes and opens the pull request (`./pull-requests.ts`).
 * A check that fails stops the round, and the model reads which one, its exit code and the end
 * of its output, to fix the work and call again.
 *
 * Where each thing comes from is the point (WEB-67): the commands are the repository's settings
 * in the registry, read at each call; the section at the end of the pull request is written here,
 * from the commands, their exit codes and their durations; nothing of a command's output, and
 * nothing the model wrote, is in it. The output goes to the model alone, and never to the trace.
 *
 * The checks run on the agent's own machine, so they say what ran there. They are a first line
 * before a repository's own CI, not in place of it.
 */
import { CHECK_LIMITS, CHECKS_HEADING, SANDBOX_REPOSITORY_PATH } from "@gateweave/agents-model";
import { type CommandResult, SANDBOX_SERVER } from "./sandbox-tools";
import type { RunRecorder } from "./trace";

/** The tool the trace names for a check, under the sandbox's name like its other commands. */
export const CHECK_TOOL = "check";

/** What runs a check: a sandbox's `run`. */
export interface CheckRunner {
	run(command: string, cwd: string, timeoutSeconds: number): Promise<CommandResult>;
}

/** How one check went. */
export type CheckOutcome =
	/** It exited, with this code: 0 passes, anything else fails. */
	| { kind: "exited"; exitCode: number }
	/** It was stopped at its time limit. Never a pass, whatever it had printed. */
	| { kind: "timed-out"; limitSeconds: number }
	/** The sandbox could not run it, or lost it. */
	| { kind: "sandbox-failed" }
	/** It was not started: a check before it failed, or the time for checks was used up. */
	| { kind: "not-run"; reason: string };

export interface CheckResult {
	command: string;
	outcome: CheckOutcome;
	/** How long it ran; 0 for one that was not started. */
	seconds: number;
	/** The end of its output, for the model alone; empty for one that passed or never ran. */
	tail: string;
}

/**
 * A round of checks: all passed; one did not, which stopped the round; or none could start,
 * because the run's time for checks was used up before the round began.
 */
export interface CheckRound {
	status: "passed" | "failed" | "not-run";
	results: CheckResult[];
}

/** What a run has spent on checks so far, across its calls of `open_pull_request`. */
export interface ChecksSpent {
	failedRounds: number;
	seconds: number;
}

const EARLIER_FAILED = "an earlier check did not pass";
const CALL_TIME_USED = `the ${minutes(CHECK_LIMITS.callSeconds)} minutes one call has for checks were used up`;
const RUN_TIME_USED = `the ${minutes(CHECK_LIMITS.runSeconds)} minutes a run has for checks were used up`;

function minutes(seconds: number): number {
	return Math.round(seconds / 60);
}

/** Whether a check passed: it exited with 0, and nothing else counts. */
export function checkPassed(result: CheckResult): boolean {
	return result.outcome.kind === "exited" && result.outcome.exitCode === 0;
}

/**
 * Runs the commands in order in the repository's root and stops at the first that does not pass.
 * Each gets the time `CHECK_LIMITS` leaves it: its own limit, what is left of the call's, and what
 * is left of the run's, which `spent` carries from call to call. Each is a span in the run's
 * trace, with the size of its command and of its output, and why it did not pass. Throws when
 * `signal` gives up, as a turn that is stopped does.
 */
export async function runChecks(
	commands: readonly string[],
	sandbox: CheckRunner,
	run: RunRecorder,
	spent: ChecksSpent,
	{ now = Date.now, signal }: { now?: () => number; signal?: AbortSignal } = {},
): Promise<CheckRound> {
	const results: CheckResult[] = [];
	let callSeconds = 0;
	let stopped: string | null = null;
	let ran = false;
	for (const command of commands) {
		// A turn that was stopped starts no further command; the one under way runs to its end.
		signal?.throwIfAborted();
		if (stopped !== null) {
			results.push(notRun(command, stopped));
			continue;
		}
		const callLeft = CHECK_LIMITS.callSeconds - callSeconds;
		const runLeft = CHECK_LIMITS.runSeconds - spent.seconds;
		const limitSeconds = Math.floor(Math.min(CHECK_LIMITS.commandSeconds, callLeft, runLeft));
		if (limitSeconds < 1) {
			stopped = runLeft <= callLeft ? RUN_TIME_USED : CALL_TIME_USED;
			results.push(notRun(command, stopped));
			continue;
		}
		ran = true;
		const span = run.toolStarted(SANDBOX_SERVER, CHECK_TOOL, byteLength(command));
		const started = now();
		let answer: CommandResult | null;
		try {
			answer = await sandbox.run(command, SANDBOX_REPOSITORY_PATH, limitSeconds);
		} catch {
			answer = null;
		}
		const seconds = Math.max(0, (now() - started) / 1000);
		callSeconds += seconds;
		spent.seconds += seconds;
		const result = checkResult(command, answer, limitSeconds, seconds);
		results.push(result);
		const passed = checkPassed(result);
		run.toolEnded(span, {
			outputBytes: answer === null ? 0 : byteLength(answer.output),
			error: passed ? null : describeOutcome(result.outcome),
		});
		if (!passed) stopped = EARLIER_FAILED;
	}
	if (!ran) return { status: "not-run", results };
	return { status: stopped === null ? "passed" : "failed", results };
}

function notRun(command: string, reason: string): CheckResult {
	return { command, outcome: { kind: "not-run", reason }, seconds: 0, tail: "" };
}

function checkResult(
	command: string,
	answer: CommandResult | null,
	limitSeconds: number,
	seconds: number,
): CheckResult {
	if (answer === null) return { command, outcome: { kind: "sandbox-failed" }, seconds, tail: "" };
	// The one place a command's output is taken from: its end, for the model.
	const tail = lastBytes(answer.output, CHECK_LIMITS.outputBytes);
	// A command stopped at its limit is never a pass, whatever exit code came with it.
	if (answer.timedOut) {
		return { command, outcome: { kind: "timed-out", limitSeconds }, seconds, tail };
	}
	const outcome: CheckOutcome = { kind: "exited", exitCode: answer.exitCode };
	return { command, outcome, seconds, tail: answer.exitCode === 0 ? "" : tail };
}

/** How a check went, in the words the trace and the model read. No output is in them. */
export function describeOutcome(outcome: CheckOutcome): string {
	switch (outcome.kind) {
		case "exited":
			return `It exited with code ${outcome.exitCode}`;
		case "timed-out":
			return `It timed out: it was stopped after ${outcome.limitSeconds} seconds`;
		case "sandbox-failed":
			return "The sandbox could not run it";
		case "not-run":
			return `It was not run: ${outcome.reason}`;
	}
}

/** Why the model's call opened nothing, with what it needs to fix the work and call again. */
export function describeFailedRound(round: CheckRound, spent: ChecksSpent): string {
	const failed = round.results.find(
		(result) => !checkPassed(result) && result.outcome.kind !== "not-run",
	);
	const left = CHECK_LIMITS.failedRounds - spent.failedRounds;
	return [
		"The repository's checks did not pass, so nothing was pushed and no pull request was opened or updated. Your work is committed in the sandbox.",
		failed ? describeFailedCheck(failed) : describeNotRun(round),
		`Fix what failed and call the tool again. This was failed round ${spent.failedRounds} of ${CHECK_LIMITS.failedRounds} in this run: ${
			left === 1
				? "if the next one fails too, the pull request is opened as a draft that says which check failed."
				: `after ${CHECK_LIMITS.failedRounds} the pull request is opened as a draft that says which check failed.`
		}`,
	].join("\n\n");
}

/** What the model is told when the pull request was made although the checks did not pass. */
export function describeDraft(round: CheckRound): string {
	if (round.status === "not-run") {
		return `The repository's checks were not run: ${RUN_TIME_USED}. The pull request says so, and a new one is opened as a draft.`;
	}
	const failed = round.results.find(
		(result) => !checkPassed(result) && result.outcome.kind !== "not-run",
	);
	return [
		`The repository's checks failed in ${CHECK_LIMITS.failedRounds} rounds of this run, so the work was pushed as it is. The pull request says which check failed, and a new one is opened as a draft.`,
		failed ? describeFailedCheck(failed) : describeNotRun(round),
	].join("\n\n");
}

function describeFailedCheck(result: CheckResult): string {
	const how = `${code(result.command)}: ${describeOutcome(result.outcome)}, after ${duration(result.seconds)}.`;
	return result.tail.trim() === ""
		? `${how} It printed nothing.`
		: `${how} The end of its output:\n\n${result.tail}`;
}

function describeNotRun(round: CheckRound): string {
	const [first] = round.results.filter((result) => result.outcome.kind === "not-run");
	return first ? `${code(first.command)}: ${describeOutcome(first.outcome)}.` : "";
}

/**
 * The section at the end of a pull request's body, in the tool's own words: each command, its
 * exit code and its duration, on the commit they ran on. `draft` adds why the pull request is one.
 */
export function checksSection(round: CheckRound, head: string, draft: boolean): string {
	const lines = round.results.map((result) => `- ${code(result.command)}: ${line(result)}`);
	const about =
		round.status === "not-run"
			? `Checks: not run (${RUN_TIME_USED}).`
			: `Gateweave Agents ran these commands in the agent's sandbox on commit ${head.slice(0, 7)}, before pushing it.`;
	return section([
		about,
		lines.join("\n"),
		draft ? draftLine(round) : null,
		"The commands are set on the repository's page in Gateweave Agents. Gateweave wrote this section, not the agent.",
	]);
}

/** The section of a pull request whose checks are set but had nowhere to run. */
export function checksNotRunSection(reason: string): string {
	return section([
		`Checks: not run (${reason}).`,
		"The commands are set on the repository's page in Gateweave Agents. Gateweave wrote this section, not the agent.",
	]);
}

/** Why a turn that works on files without a sandbox runs no checks. */
export const NO_SANDBOX = "no sandbox in this run";

function section(parts: (string | null)[]): string {
	return [`## ${CHECKS_HEADING}`, ...parts.filter((part) => part !== null)].join("\n\n");
}

function draftLine(round: CheckRound): string {
	const why =
		round.status === "not-run"
			? "The checks could not run"
			: `The checks failed in ${CHECK_LIMITS.failedRounds} rounds of this run`;
	return `${why}, so Gateweave opens the pull request as a draft. One that was open already stays as it was.`;
}

function line({ outcome, seconds }: CheckResult): string {
	switch (outcome.kind) {
		case "exited":
			return `${outcome.exitCode === 0 ? "passed" : "failed"}, exit code ${outcome.exitCode}, ${duration(seconds)}`;
		case "timed-out":
			return `timed out, no exit code, stopped after ${duration(seconds)} (limit ${outcome.limitSeconds} s)`;
		case "sandbox-failed":
			return `failed, no exit code: the sandbox could not run it, ${duration(seconds)}`;
		case "not-run":
			return `not run (${outcome.reason})`;
	}
}

function duration(seconds: number): string {
	return `${seconds.toFixed(1)} s`;
}

/**
 * A command as Markdown shows it, as it is: a code span fenced by more backticks than the
 * command has in a row, so nothing in it ends the span or is read as Markdown.
 */
function code(command: string): string {
	let longest = 0;
	for (const run of command.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(longest + 1);
	return longest === 0 ? `${fence}${command}${fence}` : `${fence} ${command} ${fence}`;
}

/**
 * The model's body without any section under the tool's heading, so the only one a reader finds
 * is the one the tool wrote. A line counts as the heading by its letters alone, whatever marks it
 * up: `#` signs, emphasis, a quote, HTML tags, a colon, another case. The section goes from there
 * to the next `#` heading, or to the end. A body without the heading comes back as it is.
 */
export function withoutChecksSection(body: string): string {
	const kept: string[] = [];
	let forged = false;
	let removed = false;
	for (const each of body.split("\n")) {
		if (isChecksHeading(each)) {
			forged = true;
			removed = true;
			continue;
		}
		if (forged && /^\s{0,3}#{1,6}(\s|$)/.test(each)) forged = false;
		if (!forged) kept.push(each);
	}
	return removed ? kept.join("\n").trimEnd() : body;
}

const PLAIN_HEADING = plain(CHECKS_HEADING);

function isChecksHeading(text: string): boolean {
	return plain(text) === PLAIN_HEADING;
}

/** A line's letters and digits, in lower case, without its HTML tags: its words and no more. */
function plain(text: string): string {
	return text
		.replace(/<[^>]*>/g, "")
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]/gu, "")
		.toLowerCase();
}

/** The body with the tool's section after it. */
export function withChecksSection(body: string, section: string): string {
	const before = withoutChecksSection(body).trimEnd();
	return before === "" ? section : `${before}\n\n${section}`;
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** The last `limit` bytes of `text`, starting at a whole character. */
export function lastBytes(text: string, limit: number): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= limit) return text;
	let start = bytes.length - limit;
	// A byte of the form 10xxxxxx continues a character that began earlier.
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return new TextDecoder().decode(bytes.subarray(start));
}
