// Inline rendering of an item's raw Markdown text (shown when the item isn't being edited),
// plus caret helpers for the contenteditable rows.
//
// Every rendered text segment carries `data-o` = the offset in the raw text where its display
// text starts, so a click on rendered text can be mapped back to a raw caret position.

import { fold } from "./model";

const TOKEN_RE = new RegExp(
	[
		String.raw`\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]`, // 1,2 wikilink
		String.raw`\[([^\]\n]+)\]\(([^)\s]+)\)`, // 3,4 md link
		String.raw`(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])`, // 5 bare url
		String.raw`\*\*([^*\n]+?)\*\*`, // 6 bold
		String.raw`~~([^~\n]+?)~~`, // 7 strike
		String.raw`==([^=\n]+?)==`, // 8 highlight
		String.raw`\x60([^\x60\n]+?)\x60`, // 9 code
		String.raw`(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])`, // 10 italic *
		String.raw`(?<![\p{L}\p{N}_])_(?![\s_])([^_\n]+?)(?<!\s)_(?![\p{L}\p{N}_])`, // 11 italic _
		String.raw`(?<![^\s(])([#@][\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)`, // 12 tag / mention
	].join("|"),
	"gu",
);

export interface InlineOptions {
	terms: string[]; // folded search terms to highlight
}

function appendText(parent: HTMLElement, text: string, rawStart: number, terms: string[], cls?: string, tag = "span") {
	const el = parent.createEl(tag as keyof HTMLElementTagNameMap, { cls });
	el.dataset.o = String(rawStart);
	highlightInto(el, text, terms);
	return el;
}

function highlightInto(el: HTMLElement, text: string, terms: string[]) {
	if (!terms.length || !text) {
		el.appendText(text);
		return;
	}
	const hay = fold(text);
	const marks: [number, number][] = [];
	for (const t of terms) {
		if (!t) continue;
		let i = hay.indexOf(t);
		while (i >= 0) {
			marks.push([i, i + t.length]);
			i = hay.indexOf(t, i + t.length);
		}
	}
	if (!marks.length) {
		el.appendText(text);
		return;
	}
	marks.sort((a, b) => a[0] - b[0]);
	let pos = 0;
	for (const [s0, e] of marks) {
		const s = Math.max(s0, pos);
		if (e <= s) continue;
		if (s > pos) el.appendText(text.slice(pos, s));
		el.createEl("mark", { cls: "flow-hl", text: text.slice(s, e) });
		pos = e;
	}
	if (pos < text.length) el.appendText(text.slice(pos));
}

export function renderInline(el: HTMLElement, raw: string, opts: InlineOptions) {
	el.empty();
	const terms = opts.terms;
	let last = 0;
	TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN_RE.exec(raw))) {
		const start = m.index;
		if (start > last) appendText(el, raw.slice(last, start), last, terms);
		last = start + m[0].length;
		if (m[1] !== undefined) {
			const target = m[1];
			const label = m[2] ?? m[1];
			const a = appendText(el, label, start + 2 + (m[2] !== undefined ? m[1].length + 1 : 0), terms, "internal-link flow-link", "a");
			a.dataset.href = target;
			a.setAttr("href", target);
		} else if (m[3] !== undefined) {
			const a = appendText(el, m[3], start + 1, terms, "external-link flow-link", "a");
			a.setAttr("href", m[4]);
			a.dataset.url = m[4];
		} else if (m[5] !== undefined) {
			const a = appendText(el, m[5], start, terms, "external-link flow-link", "a");
			a.setAttr("href", m[5]);
			a.dataset.url = m[5];
		} else if (m[6] !== undefined) appendText(el, m[6], start + 2, terms, "flow-b", "strong");
		else if (m[7] !== undefined) appendText(el, m[7], start + 2, terms, "flow-s", "del");
		else if (m[8] !== undefined) appendText(el, m[8], start + 2, terms, "flow-mark", "mark");
		else if (m[9] !== undefined) appendText(el, m[9], start + 1, terms, "flow-code", "code");
		else if (m[10] !== undefined) appendText(el, m[10], start + 1, terms, "flow-i", "em");
		else if (m[11] !== undefined) appendText(el, m[11], start + 1, terms, "flow-i", "em");
		else if (m[12] !== undefined) {
			const t = appendText(el, m[12], start, terms, m[12][0] === "@" ? "flow-tag flow-mention" : "flow-tag", "a");
			t.dataset.tag = m[12];
		}
	}
	if (last < raw.length) appendText(el, raw.slice(last), last, terms);
}

