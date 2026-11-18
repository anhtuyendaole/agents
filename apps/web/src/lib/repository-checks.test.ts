import { CHECK_ONE_LINE } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import { checksOfText, checksProblem } from "./repository-checks";

describe("the form for a repository's checks", () => {
	it("R1: reads one command to a line, without blank lines or the space around each", () => {
		expect(checksOfText("")).toEqual([]);
		expect(checksOfText("  \n\n")).toEqual([]);
		expect(checksOfText("pnpm check\r\n\n  pnpm test  \n")).toEqual(["pnpm check", "pnpm test"]);
	});

	it("R1: says why a list cannot be saved, in the words the server refuses it with", () => {
		expect(checksProblem("pnpm check\npnpm test")).toBeNull();
		expect(checksProblem("")).toBeNull();
		expect(checksProblem("a\nb\nc\nd\ne\nf")).toBe("A repository has at most 5 checks");
		expect(checksProblem("x".repeat(301))).toBe("A check is at most 300 characters");
		// A line break ends a command here, so only another control character is left to refuse.
		expect(checksProblem("pnpm\ttest")).toBe(CHECK_ONE_LINE);
	});
});
