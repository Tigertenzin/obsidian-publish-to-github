import { describe, expect, it } from "vitest";
import { convertHighlights, findNoteLinks, noteLinksToText, stripComments } from "../src/syntax";

describe("stripComments", () => {
	it("removes inline comments, and whole-line comments with their lines", () => {
		expect(stripComments("Intro %%aside%% continues.\n%%\nprivate\n%%\nAfter")).toBe("Intro  continues.\nAfter");
	});

	it("leaves code and an unclosed marker alone", () => {
		const body = "`%%no%%`\n```\n%%fenced%%\n```\nUnclosed %% stays";
		expect(stripComments(body)).toBe(body);
	});
});

describe("note links", () => {
	const body = [
		"[[My Other Post]] [[Notes/Deep Note|this note]] [[Post#Setup]] [[#Local heading]]",
		"| [[Note\\|alias]] |",
		"![[Other note]] ![[pic.png|300]]",
		"[read](My%20Other%20Post.md) [ext](https://x.com/a.md) [img](pic.png) [site](/posts/a/)",
		"`[[code link]]`",
	].join("\n");

	it("finds links to notes, but not media, the web, the site or code", () => {
		expect(findNoteLinks(body).map((link) => link.text)).toEqual([
			"My Other Post",
			"this note",
			"Post",
			"Local heading",
			"alias",
			"Other note",
			"read",
		]);
	});

	it("publishes them as plain text", () => {
		expect(noteLinksToText(body).split("\n")).toEqual([
			"My Other Post this note Post Local heading",
			"| alias |",
			"Other note ![[pic.png|300]]",
			"read [ext](https://x.com/a.md) [img](pic.png) [site](/posts/a/)",
			"`[[code link]]`",
		]);
	});
});

describe("convertHighlights", () => {
	const body = "Highlight ==this bit== but not a == b or ==  spaced==. `==code==`";

	it("converts to <mark>, strips, or keeps", () => {
		expect(convertHighlights(body, "mark")).toBe(
			"Highlight <mark>this bit</mark> but not a == b or ==  spaced==. `==code==`"
		);
		expect(convertHighlights(body, "strip")).toBe("Highlight this bit but not a == b or ==  spaced==. `==code==`");
		expect(convertHighlights(body, "keep")).toBe(body);
	});
});
