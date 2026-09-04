import { parseYaml, stringifyYaml } from "obsidian";
import type { AddedProperty, PropertyType, PublishToGithubSettings } from "./settings";

export type PropertyValue = string | number | boolean | string[] | null;

/** A property shown in the review window, with the value that will be published. */
export interface ResolvedProperty {
	key: string;
	type: PropertyType;
	value: PropertyValue;
	/** True when the source note already carried this property. */
	fromNote: boolean;
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
 * Applies the configured property rules to a note's frontmatter, producing the list
 * of added properties for the review window and the set of keys that get stripped.
 */
export function resolveProperties(
	frontmatter: Record<string, unknown>,
	settings: PublishToGithubSettings
): { added: ResolvedProperty[]; removed: string[] } {
	const removed = settings.propertiesToRemove.filter((key) => key in frontmatter);

	const added = settings.propertiesToAdd
		.filter((property) => property.key.length > 0)
		.map((property) => resolveProperty(property, frontmatter));

	return { added, removed };
}

function resolveProperty(property: AddedProperty, frontmatter: Record<string, unknown>): ResolvedProperty {
	const hasExisting = property.key in frontmatter;
	if (hasExisting && property.keepExistingValue) {
		return {
			key: property.key,
			type: property.type,
			value: coerceExisting(frontmatter[property.key], property.type),
			fromNote: true,
		};
	}

	return {
		key: property.key,
		type: property.type,
		value: parseValue(property.defaultValue, property.type),
		fromNote: hasExisting,
	};
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

/** Drops everything from the first line that matches the break marker onwards. */
export function applyBreak(body: string, settings: PublishToGithubSettings): { body: string; trimmed: boolean } {
	const marker = settings.breakMarker.trim();
	if (!settings.breakEnabled || marker.length === 0) {
		return { body, trimmed: false };
	}

	const lines = body.split("\n");
	const index = lines.findIndex((line) => line.trim() === marker);
	if (index === -1) {
		return { body, trimmed: false };
	}

	return { body: lines.slice(0, index).join("\n"), trimmed: true };
}

/**
 * Builds the markdown that gets published: source frontmatter minus the removed
 * properties, plus the reviewed values, followed by the body up to the break.
 */
export function buildOutput(
	note: ParsedNote,
	properties: ResolvedProperty[],
	settings: PublishToGithubSettings
): string {
	const frontmatter: Record<string, unknown> = { ...note.frontmatter };

	for (const key of settings.propertiesToRemove) {
		delete frontmatter[key];
	}

	for (const property of properties) {
		if (property.key.length === 0) continue;
		// An empty value means "leave the property out" rather than writing null.
		if (property.value === null || (Array.isArray(property.value) && property.value.length === 0)) {
			delete frontmatter[property.key];
			continue;
		}
		frontmatter[property.key] = property.value;
	}

	const { body } = applyBreak(note.body, settings);
	const trimmedBody = body.replace(/\s+$/, "");

	if (Object.keys(frontmatter).length === 0) {
		return trimmedBody.length > 0 ? `${trimmedBody}\n` : "";
	}

	const yaml = stringifyYaml(frontmatter).replace(/\s+$/, "");
	const header = `---\n${yaml}\n---\n`;
	return trimmedBody.length > 0 ? `${header}\n${trimmedBody}\n` : header;
}

/** Resolves the path the note is written to inside the repository. */
export function buildTargetPath(vaultPath: string, settings: PublishToGithubSettings): string {
	const fileName = vaultPath.split("/").pop() ?? vaultPath;
	const vaultFolder = vaultPath.slice(0, Math.max(0, vaultPath.length - fileName.length));

	const segments = [
		normaliseSegment(settings.targetFolder),
		settings.preserveFolderStructure ? normaliseSegment(vaultFolder) : "",
		fileName,
	].filter((segment) => segment.length > 0);

	return segments.join("/");
}

function normaliseSegment(segment: string): string {
	return segment.replace(/^\/+|\/+$/g, "").trim();
}
