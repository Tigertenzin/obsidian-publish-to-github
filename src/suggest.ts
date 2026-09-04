/**
 * A lightweight autocomplete for a text input. Built on plain DOM rather than
 * Obsidian's own input-suggest class, which is not part of the stable API.
 *
 * The list is attached to the document body so it is not clipped by a modal or
 * by the settings pane, and it closes itself when the input loses focus.
 */
export class TextSuggest {
	private listEl: HTMLElement | null = null;
	private items: string[] = [];
	private active = -1;
	private readonly handlers: Array<[string, EventListener]> = [];

	constructor(
		private readonly inputEl: HTMLInputElement,
		/** Candidates for the current value; called each time the list opens. */
		private readonly getSuggestions: (query: string) => string[] | Promise<string[]>,
		private readonly options: { limit?: number; emptyText?: string } = {}
	) {
		this.on("input", () => void this.open());
		this.on("focus", () => void this.open());
		this.on("blur", () => this.close());
		this.on("keydown", (event) => this.onKeyDown(event as KeyboardEvent));
	}

	private on(type: string, handler: EventListener): void {
		this.inputEl.addEventListener(type, handler);
		this.handlers.push([type, handler]);
	}

	/** Detaches every listener and removes the list. Call when the view closes. */
	destroy(): void {
		this.close();
		for (const [type, handler] of this.handlers) {
			this.inputEl.removeEventListener(type, handler);
		}
		this.handlers.length = 0;
	}

	private async open(): Promise<void> {
		const query = this.inputEl.value;
		let candidates: string[];
		try {
			candidates = await this.getSuggestions(query);
		} catch {
			candidates = [];
		}

		// The input may have been closed or detached while the source was loading.
		if (document.activeElement !== this.inputEl) return;

		this.items = filterSuggestions(candidates, query, this.options.limit ?? 12);
		this.active = -1;

		if (this.items.length === 0) {
			this.close();
			return;
		}
		this.render();
	}

	private render(): void {
		if (!this.listEl) {
			this.listEl = document.body.createDiv({ cls: "ptg-suggest" });
			// Chosen on mousedown so the input's blur does not close the list first.
			this.listEl.addEventListener("mousedown", (event) => {
				const target = (event.target as HTMLElement).closest(".ptg-suggest-item");
				if (!target) return;
				event.preventDefault();
				const index = Number(target.getAttribute("data-index"));
				this.choose(index);
			});
		}

		this.listEl.empty();
		this.items.forEach((item, index) => {
			const el = this.listEl!.createDiv({ cls: "ptg-suggest-item", text: item });
			el.setAttribute("data-index", String(index));
			el.toggleClass("is-selected", index === this.active);
		});

		this.position();
	}

	private position(): void {
		if (!this.listEl) return;
		const rect = this.inputEl.getBoundingClientRect();
		this.listEl.style.left = `${rect.left}px`;
		this.listEl.style.top = `${rect.bottom + 2}px`;
		this.listEl.style.width = `${rect.width}px`;
	}

	private close(): void {
		this.listEl?.remove();
		this.listEl = null;
		this.items = [];
		this.active = -1;
	}

	private choose(index: number): void {
		const value = this.items[index];
		if (value === undefined) return;

		this.inputEl.value = value;
		// The owning field listens for input events, not assignment.
		this.inputEl.dispatchEvent(new Event("input"));
		this.close();
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (this.items.length === 0) return;

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				this.active = (this.active + 1) % this.items.length;
				this.render();
				return;
			case "ArrowUp":
				event.preventDefault();
				this.active = (this.active - 1 + this.items.length) % this.items.length;
				this.render();
				return;
			case "Enter":
				if (this.active >= 0) {
					event.preventDefault();
					this.choose(this.active);
				}
				return;
			case "Escape":
				this.close();
				return;
		}
	}
}

/**
 * Ranks candidates against what has been typed: exact prefix first, then any
 * substring. An empty query lists everything, so focusing a blank field browses.
 */
export function filterSuggestions(candidates: string[], query: string, limit: number): string[] {
	const needle = query.trim().toLowerCase();
	const seen = new Set<string>();
	const unique = candidates.filter((item) => {
		const key = item.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	if (needle.length === 0) return unique.slice(0, limit);

	const prefix: string[] = [];
	const contains: string[] = [];

	for (const item of unique) {
		const value = item.toLowerCase();
		// An exact match is not a suggestion; there is nothing left to complete.
		if (value === needle) continue;
		if (value.startsWith(needle)) prefix.push(item);
		else if (value.includes(needle)) contains.push(item);
	}

	return [...prefix, ...contains].slice(0, limit);
}
