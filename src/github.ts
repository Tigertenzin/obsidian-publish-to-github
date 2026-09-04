import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { PublishToGithubSettings } from "./settings";

const API_ROOT = "https://api.github.com";

export interface ConnectionInfo {
	fullName: string;
	branch: string;
}

/** A file as it currently stands in the repository. */
export interface RemoteFile {
	sha: string;
	content: string;
	/** True when GitHub declined to inline the content because the file is too big. */
	tooLarge: boolean;
}

export interface PublishResult {
	/** True when the file did not exist on the branch before this commit. */
	created: boolean;
	commitUrl: string;
	fileUrl: string;
}

export class GithubClient {
	constructor(private readonly getSettings: () => PublishToGithubSettings) {}

	private get settings(): PublishToGithubSettings {
		return this.getSettings();
	}

	/** Throws a readable error when the connection settings are incomplete. */
	assertConfigured(): void {
		const missing: string[] = [];
		if (!this.settings.owner) missing.push("repository owner");
		if (!this.settings.repo) missing.push("repository name");
		if (!this.settings.branch) missing.push("branch");
		if (!this.settings.token) missing.push("access token");

		if (missing.length > 0) {
			throw new Error(`Missing ${missing.join(", ")} in the plugin settings.`);
		}
	}

	async checkConnection(): Promise<ConnectionInfo> {
		this.assertConfigured();
		const { owner, repo, branch } = this.settings;

		const repoResponse = await this.request("GET", `/repos/${owner}/${repo}`);
		if (repoResponse.status === 404) {
			throw new Error(`Repository ${owner}/${repo} not found, or the token cannot see it.`);
		}
		this.assertOk(repoResponse, "read the repository");

		const branchResponse = await this.request(
			"GET",
			`/repos/${owner}/${repo}/branches/${encodePath(branch)}`
		);
		if (branchResponse.status === 404) {
			throw new Error(`Branch "${branch}" does not exist in ${owner}/${repo}.`);
		}
		this.assertOk(branchResponse, "read the branch");

		return { fullName: repoResponse.json?.full_name ?? `${owner}/${repo}`, branch };
	}

	/**
	 * Every folder on the branch, for the folder pickers in the settings. One
	 * recursive tree call rather than walking the contents API directory by
	 * directory; a repository large enough to truncate returns what fitted.
	 */
	async listFolders(): Promise<string[]> {
		this.assertConfigured();
		const { owner, repo, branch } = this.settings;

		const response = await this.request(
			"GET",
			`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
		);

		if (response.status === 404) {
			throw new Error(`Branch "${branch}" not found in ${owner}/${repo}.`);
		}
		this.assertOk(response, "list the folders in the repository");

		const tree = response.json?.tree;
		if (!Array.isArray(tree)) return [];

		return tree
			.filter((entry) => entry?.type === "tree" && typeof entry.path === "string")
			.map((entry) => entry.path as string)
			.sort((a, b) => a.localeCompare(b));
	}

	/** Reads the file at a path on the branch, or null when nothing is there yet. */
	async getFile(path: string): Promise<RemoteFile | null> {
		this.assertConfigured();
		const { owner, repo, branch } = this.settings;

		const response = await this.request(
			"GET",
			`/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`
		);

		if (response.status === 404) return null;
		this.assertOk(response, "look up the existing file");

		const json = response.json;
		if (typeof json?.sha !== "string") {
			throw new Error(`${path} exists in the repository but is not a file.`);
		}

		// Above roughly 1 MB the contents API returns metadata with no inline body.
		if (json.encoding !== "base64" || typeof json.content !== "string") {
			return { sha: json.sha, content: "", tooLarge: true };
		}

		return { sha: json.sha, content: fromBase64(json.content), tooLarge: false };
	}

	/**
	 * Commits the file. Pass `expectedSha` — the SHA the user was shown a diff
	 * against, or null for "nothing was there" — so GitHub rejects the write if the
	 * file changed in the meantime instead of silently overwriting newer work.
	 */
	async publish(
		path: string,
		content: string,
		message: string,
		expectedSha?: string | null
	): Promise<PublishResult> {
		return this.put(path, toBase64(content), message, expectedSha);
	}

	/** Commits raw bytes — an image or other attachment read from the vault. */
	async publishBinary(
		path: string,
		bytes: ArrayBuffer,
		message: string,
		expectedSha?: string | null
	): Promise<PublishResult> {
		return this.put(path, bytesToBase64(new Uint8Array(bytes)), message, expectedSha);
	}

	private async put(
		path: string,
		base64: string,
		message: string,
		expectedSha?: string | null
	): Promise<PublishResult> {
		this.assertConfigured();
		const { owner, repo, branch } = this.settings;

		const sha = expectedSha === undefined ? (await this.getFile(path))?.sha ?? null : expectedSha;
		const response = await this.request("PUT", `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
			message,
			content: base64,
			branch,
			...(sha ? { sha } : {}),
		});

		this.assertOk(response, "publish the file");

		return {
			created: sha === null,
			commitUrl: response.json?.commit?.html_url ?? "",
			fileUrl: response.json?.content?.html_url ?? "",
		};
	}

	private async request(method: string, endpoint: string, body?: unknown): Promise<RequestUrlResponse> {
		return requestUrl({
			url: `${API_ROOT}${endpoint}`,
			method,
			headers: {
				Authorization: `Bearer ${this.settings.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			throw: false,
		});
	}

	private assertOk(response: RequestUrlResponse, action: string): void {
		if (response.status >= 200 && response.status < 300) return;

		const detail = response.json?.message ?? response.text?.slice(0, 200) ?? "";
		if (response.status === 401) {
			throw new Error("GitHub rejected the token (401). Check that it is valid and not expired.");
		}
		if (response.status === 403) {
			throw new Error(`GitHub refused the request (403). ${detail}`);
		}
		if (response.status === 409) {
			throw new Error("The file changed on GitHub since it was read. Try publishing again.");
		}
		if (response.status === 422) {
			throw new Error(`GitHub could not process the request (422). ${detail}`);
		}
		throw new Error(`Could not ${action} (HTTP ${response.status}). ${detail}`);
	}
}

/** Encodes a repository path without escaping its separators. */
function encodePath(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

/**
 * The SHA git would give these bytes, so an attachment already in the repository
 * unchanged can be recognised and skipped rather than committed again.
 * Returns null where SubtleCrypto is unavailable, meaning "cannot tell".
 */
export async function gitBlobSha(bytes: ArrayBuffer): Promise<string | null> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) return null;

	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	const payload = new Uint8Array(header.length + bytes.byteLength);
	payload.set(header, 0);
	payload.set(new Uint8Array(bytes), header.length);

	try {
		const digest = await subtle.digest("SHA-1", payload);
		return Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	} catch {
		return null;
	}
}

/** Base64 of raw bytes, chunked to stay clear of the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/** Decodes the base64 body GitHub returns for a file. */
export function fromBase64(encoded: string): string {
	const binary = atob(encoded.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

/** GitHub's contents API takes base64 of the UTF-8 bytes. */
export function toBase64(content: string): string {
	return bytesToBase64(new TextEncoder().encode(content));
}
