import { MarkdownView, Notice, Plugin, TFile, moment } from "obsidian";
import {
	attachmentUrl,
	findEmbeds,
	postAttachmentFolder,
	renderEmbed,
	rewriteBody,
	sanitiseAttachmentName,
} from "./attachments";
import { GithubClient, gitBlobSha, type RemoteFile } from "./github";
import { PreviewModal, ReviewModal, type Attachment, type ReviewContext } from "./modals";
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

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

		const context: ReviewContext = {
			sourcePath: file.path,
			fileName: defaultFileName(file.path),
			repoLabel: `${this.settings.owner}/${this.settings.repo}`,
			branch: this.settings.branch,
			resolvePath: (fileName) => buildTargetPath(file.path, fileName, this.settings),
			attachmentPath: (attachmentName) => this.attachmentPath(file.path, context.fileName, attachmentName),
			lookup,
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
	 * Uploads each attachment that is not already in the repository unchanged.
	 * Runs before the post is written, so the post never lands referring to an
	 * image that failed to upload.
	 */
	private async uploadAttachments(context: ReviewContext, postName: string): Promise<void> {
		// One upload per repository path: an image embedded more than once is sent once.
		const uploads = new Map<string, Attachment>();
		for (const attachment of context.attachments) {
			if (attachment.file === null || attachment.fileName.length === 0) continue;
			const path = joinPath(this.settings.attachmentFolder, context.attachmentPath(attachment.fileName));
			if (!uploads.has(path)) uploads.set(path, attachment);
		}
		if (uploads.size === 0) return;

		let index = 0;
		for (const [path, attachment] of uploads) {
			index++;
			const bytes = await this.app.vault.readBinary(attachment.file as TFile);

			const existing = await this.client.getFile(path).catch(() => null);
			const localSha = await gitBlobSha(bytes);
			if (existing && localSha && existing.sha === localSha) {
				continue;
			}

			new Notice(`Uploading attachment ${index} of ${uploads.size}: ${attachment.fileName}`, 3000);
			await this.client.publishBinary(
				path,
				bytes,
				`Add ${attachment.fileName} for ${postName}`,
				existing?.sha ?? null
			);
		}
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

		new PreviewModal(this.app, {
			targetPath,
			repoLabel: context.repoLabel,
			branch: this.settings.branch,
			output,
			remote,
			remoteError,
			onBack: () => this.openReview(file, note, context),
			attachments: context.attachments,
			attachmentPath: context.attachmentPath,
			// The SHA the diff was built against, so a file that moved on underneath
			// us is rejected rather than clobbered. Undefined means "look it up".
			onPublish: () =>
				this.commit(
					file,
					targetPath,
					output,
					context,
					remoteError ? undefined : remote?.sha ?? null
				),
		}).open();
	}

	private async commit(
		file: TFile,
		targetPath: string,
		output: string,
		context: ReviewContext,
		expectedSha?: string | null
	) {
		const message = this.commitMessage(file, targetPath);

		try {
			await this.uploadAttachments(context, file.basename);
		} catch (error) {
			new Notice(
				`Attachment upload failed, so the post was not published: ${(error as Error).message}`,
				10000
			);
			throw error;
		}

		try {
			const result = await this.client.publish(targetPath, output, message, expectedSha);
			new Notice(
				`${result.created ? "Created" : "Updated"} ${targetPath} on ${this.settings.branch}.`,
				6000
			);
		} catch (error) {
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
		return template
			.replace(/\{\{filename\}\}/g, file.basename)
			.replace(/\{\{path\}\}/g, targetPath)
			.replace(/\{\{date\}\}/g, moment().format("YYYY-MM-DD"));
	}
}

/** Joins a repository folder and a filename, tolerating stray slashes. */
function joinPath(folder: string, name: string): string {
	const base = folder.replace(/^\/+|\/+$/g, "").trim();
	const leaf = name.replace(/^\/+/, "");
	return base.length > 0 ? `${base}/${leaf}` : leaf;
}
