import { createHash } from "node:crypto";
import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubClient, type CommitFile } from "../src/github";
import { DEFAULT_SETTINGS } from "../src/settings";

/**
 * A small in-memory GitHub: commits hold flat trees of path → blob SHA, and the
 * branch points at one of them. Enough of the contents and Git Data APIs for the
 * client's commit logic.
 */
class FakeGithub {
	trees = new Map<string, Record<string, string>>();
	commits = new Map<string, { tree: string; parent: string | null }>();
	head = "";
	protected = false;
	/** Runs just before the branch is moved, to simulate someone else pushing. */
	beforeUpdate: (() => void) | null = null;

	constructor(files: Record<string, string>) {
		this.head = this.addCommit(files, null);
	}

	files(): Record<string, string> {
		return this.trees.get(this.commits.get(this.head)!.tree)!;
	}

	addCommit(files: Record<string, string>, parent: string | null): string {
		const tree = sha(JSON.stringify(files));
		this.trees.set(tree, files);
		const commit = sha(tree + parent + Math.random());
		this.commits.set(commit, { tree, parent });
		return commit;
	}

	push(changes: Record<string, string>): void {
		this.head = this.addCommit({ ...this.files(), ...changes }, this.head);
	}

	handle(method: string, url: string, body: unknown) {
		const [path, query] = url.replace("https://api.github.com/repos/o/r", "").split("?");
		const data = body as Record<string, any>;

		if (method === "POST" && path === "/git/blobs") return ok({ sha: sha(String(data.content)) });
		if (method === "GET" && path === "/git/ref/heads/main") return ok({ object: { sha: this.head } });
		if (method === "GET" && path.startsWith("/git/commits/")) {
			return ok({ tree: { sha: this.commits.get(path.split("/").pop()!)!.tree } });
		}
		if (method === "GET" && path.startsWith("/contents")) {
			const ref = new URLSearchParams(query).get("ref")!;
			const tree = this.trees.get(this.commits.get(ref === "main" ? this.head : ref)!.tree)!;
			const folder = decodeURIComponent(path.replace(/^\/contents\/?/, ""));
			const entries = Object.entries(tree)
				.filter(([p]) => p.slice(0, Math.max(0, p.lastIndexOf("/"))) === folder)
				.map(([p, s]) => ({ type: "file", name: p.slice(p.lastIndexOf("/") + 1), sha: s }));
			return entries.length > 0 ? ok(entries) : { status: 404, json: { message: "Not Found" } };
		}
		if (method === "POST" && path === "/git/trees") {
			const files = { ...this.trees.get(data.base_tree)! };
			for (const entry of data.tree) files[entry.path] = entry.sha;
			const tree = sha(JSON.stringify(files));
			this.trees.set(tree, files);
			return ok({ sha: tree });
		}
		if (method === "POST" && path === "/git/commits") {
			const commit = sha(data.tree + data.parents[0] + data.message);
			this.commits.set(commit, { tree: data.tree, parent: data.parents[0] });
			return ok({ sha: commit, html_url: `https://github.com/o/r/commit/${commit}` });
		}
		if (method === "PATCH" && path === "/git/refs/heads/main") {
			this.beforeUpdate?.();
			if (this.protected) return { status: 422, json: { message: "Protected branch update failed." } };
			if (this.commits.get(data.sha)!.parent !== this.head) {
				return { status: 422, json: { message: "Update is not a fast forward" } };
			}
			this.head = data.sha;
			return ok({});
		}
		return { status: 500, json: { message: `Unhandled ${method} ${path}` } };
	}
}

const sha = (text: string) => createHash("sha1").update(text).digest("hex");
const ok = (json: unknown) => ({ status: 200, json });

let github: FakeGithub;
const client = new GithubClient(
	() => ({ ...DEFAULT_SETTINGS, owner: "o", repo: "r", branch: "main", tokenSecret: "t" }),
	() => "github_pat_test_token"
);
const post = (expectedSha: string | null | undefined, content = "new text"): CommitFile => ({
	path: "posts/hello.md",
	content,
	expectedSha,
});

beforeEach(() => {
	github = new FakeGithub({ "posts/hello.md": sha("old"), "posts/attachments/hello/a.png": sha("img") });
	const fake = async ({ url, method, body }: { url: string; method: string; body?: string }) => {
		const response = github.handle(method, url, body ? JSON.parse(body) : undefined);
		return { ...response, text: JSON.stringify(response.json) };
	};
	vi.mocked(requestUrl).mockImplementation(fake as unknown as typeof requestUrl);
});

describe("commitFiles", () => {
	it("commits the post and its images in a single commit, leaving other files alone", async () => {
		const before = github.head;
		const image: CommitFile = { path: "posts/attachments/hello/b.png", content: new Uint8Array([1, 2, 3]).buffer, expectedSha: null };

		const result = await client.commitFiles([post(sha("old")), image], "Publish hello");

		expect(github.commits.get(github.head)!.parent).toBe(before);
		expect(Object.keys(github.files()).sort()).toEqual([
			"posts/attachments/hello/a.png",
			"posts/attachments/hello/b.png",
			"posts/hello.md",
		]);
		expect([...result.created]).toEqual(["posts/attachments/hello/b.png"]);
		expect(result.commitUrl).toBe(`https://github.com/o/r/commit/${github.head}`);
	});

	it("refuses, committing nothing, when the post changed since it was reviewed", async () => {
		const before = github.head;
		await expect(client.commitFiles([post(sha("stale"))], "x")).rejects.toThrow(/changed on GitHub/);
		expect(github.head).toBe(before);
	});

	it("refuses when a file appeared at a path reviewed as empty", async () => {
		await expect(
			client.commitFiles([{ path: "posts/attachments/hello/a.png", content: "x", expectedSha: null }], "x")
		).rejects.toThrow(/changed on GitHub/);
	});

	it("commits on top of an unrelated push that lands mid-publish", async () => {
		github.beforeUpdate = () => {
			github.beforeUpdate = null;
			github.push({ "README.md": sha("readme") });
		};

		await client.commitFiles([post(sha("old"))], "x");

		expect(github.files()["README.md"]).toBe(sha("readme"));
		expect(github.files()["posts/hello.md"]).toBe(sha("new text"));
	});

	it("refuses when the same post is changed by someone else mid-publish, keeping their version", async () => {
		github.beforeUpdate = () => {
			github.beforeUpdate = null;
			github.push({ "posts/hello.md": sha("theirs") });
		};

		await expect(client.commitFiles([post(sha("old"), "mine")], "x")).rejects.toThrow(/changed on GitHub/);
		expect(github.files()["posts/hello.md"]).toBe(sha("theirs"));
	});

	it("reports branch protection as GitHub words it", async () => {
		github.protected = true;
		await expect(client.commitFiles([post(undefined)], "x")).rejects.toThrow(/Protected branch update failed/);
	});

	it("commits a file whose version could not be checked", async () => {
		await client.commitFiles([post(undefined)], "x");
		expect(github.files()["posts/hello.md"]).toBe(sha("new text"));
	});
});

describe("listFiles", () => {
	it("lists a folder's files with their SHAs, and a missing folder as empty", async () => {
		const listing = await client.listFiles("posts/attachments/hello");
		expect([...listing.shas]).toEqual([["a.png", sha("img")]]);
		expect((await client.listFiles("no/such/folder")).shas.size).toBe(0);
	});
});
