import { describe, expect, it } from "vitest";
import {
	attachmentUrl,
	cleanAttachmentName,
	findEmbeds,
	mediaKind,
	postAttachmentFolder,
	renderEmbed,
	rewriteBody,
	sanitiseAttachmentName,
} from "../src/attachments";

describe("findEmbeds", () => {
	it("finds wikilink and markdown embeds of media, with sizes and alt text", () => {
		const embeds = findEmbeds("![[Pasted image 1.png|450]]\n![A chart|300](charts/a%20b.png)");
		expect(embeds).toMatchObject([
			{ kind: "wikilink", linkpath: "Pasted image 1.png", width: 450, alt: "" },
			{ kind: "markdown", linkpath: "charts/a b.png", width: 300, alt: "A chart" },
		]);
	});

	it("leaves notes, web links, site paths and code alone", () => {
		const body = [
			"![[Some note]]",
			"![x](https://example.com/a.png)",
			"![x](/posts/a.png)",
			"`![[inline.png]]`",
			"```",
			"![[fenced.png]]",
			"```",
		].join("\n");
		expect(findEmbeds(body)).toEqual([]);
	});
});

describe("attachment names", () => {
	it("slugs vault names, keeping a lowercase extension", () => {
		expect(sanitiseAttachmentName("Pasted image 1.PNG")).toBe("pasted-image-1.png");
	});

	it("gives names with nothing URL-safe a stable hash instead of a shared placeholder", () => {
		const a = sanitiseAttachmentName("画像.png");
		const b = sanitiseAttachmentName("写真.png");
		expect(a).toMatch(/^attachment-[0-9a-f]{8}\.png$/);
		expect(b).not.toBe(a);
		expect(sanitiseAttachmentName("画像.png")).toBe(a);
	});

	it.each([
		["My Diagram", "my-diagram.png"],
		["photo.jpg", "photo.png"],
		["diagrams/flow", "diagrams-flow.png"],
		["../../etc/passwd", "etc-passwd.png"],
		["v1.2", "v1-2.png"],
		["  ", ""],
	])("cleans the typed name %j to %j, keeping the original extension", (typed, expected) => {
		expect(cleanAttachmentName(typed, "Pasted image 1.PNG")).toBe(expected);
	});

	it.each([
		["My Post.md", "my-post"],
		["2024/My Post.md", "2024/my-post"],
		["Blog/Drafts/Hello, World!.md", "blog/drafts/hello-world"],
		["", ""],
	])("puts the images of %j in the folder %j", (postPath, folder) => {
		expect(postAttachmentFolder(postPath)).toBe(folder);
	});
});

describe("renderEmbed", () => {
	const url = "/posts/attachments/my-post/";

	it("writes images as markdown, or as a sized <img> when asked", () => {
		expect(renderEmbed("A [chart]", `${url}chart.png`, null, "html")).toBe(
			"![A \\[chart\\]](/posts/attachments/my-post/chart.png)"
		);
		expect(renderEmbed("Chart", `${url}chart.png`, 450, "html")).toBe(
			'<img src="/posts/attachments/my-post/chart.png" alt="Chart" width="450">'
		);
		expect(renderEmbed("Chart", `${url}chart.png`, 450, "drop")).toBe("![Chart](/posts/attachments/my-post/chart.png)");
	});

	it("writes video and audio as players, and a PDF as a link", () => {
		expect(renderEmbed("", `${url}clip.mp4`, 640, "html")).toBe(
			'<video src="/posts/attachments/my-post/clip.mp4" controls width="640"></video>'
		);
		expect(renderEmbed('Demo "run"', `${url}song.mp3`, null, "html")).toBe(
			'<audio src="/posts/attachments/my-post/song.mp3" controls aria-label="Demo &quot;run&quot;"></audio>'
		);
		expect(renderEmbed("", `${url}annual-report.pdf`, null, "html")).toBe(
			"[annual-report.pdf](/posts/attachments/my-post/annual-report.pdf)"
		);
	});

	it("knows each kind by extension", () => {
		expect(["a.PNG", "a.webm", "a.flac", "a.pdf", "a.md"].map(mediaKind)).toEqual([
			"image",
			"video",
			"audio",
			"document",
			null,
		]);
	});
});

describe("helpers", () => {
	it("joins a URL prefix and a name without doubling slashes", () => {
		expect(attachmentUrl("/posts/attachments/", "/a.png")).toBe("/posts/attachments/a.png");
	});

	it("rewrites a body right to left so offsets stay valid", () => {
		const body = "a ![[x.png]] b ![[y.png]] c";
		const embeds = findEmbeds(body);
		const out = rewriteBody(
			body,
			embeds.map((embed, i) => ({ index: embed.index, length: embed.length, text: `[${i}]` }))
		);
		expect(out).toBe("a [0] b [1] c");
	});
});
