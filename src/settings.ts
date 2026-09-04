import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type { ImageSizeStyle } from "./attachments";
import type PublishToGithubPlugin from "./main";
import { TextSuggest } from "./suggest";
import { buildVaultIndex, type VaultIndex } from "./vault";

/** Property value types, mirroring Obsidian's own property types. */
export type PropertyType = "text" | "number" | "checkbox" | "date" | "datetime" | "list";

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
	text: "Text",
	number: "Number",
	checkbox: "Checkbox",
	date: "Date",
	datetime: "Date & time",
	list: "List",
};

/** A property the plugin writes into the published copy of a note. */
export interface AddedProperty {
	key: string;
	type: PropertyType;
	/** Prefilled in the review window when the note has no value of its own. */
	defaultValue: string;
	/** When the note already has this property, keep its value instead of the default. */
	keepExistingValue: boolean;
}

export interface PublishToGithubSettings {
	// GitHub connection
	owner: string;
	repo: string;
	branch: string;
	token: string;
	targetFolder: string;
	preserveFolderStructure: boolean;
	commitMessageTemplate: string;

	// Property transforms
	propertiesToAdd: AddedProperty[];
	propertiesToRemove: string[];

	// Content transform
	breakEnabled: boolean;
	breakMarker: string;

	// Attachments
	uploadAttachments: boolean;
	attachmentFolder: string;
	attachmentUrlPrefix: string;
	imageSizeStyle: ImageSizeStyle;
}

export const DEFAULT_SETTINGS: PublishToGithubSettings = {
	owner: "",
	repo: "",
	branch: "main",
	token: "",
	targetFolder: "",
	preserveFolderStructure: false,
	commitMessageTemplate: "Publish {{filename}}",

	propertiesToAdd: [],
	propertiesToRemove: [],

	breakEnabled: true,
	breakMarker: "---",

	uploadAttachments: true,
	attachmentFolder: "posts/attachments",
	attachmentUrlPrefix: "/posts/attachments",
	imageSizeStyle: "html",
};

export class PublishToGithubSettingTab extends PluginSettingTab {
	plugin: PublishToGithubPlugin;
	private index: VaultIndex = { names: [], valuesFor: () => [] };
	private suggests: TextSuggest[] = [];
	/** Repository folders, fetched once per settings visit when first needed. */
	private folders: Promise<string[]> | null = null;

	constructor(app: App, plugin: PublishToGithubPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		this.teardownSuggests();
		containerEl.empty();

		this.index = buildVaultIndex(this.app);
		this.folders = null;

		this.renderConnection(containerEl);
		this.renderPropertiesToAdd(containerEl);
		this.renderPropertiesToRemove(containerEl);
		this.renderContentBreak(containerEl);
		this.renderAttachments(containerEl);
	}

	hide(): void {
		this.teardownSuggests();
	}

	private teardownSuggests(): void {
		for (const suggest of this.suggests) suggest.destroy();
		this.suggests.length = 0;
	}

	/** Attaches autocomplete to an input and keeps it for cleanup. */
	private suggest(
		input: HTMLInputElement,
		source: (query: string) => string[] | Promise<string[]>
	): void {
		this.suggests.push(new TextSuggest(input, source));
	}

	/** Folder names in the repository, loaded lazily and reused. */
	private repoFolders(): Promise<string[]> {
		if (!this.folders) {
			this.folders = this.plugin
				.github()
				.listFolders()
				.catch(() => []);
		}
		return this.folders;
	}

	private async save() {
		await this.plugin.saveSettings();
	}

