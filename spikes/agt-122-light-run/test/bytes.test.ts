// AGT-122: what the shell and the file tools do to bytes that are not plain UTF-8 text. A
// repository has such files, and a commit made from this workspace would carry whatever they
// became.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const MARK = "﻿";

describe("bytes", () => {
	it("says what happens to a byte order mark and to Windows line ends", async () => {
		const light = env.LIGHT.getByName("bytes");
		const marked = `${MARK}# Marked\r\nsecond\r\n`;
		await light.writeFile("/workspace/marked.md", marked);
		// The shell's `od` prints octal whatever it is asked: 357 273 277 is the mark, 015 a CR.
		const BYTES = "357273277";
		const first = async (label: string) => {
			const octal = await light.rawRun("od -An marked.md | head -1");
			console.log(`AGT-122 bytes ${label}: ${octal.value.stdout.trim()}`);
			return octal.value.stdout.replaceAll(/\s+/g, "");
		};
		expect((await first("as written")).startsWith(BYTES)).toBe(true);

		// The file tools: a read and a write back, as edit_file does.
		const read = await light.readFile("/workspace/marked.md");
		if (!("content" in read.value)) throw new Error(read.value.error);
		const kept = read.value.content.startsWith(MARK);
		console.log(`AGT-122 read_file keeps the mark: ${kept}`);
		await light.writeFile("/workspace/marked.md", read.value.content.replace("second", "2nd"));
		const afterTools = await first("after read_file and write_file");

		// The shell: a command that rewrites the file in place.
		await light.rawRun("sed -i 's/Marked/Edited/' marked.md");
		const afterSed = await first("after sed -i");
		const lines = await light.rawRun("grep -c $'\\r' marked.md");
		console.log(
			`AGT-122 the mark survives: tools ${afterTools.startsWith(BYTES)}, sed ${afterSed.startsWith(BYTES)}; lines that still end in CR: ${lines.value.stdout.trim()}`,
		);
		// The file tools keep the mark, because `LightSandbox.readFile` decodes the bytes itself:
		// `workspace.fs.readFile(path, "utf8")` drops it. The shell reads through that call, so a
		// command that rewrites a file drops the mark, with @cloudflare/computer 0.11.2 and
		// just-bash 3.6.0. If an upgrade changes that, this fails and the note on AGT-122 is out of
		// date.
		expect(kept).toBe(true);
		expect(afterTools.startsWith(BYTES)).toBe(true);
		expect(afterSed.startsWith(BYTES)).toBe(false);
	});
});
