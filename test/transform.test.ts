import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type StaticSitePublisherSettings } from "../src/settings";
import {
	applyBreak,
	buildOutput,
	buildTargetPath,
	normaliseFileName,
	parseNote,
	resolveProperties,
	type OutgoingProperty,
} from "../src/transform";

const settings = (overrides: Partial<StaticSitePublisherSettings> = {}): StaticSitePublisherSettings => ({
	...structuredClone(DEFAULT_SETTINGS),
	...overrides,
});

describe("parseNote", () => {
	it("closes the frontmatter only on a line of its own", () => {
		const note = parseNote("---\ntitle: Pros---\ntags: [a]\n---\nIntro");
		expect(note.frontmatter).toEqual({ title: "Pros---", tags: ["a"] });
		expect(note.body).toBe("Intro");
	});

	it.each([
		["empty frontmatter", "---\n---\nIntro", {}, "Intro"],
		["CRLF line endings", "---\r\ntitle: A\r\n---\r\nIntro", { title: "A" }, "Intro"],
		["no frontmatter", "Intro\n---\nMore", {}, "Intro\n---\nMore"],
		["frontmatter alone", "---\ntitle: A\n---", { title: "A" }, ""],
	])("handles %s", (_name, content, frontmatter, body) => {
		const note = parseNote(content);
		expect(note.frontmatter).toEqual(frontmatter);
		expect(note.body).toBe(body);
	});

	it("reports frontmatter that is not a set of properties", () => {
		expect(parseNote("---\n- a\n- b\n---\nBody").frontmatterError).not.toBeNull();
	});
});

describe("applyBreak", () => {
	const on = settings({ breakEnabled: true, breakMarker: "---" });

	it.each([
		["a plain break", "Intro\n\n---\nPrivate", 2, []],
		["a heading underline, then a break", "My heading\n---\nText\n\n---\nPrivate", 4, [1]],
		["a marker in a code fence", "Intro\n```yaml\n---\n```\nMore\n\n---\nPrivate", 6, []],
		["a longer closing fence", "~~~~\n---\n~~~~~\nAfter\n\n---\nP", 5, []],
		["a rule after a list item", "- item\n---\nPrivate", 1, []],
		["a rule after a heading", "# Title\n---\nPrivate", 1, []],
		["a rule after another rule", "Title\n---\n---\nPrivate", 2, [1]],
	])("cuts at the right line for %s", (_name, body, markerLine, underlines) => {
		const result = applyBreak(body, on);
		expect(result.markerLine).toBe(markerLine);
		expect(result.headingUnderlines).toEqual(underlines);
	});

	it("does not cut on a heading underline alone, or inside an unclosed fence", () => {
		expect(applyBreak("My heading\n---\nText", on).trimmed).toBe(false);
		expect(applyBreak("Intro\n```\n---\nstill code", on).trimmed).toBe(false);
	});

	it("does nothing when turned off", () => {
		expect(applyBreak("Intro\n\n---\nPrivate", settings({ breakEnabled: false })).trimmed).toBe(false);
	});
});

describe("resolveProperties", () => {
	it("keeps the note's order, strips removals, and appends configured properties", () => {
		const { properties, removed } = resolveProperties(
			{ title: "A", draft: true, tags: ["x"] },
			settings({
				propertiesToRemove: ["draft"],
				propertiesToAdd: [{ key: "layout", type: "text", defaultValue: "post", keepExistingValue: true }],
			})
		);
		expect(properties.map((p) => [p.key, p.value])).toEqual([
			["title", "A"],
			["tags", ["x"]],
			["layout", "post"],
		]);
		expect(removed.map((p) => p.key)).toEqual(["draft"]);
	});

	it("fills placeholders in default values", () => {
		const { properties } = resolveProperties(
			{},
			settings({ propertiesToAdd: [{ key: "slug", type: "text", defaultValue: "{{x}}", keepExistingValue: true }] }),
			(template) => template.replace("{{x}}", "my-post")
		);
		expect(properties[0].value).toBe("my-post");
	});
});

describe("buildOutput", () => {
	const title: OutgoingProperty = { key: "title", type: "text", value: "A", origin: "note" };

	it("puts exactly one blank line between frontmatter and body", () => {
		expect(buildOutput("\n\n\n# T\n", [title])).toBe("---\ntitle: A\n---\n\n# T\n");
	});

	it("keeps indentation on the first line of text", () => {
		expect(buildOutput("\n    code\n", [])).toBe("    code\n");
	});

	it("leaves out empty values", () => {
		const empty: OutgoingProperty = { key: "tags", type: "list", value: [], origin: "note" };
		expect(buildOutput("Body", [title, empty])).toBe("---\ntitle: A\n---\n\nBody\n");
	});
});

describe("filenames and paths", () => {
	it.each([
		["Release 1.2", "Release 1.2.md"],
		["post.MD", "post.MD"],
		["post.mdx", "post.mdx"],
		["foo.txt", "foo.txt.md"],
		["../a/./b", "a/b.md"],
		["", ""],
	])("normalises %j to %j", (name, expected) => {
		expect(normaliseFileName(name)).toBe(expected);
	});

	it("builds the target path, mirroring vault folders when asked", () => {
		const base = { targetFolder: "/content/posts/" };
		expect(buildTargetPath("Blog/My Post.md", "my-post", settings(base))).toBe("content/posts/my-post.md");
		expect(buildTargetPath("Blog/My Post.md", "my-post", settings({ ...base, preserveFolderStructure: true }))).toBe(
			"content/posts/Blog/my-post.md"
		);
	});
});
