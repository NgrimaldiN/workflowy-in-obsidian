// Outline data model + Markdown (nested list) parser/serializer.
// Pure module: no Obsidian imports, so it can be unit-tested with plain Node.

export interface FNode {
	id: string;
	text: string;
	note: string;
	children: FNode[];
	parent: FNode | null;
	collapsed: boolean;
	completed: boolean;
	/** Item was written as a Markdown task (`- [ ]`). Rendered with a checkbox instead of a dot. */
	checkbox: boolean;
}

export interface OutlineDoc {
	frontmatter: string;
	root: FNode;
	/** True when the source contained content that will be rewritten on save (headings, paragraphs…). */
	lossy: boolean;
}

let seq = 0;
export function newId(): string {
	seq = (seq + 1) % 1e9;
	return "n" + seq.toString(36) + Math.random().toString(36).slice(2, 7);
}

export function createNode(text = "", parent: FNode | null = null): FNode {
	return { id: newId(), text, note: "", children: [], parent, collapsed: false, completed: false, checkbox: false };
}

// ---------------------------------------------------------------- parsing

const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TASK_RE = /^\[([ xX])\](?:[ \t]+(.*))?$/;
const ESCAPED_NOTE_RE = /^\\(?=([-*+]|\d{1,9}[.)])([ \t]|$))/;

function indentWidth(line: string): number {
	let w = 0;
	for (const ch of line) {
		if (ch === " ") w += 1;
		else if (ch === "\t") w += 4;
		else break;
	}
	return w;
}

export function parseOutline(src: string): OutlineDoc {
	let body = src.replace(/\r\n?/g, "\n");
	let frontmatter = "";
	const fm = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(body);
	if (fm) {
		frontmatter = fm[0].endsWith("\n") ? fm[0] : fm[0] + "\n";
		body = body.slice(fm[0].length);
	}

	const root = createNode("");
	root.id = "root";
	const stack: { node: FNode; indent: number }[] = [{ node: root, indent: -1 }];
	let lossy = false;
	let pendingBlank = 0;
	let lastNoteTarget: FNode | null = null;

	for (const line of body.split("\n")) {
		if (line.trim() === "") {
			pendingBlank++;
			continue;
		}
		const ind = indentWidth(line);
		const m = LIST_RE.exec(line);
		if (m) {
			while (stack.length > 1 && stack[stack.length - 1].indent >= ind) stack.pop();
			const parent = stack[stack.length - 1].node;
			const node = createNode("", parent);
			let rest = m[3] ?? "";
			const task = TASK_RE.exec(rest);
			if (task) {
				node.checkbox = true;
				node.completed = task[1] !== " ";
				rest = task[2] ?? "";
			}
			if (/^\d/.test(m[2])) lossy = true; // numbered lists become bullets
			node.text = rest.replace(/[ \t]+$/, "");
			parent.children.push(node);
			stack.push({ node, indent: ind });
			lastNoteTarget = null;
			pendingBlank = 0;
			continue;
		}

		// Not a list line: a note (continuation) of the deepest item indented less than it…
		let i = stack.length - 1;
		while (i > 0 && stack[i].indent >= ind) i--;
		const content = line.trim().replace(ESCAPED_NOTE_RE, "");
		if (i > 0) {
			const target = stack[i].node;
			stack.length = i + 1;
			if (target.note) {
				target.note += "\n" + (lastNoteTarget === target ? "\n".repeat(pendingBlank) : "") + content;
			} else {
				target.note = content;
			}
			lastNoteTarget = target;
		} else {
			// …or top-level prose: it becomes a top-level item.
			lossy = true;
			stack.length = 1;
			const node = createNode(content, root);
			root.children.push(node);
			stack.push({ node, indent: ind });
			lastNoteTarget = null;
		}
		pendingBlank = 0;
	}
	return { frontmatter, root, lossy };
}

// ---------------------------------------------------------------- serializing

function serializeInto(out: string[], nodes: FNode[], depth: number) {
	const ind = "\t".repeat(depth);
	for (const n of nodes) {
		const box = n.completed ? "[x] " : n.checkbox ? "[ ] " : "";
		out.push(`${ind}- ${box}${n.text}`);
		if (n.note) {
			for (const l of n.note.split("\n")) {
				if (l.trim() === "") out.push("");
				else out.push(`${ind}  ${LIST_RE.test(l.trim()) ? "\\" : ""}${l.trim()}`);
			}
		}
		serializeInto(out, n.children, depth + 1);
	}
}

export function serializeNodes(nodes: FNode[]): string {
	const out: string[] = [];
	serializeInto(out, nodes, 0);
	return out.join("\n");
}

export function serializeOutline(doc: OutlineDoc): string {
	const body = serializeNodes(doc.root.children);
	return doc.frontmatter + body + (body ? "\n" : "");
}

// ---------------------------------------------------------------- snapshots (undo)

export interface PlainNode {
	id: string;
	t: string;
	n?: string;
	c?: PlainNode[];
	x?: 1; // collapsed
	d?: 1; // done
	b?: 1; // checkbox
}

export function toPlain(n: FNode): PlainNode {
	const p: PlainNode = { id: n.id, t: n.text };
	if (n.note) p.n = n.note;
	if (n.children.length) p.c = n.children.map(toPlain);
	if (n.collapsed) p.x = 1;
	if (n.completed) p.d = 1;
	if (n.checkbox) p.b = 1;
	return p;
}

