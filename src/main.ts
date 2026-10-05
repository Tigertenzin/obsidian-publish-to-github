import { MarkdownView, Notice, Plugin, TFile, moment } from "obsidian";
import {
	attachmentUrl,
	findEmbeds,
	postAttachmentFolder,
	renderEmbed,
	rewriteBody,
	sanitiseAttachmentName,
} from "./attachments";
import { GithubClient, gitBlobSha, type FolderListing, type RemoteFile } from "./github";
import {
	PreviewModal,
	ReviewModal,
	type Attachment,
	type PlannedUpload,
	type ReviewContext,
} from "./modals";
import {
	DEFAULT_SETTINGS,
	PublishToGithubSettingTab,
	type PublishToGithubSettings,
} from "./settings";
import { buildVaultIndex } from "./vault";
import {
	applyBreak,
	buildOutput,
	buildTargetPath,
	defaultFileName,
	parseNote,
	postRelativePath,
	resolveProperties,
	type ParsedNote,
} from "./transform";

export default class PublishToGithubPlugin extends Plugin {
	settings: PublishToGithubSettings = DEFAULT_SETTINGS;
	private client!: GithubClient;

	async onload() {
		await this.loadSettings();
		this.client = new GithubClient(() => this.settings);

		this.addCommand({
			id: "publish-to-github",
			name: "Publish to GitHub",
			checkCallback: (checking: boolean) => {
				const file = this.activeMarkdownFile();
				if (!file) return false;
				if (!checking) void this.startPublish(file);
				return true;
			},
		});

		this.addSettingTab(new PublishToGithubSettingTab(this.app, this));
	}

	github(): GithubClient {
		return this.client;
	}

