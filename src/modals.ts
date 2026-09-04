import {
	App,
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
