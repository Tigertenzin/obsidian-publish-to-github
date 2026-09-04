/** File types Obsidian embeds as media, and that are worth uploading. */
const MEDIA_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico",
	"mp4", "webm", "mov", "ogv",
	"mp3", "wav", "ogg", "m4a", "flac",
	"pdf",
]);

/** How a size suffix on an embed is carried into the published markdown. */
export type ImageSizeStyle = "html" | "drop";

/** An embed found in a note body. */
export interface Embed {
	/** Offset of the match in the body. */
	index: number;
	length: number;
	raw: string;
	/** Vault link target, without any size suffix or heading anchor. */
	linkpath: string;
	/** Pixel width from a `|450` suffix, when there is one. */
	width: number | null;
	alt: string;
	kind: "wikilink" | "markdown";
}

const WIKILINK_EMBED = /!\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_EMBED = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Finds every embed in a body that points at a file in the vault. Embeds inside
 * code are left alone, as are links to the web and paths already rooted at the
 * site — those are not the plugin's to rewrite.
 */
export function findEmbeds(body: string): Embed[] {
	const skip = codeRanges(body);
	const inCode = (index: number) => skip.some(([start, end]) => index >= start && index < end);
	const embeds: Embed[] = [];

	for (const match of body.matchAll(WIKILINK_EMBED)) {
		const index = match.index ?? 0;
		if (inCode(index)) continue;

		const [linkpath, display] = splitOnce(match[1], "|");
		const target = stripAnchor(linkpath);
		if (!isMedia(target)) continue;

		embeds.push({
			index,
			length: match[0].length,
			raw: match[0],
			linkpath: target,
			width: parseWidth(display),
			// A wikilink embed carries no alt text of its own.
			alt: "",
			kind: "wikilink",
		});
	}

	for (const match of body.matchAll(MARKDOWN_EMBED)) {
		const index = match.index ?? 0;
		if (inCode(index)) continue;

		const target = decodeTarget(match[2]);
		if (isExternal(target) || target.startsWith("/") || !isMedia(target)) continue;

		// Obsidian allows a size after the alt text, as ![alt|250](…).
		const [alt, display] = splitOnce(match[1], "|");
		embeds.push({
			index,
			length: match[0].length,
			raw: match[0],
			linkpath: stripAnchor(target),
			width: parseWidth(display),
			alt,
			kind: "markdown",
		});
	}

	return embeds.sort((a, b) => a.index - b.index);
}

export function isMedia(linkpath: string): boolean {
	const match = linkpath.toLowerCase().match(/\.([a-z0-9]+)$/);
	return match ? MEDIA_EXTENSIONS.has(match[1]) : false;
}

function isExternal(target: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function splitOnce(value: string, separator: string): [string, string | null] {
	const at = value.lastIndexOf(separator);
	return at === -1 ? [value.trim(), null] : [value.slice(0, at).trim(), value.slice(at + 1).trim()];
}

/** Drops a `#heading` or `^block` reference from a link target. */
function stripAnchor(linkpath: string): string {
	return linkpath.replace(/[#^].*$/, "").trim();
}

function parseWidth(display: string | null): number | null {
	if (!display) return null;
	// Obsidian also allows "600x400"; only the width is usable here.
	const match = display.match(/^(\d+)(?:x\d+)?$/);
	return match ? Number(match[1]) : null;
}

function decodeTarget(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

/** Spans of fenced blocks and inline code, where embeds are just text. */
function codeRanges(body: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];

	for (const match of body.matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm)) {
		ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
	}
	for (const match of body.matchAll(/`+[^`\n]*`+/g)) {
		ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
	}

	return ranges;
}

/** Turns a vault filename into one that is safe in a URL. */
export function sanitiseAttachmentName(name: string): string {
	const at = name.lastIndexOf(".");
	const stem = at === -1 ? name : name.slice(0, at);
	const extension = at === -1 ? "" : name.slice(at).toLowerCase();

	const slug = stem
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return `${slug.length > 0 ? slug : "attachment"}${extension}`;
}

/** The URL the published markdown points at. */
export function attachmentUrl(prefix: string, fileName: string): string {
	const base = prefix.replace(/\/+$/, "");
	return `${base}/${fileName.replace(/^\/+/, "")}`;
}

/** Renders an embed for the published copy, keeping its size when asked to. */
export function renderEmbed(alt: string, url: string, width: number | null, style: ImageSizeStyle): string {
	if (width !== null && style === "html") {
		return `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}" width="${width}">`;
	}
	return `![${alt.replace(/([[\]])/g, "\\$1")}](${url})`;
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Applies replacements to a body, right to left so offsets stay valid. */
export function rewriteBody(
	body: string,
	replacements: Array<{ index: number; length: number; text: string }>
): string {
	let out = body;
	for (const item of [...replacements].sort((a, b) => b.index - a.index)) {
		out = out.slice(0, item.index) + item.text + out.slice(item.index + item.length);
	}
	return out;
}
