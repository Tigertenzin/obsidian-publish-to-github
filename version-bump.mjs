// Run by `npm version`: copies the new version into manifest.json and records
// which Obsidian version it needs in versions.json, so the git tag npm creates
// always matches what the plugin reports about itself.
import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	console.error("No npm_package_version — run this through `npm version`, not directly.");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(`Set version ${targetVersion} (needs Obsidian ${manifest.minAppVersion}).`);