/** Notes: rendered line by line with the same inline rules. */
export function renderNote(el: HTMLElement, raw: string, opts: InlineOptions) {
	el.empty();
	const lines = raw.split("\n");
	let offset = 0;
	lines.forEach((line, i) => {
		const lineEl = el.createDiv({ cls: "flow-note-line" });
		const tmp = createDiv();
		renderInline(tmp, line, opts);
		// shift data-o by the line offset
		tmp.querySelectorAll<HTMLElement>("[data-o]").forEach((s) => (s.dataset.o = String(+s.dataset.o! + offset)));
		while (tmp.firstChild) lineEl.appendChild(tmp.firstChild);
		if (!line) {
			const s = lineEl.createSpan({ text: "​" });
			s.dataset.o = String(offset);
		}
		offset += line.length + (i < lines.length - 1 ? 1 : 0);
	});
}

// ---------------------------------------------------------------- caret helpers

export interface Caret {
	start: number;
	end: number;
}

function selOf(el: HTMLElement): Selection | null {
	return el.ownerDocument.getSelection();
}

/** Text of a contenteditable, counting <br> as "\n" (minus Chrome's trailing placeholder <br>). */
export function domText(el: Node, dropTrailing = true): string {
	let out = "";
	const doc = el.ownerDocument ?? (el as Document);
	const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	let n: Node | null;
	let last: Node | null = null;
	while ((n = walker.nextNode())) {
		if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
		else if (n.nodeName === "BR") out += "\n";
		else if ((n.nodeName === "DIV" || n.nodeName === "P") && n !== el && out && !out.endsWith("\n")) {
			out += "\n"; // Chrome may wrap new lines in blocks
			continue;
		} else continue;
		last = n;
	}
	if (dropTrailing && last?.nodeName === "BR" && out.endsWith("\n")) out = out.slice(0, -1);
	return out;
}

export function getCaret(el: HTMLElement): Caret | null {
	const sel = selOf(el);
	if (!sel || !sel.rangeCount) return null;
	const r = sel.getRangeAt(0);
	if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
	const pre = el.ownerDocument.createRange();
	pre.selectNodeContents(el);
	pre.setEnd(r.startContainer, r.startOffset);
	const start = domText(pre.cloneContents(), false).length;
	pre.setEnd(r.endContainer, r.endOffset);
	return { start, end: domText(pre.cloneContents(), false).length };
}

function locate(el: HTMLElement, offset: number): [Node, number] {
	const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	let n: Node | null;
	let rest = offset;
	while ((n = walker.nextNode())) {
		if (n.nodeType === Node.TEXT_NODE) {
			const len = n.nodeValue!.length;
			if (rest <= len) return [n, rest];
			rest -= len;
		} else if (n.nodeName === "BR") {
			const parent = n.parentNode!;
			const idx = Array.prototype.indexOf.call(parent.childNodes, n);
			if (rest === 0) return [parent, idx];
			rest -= 1;
			if (rest === 0) return [parent, idx + 1];
		}
	}
	return [el, el.childNodes.length];
}

export function setCaret(el: HTMLElement, start: number, end = start) {
	const sel = selOf(el);
	if (!sel) return;
	const r = el.ownerDocument.createRange();
	const [sn, so] = locate(el, start);
	const [en, eo] = locate(el, end);
	r.setStart(sn, so);
	r.setEnd(en, eo);
	sel.removeAllRanges();
	sel.addRange(r);
}

