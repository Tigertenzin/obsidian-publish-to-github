import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { PublishToGithubSettings } from "./settings";

const API_ROOT = "https://api.github.com";

const CONFLICT_MESSAGE =
	"The file changed on GitHub after you reviewed it. Go Back and continue to the preview again to see the latest version before publishing.";

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

/** The files directly inside a repository folder, by name. */
export interface FolderListing {
	/** Git blob SHA of each file, keyed by filename. */
	shas: Map<string, string>;
	/**
	 * False when the folder held more files than GitHub lists in one response, so
	 * a name missing from `shas` may still exist and has to be looked up directly.
	 */
	complete: boolean;
}

/** The contents API lists at most this many entries of a folder. */
const FOLDER_LIST_LIMIT = 1000;

/** One file to commit, and the version of it the user reviewed. */
export interface CommitFile {
	/** Full path inside the repository. */
	path: string;
	/** Text is committed as UTF-8; bytes as they are. */
	content: string | ArrayBuffer;
	/**
	 * SHA of the file the user reviewed, null when nothing was there, or undefined
	 * when it could not be checked and is committed regardless.
	 */
	expectedSha: string | null | undefined;
}

export interface CommitResult {
	commitUrl: string;
	/** Paths that did not exist on the branch before this commit. */
	created: Set<string>;
}

/** How many times a commit is rebuilt when the branch moves on mid-publish. */
const MAX_COMMIT_ATTEMPTS = 3;

export class GithubClient {
	constructor(
		private readonly getSettings: () => PublishToGithubSettings,
		/** The token itself, read from Obsidian's secret storage; null when it is not set. */
		private readonly getToken: () => string | null
	) {}

	private get settings(): PublishToGithubSettings {
		return this.getSettings();
	}

	private get token(): string {
		return this.getToken() ?? "";
	}

	/** The `/repos/owner/name` prefix, with both parts escaped. */
	private get repoRoot(): string {
		const { owner, repo } = this.settings;
		return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	}

	/** Throws a readable error when the connection settings are incomplete. */
	assertConfigured(): void {
		const missing: string[] = [];
		if (!this.settings.owner) missing.push("repository owner");
		if (!this.settings.repo) missing.push("repository name");
		if (!this.settings.branch) missing.push("branch");
		if (!this.settings.tokenSecret && !this.token) missing.push("access token");

		if (missing.length > 0) {
			throw new Error(`Missing ${missing.join(", ")} in the plugin settings.`);
		}
		// Secrets are kept per device, so one chosen elsewhere may not exist here yet.
		if (!this.token) {
			throw new Error(
				`The secret "${this.settings.tokenSecret}" holding the access token is not set on this device. Set it under Personal access token in the plugin settings.`
			);
		}
	}

