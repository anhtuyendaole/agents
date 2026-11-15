// AGT-122, questions 1, 2 and 5: a small docs change replayed on this repository's own files,
// from GitHub's API in to a pull request out, with each step timed. The numbers go to the console;
// the assertions are what must hold whatever the machine.
import { env } from "cloudflare:workers";
import { openPullRequest } from "@gateweave/agents-github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGit } from "./fake-git";
import { fixtureSize, repositoryFiles } from "./fixture";

const ROOT = "/workspace/repo";
const AUTHOR = { name: "Docs agent", email: "1+gateweave[bot]@users.noreply.github.com" };

let github: FakeGit;

beforeEach(async () => {
	github = new FakeGit();
	await github.seed(repositoryFiles, {
		symlinks: { "CLAUDE.link.md": "AGENTS.md" },
		executable: ["scripts/doctor.mjs"],
	});
	vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
		github.fetch(new Request(input as RequestInfo, init)),
	);
});

afterEach(() => vi.restoreAllMocks());

const repository = () => ({ owner: github.owner, name: github.name });
const round = (ms: number) => Math.round(ms * 10) / 10;

describe("a docs change with no container", () => {
	it("loads the repository, edits a Markdown file and opens a pull request", async () => {
		const light = env.LIGHT.getByName("replay");
		const steps: Record<string, number> = {};
		const outside = performance.now();

		const loaded = await light.load(github.token, repository(), "main");
		steps["load (GitHub in)"] = loaded.ms;
		const size = fixtureSize();
		expect(loaded.files).toBe(size.files);
		expect(loaded.skipped).toEqual([{ path: "CLAUDE.link.md", why: "symlink" }]);
		// The branch, the tree, and fifty blobs to a request.
		expect(loaded.requests).toBe(2 + Math.ceil(size.files / 50));

		console.log(`AGT-122 storage after the load: ${JSON.stringify(await light.storage())}`);

		const first = await light.readFile(`${ROOT}/README.md`);
		steps["read_file README.md (first action)"] = first.ms;
		expect(first.value).toEqual({ content: repositoryFiles["README.md"] });

		const ls = await light.run("ls", ROOT);
		steps["run: ls (first command, loads the shell)"] = ls.ms;
		expect(ls.value.output).toContain("AGENTS.md\n");

		const grep = await light.run('grep -rn "SANDBOX_DAILY_MINUTES" docs | head -5', ROOT);
		steps["run: grep -rn in docs/"] = grep.ms;
		expect(grep.value.output).toContain("docs/self-hosting.md:");

		const read = await light.readFile(`${ROOT}/docs/self-hosting.md`);
		steps["read_file docs/self-hosting.md"] = read.ms;
		if (!("content" in read.value)) throw new Error(read.value.error);
		const before = read.value.content;
		const after = before.replace(/^# .*$/m, (line) => `${line} (checked)`);
		expect(after).not.toBe(before);

		const edit = await light.writeFile(`${ROOT}/docs/self-hosting.md`, after);
		steps["edit_file docs/self-hosting.md (the write)"] = edit.ms;

		const head = await light.run("head -3 docs/self-hosting.md && wc -l docs/*.md | tail -1", ROOT);
		steps["run: head and wc"] = head.ms;
		expect(head.value.output).toContain("(checked)");

		const find = await light.run('find . -name "*.md" | wc -l', ROOT);
		steps['run: find . -name "*.md"'] = find.ms;
		expect(Number(find.value.output.trim())).toBeGreaterThan(20);

		// The rest of a change a pull request can carry: a new file and a deleted one.
		await light.writeFile(`${ROOT}/docs/notes/new.md`, "# New\n");
		const rm = await light.run("rm CODE_OF_CONDUCT.md", ROOT);
		steps["run: rm"] = rm.ms;
		expect(rm.value.exitCode).toBe(0);

		const changes = await light.changes();
		steps["what changed (hashes every file)"] = changes.ms;
		expect(changes.value).toEqual({
			written: ["docs/notes/new.md", "docs/self-hosting.md"],
			deleted: ["CODE_OF_CONDUCT.md"],
			problems: [],
		});

		const asked = github.requests.length;
		const committed = await light.commit(github.token, {
			branch: "gateweave/replay",
			message: "docs: check the self-hosting guide",
			author: AUTHOR,
		});
		steps["commit (GitHub out)"] = committed.ms;
		expect(committed.value).toMatchObject({ committed: true });
		expect(github.requests.slice(asked)).toEqual([
			"GET /repos/acme/site/git/ref/heads/gateweave/replay",
			"POST /repos/acme/site/git/trees",
			"POST /repos/acme/site/git/commits",
			"POST /repos/acme/site/git/refs",
		]);

		const pull = await openPullRequest(github.token, repository(), {
			title: "docs: check the self-hosting guide",
			body: "AGT-122",
			head: "gateweave/replay",
			base: "main",
		});
		expect(pull).toMatchObject({ number: 1, state: "open" });
		const total = performance.now() - outside;

		// The branch holds the default branch's files with exactly this run's three changes.
		const expected: Record<string, string> = {
			...repositoryFiles,
			"CLAUDE.link.md": "AGENTS.md",
			"docs/self-hosting.md": after,
			"docs/notes/new.md": "# New\n",
		};
		delete expected["CODE_OF_CONDUCT.md"];
		expect(github.filesAt("gateweave/replay")).toEqual(expected);
		// What was never loaded keeps its kind, and so does a file's executable bit.
		expect(github.modeAt("gateweave/replay", "CLAUDE.link.md")).toBe("120000");
		expect(github.modeAt("gateweave/replay", "scripts/doctor.mjs")).toBe("100755");

		// A stress the docs change does not need, to see what a search of everything costs.
		const everything = await light.run('grep -rn "SANDBOX_DAILY_MINUTES" . | wc -l', ROOT);
		const hostGrep = await light.grep("SANDBOX_DAILY_MINUTES", ROOT);
		expect(Number(everything.value.output.trim())).toBe(hostGrep.value);

		console.log(
			[
				`AGT-122 replay: ${size.files} files, ${size.bytes} bytes, ${loaded.requests} requests in, 4 out`,
				...Object.entries(steps).map(
					([step, ms]) => `  ${String(round(ms)).padStart(8)} ms  ${step}`,
				),
				`  ${String(round(total)).padStart(8)} ms  the whole run, seen from the test`,
				`  ${String(round(everything.ms)).padStart(8)} ms  stress: grep -rn over all ${size.files} files in the shell`,
				`  ${String(round(hostGrep.ms)).padStart(8)} ms  the same search by workspace.fs.grep, in the Durable Object`,
			].join("\n"),
		);
	});

	it("says whether the clock moves while code runs", async () => {
		const { spun } = await env.LIGHT.getByName("clock").clock();
		console.log(`AGT-122 clock: a 20M-step loop read as ${round(spun)} ms`);
		expect(spun).toBeGreaterThanOrEqual(0);
	});

	it("warm: the same commands in a workspace whose shell is loaded", async () => {
		const light = env.LIGHT.getByName("warm");
		await light.load(github.token, repository(), "main");
		await light.run("true", ROOT);
		const times: Record<string, number[]> = { ls: [], grep: [], cat: [], read: [] };
		for (let index = 0; index < 10; index += 1) {
			times.ls?.push((await light.run("ls", ROOT)).ms);
			times.grep?.push(
				(await light.run('grep -rn "SANDBOX_DAILY_MINUTES" docs | head -5', ROOT)).ms,
			);
			times.cat?.push((await light.run("cat README.md | head -20", ROOT)).ms);
			times.read?.push((await light.readFile(`${ROOT}/README.md`)).ms);
		}
		const median = (values: number[]) => [...values].sort((a, b) => a - b)[5] ?? 0;
		console.log(
			`AGT-122 warm medians of 10: ls ${round(median(times.ls ?? []))} ms, grep docs ${round(median(times.grep ?? []))} ms, cat ${round(median(times.cat ?? []))} ms, read_file ${round(median(times.read ?? []))} ms`,
		);
	});
});
