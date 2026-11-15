/**
 * AGT-122, a spike: what a run without a container must refuse, and how the model is told.
 *
 * The worker shell is an interpreter with a fixed set of commands, so most of what it cannot do
 * already ends in "command not found". That is the wrong answer for a model: it reads as a typo
 * and invites another spelling. A refusal here names what is missing and says what happens next,
 * and carries `needs`, which the conversation can act on by moving the run to a container.
 *
 * This is a list of names, read from the words that stand where a command can. It is a courtesy
 * to the model and not a wall: `$(echo np)m install` gets past it, and then the shell itself has
 * no `npm` to run. What keeps a command in is the Dynamic Worker, which has nothing else in it.
 */

export type Refusal =
	| { needs: "git"; what: string }
	| { needs: "packages"; what: string }
	| { needs: "runtime"; what: string }
	| { needs: "network"; what: string }
	| { needs: "checks"; what: string }
	| { needs: "program"; what: string };

const NEEDS: Record<string, Refusal["needs"]> = {};
const add = (needs: Refusal["needs"], names: string) => {
	for (const name of names.split(" ")) NEEDS[name] = needs;
};
add("git", "git gh hub");
add("packages", "npm npx pnpm yarn bun bunx corepack pip pip3 pipx uv poetry cargo gem bundle");
add("packages", "composer apt apt-get brew");
add("runtime", "node deno python python3 ruby php java javac go rustc gcc cc clang tsc tsx");
add("runtime", "bash sh zsh docker podman");
add("network", "curl wget ssh scp nc ncat telnet ping dig nslookup");
add("checks", "make just task vitest jest pytest biome eslint prettier playwright turbo nx");
add("checks", "gradle mvn tox ruff mypy");

/** The words that stand where a command can: the first, and each after `|`, `&&`, `||`, `;`. */
function commandWords(line: string): string[] {
	const words: string[] = [];
	for (const part of line.split(/\|\||&&|[|;\n]|\$\(|`/)) {
		const tokens = part.trim().split(/\s+/);
		// `FOO=bar npm test` and `env FOO=bar npm test` run npm.
		let index = 0;
		while (
			index < tokens.length &&
			(/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "") ||
				["env", "time", "exec", "command", "xargs", "nohup", "sudo"].includes(tokens[index] ?? ""))
		) {
			index += 1;
		}
		const word = tokens[index];
		if (word) words.push(word.replace(/^.*\//, ""));
	}
	return words;
}

/** What the command line needs that only a machine has, or null when the shell may try it. */
export function needsMachine(line: string): Refusal | null {
	for (const word of commandWords(line)) {
		const needs = NEEDS[word];
		if (needs) return { needs, what: word };
	}
	return null;
}

const WHY: Record<Refusal["needs"], string> = {
	git: "there is no git here: the repository's files were read through GitHub's API, and your changes become a commit when you call open_pull_request",
	packages: "nothing can be installed here: there is no package manager and no network",
	runtime: "no program can be run here: there is no Node.js, Python or compiler",
	network: "no address can be reached from here",
	checks: "the repository's own checks cannot run here: they need its tools installed",
	program: "this shell has only its built-in commands",
};

/** What the model reads in place of the command's output. */
export function refusalText(refusal: Refusal): string {
	return (
		`\`${refusal.what}\` was not run: ${WHY[refusal.needs]}. ` +
		"This run has files and a small shell: cat, ls, grep, sed, awk, find, head, tail, sort, uniq, wc, diff, cp, mv, rm, mkdir. " +
		"If the work cannot be done without it, call request_machine with the reason, and the run goes on in a Linux machine with the files as you left them; " +
		"otherwise go on with read_file, edit_file, write_file and the commands above."
	);
}