	private renderConnection(containerEl: HTMLElement) {
		new Setting(containerEl).setName("GitHub connection").setHeading();

		new Setting(containerEl)
			.setName("Repository owner")
			.setDesc("GitHub user or organisation that owns the repository.")
			.addText((text) =>
				text
					.setPlaceholder("octocat")
					.setValue(this.plugin.settings.owner)
					.onChange(async (value) => {
						this.plugin.settings.owner = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Repository name")
			.addText((text) =>
				text
					.setPlaceholder("my-blog")
					.setValue(this.plugin.settings.repo)
					.onChange(async (value) => {
						this.plugin.settings.repo = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("Branch the note is committed to.")
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.branch)
					.onChange(async (value) => {
						this.plugin.settings.branch = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc(
				"Fine-grained token with read & write access to the repository's contents. Stored in plain text inside this vault's plugin data — treat the vault accordingly."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("github_pat_…")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.save();
					});
			});

		new Setting(containerEl)
			.setName("Target folder")
			.setDesc(
				"Folder inside the repository to publish into. Focus the field to browse the folders that exist on the branch. Leave empty for the repository root."
			)
			.addText((text) => {
				text
					.setPlaceholder("content/posts")
					.setValue(this.plugin.settings.targetFolder)
					.onChange(async (value) => {
						this.plugin.settings.targetFolder = value.trim();
						await this.save();
					});
				this.suggest(text.inputEl, () => this.repoFolders());
			});

		new Setting(containerEl)
			.setName("Mirror vault folder structure")
			.setDesc("Append the note's folder path inside the vault to the target folder.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.preserveFolderStructure).onChange(async (value) => {
					this.plugin.settings.preserveFolderStructure = value;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Commit message")
			.setDesc("Supports {{filename}}, {{path}} and {{date}}.")
			.addText((text) =>
				text
					.setPlaceholder("Publish {{filename}}")
					.setValue(this.plugin.settings.commitMessageTemplate)
					.onChange(async (value) => {
						this.plugin.settings.commitMessageTemplate = value;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Check that the token can reach the repository and branch.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("Testing…");
					try {
						const info = await this.plugin.github().checkConnection();
						new Notice(`Connected to ${info.fullName} (branch ${info.branch}).`);
					} catch (error) {
						new Notice(`Connection failed: ${(error as Error).message}`, 8000);
					} finally {
						button.setDisabled(false);
						button.setButtonText("Test");
					}
				})
			);
	}

	private renderPropertiesToAdd(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Properties to add")
			.setDesc(
				"Written into the published copy. You confirm or edit each value in the review window before publishing."
			)
			.setHeading()
			.addButton((button) =>
				button
					.setButtonText("Add property")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.propertiesToAdd.push({
							key: "",
							type: "text",
							defaultValue: "",
							keepExistingValue: true,
						});
						await this.save();
						this.display();
					})
			);

		if (this.plugin.settings.propertiesToAdd.length === 0) {
			containerEl.createEl("p", {
				text: "No properties configured yet.",
				cls: "ptg-empty-state",
			});
		}

		this.plugin.settings.propertiesToAdd.forEach((property, index) => {
			const setting = new Setting(containerEl)
				.setClass("ptg-property-row")
				.addText((text) => {
					text
						.setPlaceholder("property name")
						.setValue(property.key)
						.onChange(async (value) => {
							property.key = value.trim();
							await this.save();
						});
					this.suggest(text.inputEl, () => this.index.names);
				})
				.addDropdown((dropdown) => {
					for (const [value, label] of Object.entries(PROPERTY_TYPE_LABELS)) {
						dropdown.addOption(value, label);
					}
					dropdown.setValue(property.type).onChange(async (value) => {
						property.type = value as PropertyType;
						await this.save();
						this.display();
					});
				})
				.addText((text) => {
					text
						.setPlaceholder(defaultValuePlaceholder(property.type))
						.setValue(property.defaultValue)
						.onChange(async (value) => {
							property.defaultValue = value;
							await this.save();
						});
					this.suggest(text.inputEl, () =>
						property.key.length > 0 ? this.index.valuesFor(property.key) : []
					);
				});

			setting.addToggle((toggle) =>
				toggle
					.setTooltip("Keep the note's own value when it already has this property")
					.setValue(property.keepExistingValue)
					.onChange(async (value) => {
						property.keepExistingValue = value;
						await this.save();
					})
			);

			setting.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip("Remove")
					.onClick(async () => {
						this.plugin.settings.propertiesToAdd.splice(index, 1);
						await this.save();
						this.display();
					})
			);
		});

		containerEl.createEl("p", {
			text: "Columns: name · type · default value · keep existing value.",
			cls: "ptg-hint",
		});
	}

	private renderPropertiesToRemove(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Properties to remove")
			.setDesc("Stripped from the published copy when the note carries them.")
			.setHeading()
			.addButton((button) =>
				button
					.setButtonText("Add property")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.propertiesToRemove.push("");
						await this.save();
						this.display();
					})
			);

		if (this.plugin.settings.propertiesToRemove.length === 0) {
			containerEl.createEl("p", {
				text: "No properties configured yet.",
				cls: "ptg-empty-state",
			});
			return;
		}

		this.plugin.settings.propertiesToRemove.forEach((name, index) => {
			new Setting(containerEl)
				.setClass("ptg-property-row")
				.addText((text) => {
					text
						.setPlaceholder("property name")
						.setValue(name)
						.onChange(async (value) => {
							this.plugin.settings.propertiesToRemove[index] = value.trim();
							await this.save();
						});
					text.inputEl.addClass("ptg-remove-input");
					// Suggest what the vault actually uses, minus what is already listed.
					this.suggest(text.inputEl, () =>
						this.index.names.filter(
							(candidate) =>
								candidate === this.plugin.settings.propertiesToRemove[index] ||
								!this.plugin.settings.propertiesToRemove.includes(candidate)
						)
					);
				})
				.addExtraButton((button) =>
					button
						.setIcon("trash-2")
						.setTooltip("Remove")
						.onClick(async () => {
							this.plugin.settings.propertiesToRemove.splice(index, 1);
							await this.save();
							this.display();
						})
				);
		});
	}

