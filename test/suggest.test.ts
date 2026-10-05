import { describe, expect, it } from "vitest";
import { filterSuggestions } from "../src/suggest";

describe("filterSuggestions", () => {
	const candidates = ["Tags", "tags", "category", "status", "post-tags"];

	it("ranks prefixes before substrings, without duplicates or the exact match", () => {
		expect(filterSuggestions(candidates, "ta", 10)).toEqual(["Tags", "status", "post-tags"]);
		expect(filterSuggestions(candidates, "tags", 10)).toEqual(["post-tags"]);
	});

	it("lists everything, up to the limit, for an empty query", () => {
		expect(filterSuggestions(candidates, "", 3)).toEqual(["Tags", "category", "status"]);
	});
});