export function fromPlain(p: PlainNode, parent: FNode | null = null): FNode {
	const n: FNode = {
		id: p.id,
		text: p.t,
		note: p.n ?? "",
		children: [],
		parent,
		collapsed: !!p.x,
		completed: !!p.d,
		checkbox: !!p.b,
	};
	n.children = (p.c ?? []).map((c) => fromPlain(c, n));
	return n;
}

// ---------------------------------------------------------------- tree helpers

export function walk(n: FNode, fn: (n: FNode) => void) {
	fn(n);
	for (const c of n.children) walk(c, fn);
}

export function isAncestor(a: FNode, b: FNode): boolean {
	for (let p = b.parent; p; p = p.parent) if (p === a) return true;
	return false;
}

export function pathTo(n: FNode): FNode[] {
	const path: FNode[] = [];
	for (let p: FNode | null = n; p; p = p.parent) path.unshift(p);
	return path;
}

export function detach(n: FNode) {
	const p = n.parent;
	if (!p) return;
	const i = p.children.indexOf(n);
	if (i >= 0) p.children.splice(i, 1);
	n.parent = null;
}

export function insertAt(parent: FNode, n: FNode, index: number) {
	detach(n);
	n.parent = parent;
	parent.children.splice(Math.max(0, Math.min(index, parent.children.length)), 0, n);
}

export function insertAfter(ref: FNode, n: FNode) {
	if (n === ref) return;
	detach(n);
	const p = ref.parent!;
	insertAt(p, n, p.children.indexOf(ref) + 1);
}

export function insertBefore(ref: FNode, n: FNode) {
	if (n === ref) return;
	detach(n);
	const p = ref.parent!;
	insertAt(p, n, p.children.indexOf(ref));
}

/** Merge `cur` into `into` (text appended, children re-homed), then remove `cur`. */
export function mergeInto(into: FNode, cur: FNode) {
	into.text += cur.text;
	if (cur.note) into.note = into.note ? into.note + "\n" + cur.note : cur.note;
	const kids = cur.children.slice();
	if (cur.parent === into) {
		const at = into.children.indexOf(cur);
		detach(cur);
		kids.forEach((k, i) => insertAt(into, k, at + i));
	} else {
		detach(cur);
		for (const k of kids) insertAt(into, k, into.children.length);
	}
}

/**
 * Stable-ish key for a node, used to remember collapsed/zoom state across reloads
 * without writing ids into the Markdown: the chain of texts from the root, with an
 * occurrence index to disambiguate siblings that share the same text.
 */
export function nodeKey(n: FNode): string {
	const parts: string[] = [];
	for (let c: FNode | null = n; c && c.parent; c = c.parent) {
		let k = 0;
		for (const s of c.parent.children) {
			if (s === c) break;
			if (s.text === c.text) k++;
		}
		parts.unshift(k ? `${c.text}\u0001${k}` : c.text);
	}
	return parts.join("\u0000");
}

/** Deep copy with fresh ids. */
export function cloneTree(n: FNode, parent: FNode | null = null): FNode {
	const c: FNode = { ...n, id: newId(), parent, children: [] };
	c.children = n.children.map((k) => cloneTree(k, c));
	return c;
}

// ---------------------------------------------------------------- search

/** Lowercase + strip diacritics, keeping a 1:1 char mapping with the input (for highlighting). */
export function fold(s: string): string {
	let out = "";
	for (const ch of s) {
		const base = ch.normalize("NFD")[0] ?? ch;
		const low = base.toLowerCase();
		// keep length identical to `ch` (surrogate pairs etc.)
		out += low.length === ch.length ? low : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
	}
	return out;
}

export interface Query {
	include: string[];
	exclude: string[];
	completed: boolean | null;
	empty: boolean;
}

export function parseQuery(q: string): Query {
	const include: string[] = [];
	const exclude: string[] = [];
	let completed: boolean | null = null;
	const re = /(-?)(?:"([^"]*)"|(\S+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(q))) {
		const neg = m[1] === "-";
		const term = fold(m[2] ?? m[3] ?? "");
		if (!term) continue;
		if (term === "is:complete" || term === "is:completed" || term === "is:done") {
			completed = !neg;
			continue;
		}
		(neg ? exclude : include).push(term);
	}
	return { include, exclude, completed, empty: !include.length && !exclude.length && completed === null };
}

export function matches(n: FNode, q: Query): boolean {
	if (q.completed !== null && n.completed !== q.completed) return false;
	const hay = fold(n.text + "\n" + n.note);
	for (const t of q.exclude) if (hay.includes(t)) return false;
	for (const t of q.include) if (!hay.includes(t)) return false;
	return true;
}

/** nodeKey() for every node in one pass. */
export function allKeys(root: FNode): Map<FNode, string> {
	const out = new Map<FNode, string>();
	const rec = (n: FNode, prefix: string | null) => {
		const counts = new Map<string, number>();
		for (const c of n.children) {
			const k = counts.get(c.text) ?? 0;
			counts.set(c.text, k + 1);
			const part = k ? `${c.text}\u0001${k}` : c.text;
			const key = prefix === null ? part : prefix + "\u0000" + part;
			out.set(c, key);
			rec(c, key);
		}
	};
	rec(root, null);
	return out;
}
