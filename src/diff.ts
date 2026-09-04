/** One line of a rendered diff. "gap" stands in for a run of unchanged lines. */
export interface DiffLine {
	type: "context" | "add" | "remove" | "gap";
	text: string;
}

export interface DiffResult {
	lines: DiffLine[];
	added: number;
	removed: number;
	/** True when the files match exactly. */
	identical: boolean;
	/**
	 * True when the bytes differ but no line does — a trailing newline or CRLF
	 * endings. Publishing still changes the file, but there is no diff to show.
	 */
	whitespaceOnly: boolean;
	/**
	 * True when the documents were too large to diff line by line and the result
	 * is a whole-file replacement rather than a minimal edit script.
	 */
	coarse: boolean;
}

/** Cells of the LCS table above which a real diff is not worth the memory. */
const MAX_CELLS = 4_000_000;
const CONTEXT_LINES = 3;

/** Line-based diff of two documents, collapsed to changed regions plus context. */
export function diffLines(before: string, after: string): DiffResult {
	if (before === after) {
		return { lines: [], added: 0, removed: 0, identical: true, whitespaceOnly: false, coarse: false };
	}

	const a = splitLines(before);
	const b = splitLines(after);

	// Matching head and tail are common in an edited note; trimming them keeps the
	// table small enough that only genuinely rewritten documents hit the cap.
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;

	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
		tail++;
	}

	const midA = a.slice(head, a.length - tail);
	const midB = b.slice(head, b.length - tail);

	const coarse = midA.length * midB.length > MAX_CELLS;
	const middle = coarse ? replaceAll(midA, midB) : lcsDiff(midA, midB);

	const lines: DiffLine[] = [
		...a.slice(0, head).map(toContext),
		...middle,
		...a.slice(a.length - tail).map(toContext),
	];

	const added = lines.filter((line) => line.type === "add").length;
	const removed = lines.filter((line) => line.type === "remove").length;

	// Nothing to render but gaps: the documents differ only in line endings or a
	// trailing newline, which a line diff cannot show.
	if (added === 0 && removed === 0) {
		return { lines: [], added: 0, removed: 0, identical: false, whitespaceOnly: true, coarse };
	}

	return { lines: collapseContext(lines), added, removed, identical: false, whitespaceOnly: false, coarse };
}

function splitLines(text: string): string[] {
	const normalised = text.replace(/\r\n/g, "\n");
	const lines = normalised.split("\n");
	// A trailing newline produces an empty final entry that is not a real line.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function toContext(text: string): DiffLine {
	return { type: "context", text };
}

function replaceAll(a: string[], b: string[]): DiffLine[] {
	return [
		...a.map((text): DiffLine => ({ type: "remove", text })),
		...b.map((text): DiffLine => ({ type: "add", text })),
	];
}

/** Standard longest-common-subsequence diff over two line arrays. */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);

	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + (j + 1)] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
		}
	}

	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;

	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			lines.push({ type: "context", text: a[i] });
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
			lines.push({ type: "remove", text: a[i] });
			i++;
		} else {
			lines.push({ type: "add", text: b[j] });
			j++;
		}
	}

	while (i < a.length) lines.push({ type: "remove", text: a[i++] });
	while (j < b.length) lines.push({ type: "add", text: b[j++] });

	return lines;
}

/** Replaces long runs of unchanged lines with a single gap marker. */
function collapseContext(lines: DiffLine[], context = CONTEXT_LINES): DiffLine[] {
	const keep = new Array<boolean>(lines.length).fill(false);

	lines.forEach((line, index) => {
		if (line.type === "context") return;
		const from = Math.max(0, index - context);
		const to = Math.min(lines.length - 1, index + context);
		for (let i = from; i <= to; i++) keep[i] = true;
	});

	const out: DiffLine[] = [];
	let skipped = 0;

	const flush = () => {
		if (skipped === 0) return;
		out.push({ type: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
		skipped = 0;
	};

	for (let i = 0; i < lines.length; i++) {
		if (keep[i]) {
			flush();
			out.push(lines[i]);
		} else {
			skipped++;
		}
	}
	flush();

	return out;
}
