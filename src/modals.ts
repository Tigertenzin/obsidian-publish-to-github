import { App, Modal, Setting, TextAreaComponent } from "obsidian";
import type { PropertyType } from "./settings";
import { PROPERTY_TYPE_LABELS } from "./settings";
import { parseValue, valueToInput, type ResolvedProperty } from "./transform";

export interface ReviewContext {
	/** Vault path of the note being published. */
	sourcePath: string;
	/** Path the note will occupy inside the repository. */
	targetPath: string;
	repoLabel: string;
	properties: ResolvedProperty[];
	removed: string[];
	contentTrimmed: boolean;
	frontmatterError: string | null;
}

/** First step: show and adjust the property changes. */
export class ReviewModal extends Modal {
	private readonly properties: ResolvedProperty[];

	constructor(
		app: App,
		private readonly context: ReviewContext,
		private readonly onConfirm: (properties: ResolvedProperty[]) => void
	) {
		super(app);
		// Edited in place so re-opening from the preview keeps the user's edits.
		this.properties = context.properties;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ptg-modal");

		contentEl.createEl("h2", { text: "Publish to GitHub" });

		const summary = contentEl.createDiv({ cls: "ptg-summary" });
		summary.createDiv({ cls: "ptg-summary-row" }).append(
			createLabel("Note"),
			createValue(this.context.sourcePath)
		);
		summary.createDiv({ cls: "ptg-summary-row" }).append(
			createLabel("Destination"),
			createValue(`${this.context.repoLabel} · ${this.context.targetPath}`)
		);

		if (this.context.frontmatterError) {
			contentEl.createDiv({
				cls: "ptg-warning",
				text: `The note's frontmatter could not be read (${this.context.frontmatterError}). It will be replaced by the properties below.`,
			});
		}

		this.renderAddedProperties(contentEl);
		this.renderRemovedProperties(contentEl);

		if (this.context.contentTrimmed) {
			contentEl.createDiv({
				cls: "ptg-note",
				text: "Content after the break marker will be left out of the published copy.",
			});
		}

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Continue to preview")
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm(this.properties);
					})
			);
	}

	private renderAddedProperties(containerEl: HTMLElement) {
		containerEl.createEl("h3", { text: "Properties to write" });

		if (this.properties.length === 0) {
			containerEl.createEl("p", {
				cls: "ptg-empty-state",
				text: "No properties are configured to be added. Set some up in the plugin settings.",
			});
			return;
		}

		for (const property of this.properties) {
			const setting = new Setting(containerEl)
				.setName(property.key)
				.setDesc(
					property.fromNote
						? `${PROPERTY_TYPE_LABELS[property.type]} · from the note`
						: PROPERTY_TYPE_LABELS[property.type]
				);

			this.renderInput(setting, property);
		}

		containerEl.createEl("p", {
			cls: "ptg-hint",
			text: "Leave a field empty to omit that property.",
		});
	}

	private renderInput(setting: Setting, property: ResolvedProperty) {
		const current = valueToInput(property.value, property.type);

		switch (property.type) {
			case "checkbox":
				setting.addToggle((toggle) =>
					toggle.setValue(property.value === true).onChange((value) => {
						property.value = value;
					})
				);
				return;

			case "number":
				setting.addText((text) => {
					text.inputEl.type = "number";
					text.setValue(current).onChange((value) => {
						property.value = parseValue(value, "number");
					});
				});
				return;

			case "list":
				setting.setClass("ptg-list-row").addTextArea((textarea: TextAreaComponent) => {
					textarea.inputEl.rows = 3;
					textarea
						.setPlaceholder("one value per line")
						.setValue(current)
						.onChange((value) => {
							property.value = parseValue(value, "list");
						});
				});
				return;

			case "date":
			case "datetime": {
				const nativeType = property.type === "date" ? "date" : "datetime-local";
				// Only use the picker when the existing value fits its format, so an
				// unusual value from the note is never silently blanked out.
				const fitsPicker = current.length === 0 || matchesNativeFormat(current, property.type);
				setting.addText((text) => {
					if (fitsPicker) text.inputEl.type = nativeType;
					text.setValue(current).onChange((value) => {
						property.value = parseValue(value, property.type);
					});
				});
				return;
			}

			default:
				setting.addText((text) =>
					text.setValue(current).onChange((value) => {
						property.value = parseValue(value, "text");
					})
				);
		}
	}

	private renderRemovedProperties(containerEl: HTMLElement) {
		containerEl.createEl("h3", { text: "Properties to remove" });

		if (this.context.removed.length === 0) {
			containerEl.createEl("p", {
				cls: "ptg-empty-state",
				text: "This note carries none of the properties configured for removal.",
			});
			return;
		}

		const list = containerEl.createEl("ul", { cls: "ptg-removed-list" });
		for (const key of this.context.removed) {
			list.createEl("li", { text: key });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Second step: show the exact markdown that will be committed. */
export class PreviewModal extends Modal {
	constructor(
		app: App,
		private readonly options: {
			targetPath: string;
			repoLabel: string;
			branch: string;
			output: string;
			onBack: () => void;
			onPublish: () => Promise<void>;
		}
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ptg-modal");

		contentEl.createEl("h2", { text: "Preview" });
		contentEl.createDiv({
			cls: "ptg-summary-row",
			text: `${this.options.repoLabel} · ${this.options.branch} · ${this.options.targetPath}`,
		});

		const pre = contentEl.createEl("pre", { cls: "ptg-preview" });
		pre.createEl("code", { text: this.options.output });

		if (this.options.output.trim().length === 0) {
			contentEl.createDiv({
				cls: "ptg-warning",
				text: "The published copy would be empty. Check the break marker and property settings.",
			});
		}

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Back").onClick(() => {
					this.close();
					this.options.onBack();
				})
			)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Publish")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("Publishing…");
						try {
							await this.options.onPublish();
							this.close();
						} finally {
							button.setDisabled(false);
							button.setButtonText("Publish");
						}
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function createLabel(text: string): HTMLElement {
	const el = createSpan({ cls: "ptg-label" });
	el.setText(text);
	return el;
}

function createValue(text: string): HTMLElement {
	const el = createSpan({ cls: "ptg-value" });
	el.setText(text);
	return el;
}

function matchesNativeFormat(value: string, type: PropertyType): boolean {
	return type === "date"
		? /^\d{4}-\d{2}-\d{2}$/.test(value)
		: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value);
}
