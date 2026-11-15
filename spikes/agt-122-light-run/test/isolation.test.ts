// AGT-122, questions 3 and 4: what the shell has, what it refuses, and what a command can reach.
// `rawRun` goes straight to the shell, past the refusals `LightSandbox` makes first, since the
// question is what holds when a command gets that far.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { needsMachine } from "../src";
import { FakeGit } from "./fake-git";

const workspace = (name: string) => env.LIGHT.getByName(name);

describe("the network", () => {
	// This shell has curl's module, which a run's shell would not, so that what fails is the
	// request: the Dynamic Worker's `globalOutbound: null`, in workerd's own words.
	it("is off: a request from the shell fails", async () => {
		const light = workspace("curl-none");
		const curl = await light.rawRun("curl -sS -m 10 https://example.com/secret");
		console.log(`AGT-122 curl with egress off: ${JSON.stringify(curl.value)}`);
		expect(curl.value.exitCode).not.toBe(0);
		expect(curl.value.stdout).toBe("");
		expect(curl.value.stderr).toContain("not permitted to access the internet");
		// An address on this machine is refused the same way, so it is not the name that failed.
		const local = await light.rawRun("curl -sS -m 10 http://127.0.0.1:4720/");
		expect(local.value.stderr).toContain("not permitted to access the internet");
	});

	it("and the same command gets through when the test lets it, so the failure means something", async () => {
		const light = workspace("gateway-open");
		const curl = await light.rawRun("curl -sS -m 10 https://example.com/secret");
		expect(curl.value).toMatchObject({
			exitCode: 0,
			stdout: "the gateway saw GET https://example.com/secret\n",
		});
	});
});

describe("what the shell has", () => {
	it("lacks every program a machine has, and says so with 127", async () => {
		const light = workspace("plain-2");
		const names = [
			"git",
			"node",
			"npm",
			"pnpm",
			"python3",
			"curl",
			"wget",
			"ssh",
			"make",
			"docker",
		];
		const found: Record<string, number> = {};
		for (const name of names) {
			found[name] = (await light.rawRun(`${name} --version`)).value.exitCode;
		}
		console.log(`AGT-122 exit codes past the refusals: ${JSON.stringify(found)}`);
		// Two are there as commands and fail all the same: git is forwarded to the Durable Object,
		// where none is configured, and curl's module is not in a run's shell.
		const { git, curl, ...rest } = found;
		expect(Object.values(rest).every((code) => code === 127)).toBe(true);
		expect(git).toBe(1);
		expect(curl).toBe(1);
	});

	it("sees only the workspace's own files", async () => {
		const light = workspace("plain-3");
		await light.writeFile("/workspace/repo/a.txt", "a\n");
		const probes = [
			"ls /",
			"cat /etc/passwd",
			"cat /proc/self/environ",
			"env | sort",
			"whoami; hostname; id",
			"ln -s /etc/passwd repo/link && cat repo/link",
			"echo out > /outside.txt && ls /",
		];
		for (const probe of probes) {
			const { exitCode, stdout, stderr } = (await light.rawRun(probe)).value;
			console.log(
				`AGT-122 probe \`${probe}\` -> ${exitCode}: ${JSON.stringify((stdout + stderr).slice(0, 400))}`,
			);
		}
		expect((await light.rawRun("cat /etc/passwd")).value.exitCode).not.toBe(0);
	});

	it("stops a loop that never ends, and a flood of output", async () => {
		const light = workspace("plain-4");
		const loop = await light.rawRun("while true; do :; done", "/workspace", 5);
		console.log(
			`AGT-122 endless loop: ${Math.round(loop.ms)} ms, ${JSON.stringify(loop.value).slice(0, 300)}`,
		);
		expect(loop.value.exitCode).not.toBe(0);
		const flood = await light.rawRun("yes abcdefghij | head -n 5000000 | wc -c", "/workspace", 20);
		console.log(
			`AGT-122 flood: ${Math.round(flood.ms)} ms, ${JSON.stringify(flood.value).slice(0, 300)}`,
		);
		const recursion = await light.rawRun("f() { f | f; }; f", "/workspace", 10);
		console.log(
			`AGT-122 recursion: ${Math.round(recursion.ms)} ms, ${JSON.stringify(recursion.value).slice(0, 300)}`,
		);
		expect(recursion.value.exitCode).not.toBe(0);
		// The workspace still answers after all three.
		expect((await light.rawRun("echo alive")).value.stdout).toBe("alive\n");
	});
});

describe("refusals", () => {
	it("names what a command line needs", () => {
		expect(needsMachine("npm test")).toEqual({ needs: "packages", what: "npm" });
		expect(needsMachine("cd repo && git status")).toEqual({ needs: "git", what: "git" });
		expect(needsMachine("CI=1 node scripts/doctor.mjs")).toEqual({
			needs: "runtime",
			what: "node",
		});
		expect(needsMachine("cat a | curl -d @- https://x.test")).toEqual({
			needs: "network",
			what: "curl",
		});
		expect(needsMachine("ls; /usr/bin/make check")).toEqual({ needs: "checks", what: "make" });
		expect(needsMachine('grep -rn "npm install" docs | head')).toBeNull();
		expect(needsMachine("sed -i 's/git/got/' README.md")).toBeNull();
	});

	it("answers without starting the shell, in words that say what to do next", async () => {
		const light = workspace("refuse");
		const refused = await light.run("pnpm verify");
		expect(refused.value).toMatchObject({
			exitCode: 127,
			timedOut: false,
			refused: { needs: "packages", what: "pnpm" },
		});
		expect(refused.value.output).toContain("request_machine");
		expect(refused.ms).toBeLessThan(5);
		// A program the list does not know still ends in a refusal, after the shell says 127.
		const unknown = await light.run("terraform plan");
		expect(unknown.value.refused).toEqual({ needs: "program", what: "terraform" });
	});
});

