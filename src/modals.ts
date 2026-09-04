import {
	App,
	ButtonComponent,
	DropdownComponent,
	ExtraButtonComponent,
	Modal,
	Notice,
	Setting,
	TextAreaComponent,
	TextComponent,
	ToggleComponent,
	stringifyYaml,
} from "obsidian";
import { diffLines, type DiffLine, type DiffResult } from "./diff";
import type { RemoteFile } from "./github";
import { PROPERTY_TYPE_LABELS, type PropertyType } from "./settings";
import {
	convertValue,
	parseValue,
	valueToInput,
	type EditableType,
	type OutgoingProperty,
	type PropertyOrigin,
} from "./transform";

const ORIGIN_LABELS: Record<PropertyOrigin, string> = {
	note: "from note",
	settings: "from settings",
	manual: "added here",
};

export interface ReviewContext {
	/** Vault path of the note being published. */
	sourcePath: string;
	/** Path the note will occupy inside the repository. */
	targetPath: string;
	repoLabel: string;
	/** Every property the published copy will carry. Edited in place. */
	properties: OutgoingProperty[];
	/** Properties the settings stripped, offered back for restoring. Edited in place. */
	removed: OutgoingProperty[];
	contentTrimmed: boolean;
	frontmatterError: string | null;
	/** The file already at the target path, looked up once per publish run. */
	remote: Promise<RemoteFile | null>;
}

/**
 * First step: the complete frontmatter of the published copy, laid out for editing.
 * The settings decide what this starts as; everything here can be changed, added
 * to, or dropped for this one publish.
 */
export class ReviewModal extends Modal {
	private listEl!: HTMLElement;
	private removedEl!: HTMLElement;
	/** Key of the row whose name field should take focus after the next render. */
	private focusKeyOf: OutgoingProperty | null = null;

