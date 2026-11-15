/**
 * AGT-122, a spike. The Worker behind `measure/run.mjs`: the tests' Durable Object, a stand-in
 * for GitHub, and two routes that replay the docs change and say how long each step took.
 */
import { DurableObject, env } from "cloudflare:workers";
import { FakeGit } from "../test/fake-git";
import type { LightWorkspace } from "../test/worker";

export { LightWorkspace, RecordingGateway, WorkspaceServiceProxy } from "../test/worker";

interface MeasureEnv {
	LIGHT: DurableObjectNamespace<LightWorkspace>;
	GITHUB: DurableObjectNamespace<FakeGitHub>;
}

/** api.github.com for this Worker, kept in one object's memory. */
export class FakeGitHub extends DurableObject {
	#git = new FakeGit();

	async seed(files: Record<string, string>): Promise<number> {
		this.#git = new FakeGit();
		await this.#git.seed(files);
		return Object.keys(files).length;
	}

	override fetch(request: Request): Promise<Response> {
		return this.#git.fetch(request);
	}

	token(): string {
		return this.#git.token;
	}
}

const github = () => (env as unknown as MeasureEnv).GITHUB.getByName("github");

// The GitHub client calls `fetch` with api.github.com's address. Here those calls go to the
// stand-in, and nothing else is let out: a measurement must not reach the real GitHub.
const outbound = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	const request = new Request(input, init);
	if (new URL(request.url).host === "api.github.com") return github().fetch(request);
	if (new URL(request.url).hostname === "127.0.0.1") return outbound(request);
	return Promise.reject(new Error(`A measurement reaches no address: ${request.url}`));
};

const ROOT = "/workspace/repo";
const REPOSITORY = { owner: "acme", name: "site" };

/** The docs change's commands and file calls, without GitHub on either side. */
async function work(light: DurableObjectStub<LightWorkspace>, steps: Record<string, number>) {
	const first = await light.readFile(`${ROOT}/README.md`);
	steps["read_file README.md"] = first.ms;
	steps["run: ls"] = (await light.run("ls", ROOT)).ms;
	steps["run: grep -rn in docs/"] = (
		await light.run('grep -rn "SANDBOX_DAILY_MINUTES" docs | head -5', ROOT)
	).ms;
	const read = await light.readFile(`${ROOT}/docs/self-hosting.md`);
	steps["read_file docs/self-hosting.md"] = read.ms;
	if (!("content" in read.value)) throw new Error(read.value.error);
	// A line added and taken away in turn, so each replay changes the file.
	const marker = "\n<!-- checked -->\n";
	const content = read.value.content.endsWith(marker)
		? read.value.content.slice(0, -marker.length)
		: read.value.content + marker;
	steps["edit_file (the write)"] = (
		await light.writeFile(`${ROOT}/docs/self-hosting.md`, content)
	).ms;
	steps["run: head and wc"] = (
		await light.run("head -3 docs/self-hosting.md && wc -l docs/*.md | tail -1", ROOT)
	).ms;
	steps["run: find *.md"] = (await light.run('find . -name "*.md" | wc -l', ROOT)).ms;
}

export default {
	async fetch(request: Request, bindings: MeasureEnv): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get("name") ?? "measure";
		const light = bindings.LIGHT.getByName(name);

		if (url.pathname === "/ping") return new Response("ok");

		if (url.pathname === "/seed" && request.method === "POST") {
			const files = (await request.json()) as Record<string, string>;
			return Response.json({ files: await github().seed(files) });
		}

		// The whole run on a workspace nobody has used: files in, the work, a commit out.
		if (url.pathname === "/full") {
			const steps: Record<string, number> = {};
			const start = performance.now();
			const token = await github().token();
			const loaded = await light.load(token, REPOSITORY, "main");
			steps["load (GitHub in)"] = loaded.ms;
			const afterLoad = performance.now() - start;
			await work(light, steps);
			const committed = await light.commit(token, {
				branch: `gateweave/${name}`,
				message: "docs: check the self-hosting guide",
				author: { name: "Docs agent", email: "agent@example.test" },
			});
			steps["commit (hash every file, GitHub out)"] = committed.ms;
			return Response.json({
				files: loaded.files,
				requests: loaded.requests,
				committed: committed.value.committed,
				toFirstAction: afterLoad + (steps["read_file README.md"] ?? 0),
				total: performance.now() - start,
				steps,
			});
		}

		// The work alone, on a workspace that is loaded and whose shell may be warm.
		if (url.pathname === "/work") {
			const steps: Record<string, number> = {};
			const start = performance.now();
			await work(light, steps);
			return Response.json({ total: performance.now() - start, steps });
		}

		// A search of every file, in the shell and by the filesystem.
		if (url.pathname === "/search") {
			const shell = await light.run('grep -rn "SANDBOX_DAILY_MINUTES" . | wc -l', ROOT);
			const host = await light.grep("SANDBOX_DAILY_MINUTES", ROOT);
			return Response.json({
				shell: shell.ms,
				shellMatches: Number(shell.value.output.trim()),
				host: host.ms,
				hostMatches: host.value,
			});
		}
		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<MeasureEnv>;