	async checkConnection(): Promise<ConnectionInfo> {
		this.assertConfigured();
		const { owner, repo, branch } = this.settings;

		const repoResponse = await this.request("GET", this.repoRoot);
		if (repoResponse.status === 404) {
			throw new Error(`Repository ${owner}/${repo} not found, or the token cannot see it.`);
		}
		this.assertOk(repoResponse, "read the repository");

		const branchResponse = await this.request(
			"GET",
			`${this.repoRoot}/branches/${encodePath(branch)}`
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
			`${this.repoRoot}/git/trees/${encodeURIComponent(branch)}?recursive=1`
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

	/**
	 * Reads the file at a path on the branch — or at `ref`, a commit, when given —
	 * or null when nothing is there yet.
	 */
	async getFile(path: string, ref?: string): Promise<RemoteFile | null> {
		this.assertConfigured();

		const response = await this.request(
			"GET",
			`${this.repoRoot}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref ?? this.settings.branch)}`
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
	 * Lists the files directly inside a folder on the branch — or at `ref`, a
	 * commit, when given — with their SHAs, in one call and without downloading any
	 * of them. A folder that does not exist yet lists as empty.
	 */
	async listFiles(folder: string, ref?: string): Promise<FolderListing> {
		this.assertConfigured();

		// The root is "/contents" exactly; GitHub rejects "/contents/" with a 400.
		const endpoint = folder.length > 0 ? `${this.repoRoot}/contents/${encodePath(folder)}` : `${this.repoRoot}/contents`;
		const response = await this.request("GET", `${endpoint}?ref=${encodeURIComponent(ref ?? this.settings.branch)}`);

		if (response.status === 404) return { shas: new Map(), complete: true };
		this.assertOk(response, `list ${folder || "the repository root"}`);

		const json: unknown = response.json;
		if (!Array.isArray(json)) {
			throw new Error(`${folder} exists in the repository but is not a folder.`);
		}

		const shas = new Map<string, string>();
		for (const entry of json) {
			if (entry?.type === "file" && typeof entry.name === "string" && typeof entry.sha === "string") {
				shas.set(entry.name, entry.sha);
			}
		}
		return { shas, complete: json.length < FOLDER_LIST_LIMIT };
	}

	/**
	 * Commits every file in one commit, so a post and its attachments land
	 * together or not at all.
	 *
	 * Each file carries the SHA it was reviewed against — null for "nothing was
	 * there", undefined for "not checked" — and the commit is refused if any of
	 * them has since changed on the branch, instead of overwriting newer work.
	 * Commits that touched only other files are no reason to refuse: when the
	 * branch moves on mid-publish the files are re-checked against its new head
	 * and the commit rebuilt on top of it, a few times before giving up.
	 */
	async commitFiles(
		files: CommitFile[],
		message: string,
		onProgress?: (step: string) => void
	): Promise<CommitResult> {
		this.assertConfigured();
		const { owner, repo, branch } = this.settings;
		const refPath = `${this.repoRoot}/git/refs/heads/${encodePath(branch)}`;

		// Blobs are addressed by content, so they are uploaded once, whatever head
		// the commit ends up on.
		const blobs: Array<{ path: string; sha: string }> = [];
		for (const [index, file] of files.entries()) {
			onProgress?.(`Uploading ${index + 1} of ${files.length}: ${file.path}`);
			blobs.push({ path: file.path, sha: await this.createBlob(file) });
		}

		for (let attempt = 1; ; attempt++) {
			const refResponse = await this.request("GET", `${this.repoRoot}/git/ref/heads/${encodePath(branch)}`);
			if (refResponse.status === 404) {
				throw new Error(`Branch "${branch}" does not exist in ${owner}/${repo}.`);
			}
			this.assertOk(refResponse, "read the branch");
			const head = String(refResponse.json?.object?.sha ?? "");

			const headCommit = await this.request("GET", `${this.repoRoot}/git/commits/${head}`);
			this.assertOk(headCommit, "read the latest commit");
			const baseTree = String(headCommit.json?.tree?.sha ?? "");

			const created = await this.checkExpected(files, head);

			const treeResponse = await this.request("POST", `${this.repoRoot}/git/trees`, {
				base_tree: baseTree,
				tree: blobs.map((blob) => ({ path: blob.path, mode: "100644", type: "blob", sha: blob.sha })),
			});
			this.assertOk(treeResponse, "build the commit");

			const commitResponse = await this.request("POST", `${this.repoRoot}/git/commits`, {
				message,
				tree: treeResponse.json?.sha,
				parents: [head],
			});
			this.assertOk(commitResponse, "create the commit");
			const commitSha = String(commitResponse.json?.sha ?? "");

			const update = await this.request("PATCH", refPath, { sha: commitSha, force: false });
			// Not a fast-forward: something landed on the branch since it was read.
			// Other refusals, such as branch protection, are reported as they are.
			const movedOn =
				update.status === 422 && /fast[- ]forward/i.test(String(update.json?.message ?? ""));
			if (movedOn && attempt < MAX_COMMIT_ATTEMPTS) continue;
			if (movedOn) {
				throw new Error(`The branch "${branch}" kept changing while publishing. Nothing was committed; try again.`);
			}
			this.assertOk(update, "update the branch");

			return {
				commitUrl: String(commitResponse.json?.html_url ?? ""),
				created,
			};
		}
	}

	/**
	 * Confirms each file is still as it was reviewed at `head`, and reports which
	 * paths are new. Throws the conflict error when any has changed.
	 */
	private async checkExpected(files: CommitFile[], head: string): Promise<Set<string>> {
		const listings = new Map<string, FolderListing>();
		const created = new Set<string>();

		for (const file of files) {
			const at = file.path.lastIndexOf("/");
			const folder = at === -1 ? "" : file.path.slice(0, at);
			const name = file.path.slice(at + 1);

			let listing = listings.get(folder);
			if (!listing) {
				listing = await this.listFiles(folder, head);
				listings.set(folder, listing);
			}

			let current = listing.shas.get(name) ?? null;
			// Too big a folder to list in full: absent from the list is not proof of absence.
			if (current === null && !listing.complete) current = (await this.getFile(file.path, head))?.sha ?? null;

			if (file.expectedSha !== undefined && current !== file.expectedSha) {
				throw new Error(CONFLICT_MESSAGE);
			}
			if (current === null) created.add(file.path);
		}
		return created;
	}

	private async createBlob(file: CommitFile): Promise<string> {
		const body =
			typeof file.content === "string"
				? { content: file.content, encoding: "utf-8" }
				: { content: bytesToBase64(new Uint8Array(file.content)), encoding: "base64" };

		const response = await this.request("POST", `${this.repoRoot}/git/blobs`, body);
		this.assertOk(response, `upload ${file.path}`);
		return String(response.json?.sha ?? "");
	}

	private async request(method: string, endpoint: string, body?: unknown): Promise<RequestUrlResponse> {
		return requestUrl({
			url: `${API_ROOT}${endpoint}`,
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			throw: false,
		});
	}

	/**
	 * Strips the token out of text on its way to an error or a notice. GitHub does
	 * not echo the Authorization header, but an intermediary might, and an error
	 * message is the one place plugin text becomes visible and copy-pasteable.
	 */
	private redact(text: string): string {
		const { token } = this;
		// Far shorter than any real token is a typo, and redacting it would only
		// shred ordinary words in the message.
		return token.length >= 8 ? text.split(token).join("[token]") : text;
	}

	private assertOk(response: RequestUrlResponse, action: string): void {
		if (response.status >= 200 && response.status < 300) return;

		const detail = this.redact(String(response.json?.message ?? response.text?.slice(0, 200) ?? ""));
		if (response.status === 401) {
			throw new Error("GitHub rejected the token (401). Check that it is valid and not expired.");
		}
		if (response.status === 403) {
			throw new Error(`GitHub refused the request (403). ${detail}`);
		}
		if (response.status === 409) {
			throw new Error(CONFLICT_MESSAGE);
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