	constructor(
		app: App,
		private readonly context: ReviewContext,
		private readonly onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ptg-modal");

		contentEl.createEl("h2", { text: "Publish to GitHub" });

		const summary = contentEl.createDiv({ cls: "ptg-summary" });
		summary
			.createDiv({ cls: "ptg-summary-row" })
			.append(createLabel("Note"), createValue(this.context.sourcePath));
		summary
			.createDiv({ cls: "ptg-summary-row" })
			.append(createLabel("Destination"), createValue(`${this.context.repoLabel} · ${this.context.targetPath}`));

		if (this.context.frontmatterError) {
			contentEl.createDiv({
				cls: "ptg-warning",
				text: `The note's frontmatter could not be read (${this.context.frontmatterError}). It will be replaced by the properties below.`,
			});
		}

		contentEl.createEl("h3", { text: "Properties" });
		contentEl.createEl("p", {
			cls: "ptg-hint",
			text: "These are the properties the published copy will carry. Editing them here changes only what is sent — the note in your vault is untouched.",
		});
		this.listEl = contentEl.createDiv({ cls: "ptg-property-list" });

		new Setting(contentEl).setClass("ptg-add-row").addButton((button) =>
			button.setButtonText("Add property").onClick(() => {
				const property: OutgoingProperty = { key: "", type: "text", value: null, origin: "manual" };
				this.context.properties.push(property);
				this.focusKeyOf = property;
				this.refresh();
			})
		);

		this.removedEl = contentEl.createDiv();

		this.renderDestinationStatus(contentEl.createDiv({ cls: "ptg-destination" }));

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
						const problem = this.validate();
						if (problem) {
							new Notice(problem, 6000);
							return;
						}
						this.close();
						this.onConfirm();
					})
			);

		this.refresh();
	}

	/** Reports whether the target path is already taken, once GitHub answers. */
	private renderDestinationStatus(container: HTMLElement): void {
		container.setText("Checking the repository…");
		container.addClass("ptg-checking");

		this.context.remote
			.then((remote) => {
				if (!container.isConnected) return;
				container.removeClass("ptg-checking");
				if (remote) {
					container.addClass("ptg-destination-exists");
					container.setText(
						"A file already exists at this path. You will see a diff and a separate confirmation before it is overwritten."
					);
				} else {
					container.setText("Nothing at this path yet — this will create a new file.");
				}
			})
			.catch((error: Error) => {
				if (!container.isConnected) return;
				container.removeClass("ptg-checking");
				container.addClass("ptg-warning");
				container.setText(`Could not check the destination: ${error.message}`);
			});
	}

	private refresh(): void {
		this.renderProperties();
		this.renderRemoved();

		if (this.focusKeyOf) {
			const index = this.context.properties.indexOf(this.focusKeyOf);
			const input = this.listEl.querySelectorAll<HTMLInputElement>(".ptg-key-input")[index];
			input?.focus();
			this.focusKeyOf = null;
		}
	}

	/** Blocks the step forward on duplicate keys, which would silently drop a property. */
	private validate(): string | null {
		const seen = new Set<string>();
		for (const property of this.context.properties) {
			const key = property.key.trim();
			if (key.length === 0) continue;
			if (seen.has(key)) {
				return `Two properties are both named "${key}". Rename or remove one before continuing.`;
			}
			seen.add(key);
		}
		return null;
	}

	private renderProperties(): void {
		this.listEl.empty();

		if (this.context.properties.length === 0) {
			this.listEl.createEl("p", {
				cls: "ptg-empty-state",
				text: "The published copy will have no frontmatter.",
			});
			return;
		}

		this.context.properties.forEach((property, index) => {
			this.renderRow(property, index);
		});
	}

	private renderRow(property: OutgoingProperty, index: number): void {
		const row = this.listEl.createDiv({ cls: "ptg-property" });
		const head = row.createDiv({ cls: "ptg-property-head" });

		const key = new TextComponent(head)
			.setPlaceholder("property name")
			.setValue(property.key)
			.onChange((value) => {
				property.key = value;
			});
		key.inputEl.addClass("ptg-key-input");

		const dropdown = new DropdownComponent(head);
		for (const [value, label] of Object.entries(PROPERTY_TYPE_LABELS)) {
			dropdown.addOption(value, label);
		}
		if (property.type === "object") {
			// Nested YAML has no editor here, so the row is passed through as it stands.
			dropdown.addOption("object", "Nested value");
			dropdown.setDisabled(true);
		}
		dropdown.setValue(property.type).onChange((value) => {
			const nextType = value as EditableType;
			property.value = convertValue(property, nextType);
			property.type = nextType;
			this.refresh();
		});

		head.createSpan({ cls: "ptg-origin", text: ORIGIN_LABELS[property.origin] });

		new ExtraButtonComponent(head)
			.setIcon("trash-2")
			.setTooltip("Leave this property out of the published copy")
			.onClick(() => {
				this.context.properties.splice(index, 1);
				this.refresh();
			});

		this.renderValue(row.createDiv({ cls: "ptg-property-value" }), property);
	}

	private renderValue(container: HTMLElement, property: OutgoingProperty): void {
		if (property.type === "object") {
			const pre = container.createEl("pre", { cls: "ptg-object-value" });
			pre.createEl("code", { text: stringifyYaml(property.rawValue ?? null).trimEnd() });
			return;
		}

		const current = valueToInput(property.value, property.type);

		switch (property.type) {
			case "checkbox":
				new ToggleComponent(container).setValue(property.value === true).onChange((value) => {
					property.value = value;
				});
				return;

			case "number": {
				const text = new TextComponent(container).setValue(current).onChange((value) => {
					property.value = parseValue(value, "number");
				});
				text.inputEl.type = "number";
				text.inputEl.addClass("ptg-value-input");
				return;
			}

			case "list": {
				const textarea = new TextAreaComponent(container)
					.setPlaceholder("one value per line")
					.setValue(current)
					.onChange((value) => {
						property.value = parseValue(value, "list");
					});
				textarea.inputEl.rows = 3;
				textarea.inputEl.addClass("ptg-value-input");
				return;
			}

			case "date":
			case "datetime": {
				const type = property.type;
				// Only use the native picker when the value fits its format, so an
				// unusual value from the note is never silently blanked out.
				const fitsPicker = current.length === 0 || matchesNativeFormat(current, type);
				const text = new TextComponent(container).setValue(current).onChange((value) => {
					property.value = parseValue(value, type);
				});
				if (fitsPicker) text.inputEl.type = type === "date" ? "date" : "datetime-local";
				text.inputEl.addClass("ptg-value-input");
				return;
			}

			default: {
				const text = new TextComponent(container).setValue(current).onChange((value) => {
					property.value = parseValue(value, "text");
				});
				text.inputEl.addClass("ptg-value-input");
			}
		}
	}

	private renderRemoved(): void {
		this.removedEl.empty();

		if (this.context.removed.length === 0) return;

		this.removedEl.createEl("h3", { text: "Removed by settings" });
		this.removedEl.createEl("p", {
			cls: "ptg-hint",
			text: "Present in the note, stripped from the published copy. Restore one to publish it this time.",
		});

		this.context.removed.forEach((property, index) => {
			const row = this.removedEl.createDiv({ cls: "ptg-removed-row" });
			row.createSpan({ cls: "ptg-removed-key", text: property.key });
			row.createSpan({
				cls: "ptg-removed-value",
				text: property.type === "object" ? "nested value" : valueToInput(property.value, property.type),
			});

			new ExtraButtonComponent(row)
				.setIcon("rotate-ccw")
				.setTooltip("Restore this property")
				.onClick(() => {
					this.context.removed.splice(index, 1);
					this.context.properties.push(property);
					this.refresh();
				});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface PreviewOptions {
	targetPath: string;
	repoLabel: string;
	branch: string;
	output: string;
	/** The file currently at the target path, or null when the path is free. */
	remote: RemoteFile | null;
	/** Set when the destination lookup failed, so the diff could not be built. */
	remoteError: string | null;
	onBack: () => void;
	onPublish: () => Promise<void>;
}

/**
 * Second step: the exact markdown that will be committed. When something is already
 * at the target path it opens on a diff against that file, and publishing goes
 * through a separate overwrite confirmation.
 */
export class PreviewModal extends Modal {
	private readonly diff: DiffResult | null;
	private view: "diff" | "document";
	private bodyEl!: HTMLElement;

	constructor(app: App, private readonly options: PreviewOptions) {
		super(app);

		const remote = options.remote;
		this.diff = remote && !remote.tooLarge ? diffLines(remote.content, options.output) : null;
		// Default to whichever view answers the question the user actually has.
		this.view = hasLineChanges(this.diff) ? "diff" : "document";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ptg-modal");

		const overwriting = this.options.remote !== null;
		contentEl.createEl("h2", { text: overwriting ? "Review changes" : "Preview" });
		contentEl.createDiv({
			cls: "ptg-summary-row",
			text: `${this.options.repoLabel} · ${this.options.branch} · ${this.options.targetPath}`,
		});

		this.renderStatus(contentEl);
		this.renderViewSwitch(contentEl);
		this.bodyEl = contentEl.createDiv();
		this.renderBody();
		this.renderButtons(contentEl, overwriting);
	}

	private renderStatus(contentEl: HTMLElement): void {
		if (this.options.remoteError) {
			contentEl.createDiv({
				cls: "ptg-warning",
				text: `The destination could not be checked (${this.options.remoteError}). Publishing may overwrite an existing file without showing you a diff.`,
			});
			return;
		}

		if (!this.options.remote) {
			contentEl.createDiv({ cls: "ptg-note", text: "This will create a new file." });
			return;
		}

		if (this.options.remote.tooLarge) {
			contentEl.createDiv({
				cls: "ptg-warning",
				text: "A file already exists here but is too large for GitHub to return inline, so it cannot be diffed. Publishing will replace it.",
			});
			return;
		}

		if (this.diff?.identical) {
			contentEl.createDiv({
				cls: "ptg-note",
				text: "The published copy is identical to the file already in the repository — there is nothing to change.",
			});
			return;
		}

		if (this.diff?.whitespaceOnly) {
			contentEl.createDiv({
				cls: "ptg-note",
				text: "No line differs from the file in the repository — only its line endings or trailing newline. Publishing will still rewrite the file.",
			});
			return;
		}

		const stats = contentEl.createDiv({ cls: "ptg-warning" });
		stats.setText("This will overwrite the file already at this path. ");
		stats.createSpan({ cls: "ptg-stat-add", text: `+${this.diff?.added ?? 0}` });
		stats.createSpan({ text: " " });
		stats.createSpan({ cls: "ptg-stat-remove", text: `−${this.diff?.removed ?? 0}` });

		if (this.diff?.coarse) {
			contentEl.createDiv({
				cls: "ptg-hint",
				text: "The documents differ too much to match up line by line, so the whole file is shown as replaced.",
			});
		}
	}

	private renderViewSwitch(contentEl: HTMLElement): void {
		if (!hasLineChanges(this.diff)) return;

		const switcher = contentEl.createDiv({ cls: "ptg-view-switch" });
		const options: Array<{ id: "diff" | "document"; label: string }> = [
			{ id: "diff", label: "Changes" },
			{ id: "document", label: "Full document" },
		];

		for (const option of options) {
			const button = switcher.createEl("button", { text: option.label });
			button.toggleClass("is-active", this.view === option.id);
			button.onclick = () => {
				this.view = option.id;
				switcher.findAll("button").forEach((el) => el.removeClass("is-active"));
				button.addClass("is-active");
				this.renderBody();
			};
		}
	}

	private renderBody(): void {
		this.bodyEl.empty();

		if (this.view === "diff" && hasLineChanges(this.diff)) {
			this.renderDiff(this.bodyEl);
			return;
		}

		const pre = this.bodyEl.createEl("pre", { cls: "ptg-preview" });
		pre.createEl("code", { text: this.options.output });

		if (this.options.output.trim().length === 0) {
			this.bodyEl.createDiv({
				cls: "ptg-warning",
				text: "The published copy would be empty. Check the break marker and property settings.",
			});
		}
	}

	private renderDiff(container: HTMLElement): void {
		const pre = container.createEl("pre", { cls: "ptg-preview ptg-diff" });

		for (const line of this.diff?.lines ?? []) {
			pre.createDiv({ cls: `ptg-diff-line ptg-diff-${line.type}`, text: diffLineText(line) });
		}
	}

	private renderButtons(contentEl: HTMLElement, overwriting: boolean): void {
		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Back").onClick(() => {
					this.close();
					this.options.onBack();
				})
			)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => {
				button.setButtonText(overwriting ? "Overwrite…" : "Publish").setCta();
				if (overwriting) button.setWarning();
				button.onClick(() => {
					if (!overwriting) {
						void this.runPublish(button);
						return;
					}
					new ConfirmOverwriteModal(this.app, {
						targetPath: this.options.targetPath,
						repoLabel: this.options.repoLabel,
						branch: this.options.branch,
						diff: this.diff,
						onConfirm: async () => {
							await this.options.onPublish();
							this.close();
						},
					}).open();
				});
			});
	}

	private async runPublish(button: ButtonComponent): Promise<void> {
		button.setDisabled(true);
		button.setButtonText("Publishing…");
		try {
			await this.options.onPublish();
			this.close();
		} finally {
			button.setDisabled(false);
			button.setButtonText("Publish");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Third step, only when a file is being replaced: confirm the overwrite. */
export class ConfirmOverwriteModal extends Modal {
	constructor(
		app: App,
		private readonly options: {
			targetPath: string;
			repoLabel: string;
			branch: string;
			diff: DiffResult | null;
			onConfirm: () => Promise<void>;
		}
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ptg-modal");

		contentEl.createEl("h2", { text: "Overwrite this file?" });

		contentEl.createEl("p", {
			text: `${this.options.targetPath} in ${this.options.repoLabel} on branch ${this.options.branch} will be replaced by the version you just reviewed.`,
		});

		const diff = this.options.diff;
		if (hasLineChanges(diff)) {
			const stats = contentEl.createEl("p", { cls: "ptg-summary-row" });
			stats.createSpan({ cls: "ptg-stat-add", text: `+${diff.added}` });
			stats.createSpan({ text: " " });
			stats.createSpan({ cls: "ptg-stat-remove", text: `−${diff.removed}` });
			stats.createSpan({ text: " lines" });
		}

		contentEl.createEl("p", {
			cls: "ptg-hint",
			text: "The commit will be rejected if the file has changed on GitHub since it was read.",
		});

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Overwrite")
					.setWarning()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("Publishing…");
						try {
							await this.options.onConfirm();
							this.close();
						} finally {
							button.setDisabled(false);
							button.setButtonText("Overwrite");
						}
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** True when the diff has something worth rendering as added and removed lines. */
function hasLineChanges(diff: DiffResult | null): diff is DiffResult {
	return diff !== null && !diff.identical && !diff.whitespaceOnly;
}

function diffLineText(line: DiffLine): string {
	switch (line.type) {
		case "add":
			return `+ ${line.text}`;
		case "remove":
			return `- ${line.text}`;
		case "gap":
			return `⋯ ${line.text}`;
		default:
			return `  ${line.text}`;
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
