import { codeRanges, decodeTarget, isExternal, isMedia } from "./attachments";

/** How links to other notes are published. */
export type NoteLinkStyle = "text" | "keep";

/** How `==highlights==` are published. */
export type HighlightStyle = "mark" | "strip" | "keep";

/** A link to another note, and the plain text it is published as. */
export interface NoteLink {
	/** The link as written in the note. */
	raw: string;
	/** What replaces it. */
	text: string;
}

const COMMENT = /%%[\s\S]*?%%/g;
const WIKILINK = /(!?)\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// Obsidian only highlights when the text hugs the markers, so "a == b" is left alone.
const HIGHLIGHT = /==(?=\S)([^\n]*?\S)==/g;

/**
 * Removes Obsidian comments, inline or spanning lines. A comment that fills its
 * lines entirely takes the lines with it rather than leaving blanks behind.
 */
export function stripComments(body: string): string {
	return replaceOutsideCode(body, COMMENT, (match, index, source) => {
		const startsLine = index === 0 || source[index - 1] === "\n";
		const end = index + match.length;
		const endsLine = end === source.length || source[end] === "\n";
		return { text: "", swallowNewline: startsLine && endsLine };
	});
}

/** Every link to another note — wikilinks, note embeds, and markdown links to .md files. */
export function findNoteLinks(body: string): NoteLink[] {
	const links: NoteLink[] = [];
	replaceOutsideCode(body, WIKILINK, (match, _index, _source, groups) => {
		const link = wikilinkText(groups[0], groups[1]);
		if (link !== null) links.push({ raw: match, text: link });
		return null;
	});
	replaceOutsideCode(body, MARKDOWN_LINK, (match, _index, _source, groups) => {
		const text = markdownLinkText(groups[1], groups[2]);
		if (text !== null) links.push({ raw: match, text });
		return null;
	});
	return links;
}

/** Turns every link to another note into its plain text. */
export function noteLinksToText(body: string): string {
	const wikilinks = replaceOutsideCode(body, WIKILINK, (_match, _index, _source, groups) => {
		const text = wikilinkText(groups[0], groups[1]);
		return text === null ? null : { text };
	});
	return replaceOutsideCode(wikilinks, MARKDOWN_LINK, (_match, _index, _source, groups) => {
		const text = markdownLinkText(groups[1], groups[2]);
		return text === null ? null : { text };
	});
}

/** Rewrites `==highlights==` as `<mark>` tags, or drops the markers. */
export function convertHighlights(body: string, style: HighlightStyle): string {
	if (style === "keep") return body;
	return replaceOutsideCode(body, HIGHLIGHT, (_match, _index, _source, groups) => ({
		text: style === "mark" ? `<mark>${groups[0]}</mark>` : groups[0],
	}));
}

/**
 * The text a wikilink stands for, or null when it is not a link to a note — a
 * media embed, which the attachment handling owns.
 */
function wikilinkText(bang: string, inner: string): string | null {
	// Inside a table the alias pipe is escaped as "\|".
	const pipe = inner.search(/\\?\|/);
	const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
	const alias = pipe === -1 ? "" : inner.slice(pipe).replace(/^\\?\|/, "").trim();

	const path = target.replace(/[#^].*$/, "").trim();
	if (bang === "!" && isMedia(path)) return null;

	if (alias.length > 0) return alias;
	return linkLabel(target);
}

/** The text of a markdown link to a note in the vault, or null for any other link. */
function markdownLinkText(text: string, href: string): string | null {
	const target = decodeTarget(href);
	if (isExternal(target) || target.startsWith("/") || target.startsWith("#")) return null;
	if (!/\.md$/i.test(target.replace(/[#^].*$/, ""))) return null;
	return text.trim().length > 0 ? text : linkLabel(target);
}

/** What a bare link target reads as: the note's name, or the heading of a link within the note. */
function linkLabel(target: string): string {
	const hash = target.search(/[#^]/);
	const path = (hash === -1 ? target : target.slice(0, hash)).trim();
	const name = path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
	if (name.length > 0) return name;
	// A link to a heading in this same note, as in [[#Setup]].
	return target.slice(hash + 1).replace(/^\^/, "").trim();
}

/**
 * Runs a replacement over every match that does not start inside code. The
 * callback returns the replacement, or null to leave the match as it is.
 */
function replaceOutsideCode(
	body: string,
	pattern: RegExp,
	replace: (
		match: string,
		index: number,
		source: string,
		groups: string[]
	) => { text: string; swallowNewline?: boolean } | null
): string {
	const skip = codeRanges(body);
	const inCode = (index: number) => skip.some(([start, end]) => index >= start && index < end);

	let out = "";
	let last = 0;
	for (const match of body.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (inCode(index)) continue;

		const result = replace(match[0], index, body, match.slice(1));
		if (result === null) continue;

		let end = index + match[0].length;
		if (result.swallowNewline && body[end] === "\n") end++;
		out += body.slice(last, index) + result.text;
		last = end;
	}
	return out + body.slice(last);
}
