/**
 * AGT-122, a spike. The repository the measurements run on is this one: every text file of its
 * source, as Vite reads them from disk when the tests start. A few hundred files and a few
 * megabytes, which is the size of repository the issue is about.
 */
const found = import.meta.glob<string>(
	[
		"../../../**/*.{md,ts,tsx,json,jsonc,sql,yml,mjs,css}",
		"../../../*.{md,json,jsonc,yaml}",
		"!../../../**/node_modules/**",
		"!../../../**/.wrangler/**",
		"!../../../**/.tanstack/**",
		"!../../../**/.output/**",
		"!../../../**/dist/**",
		"!../../../**/test-results/**",
		"!../../../**/playwright-report/**",
		"!../../../**/worker-configuration.d.ts",
		"!../../../pnpm-lock.yaml",
	],
	{ query: "?raw", import: "default", eager: true },
);

/** Where this file is, from the repository's root: the glob's keys are relative to it. */
const HERE = "https://repository.invalid/spikes/agt-122-light-run/test/";

/** The repository's files by their path from its root. */
export const repositoryFiles: Record<string, string> = Object.fromEntries(
	Object.entries(found).map(([path, text]) => [new URL(path, HERE).pathname.slice(1), text]),
);

export function fixtureSize(): { files: number; bytes: number } {
	const encoder = new TextEncoder();
	let bytes = 0;
	for (const text of Object.values(repositoryFiles)) bytes += encoder.encode(text).length;
	return { files: Object.keys(repositoryFiles).length, bytes };
}
