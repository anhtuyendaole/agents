// AGT-122, a spike. Starts measure/worker.ts with `wrangler dev`, replays the docs change on this
// repository's own files and prints how long each step took and how much processor time the local
// runtime used for it.
//
//   pnpm measure                    (from this spike's folder; Windows, as it reads the runtime's
//                                    processor time through PowerShell)
//
// The processor time is workerd's whole process: the Worker, both Durable Objects, the shell's
// Dynamic Worker, the stand-in for GitHub, SQLite, and the runtime's own threads. It is therefore
// more than Cloudflare would bill as CPU time, which counts the isolates' JavaScript alone.
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const port = Number(process.env.AGT122_PORT ?? 4791);
const base = `http://127.0.0.1:${port}`;
const RUNS = 10;

// The files the tests' fixture holds (test/fixture.ts), read the same way.
const SKIPPED_FOLDERS = new Set([
	"node_modules",
	".wrangler",
	".tanstack",
	".output",
	"dist",
	"test-results",
	"playwright-report",
	".git",
]);
const TEXT = /\.(md|ts|tsx|json|jsonc|sql|yml|mjs|css)$/;
function collect(folder, files = {}) {
	for (const name of readdirSync(folder)) {
		const path = join(folder, name);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			if (!SKIPPED_FOLDERS.has(name)) collect(path, files);
		} else if (
			(TEXT.test(name) || (folder === root && /\.yaml$/.test(name))) &&
			name !== "worker-configuration.d.ts" &&
			name !== "pnpm-lock.yaml" &&
			stat.size <= 256 * 1024
		) {
			files[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
		}
	}
	return files;
}

/** Every process's parent and processor time so far, in milliseconds. */
function processes() {
	const out = execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,UserModeTime,KernelModeTime | ConvertTo-Json -Compress",
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	return JSON.parse(out).map((entry) => ({
		pid: entry.ProcessId,
		parent: entry.ParentProcessId,
		name: entry.Name,
		// Both are in units of 100 nanoseconds.
		cpu: (Number(entry.UserModeTime) + Number(entry.KernelModeTime)) / 10_000,
	}));
}

/** The processor time of every workerd that descends from `ancestor`. */
function workerdCpu(ancestor) {
	const all = processes();
	const parents = new Map(all.map((entry) => [entry.pid, entry.parent]));
	const below = (pid) => {
		for (let at = pid, hops = 0; at && hops < 20; at = parents.get(at), hops += 1) {
			if (at === ancestor) return true;
		}
		return false;
	};
	const found = all.filter((entry) => entry.name === "workerd.exe" && below(entry.pid));
	if (found.length === 0) throw new Error("No workerd below the process this script started.");
	return found.reduce((total, entry) => total + entry.cpu, 0);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;

async function get(path, init) {
	const start = performance.now();
	const response = await fetch(`${base}${path}`, init);
	if (!response.ok)
		throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
	return { body: await response.json(), ms: performance.now() - start };
}

const wrangler = join(here, "..", "node_modules", "wrangler", "bin", "wrangler.js");
const child = spawn(
	process.execPath,
	[
		wrangler,
		"dev",
		"--config",
		join(here, "wrangler.jsonc"),
		"--port",
		String(port),
		"--inspector-port",
		String(port + 100),
		// Outside the package: a folder appearing beside the sources made Wrangler start over once,
		// and the stand-in for GitHub keeps its repository in memory.
		"--persist-to",
		join(tmpdir(), `agt-122-measure-${Date.now()}`),
	],
	{ cwd: join(here, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } },
);
let log = "";
child.stdout.on("data", (chunk) => {
	log += chunk;
});
child.stderr.on("data", (chunk) => {
	log += chunk;
});

try {
	for (let tries = 0; ; tries += 1) {
		try {
			if ((await fetch(`${base}/ping`)).ok) break;
		} catch {}
		if (tries > 120) throw new Error(`wrangler dev did not start:\n${log}`);
		await sleep(500);
	}
	const files = collect(root);
	const bytes = Object.values(files).reduce((total, text) => total + Buffer.byteLength(text), 0);
	await get("/seed", { method: "POST", body: JSON.stringify(files) });
	console.log(`Repository: ${Object.keys(files).length} files, ${bytes} bytes.`);

	const stamp = Date.now();
	// The first run of all: the workspace is new, and so is the shell's Dynamic Worker.
	const cold = await get(`/full?name=cold-${stamp}`);
	console.log("\nThe first run in a new runtime (ms):");
	console.log(JSON.stringify({ ...cold.body, seenFromOutside: round(cold.ms) }, null, 1));

	// Each of these is a workspace nobody has used, so each loads the shell anew for its id.
	const idle = workerdCpu(child.pid);
	await sleep(3000);
	const idleRate = (workerdCpu(child.pid) - idle) / 3000;

	const fullBefore = workerdCpu(child.pid);
	const fullStart = performance.now();
	const full = [];
	for (let run = 0; run < RUNS; run += 1)
		full.push((await get(`/full?name=full-${stamp}-${run}`)).body);
	const fullWall = performance.now() - fullStart;
	const fullCpu = workerdCpu(child.pid) - fullBefore - idleRate * fullWall;

	const workBefore = workerdCpu(child.pid);
	const workStart = performance.now();
	const work = [];
	for (let run = 0; run < RUNS; run += 1) work.push((await get(`/work?name=full-${stamp}-0`)).body);
	const workWall = performance.now() - workStart;
	const workCpu = workerdCpu(child.pid) - workBefore - idleRate * workWall;

	const search = [];
	for (let run = 0; run < 5; run += 1)
		search.push((await get(`/search?name=full-${stamp}-0`)).body);

	const stepNames = Object.keys(full[0].steps);
	console.log(`\nMedians of ${RUNS} whole runs, each on a new workspace (ms):`);
	for (const step of stepNames) {
		console.log(
			`  ${String(round(median(full.map((run) => run.steps[step])))).padStart(8)}  ${step}`,
		);
	}
	console.log(
		`  ${String(round(median(full.map((run) => run.toFirstAction)))).padStart(8)}  to the first file read`,
	);
	console.log(
		`  ${String(round(median(full.map((run) => run.total)))).padStart(8)}  the whole run`,
	);
	console.log(
		`  processor time: ${round(fullCpu / RUNS)} ms a run (${round(fullCpu)} ms over ${round(fullWall)} ms)`,
	);

	console.log(
		`\nMedians of ${RUNS} runs of the work alone, on a loaded workspace with a warm shell (ms):`,
	);
	for (const step of Object.keys(work[0].steps)) {
		console.log(
			`  ${String(round(median(work.map((run) => run.steps[step])))).padStart(8)}  ${step}`,
		);
	}
	console.log(`  ${String(round(median(work.map((run) => run.total)))).padStart(8)}  the work`);
	console.log(
		`  processor time: ${round(workCpu / RUNS)} ms a run (${round(workCpu)} ms over ${round(workWall)} ms)`,
	);

	console.log(
		`\nA search of every file, medians of 5 (ms): ${round(median(search.map((run) => run.shell)))} in the shell, ${round(median(search.map((run) => run.host)))} by workspace.fs.grep; ${search[0].shellMatches} and ${search[0].hostMatches} matches.`,
	);
	console.log(`Idle, the runtime used ${round(idleRate * 1000)} ms of processor time a second.`);
} finally {
	// Wrangler's own child, workerd, would outlive a plain kill on Windows.
	try {
		execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	} catch {}
}
