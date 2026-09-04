import { MarkdownView, Notice, Plugin, TFile, moment } from "obsidian";
import { GithubClient, type RemoteFile } from "./github";
import { PreviewModal, ReviewModal, type ReviewContext } from "./modals";
import {
	DEFAULT_SETTINGS,
	PublishToGithubSettingTab,
	type PublishToGithubSettings,
} from "./settings";
import {
	applyBreak,
	buildOutput,
	buildTargetPath,
	defaultFileName,
	parseNote,
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
			lookup,
			properties,
			removed,
			breakResult: applyBreak(note.body, this.settings),
			frontmatterError: note.frontmatterError,
		};

		this.openReview(file, note, context);
	}

	private openReview(file: TFile, note: ParsedNote, context: ReviewContext) {
		// The modal edits context.properties in place, so stepping back from the
		// preview reopens the review window with the user's edits still there.
		new ReviewModal(this.app, context, () => {
			void this.openPreview(file, note, context);
		}).open();
	}

	private async openPreview(file: TFile, note: ParsedNote, context: ReviewContext) {
		const output = buildOutput(note, context.properties, this.settings);
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
			// The SHA the diff was built against, so a file that moved on underneath
			// us is rejected rather than clobbered. Undefined means "look it up".
			onPublish: () =>
				this.commit(file, targetPath, output, remoteError ? undefined : remote?.sha ?? null),
		}).open();
	}

	private async commit(file: TFile, targetPath: string, output: string, expectedSha?: string | null) {
		const message = this.commitMessage(file, targetPath);

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

	private commitMessage(file: TFile, targetPath: string): string {
		const template = this.settings.commitMessageTemplate.trim() || DEFAULT_SETTINGS.commitMessageTemplate;
		return template
			.replace(/\{\{filename\}\}/g, file.basename)
			.replace(/\{\{path\}\}/g, targetPath)
			.replace(/\{\{date\}\}/g, moment().format("YYYY-MM-DD"));
	}
}
