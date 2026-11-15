// AGT-122, question 1: does the worker shell run under the app's compatibility date and flags?
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const workspace = (name: string) => env.LIGHT.getByName(name);

describe("the worker shell under the app's compatibility date", () => {
	it("writes a file and reads it back through the shell", async () => {
		const light = workspace("smoke");
		const written = await light.writeFile("/workspace/docs/hello.md", "# Hello\n\nA line.\n");
		expect(written.value).toEqual({ written: 17 });
		const cat = await light.run("cat docs/hello.md && ls docs | wc -l");
		expect(cat.value).toMatchObject({ exitCode: 0, timedOut: false });
		expect(cat.value.output).toBe("# Hello\n\nA line.\n1\n");
	});

	it("keeps what a command wrote for the file tools", async () => {
		const light = workspace("smoke-2");
		await light.writeFile("/workspace/a.txt", "one\ntwo\n");
		const sed = await light.run("sed -i 's/two/three/' a.txt && grep -n three a.txt");
		expect(sed.value.output).toBe("2:three\n");
		expect((await light.readFile("/workspace/a.txt")).value).toEqual({ content: "one\nthree\n" });
	});
});