	private renderContentBreak(containerEl: HTMLElement) {
		new Setting(containerEl).setName("Content break").setHeading();

		new Setting(containerEl)
			.setName("Trim content after a break")
			.setDesc("Everything from the first break marker onwards is left out of the published copy.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.breakEnabled).onChange(async (value) => {
					this.plugin.settings.breakEnabled = value;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Break marker")
			.setDesc("Matched against a whole line, ignoring surrounding whitespace. Defaults to a horizontal rule.")
			.addText((text) =>
				text
					.setPlaceholder("---")
					.setValue(this.plugin.settings.breakMarker)
					.onChange(async (value) => {
						this.plugin.settings.breakMarker = value;
						await this.save();
					})
			);
	}

	private renderAttachments(containerEl: HTMLElement) {
		new Setting(containerEl).setName("Attachments").setHeading();

		new Setting(containerEl)
			.setName("Upload embedded images")
			.setDesc(
				"Find images embedded in the note, upload them to the repository, and rewrite the embeds to point at the uploaded copies."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.uploadAttachments).onChange(async (value) => {
					this.plugin.settings.uploadAttachments = value;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Attachment folder")
			.setDesc(
				"Folder inside the repository that uploaded images are committed to. Focus the field to browse existing folders."
			)
			.addText((text) => {
				text
					.setPlaceholder("posts/attachments")
					.setValue(this.plugin.settings.attachmentFolder)
					.onChange(async (value) => {
						this.plugin.settings.attachmentFolder = value.trim();
						await this.save();
					});
				this.suggest(text.inputEl, () => this.repoFolders());
			});

		new Setting(containerEl)
			.setName("Attachment URL prefix")
			.setDesc(
				"What the rewritten embeds point at. Usually the attachment folder with a leading slash, since the site serves it from the root."
			)
			.addText((text) =>
				text
					.setPlaceholder("/posts/attachments")
					.setValue(this.plugin.settings.attachmentUrlPrefix)
					.onChange(async (value) => {
						this.plugin.settings.attachmentUrlPrefix = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Image sizes")
			.setDesc(
				"Obsidian writes a size as ![[image.png|450]], which markdown has no way to express."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("html", "Keep, as an <img width> tag")
					.addOption("drop", "Drop, use plain markdown")
					.setValue(this.plugin.settings.imageSizeStyle)
					.onChange(async (value) => {
						this.plugin.settings.imageSizeStyle = value as ImageSizeStyle;
						await this.save();
					})
			);
	}
}

function defaultValuePlaceholder(type: PropertyType): string {
	switch (type) {
		case "number":
			return "0";
		case "checkbox":
			return "false";
		case "date":
			return "2026-09-04";
		case "datetime":
			return "2026-09-04T09:00";
		case "list":
			return "one, two";
		default:
			return "default value";
	}
}
