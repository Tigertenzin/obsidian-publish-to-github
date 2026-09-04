import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { PublishToGithubSettings } from "./settings";

const API_ROOT = "https://api.github.com";

export interface ConnectionInfo {
	fullName: string;
	branch: string;
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

	/** Returns the blob SHA of a file on the branch, or null when it does not exist. */
	async getFileSha(path: string): Promise<string | null> {
		const { owner, repo, branch } = this.settings;
		const response = await this.request(
			"GET",
			`/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`
		);

		if (response.status === 404) return null;
		this.assertOk(response, "look up the existing file");

		const sha = response.json?.sha;
		if (typeof sha !== "string") {
			throw new Error(`${path} exists in the repository but is not a file.`);
		}
		return sha;
	}

	async publish(path: string, content: string, message: string): Promise<PublishResult> {
		this.assertConfigured();
		const { owner, repo, branch } = this.settings;

		const sha = await this.getFileSha(path);
		const response = await this.request("PUT", `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
			message,
			content: toBase64(content),
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

/** GitHub's contents API takes base64 of the UTF-8 bytes. */
export function toBase64(content: string): string {
	const bytes = new TextEncoder().encode(content);
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}
