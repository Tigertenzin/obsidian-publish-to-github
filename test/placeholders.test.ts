import moment from "moment";
import { describe, expect, it } from "vitest";
import { expandPlaceholders } from "../src/placeholders";

const now = moment("2026-10-05T14:30:00");
const expand = (template: string, title = "My Post: Part 2!") =>
	expandPlaceholders(template, { title, now, extra: { path: "posts/my-post.md" } });

describe("expandPlaceholders", () => {
	it.each([
		["{{slug}}.md", "my-post-part-2.md"],
		["{{title}}.md", "My Post: Part 2!.md"],
		["{{date}}-{{slug}}.md", "2026-10-05-my-post-part-2.md"],
		["{{date:MMMM D, YYYY}}", "October 5, 2026"],
		["{{ date : YYYY }}", "2026"],
		["{{datetime}}", "2026-10-05T14:30"],
		["{{time}}", "14:30"],
		["Publish {{filename}} to {{path}}", "Publish My Post: Part 2! to posts/my-post.md"],
		["{{unknown}} {{slug:x}}", "{{unknown}} {{slug:x}}"],
	])("fills %j as %j", (template, expected) => {
		expect(expand(template)).toBe(expected);
	});

	it("never reads a value as a placeholder or a replacement pattern", () => {
		expect(expand("{{title}}", "Cost $& more {{date}}")).toBe("Cost $& more {{date}}");
	});
});
