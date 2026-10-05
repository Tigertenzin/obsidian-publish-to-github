import { describe, expect, it } from "vitest";
import { diffLines } from "../src/diff";

describe("diffLines", () => {
	it("recognises identical documents, and ones differing only in line endings", () => {
		expect(diffLines("a\nb\n", "a\nb\n").identical).toBe(true);
		expect(diffLines("a\nb\n", "a\r\nb").whitespaceOnly).toBe(true);
	});

	it("reports changed lines with context, collapsing long unchanged runs", () => {
		const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const after = before.replace("line 10", "line ten");
		const diff = diffLines(before, after);

		expect([diff.added, diff.removed]).toEqual([1, 1]);
		expect(diff.lines.filter((line) => line.type === "gap").map((line) => line.text)).toEqual([
			"7 unchanged lines",
			"6 unchanged lines",
		]);
	});
});
