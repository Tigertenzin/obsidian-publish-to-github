import { parseYaml, stringifyYaml } from "obsidian";
import type { AddedProperty, PropertyType, PublishToGithubSettings } from "./settings";

export type PropertyValue = string | number | boolean | string[] | null;

/**
 * Types a property can take in the review window. "object" covers nested YAML the
 * inputs cannot represent; those values are passed through untouched.
 */
export type EditableType = PropertyType | "object";

/** Where a property in the review window came from. */
export type PropertyOrigin = "note" | "settings" | "manual";

/** One property of the published copy, as shown and edited in the review window. */
export interface OutgoingProperty {
	key: string;
	type: EditableType;
	/** The edited value, for every type except "object". */
	value: PropertyValue;
	/** The original value, used instead of `value` when the type is "object". */
	rawValue?: unknown;
	origin: PropertyOrigin;
}

export interface ParsedNote {
	frontmatter: Record<string, unknown>;
	/** Note body with the frontmatter block removed. */
	body: string;
	/** Set when a frontmatter block was present but could not be parsed as YAML. */
	frontmatterError: string | null;
}

const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** Splits a note into its frontmatter object and its body. */
export function parseNote(content: string): ParsedNote {
	const match = content.match(FRONTMATTER_PATTERN);
	if (!match) {
		return { frontmatter: {}, body: content, frontmatterError: null };
	}

	const body = content.slice(match[0].length);
	const raw = match[1] ?? "";
	if (raw.trim().length === 0) {
		return { frontmatter: {}, body, frontmatterError: null };
	}

	try {
		const parsed = parseYaml(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { frontmatter: parsed as Record<string, unknown>, body, frontmatterError: null };
		}
		return { frontmatter: {}, body, frontmatterError: "Frontmatter is not a set of properties." };
	} catch (error) {
		return { frontmatter: {}, body, frontmatterError: (error as Error).message };
	}
}

/**
 * Builds the full list of properties the published copy will carry: the note's own
 * properties, with the configured additions applied on top. Properties the settings
 * strip are returned separately so the review window can offer them back.
 *
 * A key that appears in both settings lists is added rather than removed — the add
 * list states a value, so it is the more specific instruction.
 */
export function resolveProperties(
	frontmatter: Record<string, unknown>,
	settings: PublishToGithubSettings
): { properties: OutgoingProperty[]; removed: OutgoingProperty[] } {
	const toRemove = new Set(settings.propertiesToRemove);
	const configured = new Map(
		settings.propertiesToAdd.filter((property) => property.key.length > 0).map((property) => [property.key, property])
	);

	const properties: OutgoingProperty[] = [];
	const removed: OutgoingProperty[] = [];

	// The note's own properties keep their original order.
	for (const [key, value] of Object.entries(frontmatter)) {
		const config = configured.get(key);
		if (config) {
			properties.push(resolveConfigured(config, frontmatter));
		} else if (toRemove.has(key)) {
			removed.push(noteProperty(key, value));
		} else {
			properties.push(noteProperty(key, value));
		}
	}

	// Configured properties the note does not have are appended in settings order.
	for (const [key, config] of configured) {
		if (key in frontmatter) continue;
		properties.push(resolveConfigured(config, frontmatter));
	}

	return { properties, removed };
}

function resolveConfigured(property: AddedProperty, frontmatter: Record<string, unknown>): OutgoingProperty {
	const hasExisting = property.key in frontmatter;
	const value =
		hasExisting && property.keepExistingValue
			? coerceExisting(frontmatter[property.key], property.type)
			: parseValue(property.defaultValue, property.type);

	return {
		key: property.key,
		type: property.type,
		value,
		origin: hasExisting ? "note" : "settings",
	};
}

/** Wraps a value read straight from the note, guessing the type its editor should use. */
export function noteProperty(key: string, value: unknown): OutgoingProperty {
	const type = inferType(value);
	if (type === "object") {
		return { key, type, value: null, rawValue: value, origin: "note" };
	}
	return { key, type, value: coerceExisting(value, type), origin: "note" };
}