	async loadSettings() {
		// A deep copy, so the lists the settings tab edits in place are never the
		// defaults' own: a fresh install would otherwise be editing DEFAULT_SETTINGS.
		this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), await this.loadData());

		// Older versions stored the removal list as one newline-joined string.
		const removals = this.settings.propertiesToRemove as unknown;
		if (typeof removals === "string") {
			this.settings.propertiesToRemove = removals
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private activeMarkdownFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.file ?? null;
	}

	/** Reads the note, works out the changes, and opens the review window. */
	private async startPublish(file: TFile) {
		try {
			this.client.assertConfigured();
		} catch (error) {
			new Notice((error as Error).message, 8000);
			return;
		}

		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch (error) {
			new Notice(`Could not read ${file.path}: ${(error as Error).message}`, 8000);
			return;
		}

		const note = parseNote(content);
		const { properties, removed } = resolveProperties(note.frontmatter, this.settings);

		// Embeds are collected from the body that will actually be published, so
		// images sitting below the break are never uploaded.
		const breakResult = applyBreak(note.body, this.settings);
		const attachments = this.collectAttachments(file, breakResult.body);

		// One lookup per path, shared by both windows, so stepping back and forth
		// and retyping a name does not re-query GitHub for a path already seen.
		const lookups = new Map<string, Promise<RemoteFile | null>>();
		const lookup = (path: string): Promise<RemoteFile | null> => {
			const cached = lookups.get(path);
			if (cached) return cached;

			const pending = this.client.getFile(path);
			// The windows report the failure; nothing is unhandled if it rejects.
			pending.catch(() => undefined);
			lookups.set(path, pending);
			return pending;
		};
		const forget = (path: string): void => {
			lookups.delete(path);
		};

		const context: ReviewContext = {
			sourcePath: file.path,
			fileName: defaultFileName(file.path),
			repoLabel: `${this.settings.owner}/${this.settings.repo}`,
			branch: this.settings.branch,
			resolvePath: (fileName) => buildTargetPath(file.path, fileName, this.settings),
			attachmentPath: (attachmentName) => this.attachmentPath(file.path, context.fileName, attachmentName),
			lookup,
			forget,
			properties,
			removed,
			attachments,
			attachmentUrlPrefix: this.settings.attachmentUrlPrefix,
			breakResult,
			frontmatterError: note.frontmatterError,
			index: buildVaultIndex(this.app),
		};

		this.openReview(file, note, context);
	}

	/** Finds the note's embeds and pairs each with the vault file it points at. */
	private collectAttachments(source: TFile, body: string): Attachment[] {
		if (!this.settings.uploadAttachments) return [];

		const taken = new Set<string>();
		// The same image embedded twice is one upload under one name.
		const nameOf = new Map<string, string>();

		return findEmbeds(body).map((embed) => {
			// Resolved the way Obsidian resolves the link itself, so shortest-path
			// names and full vault paths both land on the right file.
			const target = this.app.metadataCache.getFirstLinkpathDest(embed.linkpath, source.path);

			let fileName = "";
			if (target) {
				const known = nameOf.get(target.path);
				if (known !== undefined) {
					fileName = known;
				} else {
					fileName = sanitiseAttachmentName(target.name);
					// Two different images can sanitise to the same name; keep them apart.
					if (taken.has(fileName)) {
						const at = fileName.lastIndexOf(".");
						const stem = at === -1 ? fileName : fileName.slice(0, at);
						const extension = at === -1 ? "" : fileName.slice(at);
						let suffix = 2;
						while (taken.has(`${stem}-${suffix}${extension}`)) suffix++;
						fileName = `${stem}-${suffix}${extension}`;
					}
					taken.add(fileName);
					nameOf.set(target.path, fileName);
				}
			}

			return {
				embed,
				file: target,
				fileName,
				alt: embed.alt,
				size: target?.stat.size ?? 0,
				missing: target === null,
			};
		});
	}

	/**
	 * Works out what each attachment needs before anything is shown: its path in
	 * the repository, its bytes, and whether it is new, changed, or already there
	 * unchanged — so the preview can say exactly what will be committed, and an
	 * unchanged post with unchanged images is recognised as nothing to publish.
	 */
	private async planUploads(context: ReviewContext): Promise<PlannedUpload[]> {
		// One upload per repository path: an image embedded more than once is sent once.
		const unique = new Map<string, Attachment>();
		for (const attachment of context.attachments) {
			if (attachment.file === null || attachment.fileName.length === 0) continue;
			const path = joinPath(this.settings.attachmentFolder, context.attachmentPath(attachment.fileName));
			if (!unique.has(path)) unique.set(path, attachment);
		}

		// What is already there is read one folder at a time — with images grouped
		// by post, one call for the whole publish — rather than downloading each
		// image just to learn its SHA.
		const listings = new Map<string, FolderListing>();
		const remoteSha = async (path: string): Promise<string | null> => {
			const at = path.lastIndexOf("/");
			const folder = at === -1 ? "" : path.slice(0, at);
			const name = path.slice(at + 1);

			let listing = listings.get(folder);
			if (!listing) {
				listing = await this.client.listFiles(folder);
				listings.set(folder, listing);
			}

			const sha = listing.shas.get(name);
			if (sha !== undefined) return sha;
			// Too big a folder to list in full: absent from the list is not proof of absence.
			return listing.complete ? null : (await this.client.getFile(path))?.sha ?? null;
		};

		const plan: PlannedUpload[] = [];
		for (const [path, attachment] of unique) {
			const bytes = await this.app.vault.readBinary(attachment.file as TFile);
			const existing = await remoteSha(path);
			// Without a local hash there is no telling, so it is sent as changed.
			const local = await gitBlobSha(bytes);

			plan.push({
				path,
				fileName: attachment.fileName,
				bytes,
				remoteSha: existing,
				status: existing === null ? "new" : existing === local ? "unchanged" : "changed",
			});
		}
		return plan;
	}

	/**
	 * Commits each planned upload that is new or changed. Runs before the post is
	 * written, so the post never lands referring to an image that failed to upload.
	 */
	private async uploadAttachments(plan: PlannedUpload[], postName: string): Promise<number> {
		const pending = plan.filter((upload) => upload.status !== "unchanged");

		let index = 0;
		for (const upload of pending) {
			index++;
			new Notice(`Uploading attachment ${index} of ${pending.length}: ${upload.fileName}`, 3000);
			// Against the SHA it was compared with, so an image that changed on GitHub
			// since is rejected rather than replaced.
			const verb = upload.status === "new" ? "Add" : "Update";
			await this.client.publishBinary(
				upload.path,
				upload.bytes,
				`${verb} ${upload.fileName} for ${postName}`,
				upload.remoteSha
			);
		}
		return pending.length;
	}

	private openReview(file: TFile, note: ParsedNote, context: ReviewContext) {
		// The modal edits context.properties in place, so stepping back from the
		// preview reopens the review window with the user's edits still there.
		new ReviewModal(this.app, context, () => {
			void this.openPreview(file, note, context);
		}).open();
	}

	/** The note body with every embed rewritten to point at its uploaded copy. */
	private publishedBody(context: ReviewContext): string {
		const replacements = context.attachments
			.filter((attachment) => !attachment.missing && attachment.fileName.length > 0)
			.map((attachment) => ({
				index: attachment.embed.index,
				length: attachment.embed.length,
				text: renderEmbed(
					attachment.alt,
					attachmentUrl(this.settings.attachmentUrlPrefix, context.attachmentPath(attachment.fileName)),
					attachment.embed.width,
					this.settings.imageSizeStyle
				),
			}));

		return rewriteBody(context.breakResult.body, replacements);
	}

	private async openPreview(file: TFile, note: ParsedNote, context: ReviewContext) {
		// The break is already applied to the body the embeds were found in.
		const output = buildOutput({ ...note, body: this.publishedBody(context) }, context.properties, this.settings);
		const targetPath = context.resolvePath(context.fileName);

		let remote: RemoteFile | null = null;
		let remoteError: string | null = null;
		try {
			remote = await context.lookup(targetPath);
		} catch (error) {
			remoteError = (error as Error).message;
		}

		let uploads: PlannedUpload[] | null = null;
		let uploadsError: string | null = null;
		try {
			uploads = await this.planUploads(context);
		} catch (error) {
			uploadsError = (error as Error).message;
		}

		const postUnchanged = remote !== null && !remote.tooLarge && remote.content === output;

		new PreviewModal(this.app, {
			targetPath,
			repoLabel: context.repoLabel,
			branch: this.settings.branch,
			output,
			remote,
			remoteError,
			postUnchanged,
			uploads,
			uploadsError,
			onBack: () => this.openReview(file, note, context),
			// The SHA the diff was built against, so a file that moved on underneath
			// us is rejected rather than clobbered. Undefined means "look it up".
			onPublish: () =>
				this.commit(file, targetPath, output, context, {
					expectedSha: remoteError ? undefined : remote?.sha ?? null,
					postUnchanged,
					uploads,
				}),
		}).open();
	}

	private async commit(
		file: TFile,
		targetPath: string,
		output: string,
		context: ReviewContext,
		options: { expectedSha?: string | null; postUnchanged: boolean; uploads: PlannedUpload[] | null }
	) {
		const message = this.commitMessage(file, targetPath);

		let uploaded: number;
		try {
			// The preview could not check the images: check them now, and stop if it still fails.
			const plan = options.uploads ?? (await this.planUploads(context));
			uploaded = await this.uploadAttachments(plan, file.basename);
		} catch (error) {
			new Notice(
				`Attachment upload failed, so the post was not published: ${(error as Error).message}`,
				10000
			);
			throw error;
		}

		if (options.postUnchanged) {
			new Notice(
				`Uploaded ${uploaded} attachment${uploaded === 1 ? "" : "s"}. ${targetPath} was already up to date, so it was left as is.`,
				6000
			);
			return;
		}

		try {
			const result = await this.client.publish(targetPath, output, message, options.expectedSha);
			new Notice(
				`${result.created ? "Created" : "Updated"} ${targetPath} on ${this.settings.branch}.`,
				6000
			);
		} catch (error) {
			// Whatever is at the path may have moved on; going Back must read it afresh
			// rather than diff and commit against the version that was just rejected.
			context.forget(targetPath);
			new Notice(`Publish failed: ${(error as Error).message}`, 10000);
			throw error;
		}
	}

	/**
	 * Where an image goes, relative to the attachment folder: inside the post's own
	 * subfolder when images are grouped by post, which follows the post's filename
	 * as it currently stands in the review window.
	 */
	private attachmentPath(vaultPath: string, postFileName: string, attachmentName: string): string {
		if (!this.settings.groupAttachmentsByPost) return attachmentName;
		const folder = postAttachmentFolder(postRelativePath(vaultPath, postFileName, this.settings));
		return folder.length > 0 ? `${folder}/${attachmentName}` : attachmentName;
	}

	private commitMessage(file: TFile, targetPath: string): string {
		const template = this.settings.commitMessageTemplate.trim() || DEFAULT_SETTINGS.commitMessageTemplate;
		const values: Record<string, string> = {
			filename: file.basename,
			path: targetPath,
			date: moment().format("YYYY-MM-DD"),
		};
		// A replacer function, not a replacement string: a name like "Cost $& more"
		// must not be read as a replacement pattern.
		return template.replace(/\{\{(filename|path|date)\}\}/g, (_match, key: string) => values[key]);
	}
}

/** Joins a repository folder and a filename, tolerating stray slashes. */
function joinPath(folder: string, name: string): string {
	const base = folder.replace(/^\/+|\/+$/g, "").trim();
	const leaf = name.replace(/^\/+/, "");
	return base.length > 0 ? `${base}/${leaf}` : leaf;
}