/** Raw-text offset under a screen point, for a rendered (non-editing) element. */
export function rawOffsetFromPoint(el: HTMLElement, x: number, y: number, rawLen: number): number {
	const doc = el.ownerDocument;
	const pos = caretFromPoint(doc, x, y);
	if (!pos || !el.contains(pos.node)) return rawLen;
	const r = doc.createRange();
	r.selectNodeContents(el);
	try {
		r.setEnd(pos.node, pos.offset);
	} catch {
		return rawLen;
	}
	// rendered offset -> raw offset, through the [data-o] segments
	const rendered = r.toString().length;
	let acc = 0;
	for (const seg of Array.from(el.querySelectorAll<HTMLElement>("[data-o]"))) {
		const t = seg.textContent ?? "";
		if (rendered <= acc + t.length) {
			const inner = t === "\u200b" ? 0 : rendered - acc;
			return Math.min(rawLen, +seg.dataset.o! + inner);
		}
		acc += t.length;
	}
	return rawLen;
}

export function caretFromPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
	const d = doc as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	if (d.caretPositionFromPoint) {
		const p = d.caretPositionFromPoint(x, y);
		if (p) return { node: p.offsetNode, offset: p.offset };
	}
	if (d.caretRangeFromPoint) {
		const r = d.caretRangeFromPoint(x, y);
		if (r) return { node: r.startContainer, offset: r.startOffset };
	}
	return null;
}

function caretRect(el: HTMLElement): DOMRect | null {
	const sel = selOf(el);
	if (!sel || !sel.rangeCount) return null;
	const r = sel.getRangeAt(0).cloneRange();
	r.collapse(sel.focusNode === r.startContainer && sel.focusOffset === r.startOffset);
	const rects = r.getClientRects();
	if (rects.length) return rects[rects.length - 1];
	const b = r.getBoundingClientRect();
	return b.height ? b : null;
}

function lineHeight(el: HTMLElement): number {
	const cs = getComputedStyle(el);
	const lh = parseFloat(cs.lineHeight);
	return isNaN(lh) ? parseFloat(cs.fontSize) * 1.5 : lh;
}

export function caretOnFirstLine(el: HTMLElement): boolean {
	const text = domText(el);
	if (!text) return true;
	const c = getCaret(el);
	if (c && c.start === 0) return true;
	if (c && text.slice(0, c.start).includes("\n")) return false;
	const rect = caretRect(el);
	if (!rect) return true;
	return rect.top - el.getBoundingClientRect().top < lineHeight(el) * 0.75;
}

export function caretOnLastLine(el: HTMLElement): boolean {
	const text = domText(el);
	if (!text) return true;
	const c = getCaret(el);
	if (c && c.end >= text.length) return true;
	if (c && text.slice(c.end).includes("\n")) return false;
	const rect = caretRect(el);
	if (!rect) return true;
	return el.getBoundingClientRect().bottom - rect.bottom < lineHeight(el) * 0.75;
}

export function caretX(el: HTMLElement): number | null {
	const rect = caretRect(el);
	return rect ? rect.left : null;
}

/** After `el` has been switched to raw text, find the offset closest to x on its first/last line. */
export function offsetAtX(el: HTMLElement, x: number, line: "first" | "last"): number | null {
	const b = el.getBoundingClientRect();
	const lh = lineHeight(el);
	const y = line === "first" ? b.top + lh / 2 : b.bottom - lh / 2;
	const pos = caretFromPoint(el.ownerDocument, x, y);
	if (!pos || !el.contains(pos.node)) return null;
	const r = el.ownerDocument.createRange();
	r.selectNodeContents(el);
	r.setEnd(pos.node, pos.offset);
	return domText(r.cloneContents(), false).length;
}

/** Replace the current selection with plain text (may contain newlines), without letting the browser build <div>s. */
export function insertPlain(el: HTMLElement, text: string) {
	const c = getCaret(el) ?? { start: domText(el).length, end: domText(el).length };
	const cur = domText(el);
	const next = cur.slice(0, c.start) + text + cur.slice(c.end);
	el.textContent = next;
	// a trailing newline needs a placeholder <br> to be visible / reachable by the caret
	if (next.endsWith("\n")) el.appendChild(el.ownerDocument.createElement("br"));
	setCaret(el, c.start + text.length);
}