/** Picks the editor type that best fits a value already in the note. */
export function inferType(value: unknown): EditableType {
	if (typeof value === "boolean") return "checkbox";
	if (typeof value === "number") return "number";
	if (Array.isArray(value)) {
		return value.every((item) => item === null || typeof item !== "object") ? "list" : "object";
	}
	if (value === null || value === undefined) return "text";
	if (typeof value === "object") return "object";

	const text = String(value);
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return "date";
	if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) return "datetime";
	return "text";
}

/** Re-reads a property's value through a different type, when the user switches it. */
export function convertValue(property: OutgoingProperty, nextType: EditableType): PropertyValue {
	if (property.type === "object" || nextType === "object") return property.value;
	return parseValue(valueToInput(property.value, property.type), nextType);
}

/** Reshapes a value already present in the note so it matches the configured type. */
function coerceExisting(value: unknown, type: PropertyType): PropertyValue {
	if (value === null || value === undefined) {
		return type === "list" ? [] : null;
	}
	if (type === "list") {
		if (Array.isArray(value)) return value.map((item) => String(item));
		return String(value)
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	if (Array.isArray(value)) {
		return parseValue(value.join(", "), type);
	}
	if (type === "number") {
		return typeof value === "number" ? value : parseValue(String(value), type);
	}
	if (type === "checkbox") {
		return typeof value === "boolean" ? value : parseValue(String(value), type);
	}
	return String(value);
}

/** Turns the raw text typed in settings or the review window into a typed value. */
export function parseValue(raw: string, type: PropertyType): PropertyValue {
	const trimmed = raw.trim();

	switch (type) {
		case "number": {
			if (trimmed.length === 0) return null;
			const parsed = Number(trimmed);
			return Number.isNaN(parsed) ? null : parsed;
		}
		case "checkbox":
			return trimmed.toLowerCase() === "true" || trimmed === "1" || trimmed.toLowerCase() === "yes";
		case "list":
			return splitList(raw);
		case "date":
		case "datetime":
		case "text":
		default:
			return trimmed.length === 0 ? null : raw.trim();
	}
}

/** List values are entered one per line, with commas accepted on a single line. */
export function splitList(raw: string): string[] {
	const source = raw.includes("\n") ? raw.split("\n") : raw.split(",");
	return source.map((item) => item.trim()).filter((item) => item.length > 0);
}

/** Renders a typed value back into the text shown in an input field. */
export function valueToInput(value: PropertyValue, type: PropertyType): string {
	if (value === null || value === undefined) return "";
	if (type === "list") return Array.isArray(value) ? value.join("\n") : String(value);
	if (type === "checkbox") return value ? "true" : "false";
	return String(value);
}

/** What the break marker does to a note's body. */
export interface BreakResult {
	/** The body that will be published. */
	body: string;
	trimmed: boolean;
	/** Body line the marker sits on, or -1 when there is none. */
	markerLine: number;
	keptLines: number;
	droppedLines: number;
	/** The content the break keeps out of the published copy. */
	dropped: string;
}

/**
 * Drops everything from the first line that matches the break marker onwards.
 * Reports what was dropped so the review window can show it — the default marker
 * is a horizontal rule, which is easy to use mid-note without meaning to cut.
 */
export function applyBreak(body: string, settings: PublishToGithubSettings): BreakResult {
	const marker = settings.breakMarker.trim();
	const lines = body.split("\n");
	const untouched: BreakResult = {
		body,
		trimmed: false,
		markerLine: -1,
		keptLines: countLines(lines),
		droppedLines: 0,
		dropped: "",
	};

	if (!settings.breakEnabled || marker.length === 0) return untouched;

	const index = lines.findIndex((line) => line.trim() === marker);
	if (index === -1) return untouched;

	const kept = lines.slice(0, index);
	const dropped = lines.slice(index);

	return {
		body: kept.join("\n"),
		trimmed: true,
		markerLine: index,
		keptLines: kept.length,
		droppedLines: countLines(dropped),
		dropped: dropped.join("\n"),
	};
}

/** Counts real lines, ignoring the empty entry a trailing newline leaves behind. */
function countLines(lines: string[]): number {
	return lines.length - (lines.length > 0 && lines[lines.length - 1] === "" ? 1 : 0);
}

/**
 * Builds the markdown that gets published. The property list is the complete set of
 * frontmatter for the published copy — anything the user removed in the review window
 * is simply absent from it — followed by the body up to the break marker.
 */
export function buildOutput(
	note: ParsedNote,
	properties: OutgoingProperty[],
	settings: PublishToGithubSettings
): string {
	const frontmatter: Record<string, unknown> = {};

	for (const property of properties) {
		const key = property.key.trim();
		if (key.length === 0) continue;

		if (property.type === "object") {
			frontmatter[key] = property.rawValue;
			continue;
		}
		// An empty value means "leave the property out" rather than writing null.
		if (property.value === null || (Array.isArray(property.value) && property.value.length === 0)) {
			continue;
		}
		frontmatter[key] = property.value;
	}

	const { body } = applyBreak(note.body, settings);
	const trimmedBody = body.replace(/\s+$/, "");

	if (Object.keys(frontmatter).length === 0) {
		return trimmedBody.length > 0 ? `${trimmedBody}\n` : "";
	}

	const dateKeys = new Set(
		properties.filter((p) => p.type === "date" || p.type === "datetime").map((p) => p.key.trim())
	);
	const yaml = unquoteDates(stringifyYaml(frontmatter), dateKeys).replace(/\s+$/, "");
	const header = `---\n${yaml}\n---\n`;
	return trimmedBody.length > 0 ? `${header}\n${trimmedBody}\n` : header;
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

/**
 * Date properties are carried as strings, and the YAML dumper quotes any string
 * that looks like a date to keep it a string. Frontmatter dates are conventionally
 * written plain, so the quotes are stripped back off the keys the user typed as
 * dates — otherwise every publish shows a spurious change against the live file.
 */
function unquoteDates(yaml: string, dateKeys: Set<string>): string {
	if (dateKeys.size === 0) return yaml;

	return yaml
		.split("\n")
		.map((line) => {
			// Top-level keys only: frontmatter properties are never indented.
			const match = line.match(/^([^\s#][^:]*): (['"])(.+)\2$/);
			if (!match) return line;

			const [, key, , value] = match;
			if (!dateKeys.has(key) || !DATE_LIKE.test(value)) return line;
			return `${key}: ${value}`;
		})
		.join("\n");
}

/** The filename a note is published under before the user edits it. */
export function defaultFileName(vaultPath: string): string {
	return vaultPath.split("/").pop() ?? vaultPath;
}

/**
 * Cleans up a filename typed in the review window. Slashes are kept, so a name
 * can nest the post a level deeper, but the path cannot climb out of the target
 * folder and always ends in .md.
 */
export function normaliseFileName(name: string): string {
	const cleaned = name
		.split("/")
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
		.join("/");

	if (cleaned.length === 0) return "";
	return /\.[a-z0-9]+$/i.test(cleaned) ? cleaned : `${cleaned}.md`;
}

/**
 * Resolves the path the note is written to inside the repository, given the
 * filename as it stands in the review window.
 */
export function buildTargetPath(
	vaultPath: string,
	fileName: string,
	settings: PublishToGithubSettings
): string {
	const sourceName = defaultFileName(vaultPath);
	const vaultFolder = vaultPath.slice(0, Math.max(0, vaultPath.length - sourceName.length));

	const segments = [
		normaliseSegment(settings.targetFolder),
		settings.preserveFolderStructure ? normaliseSegment(vaultFolder) : "",
		normaliseFileName(fileName),
	].filter((segment) => segment.length > 0);

	return segments.join("/");
}

function normaliseSegment(segment: string): string {
	return segment.replace(/^\/+|\/+$/g, "").trim();
}
