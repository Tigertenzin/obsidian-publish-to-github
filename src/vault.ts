import type { App } from "obsidian";

/** Property names and values already in use across the vault. */
export interface VaultIndex {
	/** Property names, most widely used first. */
	names: string[];
	/** Distinct values seen for a property name, most common first. */
	valuesFor(name: string): string[];
}

/** Values kept per property, so a free-text field cannot grow without bound. */
const MAX_VALUES_PER_KEY = 200;

/**
 * Reads every note's cached frontmatter to learn which properties the vault
 * actually uses, and what values they take. Metadata is already in memory, so
 * this is a pass over maps rather than any file reading.
 */
export function buildVaultIndex(app: App): VaultIndex {
	const nameCounts = new Map<string, number>();
	const valueCounts = new Map<string, Map<string, number>>();

	for (const file of app.vault.getMarkdownFiles()) {
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) continue;

		for (const [name, value] of Object.entries(frontmatter)) {
			if (name === "position") continue; // Obsidian's own marker, not a property.
			nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);

			let values = valueCounts.get(name);
			if (!values) {
				values = new Map<string, number>();
				valueCounts.set(name, values);
			}
			if (values.size >= MAX_VALUES_PER_KEY) continue;

			for (const item of flatten(value)) {
				values.set(item, (values.get(item) ?? 0) + 1);
			}
		}
	}

	return {
		names: byFrequency(nameCounts),
		valuesFor(name: string): string[] {
			const values = valueCounts.get(name);
			return values ? byFrequency(values) : [];
		},
	};
}

/** Reduces a frontmatter value to the strings worth suggesting. */
function flatten(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) {
		return value.filter((item) => item !== null && typeof item !== "object").map((item) => String(item));
	}
	if (typeof value === "object") return [];

	const text = String(value);
	// Long prose is a value in name only; suggesting it helps nobody.
	return text.length > 0 && text.length <= 120 ? [text] : [];
}

function byFrequency(counts: Map<string, number>): string[] {
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
}
