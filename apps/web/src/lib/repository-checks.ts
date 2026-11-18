import { repositoryChecksInput } from "@gateweave/agents-model";

/**
 * A repository's checks as the form on its page holds them: one command to a line. No server
 * code, so the page reads these too.
 */

/** The commands one to a line, without the blank ones, as the form's text is read. */
export function checksOfText(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/** Why the form's text cannot be saved, in the schema's own words; null when it can. */
export function checksProblem(text: string): string | null {
	const read = repositoryChecksInput.safeParse(checksOfText(text));
	return read.success ? null : (read.error.issues[0]?.message ?? "These checks cannot be saved");
}
