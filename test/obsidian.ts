// Stands in for the parts of Obsidian's API the tested modules import. Dates use
// the same moment library Obsidian bundles; YAML uses the yaml package, close
// enough for the plugin's own logic, which is what the tests are about.
import moment from "moment";
import { vi } from "vitest";
import { parse, stringify } from "yaml";

export { moment };

export function parseYaml(text: string): unknown {
	return parse(text);
}

export function stringifyYaml(value: unknown): string {
	return stringify(value);
}

/** Every request goes to whatever a test installs with mockImplementation. */
export const requestUrl = vi.fn();

// Base classes the settings module extends or constructs; tests never render them.
export class PluginSettingTab {}
export class Setting {}
export class SecretComponent {}
export class Notice {}
