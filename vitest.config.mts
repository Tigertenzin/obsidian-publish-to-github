import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// The real "obsidian" package is type definitions only; the app supplies the
		// implementation at runtime. Tests get a small stand-in instead.
		alias: { obsidian: fileURLToPath(new URL("./test/obsidian.ts", import.meta.url)) },
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
