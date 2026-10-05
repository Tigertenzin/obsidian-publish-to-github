import { moment } from "obsidian";
import { slugOrHash } from "./attachments";

/** What placeholders are filled in from. */
export interface PlaceholderSource {
	/** The note's name, without its extension. */
	title: string;
	/** Extra values for one use, such as the commit message's {{path}}. */
	extra?: Record<string, string>;
	/** The moment dates and times are taken from; now when left out. */
	now?: moment.Moment;
}

const DEFAULT_FORMATS: Record<string, string> = {
	date: "YYYY-MM-DD",
	time: "HH:mm",
	datetime: "YYYY-MM-DDTHH:mm",
};

/**
 * Fills in {{placeholders}}, in one pass so a value is never read as a
 * placeholder in turn:
 *
 * - {{title}} and {{filename}}: the note's name.
 * - {{slug}}: the note's name, URL-safe, as in "my-post".
 * - {{date}}, {{time}}, {{datetime}}: now, as 2026-10-05, 14:30, 2026-10-05T14:30.
 *   Any of them takes a format of its own, as {{date:MMMM D, YYYY}}, written the
 *   way Obsidian writes date formats.
 *
 * A placeholder that is not recognised is left exactly as written.
 */
export function expandPlaceholders(template: string, source: PlaceholderSource): string {
	const now = source.now ?? moment();

	return template.replace(/\{\{\s*([a-z]+)\s*(?::([^}]*))?\}\}/gi, (match, rawName: string, format?: string) => {
		const name = rawName.toLowerCase();

		if (name in DEFAULT_FORMATS) {
			return now.format(format !== undefined && format.trim().length > 0 ? format.trim() : DEFAULT_FORMATS[name]);
		}
		if (format !== undefined) return match;

		switch (name) {
			case "title":
			case "filename":
				return source.title;
			case "slug":
				return slugOrHash(source.title, "post");
			default:
				return source.extra?.[name] ?? match;
		}
	});
}
