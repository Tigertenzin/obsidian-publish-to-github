/** What an embedded file is, which decides how its published embed is written. */
export type MediaKind = "image" | "video" | "audio" | "document";

/** File types Obsidian embeds as media, and that are worth uploading. */
const MEDIA_KINDS: Record<string, MediaKind> = {
	png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
	avif: "image", bmp: "image", svg: "image", ico: "image",
	mp4: "video", webm: "video", mov: "video", ogv: "video",
	mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio",
	pdf: "document",
};

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
	return mediaKind(linkpath) !== null;
}

/** The kind of media a path names, by its extension, or null when it is not media. */
export function mediaKind(path: string): MediaKind | null {
	const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
	return match ? MEDIA_KINDS[match[1]] ?? null : null;
}

export function isExternal(target: string): boolean {
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

export function decodeTarget(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

/** Spans of fenced blocks and inline code, where embeds are just text. */
export function codeRanges(body: string): Array<[number, number]> {
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

	return `${slugOrHash(stem, "attachment")}${extension}`;
}

/**
 * Cleans a name typed in the review window the same way the automatic names are
 * made. Folders are flattened into the name, so an image always lands in its
 * post's folder, and the original file's extension is kept whatever was typed,
 * so the upload is never served as the wrong type. Empty stays empty: that means
 * "leave this embed as written".
 */
export function cleanAttachmentName(typed: string, originalName: string): string {
	const at = originalName.lastIndexOf(".");
	const extension = at === -1 ? "" : originalName.slice(at).toLowerCase();

	let stem = typed.trim();
	if (stem.length === 0) return "";

	// Drop a media extension if one was typed; the original's is put back below.
	// Anything else after a dot, as in "v1.2", is part of the name.
	if (isMedia(stem)) stem = stem.replace(/\.[a-z0-9]+$/i, "");
	return `${slugOrHash(stem, "attachment")}${extension}`;
}

/**
 * The subfolder a post's images are kept in, named after where the post itself
 * is published — so two posts can never share one, and one post's images never
 * overwrite another's. `postPath` is relative to the target folder.
 */
export function postAttachmentFolder(postPath: string): string {
	const segments = postPath.split("/").filter((segment) => segment.length > 0);
	const last = segments.length - 1;
	if (last >= 0) segments[last] = segments[last].replace(/\.[a-z0-9]+$/i, "");

	return segments
		.filter((segment) => segment.length > 0)
		.map((segment) => slugOrHash(segment, "post"))
		.join("/");
}

/**
 * A URL-safe slug. A name with nothing slug-worthy in it, such as one written
 * entirely in a non-Latin script, falls back to a short hash of the original so
 * that two such names still end up apart.
 */
function slugOrHash(text: string, fallback: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length > 0) return slug;
	return text.trim().length > 0 ? `${fallback}-${shortHash(text)}` : fallback;
}

/** FNV-1a, as 8 hex digits: stable across runs, which is all a name needs. */
function shortHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The URL the published markdown points at. */
export function attachmentUrl(prefix: string, fileName: string): string {
	const base = prefix.replace(/\/+$/, "");
	return `${base}/${fileName.replace(/^\/+/, "")}`;
}

/**
 * Renders an embed for the published copy, in the form its kind needs: markdown
 * image syntax only shows images, so video and audio become HTML players and a
 * PDF becomes a link. `alt` is the image's alt text, a player's accessible
 * label, or a PDF's link text. A size is kept when asked to.
 */
export function renderEmbed(alt: string, url: string, width: number | null, style: ImageSizeStyle): string {
	const sized = width !== null && style === "html" ? ` width="${width}"` : "";
	const label = alt.length > 0 ? ` aria-label="${escapeAttribute(alt)}"` : "";

	switch (mediaKind(url)) {
		case "video":
			return `<video src="${escapeAttribute(url)}" controls${sized}${label}></video>`;
		case "audio":
			return `<audio src="${escapeAttribute(url)}" controls${label}></audio>`;
		case "document": {
			const text = alt.length > 0 ? alt : decodeTarget(url.slice(url.lastIndexOf("/") + 1));
			return `[${escapeLinkText(text)}](${url})`;
		}
		default:
			if (sized) return `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}"${sized}>`;
			return `![${escapeLinkText(alt)}](${url})`;
	}
}

function escapeLinkText(text: string): string {
	return text.replace(/([[\]])/g, "\\$1");
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
