// Lightweight `[[link` and `#tag` autocomplete for the outline's contenteditable rows.

import { App, TFile, prepareFuzzySearch } from "obsidian";
import { domText, getCaret, setCaret } from "./inline";

interface Item {
	label: string;
	detail?: string;
	insert: string;
}

interface Ctx {
	el: HTMLElement;
	kind: "link" | "tag";
	start: number; // offset of the query start (after `[[` or `#`)
	end: number; // caret
	query: string;
}

export class InlineSuggest {
	private box: HTMLElement | null = null;
	private items: Item[] = [];
	private idx = 0;
	private ctx: Ctx | null = null;

	constructor(private app: App, private sourcePath: () => string) {}

	get isOpen() {
		return !!this.box && !!this.ctx;
	}

	update(el: HTMLElement) {
		const c = getCaret(el);
		const text = domText(el);
		if (!c || c.start !== c.end) return this.close();
		const before = text.slice(0, c.start);
		let m = /\[\[([^[\]\n|#^]*)$/.exec(before);
		if (m) {
			this.ctx = { el, kind: "link", start: c.start - m[1].length, end: c.start, query: m[1] };
			this.items = this.linkItems(m[1]);
		} else if ((m = /(?:^|[\s(])#([\p{L}\p{N}_\-/]+)$/u.exec(before))) {
			this.ctx = { el, kind: "tag", start: c.start - m[1].length, end: c.start, query: m[1] };
			this.items = this.tagItems(m[1]);
		} else return this.close();
		if (!this.items.length) return this.close();
		this.idx = 0;
		this.draw();
	}

	private linkItems(q: string): Item[] {
		const files = this.app.vault.getMarkdownFiles();
		const src = this.sourcePath();
		const toItem = (f: TFile): Item => ({
			label: f.basename,
			detail: f.parent && f.parent.path !== "/" ? f.parent.path : undefined,
			insert: this.app.metadataCache.fileToLinktext(f, src, true),
		});
		if (!q) {
			const recent = this.app.workspace.getLastOpenFiles();
			const byPath = new Map(files.map((f) => [f.path, f]));
			const out = recent.map((p) => byPath.get(p)).filter((f): f is TFile => !!f && f.path !== src);
			return out.slice(0, 8).map(toItem);
		}
		const fuzzy = prepareFuzzySearch(q);
		const scored: [number, TFile][] = [];
		for (const f of files) {
			const r = fuzzy(f.basename) ?? fuzzy(f.path);
			if (r) scored.push([r.score, f]);
		}
		scored.sort((a, b) => b[0] - a[0]);
		return scored.slice(0, 10).map(([, f]) => toItem(f));
	}

	private tagItems(q: string): Item[] {
		const mc = this.app.metadataCache as unknown as { getTags?: () => Record<string, number> };
		const tags = Object.entries(mc.getTags?.() ?? {});
		const fuzzy = prepareFuzzySearch(q);
		const scored: [number, string, number][] = [];
		for (const [tag, count] of tags) {
			const r = fuzzy(tag.slice(1));
			if (r && tag.slice(1) !== q) scored.push([r.score, tag, count]);
		}
		scored.sort((a, b) => b[0] - a[0] || b[2] - a[2]);
		return scored.slice(0, 8).map(([, tag, count]) => ({ label: tag, detail: String(count), insert: tag.slice(1) }));
	}

	private draw() {
		const ctx = this.ctx!;
		const doc = ctx.el.ownerDocument;
		if (!this.box) {
			this.box = doc.body.createDiv({ cls: "suggestion-container flow-suggest" });
			this.box.addEventListener("mousedown", (e) => e.preventDefault());
		}
		const box = this.box;
		box.empty();
		const list = box.createDiv({ cls: "suggestion" });
		this.items.forEach((it, i) => {
			const row = list.createDiv({ cls: "suggestion-item mod-complex" + (i === this.idx ? " is-selected" : "") });
			const content = row.createDiv({ cls: "suggestion-content" });
			content.createDiv({ cls: "suggestion-title", text: it.label });
			if (it.detail) row.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair", text: it.detail });
			row.addEventListener("mousemove", () => {
				if (this.idx !== i) {
					this.idx = i;
					this.draw();
				}
			});
			row.addEventListener("click", () => {
				this.idx = i;
				this.choose();
			});
		});
		// position under the caret
		const sel = doc.getSelection();
		let rect: DOMRect | null = null;
		if (sel && sel.rangeCount) {
			const rs = sel.getRangeAt(0).getClientRects();
			rect = rs.length ? rs[rs.length - 1] : null;
		}
		rect ??= ctx.el.getBoundingClientRect();
		const win = doc.defaultView!;
		box.style.left = `${Math.min(rect.left, win.innerWidth - 320)}px`;
		const below = rect.bottom + 4;
		box.style.top = `${below}px`;
		requestAnimationFrame(() => {
			if (!this.box) return;
			const h = this.box.getBoundingClientRect().height;
			if (below + h > win.innerHeight - 8) this.box.style.top = `${Math.max(8, rect!.top - h - 4)}px`;
		});
	}

	handleKey(evt: KeyboardEvent): boolean {
		if (!this.isOpen) return false;
		const k = evt.key;
		if (k === "ArrowDown" || k === "ArrowUp") {
			const n = this.items.length;
			this.idx = (this.idx + (k === "ArrowDown" ? 1 : -1) + n) % n;
			this.draw();
			return true;
		}
		if ((k === "Enter" || k === "Tab") && !evt.metaKey && !evt.ctrlKey && !evt.shiftKey) {
			this.choose();
			return true;
		}
		if (k === "Escape") {
			this.close();
			return true;
		}
		return false;
	}

	private choose() {
		const ctx = this.ctx;
		const it = this.items[this.idx];
		if (!ctx || !it) return this.close();
		const el = ctx.el;
		const text = domText(el);
		let insert = it.insert;
		let end = ctx.end;
		if (ctx.kind === "link") {
			if (text.slice(end, end + 2) === "]]") end += 2;
			insert += "]]";
		} else if (text[end] !== " ") insert += " ";
		this.close();
		el.focus();
		setCaret(el, ctx.start, end);
		el.ownerDocument.execCommand("insertText", false, insert);
	}

	close() {
		this.box?.remove();
		this.box = null;
		this.ctx = null;
		this.items = [];
	}
}