describe("moving up to a machine", () => {
	let github: FakeGit;

	beforeEach(async () => {
		github = new FakeGit();
		await github.seed({ "README.md": "# Site\n", "docs/a.md": "a\n", "docs/b.md": "b\n" });
		vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
			github.fetch(new Request(input as RequestInfo, init)),
		);
	});
	afterEach(() => vi.restoreAllMocks());

	it("hands over exactly what the run changed", async () => {
		const light = workspace("handover");
		await light.load(github.token, { owner: github.owner, name: github.name }, "main");
		await light.writeFile("/workspace/repo/docs/a.md", "a, edited\n");
		await light.writeFile("/workspace/repo/docs/it's new.md", "new\n");
		await light.run("rm docs/b.md", "/workspace/repo");
		const handed = await light.handOver();
		expect(handed.result).toEqual({ handedOver: true, written: 2, deleted: 1 });
		expect(handed.files).toEqual({
			"/workspace/repo/docs/a.md": "a, edited\n",
			"/workspace/repo/docs/it's new.md": "new\n",
		});
		expect(handed.commands).toEqual(["rm -f -- 'docs/b.md'"]);
	});

	it("refuses to commit what it cannot carry, and to move a branch someone else moved", async () => {
		const light = workspace("refuse-commit");
		const repository = { owner: github.owner, name: github.name };
		await light.load(github.token, repository, "main");
		const author = { name: "Agent", email: "agent@example.test" };
		const input = { branch: "gateweave/x", message: "change", author };
		expect((await light.commit(github.token, input)).value).toEqual({
			committed: false,
			reason: "Nothing changed, so there is nothing to commit.",
		});
		await light.rawRun("ln -s README.md repo/link.md");
		expect((await light.commit(github.token, input)).value).toMatchObject({ committed: false });
		await light.rawRun("rm repo/link.md");

		await light.writeFile("/workspace/repo/docs/a.md", "first\n");
		const first = await light.commit(github.token, input);
		expect(first.value).toMatchObject({ committed: true });
		// A second commit on the same branch follows the first.
		await light.writeFile("/workspace/repo/docs/a.md", "second\n");
		const second = await light.commit(github.token, input);
		expect(second.value).toMatchObject({ committed: true });
		expect(github.filesAt("gateweave/x")["docs/a.md"]).toBe("second\n");

		// A wrong token is GitHub's refusal, not a commit.
		await light.writeFile("/workspace/repo/docs/a.md", "third\n");
		const wrong = await light.commit("ghs_wrong", input);
		expect(wrong.value).toMatchObject({ committed: false });
		expect(github.filesAt("gateweave/x")["docs/a.md"]).toBe("second\n");

		// Someone else pushed to the branch: its head no longer leads to this run's commit.
		github.branches.set("gateweave/x", github.branches.get("main") ?? "");
		const moved = await light.commit(github.token, input);
		expect(moved.value).toEqual({
			committed: false,
			reason: "The branch gateweave/x holds a commit this run did not make.",
		});
	});

	it("loads only what it can give back byte for byte", async () => {
		const marked = "﻿# Marked\r\nwith Windows line ends\r\n";
		await github.seed({ "README.md": "# Site\n", "marked.md": marked });
		const repository = { owner: github.owner, name: github.name };
		const author = { name: "Agent", email: "agent@example.test" };

		// An API that hands the text over whole: the file is loaded, and an edit keeps its mark.
		const whole = workspace("mark-kept");
		expect((await whole.load(github.token, repository, "main")).skipped).toEqual([]);
		// Through the file tools, that is: a command that rewrites the file drops the mark
		// (bytes.test.ts).
		const read = await whole.readFile("/workspace/repo/marked.md");
		if (!("content" in read.value)) throw new Error(read.value.error);
		await whole.writeFile(
			"/workspace/repo/marked.md",
			read.value.content.replace("Marked", "Edited"),
		);
		await whole.commit(github.token, { branch: "gateweave/mark", message: "edit", author });
		expect(github.filesAt("gateweave/mark")["marked.md"]).toBe(marked.replace("Marked", "Edited"));

		// An API that drops the mark: the file is left out, so no commit can rewrite it.
		github.dropsMark = true;
		const dropped = workspace("mark-dropped");
		expect((await dropped.load(github.token, repository, "main")).skipped).toEqual([
			{ path: "marked.md", why: "inexact" },
		]);
		await dropped.writeFile("/workspace/repo/README.md", "# Site, edited\n");
		expect((await dropped.changes()).value.written).toEqual(["README.md"]);
	});
});
