import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
	test: {
		// The first call loads a megabyte of shell into a Dynamic Worker.
		testTimeout: 60_000,
		// As in packages/runtime: the cache would hand workerd more than one message can carry.
		fsModuleCache: false,
	},
});
