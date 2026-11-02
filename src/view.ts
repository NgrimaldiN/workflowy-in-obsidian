import {
	FuzzySuggestModal,
	Keymap,
	Menu,
	Platform,
	Scope,
	TextFileView,
	TFile,
	WorkspaceLeaf,
	debounce,
	setIcon,
} from "obsidian";
import type FlowPlugin from "./main";
import {
	FNode,
	OutlineDoc,
	PlainNode,
	Query,
	allKeys,
	cloneTree,
	createNode,
	detach,
	fromPlain,
	insertAfter,
	insertAt,
	insertBefore,
	isAncestor,
	matches,
	mergeInto,
	parseOutline,
	parseQuery,
	pathTo,
	serializeNodes,
	serializeOutline,
	toPlain,
	walk,
} from "./model";
import {
	caretOnFirstLine,
	caretOnLastLine,
	caretX,
	getCaret,
	offsetAtX,
	rawOffsetFromPoint,
	renderInline,
	renderNote,
	setCaret,
	domText,
	insertPlain,
} from "./inline";
import { InlineSuggest } from "./suggest";

export const VIEW_TYPE = "flow-outliner";

type Kind = "text" | "note";
interface FocusState {
	id: string;
	kind: Kind;
	start: number;
	end: number;
}
interface Snapshot {
	root: PlainNode;
	zoom: string;
	focus: FocusState | null;
}
type DropMode = "before" | "after" | "child";
interface NodeDom {
	el: HTMLElement;
	sig: string;
	kids: HTMLElement | null;
}

const MAX_UNDO = 300;

function emptyDoc(): OutlineDoc {
	const root = createNode("");
	root.id = "root";
	return { frontmatter: "", root, lossy: false };
}

export function plainText(raw: string): string {
	return raw
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]]+)\]\]/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/(\*\*|__|~~|==|`)(.+?)\1/g, "$2")
		.replace(/(^|[^\w*])\*([^*]+)\*/g, "$1$2");
}

export class OutlineView extends TextFileView {
	plugin: FlowPlugin;
	doc: OutlineDoc = emptyDoc();
	byId = new Map<string, FNode>();
	zoom: FNode = this.doc.root;

	private query: Query = parseQuery("");
	private visibleSet: Set<FNode> | null = null;
	private forceShow = new Set<string>();
	private noteOpen: string | null = null;
	private selection: { anchor: string; head: string } | null = null;
	private undoStack: Snapshot[] = [];
	private redoStack: Snapshot[] = [];
	private typingBurst = false;
	private burstTimer = 0;
	private unsaved = false;
	/** Raw file contents as last loaded, and whether the outline has been edited since. */
	private loaded = "";
	private edited = false;
	private drag: {
		node: FNode;
		target: FNode | null;
		mode: DropMode;
		indicator: HTMLElement;
	} | null = null;

	private built = false;
	private nodeEls = new Map<string, NodeDom>();
	private termsKey = "";
	private topbarEl!: HTMLElement;
	private crumbsEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private pageEl!: HTMLElement;
	private bannerEl!: HTMLElement;
	private titleWrapEl!: HTMLElement;
	private listEl!: HTMLElement;
	private addEl!: HTMLElement;
	private suggest: InlineSuggest;

	private flush = async () => {
		if (!this.unsaved || !this.file) return;
		this.unsaved = false;
		await this.save();
	};
	private saveSoon = debounce(() => void this.flush(), 400, true);
	private persistSoon = debounce(() => this.persistState(), 800, true);
	private searchSoon = debounce(() => this.render(null), 60, true);

	constructor(leaf: WorkspaceLeaf, plugin: FlowPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.scope = new Scope(this.app.scope);
		// Catch-all: Obsidian's keymap runs in the capture phase, before the focused element sees
		// the key. Returning false = handled (prevented); undefined = fall through to global hotkeys.
		this.scope.register(null, null, (evt: KeyboardEvent) => {
			if (evt.isComposing || evt.keyCode === 229) return;
			return this.handleKey(evt) ? false : undefined;
		});
		this.suggest = new InlineSuggest(this.app, () => this.file?.path ?? "");
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getIcon() {
		return "list-tree";
	}
	getDisplayText() {
		return this.file?.basename ?? "Outline";
	}
	canAcceptExtension(_ext: string) {
		// Don't let Obsidian reuse this view for other notes (explorer clicks, links): those open as Markdown.
		return false;
	}

	// ------------------------------------------------------------ lifecycle / file data

	async onOpen() {
		this.buildDom();
	}

	async onClose() {
		this.suggest.close();
		this.saveSoon.cancel();
		await this.flush();
		this.persistState();
	}

	async onUnloadFile(file: TFile) {
		this.suggest.close();
		this.saveSoon.cancel();
		await this.flush();
		this.persistState();
		return super.onUnloadFile(file);
	}

	getViewData(): string {
		// Until the user edits something, hand back the file exactly as loaded, so merely opening
		// (or closing) a note in this view never reformats it.
		return this.edited ? serializeOutline(this.doc) : this.loaded;
	}

	setViewData(data: string, clear: boolean): void {
		this.buildDom();
		if (!clear && data === this.getViewData()) return;

		// remember view state by node key so it survives a re-parse
		const prevKeys = allKeys(this.doc.root);
		const prevCollapsed = new Set<string>();
		for (const [n, k] of prevKeys) if (n.collapsed) prevCollapsed.add(k);
		const prevZoom = prevKeys.get(this.zoom) ?? "";
		const prevFocus = this.currentFocus();
		const prevFocusKey = prevFocus ? prevKeys.get(this.byId.get(prevFocus.id)!) : undefined;

		this.doc = parseOutline(data);
		this.loaded = data;
		this.edited = false;
		this.reindex();
		const keys = allKeys(this.doc.root);
		const byKey = new Map<string, FNode>();
		for (const [n, k] of keys) byKey.set(k, n);

		let focus: FocusState | null | undefined = null;
		if (clear) {
			this.undoStack = [];
			this.redoStack = [];
			this.selection = null;
			this.noteOpen = null;
			this.forceShow.clear();
			const st = this.file ? this.plugin.getOutlineState(this.file.path) : null;
			const collapsed = new Set(st?.collapsed ?? []);
			for (const [n, k] of keys) n.collapsed = collapsed.has(k);
			this.zoom = (st?.zoom && byKey.get(st.zoom)) || this.doc.root;
		} else {
			for (const [n, k] of keys) n.collapsed = prevCollapsed.has(k);
			this.zoom = (prevZoom && byKey.get(prevZoom)) || this.doc.root;
			// ids changed: old snapshots can't be restored meaningfully
			this.undoStack = [];
			this.redoStack = [];
			const fnode = prevFocusKey !== undefined ? byKey.get(prevFocusKey) : undefined;
			if (fnode && prevFocus) focus = { ...prevFocus, id: fnode.id };
		}
		this.render(focus);
	}

	clear(): void {
		this.doc = emptyDoc();
		this.zoom = this.doc.root;
		this.reindex();
		this.undoStack = [];
		this.redoStack = [];
		this.selection = null;
	}

	private persistState() {
		if (!this.file) return;
		const keys = allKeys(this.doc.root);
		const collapsed: string[] = [];
		for (const [n, k] of keys) if (n.collapsed && n.children.length) collapsed.push(k);
		this.plugin.setOutlineState(this.file.path, { collapsed, zoom: keys.get(this.zoom) ?? "" });
	}

	/** Model changed: re-render (keeping focus unless given), then save. */
	private changed(focus?: FocusState | null) {
		this.doc.lossy = false;
		this.unsaved = true;
		this.edited = true;
		this.render(focus);
		this.saveSoon();
		this.persistSoon();
	}

	private reindex() {
		this.byId.clear();
		walk(this.doc.root, (n) => this.byId.set(n.id, n));
	}

	// ------------------------------------------------------------ undo

	private snapshot(): Snapshot {
		return { root: toPlain(this.doc.root), zoom: this.zoom.id, focus: this.currentFocus() };
	}

	private checkpoint() {
		this.undoStack.push(this.snapshot());
		if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
		this.redoStack = [];
	}

	private restore(s: Snapshot) {
		this.doc.root = fromPlain(s.root);
		this.reindex();
		this.zoom = this.byId.get(s.zoom) ?? this.doc.root;
		this.typingBurst = false;
		this.selection = null;
		this.changed(s.focus);
	}

	undo() {
		const s = this.undoStack.pop();
		if (!s) return;
		this.redoStack.push(this.snapshot());
		this.restore(s);
	}

	redo() {
		const s = this.redoStack.pop();
		if (!s) return;
		this.undoStack.push(this.snapshot());
		this.restore(s);
	}

	// ------------------------------------------------------------ DOM

	private buildDom() {
		if (this.built) return;
		this.built = true;
		const c = this.contentEl;
		c.empty();
		c.addClass("flow-view");
		c.tabIndex = -1;

		this.topbarEl = c.createDiv({ cls: "flow-topbar" });
		this.crumbsEl = this.topbarEl.createDiv({ cls: "flow-crumbs" });
		const sw = this.topbarEl.createDiv({ cls: "flow-search" });
		setIcon(sw.createSpan({ cls: "flow-search-icon" }), "search");
		this.searchEl = sw.createEl("input", {
			cls: "flow-search-input",
			attr: { type: "text", placeholder: "Search", spellcheck: "false" },
		});
		const clearBtn = sw.createSpan({ cls: "flow-search-clear", attr: { "aria-label": "Clear search" } });
		setIcon(clearBtn, "x");
		clearBtn.addEventListener("click", () => this.setSearch(""));
		this.searchEl.addEventListener("input", () => {
			this.query = parseQuery(this.searchEl.value);
			this.forceShow.clear();
			this.contentEl.toggleClass("is-searching", !this.query.empty);
			this.searchSoon();
		});

		this.pageEl = c.createDiv({ cls: "flow-page" });
		this.bannerEl = this.pageEl.createDiv({ cls: "flow-banner" });
		this.titleWrapEl = this.pageEl.createDiv({ cls: "flow-title-wrap" });
		this.listEl = this.pageEl.createDiv({ cls: "flow-list" });
		this.addEl = this.pageEl.createDiv({ cls: "flow-add", attr: { "aria-label": "Add item" } });
		setIcon(this.addEl.createSpan({ cls: "flow-add-icon" }), "plus");
		this.addEl.addEventListener("mousedown", (e) => e.preventDefault());
		this.addEl.addEventListener("click", () => this.appendChild(this.zoom));

		const p = this.pageEl;
		p.addEventListener("focusin", (e) => this.onFocusIn(e));
		p.addEventListener("focusout", (e) => this.onFocusOut(e));
		p.addEventListener("beforeinput", (e) => this.onBeforeInput(e));
		p.addEventListener("input", (e) => this.onInput(e));
		p.addEventListener("paste", (e) => this.onPaste(e));
		p.addEventListener("copy", (e) => this.onCopy(e, false));
		p.addEventListener("cut", (e) => this.onCopy(e, true));
		p.addEventListener("mousedown", (e) => this.onMouseDown(e));
		p.addEventListener("click", (e) => this.onClick(e));
		p.addEventListener("mouseover", (e) => this.onMouseOver(e));
		p.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		p.addEventListener("contextmenu", (e) => this.onContextMenu(e));
		// Fallback when the view scope isn't active for some reason.
		p.addEventListener("keydown", (e) => {
			if (!e.defaultPrevented && !e.isComposing && this.handleKey(e)) e.preventDefault();
		});
		c.addEventListener("keydown", (e) => {
			if (e.target === c && !e.defaultPrevented && this.handleKey(e)) e.preventDefault();
		});
		c.addEventListener("mousedown", (e) => {
			if (e.target === c || e.target === this.pageEl) {
				if (this.selection) this.clearSelection();
			}
		});

		// Never sit on unsaved edits when the window is hidden/backgrounded (timers get throttled there).
		const flushNow = () => {
			if (this.unsaved) {
				this.saveSoon.cancel();
				void this.flush();
			}
		};
		this.registerDomEvent(c.win, "blur", flushNow);
		this.registerDomEvent(c.doc, "visibilitychange", () => {
			if (c.doc.visibilityState === "hidden") flushNow();
		});

		if (Platform.isMobile) this.buildMobileBar();

		this.addAction("check-check", "Show / hide completed", () => this.plugin.toggleShowCompleted());
		this.addAction("file-text", "Open as Markdown", () => this.plugin.toggleViewMode(this.leaf));
	}

	private buildMobileBar() {
		const bar = this.contentEl.createDiv({ cls: "flow-mobile-bar" });
		const btn = (icon: string, label: string, fn: (n: FNode) => void) => {
			const b = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.addEventListener("mousedown", (e) => e.preventDefault());
			b.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
			const run = () => {
				const f = this.currentFocus();
				const n = f && this.byId.get(f.id);
				if (n) fn(n);
			};
			b.addEventListener("click", run);
			b.addEventListener("touchend", (e) => {
				e.preventDefault();
				run();
			});
		};
		btn("arrow-left", "Outdent", (n) => this.outdent([n]));
		btn("arrow-right", "Indent", (n) => this.indent([n]));
		btn("arrow-up", "Move up", (n) => this.moveBlock([n], -1));
		btn("arrow-down", "Move down", (n) => this.moveBlock([n], 1));
		btn("check", "Complete", (n) => this.toggleComplete([n]));
		btn("file-text", "Note", (n) => this.openNote(n));
		btn("zoom-in", "Zoom in", (n) => this.zoomTo(n, "in"));
		btn("zoom-out", "Zoom out", () => this.zoomOut());
	}

	onPaneMenu(menu: Menu, source: string) {
		menu.addItem((i) =>
			i
				.setTitle(this.plugin.settings.showCompleted ? "Hide completed" : "Show completed")
				.setIcon("check-check")
				.onClick(() => this.plugin.toggleShowCompleted()),
		);
		menu.addItem((i) => i.setTitle("Expand all").setIcon("chevrons-up-down").onClick(() => this.expandAll(true)));
		menu.addItem((i) => i.setTitle("Collapse all").setIcon("chevrons-down-up").onClick(() => this.expandAll(false)));
		menu.addItem((i) => i.setTitle("Jump to item…").setIcon("search").onClick(() => this.openJump()));
		menu.addItem((i) => i.setTitle("Open as Markdown").setIcon("file-text").onClick(() => this.plugin.toggleViewMode(this.leaf)));
		super.onPaneMenu(menu, source);
	}

	// ------------------------------------------------------------ rendering

	private isShown(n: FNode): boolean {
		if (n.completed && !this.plugin.settings.showCompleted && this.query.completed !== true && !this.forceShow.has(n.id)) return false;
		if (this.visibleSet && !this.visibleSet.has(n)) return false;
		return true;
	}

	private isExpanded(n: FNode): boolean {
		if (n === this.zoom) return true;
		if (this.visibleSet) return n.children.some((c) => this.visibleSet!.has(c));
		return !n.collapsed;
	}

	private computeVisibility() {
		if (this.query.empty) {
			this.visibleSet = null;
			return;
		}
		const vis = new Set<FNode>();
		const rec = (n: FNode): boolean => {
			let any = false;
			for (const c of n.children) if (rec(c)) any = true;
			if (any || matches(n, this.query) || this.forceShow.has(n.id)) {
				vis.add(n);
				return true;
			}
			return false;
		};
		for (const c of this.zoom.children) rec(c);
		this.visibleSet = vis;
	}

	/**
	 * Rebuild the visible tree. `focus`: undefined = keep the current focus/caret,
	 * null = no focus, otherwise focus that editable.
	 */
	render(focus?: FocusState | null) {
		if (!this.built) return;
		const keep = focus === undefined ? this.currentFocus() : focus;
		this.suggest.close();
		this.reindex();
		if (!this.byId.has(this.zoom.id)) this.zoom = this.doc.root;
		const root = this.doc.root;
		if (this.zoom === root && root.children.length === 0) insertAt(root, createNode(""), 0);

		this.computeVisibility();
		this.contentEl.toggleClass("hide-completed", !this.plugin.settings.showCompleted);
		this.renderBanner();
		this.renderCrumbs();
		this.renderTitle();

		this.listEl.querySelector(":scope > .flow-empty")?.remove();
		const old = this.nodeEls;
		this.nodeEls = new Map();
		this.termsKey = this.query.include.join("\u0002");
		try {
			this.reconcile(this.listEl, this.zoom.children, old);
		} catch (err) {
			console.error("Flow Outliner: incremental render failed, rebuilding", err);
			this.nodeEls = new Map();
			this.listEl.empty();
			this.reconcile(this.listEl, this.zoom.children, new Map());
		}
		const shownAny = this.listEl.childElementCount > 0;
		this.listEl.toggleClass("is-empty", !shownAny);
		if (!shownAny) {
			this.listEl.createDiv({
				cls: "flow-empty",
				text: this.visibleSet ? "No matches." : "Empty. Press Enter in the title, or click + to add an item.",
			});
		}
		this.addEl.toggle(!this.visibleSet);

		if (this.selection) {
			if (!this.byId.has(this.selection.anchor) || !this.byId.has(this.selection.head)) this.selection = null;
			else {
				this.applySelectionClasses();
				this.contentEl.focus({ preventScroll: true });
				this.cleanupStale();
				return;
			}
		}
		if (keep) this.focusState(keep);
		this.cleanupStale();
	}

	/** Rows that lost focus by being moved in the DOM don't get a blur: put them back in rendered mode. */
	private cleanupStale() {
		const active = this.contentEl.doc.activeElement;
		this.pageEl.querySelectorAll<HTMLElement>('.flow-editable[data-raw="1"]').forEach((el) => {
			if (el === active) return;
			delete el.dataset.raw;
			const n = this.byId.get(el.dataset.id!);
			if (n) this.paint(el, n, el.dataset.kind as Kind);
		});
		this.listEl.querySelectorAll(".flow-node.is-focused").forEach((w) => {
			if (!active || !w.querySelector(":scope > .flow-row")?.contains(active)) w.removeClass("is-focused");
		});
	}

	private renderBanner() {
		this.bannerEl.empty();
		this.bannerEl.toggle(this.doc.lossy);
		if (!this.doc.lossy) return;
		this.bannerEl.createSpan({
			text: "This note isn't a pure outline: headings, paragraphs and numbered lists become bullets once you edit it here. ",
		});
		const a = this.bannerEl.createEl("a", { text: "Open as Markdown" });
		a.addEventListener("click", () => this.plugin.toggleViewMode(this.leaf));
	}

	private renderCrumbs() {
		const el = this.crumbsEl;
		el.empty();
		const path = pathTo(this.zoom).slice(0, -1);
		if (!path.length) {
			el.createSpan({ cls: "flow-crumb is-home is-current", attr: { "aria-label": "Home" } }).setText(this.getDisplayText());
			return;
		}
		path.forEach((n, i) => {
			const a = el.createEl("a", { cls: "flow-crumb" + (n === this.doc.root ? " is-home" : "") });
			if (n === this.doc.root) a.setText(this.getDisplayText());
			else a.setText(plainText(n.text) || "Untitled");
			a.addEventListener("click", () => this.zoomTo(n, "out"));
			if (i < path.length) el.createSpan({ cls: "flow-crumb-sep", text: "›" });
		});
	}

	private renderTitle() {
		const w = this.titleWrapEl;
		w.empty();
		const z = this.zoom;
		if (z === this.doc.root) {
			w.createDiv({ cls: "flow-title is-root", text: this.getDisplayText() });
			return;
		}
		const t = this.makeEditable(w, z, "text", "flow-title");
		t.dataset.title = "1";
		t.toggleClass("is-completed", z.completed);
		if (z.note || this.noteOpen === z.id) {
			const n = this.makeEditable(w, z, "note", "flow-note flow-title-note");
			n.dataset.title = "1";
		}
	}

	/**
	 * Keyed reconciliation: rows whose content/state signature didn't change keep their DOM element
	 * (and focus), so an edit in a 5,000-item outline only touches the rows that actually changed.
	 */
	private reconcile(container: HTMLElement, nodes: FNode[], old: Map<string, NodeDom>) {
		// Build (or reuse) every child first: building can move reused rows between containers
		// (e.g. when zooming out), so positions are only applied once the set is final.
		const els: HTMLElement[] = [];
		for (const n of nodes) if (this.isShown(n)) els.push(this.nodeEl(n, old));
		const kids = container.children;
		for (let i = 0; i < els.length; i++) {
			if (kids[i] !== els[i]) container.insertBefore(els[i], kids[i] ?? null);
		}
		while (kids.length > els.length) kids[kids.length - 1].remove();
	}

	private nodeEl(n: FNode, old: Map<string, NodeDom>): HTMLElement {
		const hasKids = n.children.length > 0;
		const expanded = hasKids && this.isExpanded(n);
		const sig = [n.text, n.note, +n.completed, +n.checkbox, +hasKids, +expanded, +(this.noteOpen === n.id), this.termsKey].join("\u0001");
		const prev = old.get(n.id);
		let wrap: HTMLElement;
		let kids: HTMLElement | null = null;
		if (prev && prev.sig === sig) {
			wrap = prev.el;
			kids = prev.kids;
		} else {
			wrap = createDiv({ cls: "flow-node" });
			wrap.dataset.id = n.id;
			if (n.completed) wrap.addClass("is-completed");
			if (hasKids) wrap.addClass("has-children");
			if (hasKids && !expanded) wrap.addClass("is-collapsed");
			const row = wrap.createDiv({ cls: "flow-row" });
			// no aria-label here: Obsidian turns those into hover tooltips, which get noisy on every bullet
			row.createDiv({ cls: "flow-toggle" });
			const bullet = row.createDiv({ cls: "flow-bullet" });
			bullet.createDiv({ cls: "flow-dot" });
			if (n.checkbox || n.completed) {
				const cb = row.createDiv({ cls: "flow-check" + (n.completed ? " is-checked" : "") });
				if (!n.checkbox) cb.addClass("is-implicit");
			}
			this.makeEditable(row, n, "text", "flow-text");
			if (n.note || this.noteOpen === n.id) this.makeEditable(wrap, n, "note", "flow-note");
			// adopt the previous children container so its rows can be reused in place
			if (prev?.kids && expanded) {
				kids = prev.kids;
				wrap.appendChild(kids);
			}
		}
		if (expanded) {
			if (!kids) kids = wrap.createDiv({ cls: "flow-children" });
			this.reconcile(kids, n.children, old);
		} else if (kids) {
			kids.remove();
			kids = null;
		}
		this.nodeEls.set(n.id, { el: wrap, sig, kids });
		return wrap;
	}

	private makeEditable(parent: HTMLElement, node: FNode, kind: Kind, cls: string): HTMLElement {
		const el = parent.createDiv({ cls: `flow-editable ${cls}` });
		el.contentEditable = "plaintext-only";
		if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
		el.dataset.id = node.id;
		el.dataset.kind = kind;
		el.spellcheck = true;
		this.paint(el, node, kind);
		return el;
	}

	private paint(el: HTMLElement, node: FNode, kind: Kind) {
		const raw = kind === "text" ? node.text : node.note;
		if (el.dataset.raw === "1") {
			el.textContent = raw;
			return;
		}
		const opts = { terms: this.query.include };
		if (kind === "text") renderInline(el, raw, opts);
		else renderNote(el, raw, opts);
	}

	// ------------------------------------------------------------ focus helpers

	private activeEditable(): HTMLElement | null {
		const a = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
		if (!a || !this.pageEl.contains(a) || !a.hasClass("flow-editable")) return null;
		return a;
	}

	private currentFocus(): FocusState | null {
		const el = this.activeEditable();
		if (!el) return null;
		const c = getCaret(el) ?? { start: 0, end: 0 };
		return { id: el.dataset.id!, kind: el.dataset.kind as Kind, ...c };
	}

	private findEditable(id: string, kind: Kind): HTMLElement | null {
		const title = this.titleWrapEl.querySelector<HTMLElement>(`.flow-editable[data-id="${id}"][data-kind="${kind}"]`);
		return title ?? this.listEl.querySelector<HTMLElement>(`.flow-editable[data-id="${id}"][data-kind="${kind}"]`);
	}

	private focusState(f: FocusState) {
		let el = this.findEditable(f.id, f.kind);
		if (!el && f.kind === "note") el = this.findEditable(f.id, "text");
		if (!el) return;
		this.focusEl(el, f.start, f.end);
	}

	private focusEl(el: HTMLElement, start: number, end = start) {
		if (this.contentEl.ownerDocument.activeElement !== el) el.focus({ preventScroll: true });
		const len = domText(el).length;
		setCaret(el, Math.min(start, len), Math.min(end, len));
		this.scrollIntoView(el);
	}

	private scrollIntoView(el: HTMLElement) {
		const box = this.contentEl.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		const top = box.top + (this.topbarEl.offsetHeight || 0) + 8;
		if (r.top < top) this.contentEl.scrollTop -= top - r.top;
		else if (r.bottom > box.bottom - 24) this.contentEl.scrollTop += r.bottom - box.bottom + 24;
	}

	private editables(kind?: Kind): HTMLElement[] {
		const all = Array.from(this.pageEl.querySelectorAll<HTMLElement>(".flow-editable"));
		return kind ? all.filter((e) => e.dataset.kind === kind) : all;
	}

	private textEnd(n: FNode): FocusState {
		return { id: n.id, kind: "text", start: n.text.length, end: n.text.length };
	}

	// ------------------------------------------------------------ DOM events

	private nodeOf(el: Element | null): FNode | null {
		const id = (el?.closest("[data-id]") as HTMLElement | null)?.dataset.id;
		return id ? this.byId.get(id) ?? null : null;
	}

	private onFocusIn(e: FocusEvent) {
		const el = (e.target as HTMLElement).closest<HTMLElement>(".flow-editable");
		if (!el) return;
		if (this.selection) this.clearSelection(false);
		const node = this.byId.get(el.dataset.id!);
		if (!node) return;
		if (el.dataset.raw !== "1") {
			el.dataset.raw = "1";
			el.textContent = el.dataset.kind === "text" ? node.text : node.note;
		}
		el.closest(".flow-node")?.addClass("is-focused");
	}

	private onFocusOut(e: FocusEvent) {
		const el = (e.target as HTMLElement).closest<HTMLElement>(".flow-editable");
		if (!el) return;
		this.typingBurst = false;
		this.suggest.close();
		el.closest(".flow-node")?.removeClass("is-focused");
		if (!el.isConnected) return;
		const node = this.byId.get(el.dataset.id!);
		delete el.dataset.raw;
		if (!node) return;
		const kind = el.dataset.kind as Kind;
		if (kind === "note") {
			const trimmed = node.note.replace(/\s+$/, "");
			if (trimmed !== node.note) {
				node.note = trimmed;
				this.unsaved = true;
		this.edited = true;
				this.saveSoon();
			}
			if (!node.note) {
				if (this.noteOpen === node.id) this.noteOpen = null;
				el.remove();
				return;
			}
		}
		this.paint(el, node, kind);
	}

	private onBeforeInput(e: InputEvent) {
		const el = (e.target as HTMLElement).closest?.(".flow-editable");
		if (!el) return;
		if (!this.typingBurst) {
			this.checkpoint();
			this.typingBurst = true;
		}
		window.clearTimeout(this.burstTimer);
		this.burstTimer = window.setTimeout(() => (this.typingBurst = false), 1000);
	}

	private onInput(e: Event) {
		const el = (e.target as HTMLElement).closest<HTMLElement>(".flow-editable");
		if (!el) return;
		const node = this.byId.get(el.dataset.id!);
		if (!node) return;
		if (el.dataset.kind === "text") {
			let t = domText(el);
			if (t.includes("\n")) {
				const c = getCaret(el);
				t = t.replace(/\n/g, " ");
				el.textContent = t;
				if (c) setCaret(el, c.start);
			}
			node.text = t;
			if (node === this.zoom) this.renderCrumbs();
		} else {
			node.note = domText(el);
		}
		this.doc.lossy = false;
		this.unsaved = true;
		this.edited = true;
		this.saveSoon();
		this.suggest.update(el);
	}

	/** Insert text into a note editor ourselves (keeps the DOM as plain text + newlines). */
	private editNote(el: HTMLElement, text: string) {
		const node = this.byId.get(el.dataset.id!);
		if (!node) return;
		if (!this.typingBurst) this.checkpoint();
		this.typingBurst = true;
		window.clearTimeout(this.burstTimer);
		this.burstTimer = window.setTimeout(() => (this.typingBurst = false), 1000);
		insertPlain(el, text);
		node.note = domText(el);
		this.unsaved = true;
		this.edited = true;
		this.saveSoon();
	}

	private onMouseDown(e: MouseEvent) {
		if (e.button !== 0) return;
		const t = e.target as HTMLElement;
		if (t.closest(".flow-toggle, .flow-check")) {
			e.preventDefault();
			return;
		}
		const ed = t.closest<HTMLElement>(".flow-editable");
		if (!ed || ed.dataset.raw === "1") return;
		if (t.closest("a.flow-link, a.flow-tag")) {
			e.preventDefault(); // handled on click, don't start editing
			return;
		}
		const node = this.byId.get(ed.dataset.id!);
		if (!node) return;
		const active = this.activeEditable();
		if (e.shiftKey && active && active.dataset.kind === "text" && ed.dataset.kind === "text" && !ed.dataset.title && !active.dataset.title) {
			e.preventDefault();
			this.startSelection(active.dataset.id!, node.id);
			return;
		}
		e.preventDefault();
		const raw = ed.dataset.kind === "text" ? node.text : node.note;
		const off = rawOffsetFromPoint(ed, e.clientX, e.clientY, raw.length);
		this.focusEl(ed, off);
	}

	private onClick(e: MouseEvent) {
		const t = e.target as HTMLElement;
		if (t.closest(".flow-toggle")) {
			const n = this.nodeOf(t);
			if (n && n.children.length) this.setCollapsed([n], this.isExpanded(n));
			return;
		}
		if (t.closest(".flow-check")) {
			const n = this.nodeOf(t);
			if (n) this.toggleComplete([n]);
			return;
		}
		const ed = t.closest<HTMLElement>(".flow-editable");
		if (ed && ed.dataset.raw === "1") return;
		const link = t.closest<HTMLElement>("a.flow-link");
		if (link) {
			e.preventDefault();
			if (link.dataset.href) {
				// keep the outline where it is: links open in a new tab (Mod-click: per Obsidian's modifier rules)
				void this.app.workspace.openLinkText(link.dataset.href, this.file?.path ?? "", Keymap.isModEvent(e) || "tab");
			} else if (link.dataset.url) {
				window.open(link.dataset.url);
			}
			return;
		}
		const tag = t.closest<HTMLElement>("a.flow-tag");
		if (tag) {
			e.preventDefault();
			const v = tag.dataset.tag!;
			this.setSearch(this.searchEl.value.trim() === v ? "" : v);
			return;
		}
		if (t === this.listEl || t === this.pageEl) {
			const eds = this.editables("text");
			const last = eds[eds.length - 1];
			if (last && last.dataset.title !== "1") {
				const n = this.byId.get(last.dataset.id!);
				if (n) this.focusEl(last, n.text.length);
			}
		}
	}

	private onMouseOver(e: MouseEvent) {
		const link = (e.target as HTMLElement).closest<HTMLElement>("a.internal-link");
		if (!link || !link.dataset.href) return;
		this.app.workspace.trigger("hover-link", {
			event: e,
			source: VIEW_TYPE,
			hoverParent: this,
			targetEl: link,
			linktext: link.dataset.href,
			sourcePath: this.file?.path ?? "",
		});
	}

	private onContextMenu(e: MouseEvent) {
		const t = e.target as HTMLElement;
		if (!t.closest(".flow-bullet")) return;
		const n = this.nodeOf(t);
		if (!n) return;
		e.preventDefault();
		const m = new Menu();
		m.addItem((i) => i.setTitle("Zoom in").setIcon("zoom-in").onClick(() => this.zoomTo(n, "in")));
		m.addItem((i) => i.setTitle(n.completed ? "Uncomplete" : "Complete").setIcon("check").onClick(() => this.toggleComplete([n])));
		m.addItem((i) => i.setTitle(n.checkbox ? "Remove checkbox" : "Add checkbox").setIcon("square-check").onClick(() => this.toggleCheckbox([n])));
		m.addItem((i) => i.setTitle(n.note ? "Edit note" : "Add note").setIcon("file-text").onClick(() => this.openNote(n)));
		m.addSeparator();
		if (n.children.length) {
			m.addItem((i) => i.setTitle("Expand all inside").setIcon("chevrons-up-down").onClick(() => this.expandSubtree(n, true)));
			m.addItem((i) => i.setTitle("Collapse all inside").setIcon("chevrons-down-up").onClick(() => this.expandSubtree(n, false)));
		}
		m.addItem((i) => i.setTitle("Duplicate").setIcon("copy").onClick(() => this.duplicate(n)));
		m.addItem((i) =>
			i
				.setTitle("Copy as Markdown")
				.setIcon("clipboard-copy")
				.onClick(() => void navigator.clipboard.writeText(serializeNodes([n]))),
		);
		m.addSeparator();
		m.addItem((i) => i.setTitle("Delete").setIcon("trash-2").setWarning(true).onClick(() => this.deleteNodes([n])));
		m.showAtMouseEvent(e);
	}

	// ------------------------------------------------------------ bullet: click = zoom, drag = move

	private onPointerDown(e: PointerEvent) {
		const t = e.target as HTMLElement;
		const bullet = t.closest<HTMLElement>(".flow-bullet");
		if (!bullet || e.button !== 0) return;
		const node = this.nodeOf(bullet);
		if (!node) return;
		e.preventDefault();
		const sx = e.clientX;
		const sy = e.clientY;
		let dragging = false;
		bullet.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => {
			if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) {
				dragging = true;
				this.startDrag(node);
			}
			if (dragging) this.updateDrag(ev);
		};
		const up = () => {
			bullet.removeEventListener("pointermove", move);
			bullet.removeEventListener("pointerup", up);
			bullet.removeEventListener("pointercancel", cancel);
			if (dragging) this.endDrag(true);
			else this.zoomTo(node, "in");
		};
		const cancel = () => {
			bullet.removeEventListener("pointermove", move);
			bullet.removeEventListener("pointerup", up);
			bullet.removeEventListener("pointercancel", cancel);
			if (dragging) this.endDrag(false);
		};
		bullet.addEventListener("pointermove", move);
		bullet.addEventListener("pointerup", up);
		bullet.addEventListener("pointercancel", cancel);
	}

	private startDrag(node: FNode) {
		this.activeEditable()?.blur();
		const indicator = this.pageEl.createDiv({ cls: "flow-drop-indicator" });
		this.drag = { node, target: null, mode: "after", indicator };
		this.contentEl.addClass("is-dragging");
		this.listEl.querySelector(`.flow-node[data-id="${node.id}"]`)?.addClass("is-drag-source");
	}

	private updateDrag(e: PointerEvent) {
		const d = this.drag;
		if (!d) return;
		const doc = this.contentEl.ownerDocument;
		const hit = doc.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
		const row = hit?.closest<HTMLElement>(".flow-row");
		const target = row ? this.nodeOf(row) : null;
		if (!row || !target || target === d.node || isAncestor(d.node, target)) {
			d.target = null;
			d.indicator.hide();
			return;
		}
		const r = row.getBoundingClientRect();
		const textEl = row.querySelector<HTMLElement>(".flow-text")!;
		const tr = textEl.getBoundingClientRect();
		let mode: DropMode;
		if (e.clientY < r.top + r.height / 2) mode = "before";
		else if ((target.children.length && this.isExpanded(target)) || e.clientX > tr.left + 28) mode = "child";
		else mode = "after";
		d.target = target;
		d.mode = mode;
		const pr = this.pageEl.getBoundingClientRect();
		const left = (mode === "child" ? tr.left + 20 : tr.left) - pr.left;
		d.indicator.show();
		d.indicator.style.top = `${(mode === "before" ? r.top : r.bottom) - pr.top - 1}px`;
		d.indicator.style.left = `${left}px`;
		d.indicator.style.width = `${Math.max(40, pr.right - pr.left - left - 8)}px`;
	}

	private endDrag(commit: boolean) {
		const d = this.drag;
		this.drag = null;
		this.contentEl.removeClass("is-dragging");
		this.listEl.querySelectorAll(".is-drag-source").forEach((x) => x.removeClass("is-drag-source"));
		if (!d) return;
		d.indicator.remove();
		if (!commit || !d.target) return;
		this.checkpoint();
		if (d.mode === "before") insertBefore(d.target, d.node);
		else if (d.mode === "after") insertAfter(d.target, d.node);
		else {
			insertAt(d.target, d.node, 0);
			d.target.collapsed = false;
		}
		this.changed(null);
	}

	// ------------------------------------------------------------ keyboard

	private isMod(e: KeyboardEvent | MouseEvent) {
		return Platform.isMacOS ? e.metaKey : e.ctrlKey;
	}

	handleKey(e: KeyboardEvent): boolean {
		const t = e.target as HTMLElement;
		// Our scope is only active while this leaf is, so keys aimed at "nothing" (body) are ours too.
		if (!this.contentEl.contains(t) && t !== this.contentEl.doc.body) return false;
		const mod = this.isMod(e);
		const k = e.key;
		const lower = k.length === 1 ? k.toLowerCase() : k;

		if (this.suggest.isOpen && this.suggest.handleKey(e)) return true;

		if (mod && !e.shiftKey && !e.altKey && lower === "k") {
			this.openJump();
			return true;
		}
		if (mod && !e.shiftKey && !e.altKey && lower === "f") {
			this.searchEl.focus();
			this.searchEl.select();
			return true;
		}
		if (t === this.searchEl) return this.handleSearchKey(e);

		if (mod && !e.altKey && lower === "z") {
			if (e.shiftKey) this.redo();
			else this.undo();
			return true;
		}
		if (mod && !e.altKey && !e.shiftKey && lower === "y" && !Platform.isMacOS) {
			this.redo();
			return true;
		}

		if (this.selection) return this.handleSelectionKey(e);

		const zoomIn = (mod && e.altKey && k === "ArrowRight") || (mod && !e.altKey && (k === "]" || e.code === "BracketRight"));
		const zoomOut = (mod && e.altKey && k === "ArrowLeft") || (mod && !e.altKey && (k === "[" || e.code === "BracketLeft"));

		const el = t.closest<HTMLElement>(".flow-editable");
		if (!el) {
			if (zoomOut) {
				this.zoomOut();
				return true;
			}
			if (zoomIn) return true;
			if (k === "Escape" && this.searchEl.value) {
				this.setSearch("");
				return true;
			}
			if ((k === "ArrowDown" || k === "Enter") && !mod && !e.altKey && !e.shiftKey) {
				this.focusFirstItem();
				return true;
			}
			return false;
		}

		const node = this.byId.get(el.dataset.id!);
		if (!node) return false;
		const kind = el.dataset.kind as Kind;
		const isTitle = el.dataset.title === "1";
		const caret = getCaret(el) ?? { start: 0, end: 0 };
		const len = domText(el).length;
		const collapsedSel = caret.start === caret.end;
		const plain = !mod && !e.altKey && !e.shiftKey;

		if (zoomIn) {
			if (!isTitle) this.zoomTo(node, "in");
			return true;
		}
		if (zoomOut) {
			this.zoomOut();
			return true;
		}

		switch (k) {
			case "Enter":
				if (mod && !e.altKey) {
					this.toggleComplete([node]);
					return true;
				}
				if (e.shiftKey && !e.altKey) {
					if (kind === "text") this.openNote(node);
					else this.focusState(this.textEnd(node));
					return true;
				}
				if (plain) {
					if (kind === "note") {
						this.editNote(el, "\n");
						return true;
					}
					this.onEnter(node, caret, isTitle);
					return true;
				}
				return false;
			case "Tab":
				if (mod || e.altKey) return false;
				if (!isTitle) {
					if (e.shiftKey) this.outdent([node]);
					else this.indent([node]);
				}
				return true;
			case "Backspace":
			case "Delete":
				if (mod && e.shiftKey) {
					if (!isTitle) this.deleteNodes([node]);
					return true;
				}
				if (mod || e.altKey || e.shiftKey || !collapsedSel) return false;
				if (kind === "note") {
					if (len === 0) {
						this.noteOpen = null;
						this.focusState(this.textEnd(node));
						return true;
					}
					return false;
				}
				if (isTitle) return false;
				if (k === "Backspace" && caret.start === 0) return this.onBackspaceAtStart(el, node);
				if (k === "Delete" && caret.end === len) return this.onDeleteAtEnd(el, node);
				return false;
			case "ArrowUp":
			case "ArrowDown": {
				const up = k === "ArrowUp";
				if (mod && !e.shiftKey && !e.altKey) {
					if (!isTitle) this.setCollapsed([node], up);
					return true;
				}
				if ((mod || e.altKey) && e.shiftKey) {
					if (!isTitle) this.moveBlock([node], up ? -1 : 1);
					return true;
				}
				if (e.shiftKey && !mod && !e.altKey && kind === "text" && !isTitle) {
					const atEdge = up ? caret.start === 0 || (collapsedSel && caretOnFirstLine(el)) : caret.end === len || (collapsedSel && caretOnLastLine(el));
					if (atEdge && (up ? caret.start === 0 : caret.end === len)) {
						const ids = this.rowIds();
						const i = ids.indexOf(node.id);
						const j = Math.max(0, Math.min(ids.length - 1, i + (up ? -1 : 1)));
						this.startSelection(node.id, ids[j]);
						return true;
					}
					return false;
				}
				if (plain) {
					const edge = up ? caretOnFirstLine(el) : caretOnLastLine(el);
					if (!edge) return false;
					return this.moveFocus(el, up ? -1 : 1);
				}
				return false;
			}
			case "Escape":
				if (kind === "note") {
					this.focusState(this.textEnd(node));
					return true;
				}
				if (this.searchEl.value && isTitle) {
					this.setSearch("");
					return true;
				}
				if (!isTitle) this.startSelection(node.id, node.id);
				else el.blur();
				return true;
		}

		if (mod && !e.altKey && !e.shiftKey) {
			switch (lower) {
				case "l":
					this.toggleCheckbox([node]);
					return true;
				case "b":
					this.wrapSelection(el, "**");
					return true;
				case "i":
					this.wrapSelection(el, "*");
					return true;
				case "a":
					if (kind === "text" && !isTitle && caret.start === 0 && caret.end === len) {
						const ids = this.rowIds();
						if (ids.length) this.startSelection(ids[0], ids[ids.length - 1]);
						return true;
					}
					return false;
			}
		}
		if (mod && e.shiftKey && !e.altKey && lower === "d") {
			this.duplicate(node);
			return true;
		}
		return false;
	}

	private handleSearchKey(e: KeyboardEvent): boolean {
		if (e.key === "Escape") {
			if (this.searchEl.value) this.setSearch("");
			else this.focusFirstItem();
			return true;
		}
		if ((e.key === "Enter" || e.key === "ArrowDown") && !e.shiftKey) {
			this.searchSoon.run();
			this.focusFirstItem();
			return true;
		}
		return false;
	}

	private focusFirstItem() {
		const first = this.listEl.querySelector<HTMLElement>(".flow-editable[data-kind='text']");
		if (first) this.focusEl(first, 0);
	}

	private moveFocus(el: HTMLElement, dir: -1 | 1): boolean {
		const eds = this.editables();
		const i = eds.indexOf(el);
		const target = eds[i + dir];
		if (!target) return false;
		const x = caretX(el);
		target.focus({ preventScroll: true });
		const len = domText(target).length;
		let off: number | null = null;
		if (x !== null) off = offsetAtX(target, x, dir < 0 ? "last" : "first");
		this.focusEl(target, off ?? (dir < 0 ? len : 0));
		return true;
	}

	// ------------------------------------------------------------ block selection

	private rowIds(): string[] {
		return Array.from(this.listEl.querySelectorAll<HTMLElement>(".flow-node")).map((n) => n.dataset.id!);
	}

	private startSelection(anchor: string, head: string) {
		this.activeEditable()?.blur();
		this.selection = { anchor, head };
		this.contentEl.focus({ preventScroll: true });
		this.applySelectionClasses();
	}

	private clearSelection(focusHead = false) {
		const s = this.selection;
		this.selection = null;
		this.listEl.querySelectorAll(".flow-node.is-selected").forEach((r) => r.removeClass("is-selected"));
		if (focusHead && s) {
			const n = this.byId.get(s.head);
			if (n) this.focusState(this.textEnd(n));
		}
	}

	private selectedIds(): string[] {
		if (!this.selection) return [];
		const ids = this.rowIds();
		let a = ids.indexOf(this.selection.anchor);
		let b = ids.indexOf(this.selection.head);
		if (a < 0 || b < 0) return [];
		if (a > b) [a, b] = [b, a];
		return ids.slice(a, b + 1);
	}

	private selectedRoots(): FNode[] {
		const nodes = this.selectedIds().map((id) => this.byId.get(id)!).filter(Boolean);
		const set = new Set(nodes);
		return nodes.filter((n) => {
			for (let p = n.parent; p; p = p.parent) if (set.has(p)) return false;
			return true;
		});
	}

	private applySelectionClasses() {
		const sel = new Set(this.selectedIds());
		this.listEl.querySelectorAll<HTMLElement>(".flow-node").forEach((n) => n.toggleClass("is-selected", sel.has(n.dataset.id!)));
		const head = this.selection && this.listEl.querySelector<HTMLElement>(`.flow-node[data-id="${this.selection.head}"] > .flow-row`);
		if (head) this.scrollIntoView(head);
	}

	private handleSelectionKey(e: KeyboardEvent): boolean {
		const s = this.selection!;
		const mod = this.isMod(e);
		const k = e.key;
		const lower = k.length === 1 ? k.toLowerCase() : k;
		const roots = this.selectedRoots();
		switch (k) {
			case "Escape":
				this.clearSelection();
				return true;
			case "Enter":
				if (mod) {
					this.toggleComplete(roots);
					return true;
				}
				this.clearSelection(true);
				return true;
			case "ArrowUp":
			case "ArrowDown": {
				const up = k === "ArrowUp";
				if ((mod || e.altKey) && e.shiftKey) {
					this.moveBlock(roots, up ? -1 : 1);
					return true;
				}
				if (mod) {
					this.setCollapsed(roots, up);
					return true;
				}
				const ids = this.rowIds();
				const i = ids.indexOf(s.head);
				const j = Math.max(0, Math.min(ids.length - 1, i + (up ? -1 : 1)));
				this.selection = e.shiftKey ? { anchor: s.anchor, head: ids[j] } : { anchor: ids[j], head: ids[j] };
				this.applySelectionClasses();
				return true;
			}
			case "Tab":
				if (e.shiftKey) this.outdent(roots);
				else this.indent(roots);
				return true;
			case "Backspace":
			case "Delete":
				this.deleteNodes(roots);
				return true;
		}
		if (mod && !e.altKey) {
			if (lower === "c" || lower === "x") {
				void navigator.clipboard.writeText(serializeNodes(roots));
				if (lower === "x") this.deleteNodes(roots);
				return true;
			}
			if (lower === "a") {
				const ids = this.rowIds();
				this.selection = { anchor: ids[0], head: ids[ids.length - 1] };
				this.applySelectionClasses();
				return true;
			}
			if (lower === "l") {
				this.toggleCheckbox(roots);
				return true;
			}
			if (lower === "d" && e.shiftKey) {
				roots.forEach((r) => this.duplicate(r));
				return true;
			}
			if (k === "]" || e.code === "BracketRight" || (e.altKey && k === "ArrowRight")) {
				const n = this.byId.get(s.head);
				if (n) this.zoomTo(n, "in");
				return true;
			}
		}
		if (mod && e.altKey && k === "ArrowRight") {
			const n = this.byId.get(s.head);
			if (n) this.zoomTo(n, "in");
			return true;
		}
		if ((mod && e.altKey && k === "ArrowLeft") || (mod && (k === "[" || e.code === "BracketLeft"))) {
			this.zoomOut();
			return true;
		}
		return false;
	}

	private onPaste(e: ClipboardEvent) {
		const el = (e.target as HTMLElement).closest<HTMLElement>(".flow-editable");
		if (!el) return;
		const node = this.byId.get(el.dataset.id!);
		if (!node) return;
		e.preventDefault();
		const raw = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
		const doc = el.ownerDocument;
		if (el.dataset.kind === "note") {
			this.editNote(el, raw);
			return;
		}
		const text = raw.replace(/\n+$/, "").replace(/^\n+/, "");
		if (!text.includes("\n")) {
			doc.execCommand("insertText", false, text);
			return;
		}
		// Multi-line paste: each line (or Markdown list item) becomes an item. Plain indented text
		// (no list markers at all) nests by indentation, like Workflowy.
		const lines = text.split("\n");
		const isList = lines.some((l) => /^[ \t]*([-*+]|\d{1,9}[.)])([ \t]|$)/.test(l));
		const md = isList ? text : lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0] + "- " + l.trim()).join("\n");
		const items = parseOutline(md).root.children;
		if (!items.length) return;
		this.checkpoint();
		this.typingBurst = false;
		let last: FNode;
		if (el.dataset.title === "1") {
			items.forEach((n, i) => insertAt(node, n, i));
			last = items[items.length - 1];
		} else {
			let anchor = node;
			let rest = items;
			if (!node.text && !node.children.length && !node.note) {
				const [first, ...others] = items;
				node.text = first.text;
				node.note = first.note;
				node.checkbox = first.checkbox;
				node.completed = first.completed;
				for (const k of first.children.slice()) insertAt(node, k, node.children.length);
				rest = others;
			}
			for (const n of rest) {
				insertAfter(anchor, n);
				anchor = n;
			}
			last = anchor;
		}
		for (const n of items) walk(n, (d) => this.forceShow.add(d.id));
		this.changed(this.textEnd(last));
	}

	private onCopy(e: ClipboardEvent, cut: boolean) {
		if (!this.selection) return;
		const roots = this.selectedRoots();
		e.preventDefault();
		e.clipboardData?.setData("text/plain", serializeNodes(roots));
		if (cut) this.deleteNodes(roots);
	}

	// ------------------------------------------------------------ operations

	private prevShownSibling(n: FNode): FNode | null {
		const sibs = n.parent!.children;
		for (let i = sibs.indexOf(n) - 1; i >= 0; i--) if (this.isShown(sibs[i])) return sibs[i];
		return null;
	}

	private nextShownSibling(n: FNode): FNode | null {
		const sibs = n.parent!.children;
		for (let i = sibs.indexOf(n) + 1; i < sibs.length; i++) if (this.isShown(sibs[i])) return sibs[i];
		return null;
	}

	private onEnter(node: FNode, caret: { start: number; end: number }, isTitle: boolean) {
		this.checkpoint();
		this.typingBurst = false;
		if (isTitle) {
			const c = createNode("");
			insertAt(node, c, 0);
			this.forceShow.add(c.id);
			this.changed({ id: c.id, kind: "text", start: 0, end: 0 });
			return;
		}
		const text = node.text;
		if (caret.start === 0 && caret.end === 0 && text.length > 0) {
			const c = createNode("");
			c.checkbox = node.checkbox;
			insertBefore(node, c);
			this.forceShow.add(c.id);
			this.changed({ id: node.id, kind: "text", start: 0, end: 0 });
			return;
		}
		node.text = text.slice(0, caret.start);
		const c = createNode(text.slice(caret.end));
		c.checkbox = node.checkbox;
		if (node.children.length && this.isExpanded(node)) insertAt(node, c, 0);
		else insertAfter(node, c);
		this.forceShow.add(c.id);
		this.changed({ id: c.id, kind: "text", start: 0, end: 0 });
	}

	private onBackspaceAtStart(el: HTMLElement, node: FNode): boolean {
		const eds = this.editables("text");
		const prevEl = eds[eds.indexOf(el) - 1];
		const prev = prevEl ? this.byId.get(prevEl.dataset.id!) : undefined;
		if (!node.text && !node.children.length && !node.note) {
			this.checkpoint();
			let focus: FocusState | null = null;
			if (prev) focus = this.textEnd(prev);
			else {
				const nextEl = eds[eds.indexOf(el) + 1];
				const next = nextEl && this.byId.get(nextEl.dataset.id!);
				if (next) focus = { id: next.id, kind: "text", start: 0, end: 0 };
			}
			detach(node);
			this.changed(focus);
			return true;
		}
		if (!prev || prevEl.dataset.title === "1") return false;
		if (prev.children.length && prev !== node.parent && node.children.length) {
			// both have children and they're not parent/child: ambiguous merge, refuse like Workflowy
			return true;
		}
		this.checkpoint();
		const at = prev.text.length;
		mergeInto(prev, node);
		this.changed({ id: prev.id, kind: "text", start: at, end: at });
		return true;
	}

	private onDeleteAtEnd(el: HTMLElement, node: FNode): boolean {
		const eds = this.editables("text");
		const nextEl = eds[eds.indexOf(el) + 1];
		const next = nextEl ? this.byId.get(nextEl.dataset.id!) : undefined;
		if (!next) return false;
		if (next.children.length && node.children.length && next.parent !== node) return true;
		this.checkpoint();
		const at = node.text.length;
		mergeInto(node, next);
		this.changed({ id: node.id, kind: "text", start: at, end: at });
		return true;
	}

	private sortByDocOrder(nodes: FNode[]): FNode[] {
		const order = new Map<FNode, number>();
		let i = 0;
		walk(this.doc.root, (n) => order.set(n, i++));
		return nodes.slice().sort((a, b) => order.get(a)! - order.get(b)!);
	}

	indent(nodes: FNode[]) {
		const list = this.sortByDocOrder(nodes).filter((n) => n !== this.zoom);
		if (!list.length) return;
		this.checkpoint();
		let moved = false;
		for (const n of list) {
			const prev = this.prevShownSibling(n);
			if (!prev) continue;
			insertAt(prev, n, prev.children.length);
			prev.collapsed = false;
			moved = true;
		}
		if (moved) this.changed();
		else this.undoStack.pop();
	}

	outdent(nodes: FNode[]) {
		const list = this.sortByDocOrder(nodes).reverse();
		this.checkpoint();
		let moved = false;
		for (const n of list) {
			const p = n.parent;
			if (!p || p === this.zoom || !p.parent || n === this.zoom) continue;
			insertAfter(p, n);
			moved = true;
		}
		if (moved) this.changed();
		else this.undoStack.pop();
	}

	moveBlock(nodes: FNode[], dir: -1 | 1) {
		const list = this.sortByDocOrder(nodes);
		if (!list.length) return;
		const parent = list[0].parent;
		if (!parent || list.some((n) => n.parent !== parent || n === this.zoom)) return;
		const first = list[0];
		const last = list[list.length - 1];
		this.checkpoint();
		if (dir < 0) {
			const prev = this.prevShownSibling(first);
			if (prev) {
				detach(prev); // before computing the index, or it's off by one
				insertAt(parent, prev, parent.children.indexOf(last) + 1);
			}
			else if (parent !== this.zoom && parent.parent) {
				const ps = this.prevShownSibling(parent);
				if (ps) {
					for (const n of list) insertAt(ps, n, ps.children.length);
					ps.collapsed = false;
				} else for (const n of list) insertBefore(parent, n);
			} else return void this.undoStack.pop();
		} else {
			const next = this.nextShownSibling(last);
			if (next) {
				detach(next);
				insertAt(parent, next, parent.children.indexOf(first));
			}
			else if (parent !== this.zoom && parent.parent) {
				const ns = this.nextShownSibling(parent);
				if (ns) {
					list.forEach((n, i) => insertAt(ns, n, i));
					ns.collapsed = false;
				} else for (const n of list.slice().reverse()) insertAfter(parent, n);
			} else return void this.undoStack.pop();
		}
		this.changed();
	}

	private nextFocusAfter(nodes: FNode[]): FocusState | null {
		const eds = this.editables("text").filter((e) => e.dataset.title !== "1");
		const ids = new Set<string>();
		for (const n of nodes) walk(n, (d) => ids.add(d.id));
		const idx = eds.map((e) => ids.has(e.dataset.id!));
		const firstI = idx.indexOf(true);
		const lastI = idx.lastIndexOf(true);
		const after = eds.slice(lastI + 1).find((e) => !ids.has(e.dataset.id!));
		if (after) return { id: after.dataset.id!, kind: "text", start: 0, end: 0 };
		const before = firstI > 0 ? eds[firstI - 1] : undefined;
		if (before) {
			const n = this.byId.get(before.dataset.id!);
			if (n) return this.textEnd(n);
		}
		return null;
	}

	deleteNodes(nodes: FNode[]) {
		const list = nodes.filter((n) => n !== this.zoom && n !== this.doc.root);
		if (!list.length) return;
		this.checkpoint();
		const eds = this.editables("text").filter((e) => e.dataset.title !== "1");
		const ids = new Set<string>();
		for (const n of list) walk(n, (d) => ids.add(d.id));
		const firstI = eds.findIndex((e) => ids.has(e.dataset.id!));
		const before = firstI > 0 ? this.byId.get(eds[firstI - 1].dataset.id!) : undefined;
		let focus: FocusState | null = before ? this.textEnd(before) : this.nextFocusAfter(list);
		for (const n of list) detach(n);
		this.selection = null;
		if (!focus && this.zoom !== this.doc.root) focus = this.textEnd(this.zoom);
		this.changed(focus);
	}

	toggleComplete(nodes: FNode[]) {
		if (!nodes.length) return;
		this.checkpoint();
		const v = !nodes.every((n) => n.completed);
		let focus: FocusState | null | undefined = undefined;
		if (v && !this.plugin.settings.showCompleted && !this.selection) {
			const cur = this.currentFocus();
			if (cur && nodes.some((n) => n.id === cur.id)) focus = this.nextFocusAfter(nodes);
		}
		for (const n of nodes) n.completed = v;
		if (v && !this.plugin.settings.showCompleted && this.selection) this.selection = null;
		this.changed(focus);
	}

	toggleCheckbox(nodes: FNode[]) {
		if (!nodes.length) return;
		this.checkpoint();
		const v = !nodes.every((n) => n.checkbox);
		for (const n of nodes) {
			n.checkbox = v;
			if (!v) n.completed = false;
		}
		this.changed();
	}

	setCollapsed(nodes: FNode[], collapsed: boolean) {
		let any = false;
		for (const n of nodes) {
			if (!n.children.length || n === this.zoom) continue;
			if (this.visibleSet) continue; // search view ignores collapse state
			if (n.collapsed !== collapsed) {
				n.collapsed = collapsed;
				any = true;
			}
		}
		if (!any) return;
		this.render();
		this.persistSoon();
	}

	expandSubtree(n: FNode, expand: boolean) {
		walk(n, (d) => {
			if (d !== n && d.children.length) d.collapsed = !expand;
		});
		n.collapsed = !expand && n !== this.zoom;
		if (n === this.zoom && !expand) for (const c of n.children) c.collapsed = c.children.length > 0;
		this.render();
		this.persistSoon();
	}

	expandAll(expand: boolean) {
		if (expand) this.expandSubtree(this.zoom, true);
		else {
			walk(this.zoom, (d) => {
				if (d !== this.zoom && d.children.length) d.collapsed = true;
			});
			this.render(null);
			this.persistSoon();
		}
	}

	duplicate(n: FNode) {
		if (n === this.zoom || !n.parent) return;
		this.checkpoint();
		const c = cloneTree(n);
		insertAfter(n, c);
		this.forceShow.add(c.id);
		this.changed(this.textEnd(c));
	}

	openNote(n: FNode) {
		this.noteOpen = n.id;
		this.render({ id: n.id, kind: "note", start: n.note.length, end: n.note.length });
	}

	appendChild(parent: FNode) {
		this.checkpoint();
		const c = createNode("");
		insertAt(parent, c, parent.children.length);
		parent.collapsed = false;
		this.forceShow.add(c.id);
		this.changed({ id: c.id, kind: "text", start: 0, end: 0 });
	}

	/** Used by quick capture when this file is open. */
	addTopLevel(text: string) {
		this.checkpoint();
		const n = createNode(text);
		const root = this.doc.root;
		if (root.children.length === 1 && !root.children[0].text && !root.children[0].children.length) detach(root.children[0]);
		insertAt(root, n, 0);
		this.changed(null);
	}

	private wrapSelection(el: HTMLElement, marker: string) {
		const c = getCaret(el);
		if (!c) return;
		const text = domText(el);
		const inner = text.slice(c.start, c.end);
		const before = text.slice(Math.max(0, c.start - marker.length), c.start);
		const after = text.slice(c.end, c.end + marker.length);
		const doc = el.ownerDocument;
		if (before === marker && after === marker) {
			setCaret(el, c.start - marker.length, c.end + marker.length);
			doc.execCommand("insertText", false, inner);
			setCaret(el, c.start - marker.length, c.end - marker.length);
		} else {
			doc.execCommand("insertText", false, marker + inner + marker);
			setCaret(el, c.start + marker.length, c.end + marker.length);
		}
	}

	// ------------------------------------------------------------ zoom & search

	zoomTo(n: FNode, dir: "in" | "out", focus?: FocusState | null) {
		if (n === this.zoom) return;
		const from = this.zoom;
		this.zoom = n;
		this.noteOpen = null;
		this.selection = null;
		if (this.searchEl.value) {
			this.searchEl.value = "";
			this.query = parseQuery("");
			this.contentEl.removeClass("is-searching");
		}
		this.forceShow.clear();
		if (focus === undefined) {
			if (dir === "out" && isAncestor(n, from)) {
				// land on the child we came from
				let c = from;
				while (c.parent && c.parent !== n && c.parent.collapsed === false) c = c.parent;
				focus = this.textEnd(c);
			} else {
				const first = n.children.find((c) => this.isShown(c));
				focus = first ? { id: first.id, kind: "text", start: 0, end: 0 } : n === this.doc.root ? null : this.textEnd(n);
			}
		}
		this.pageEl.removeClass("flow-anim-in", "flow-anim-out");
		void this.pageEl.offsetWidth;
		this.pageEl.addClass(dir === "in" ? "flow-anim-in" : "flow-anim-out");
		this.contentEl.scrollTop = 0;
		this.render(focus);
		this.persistSoon();
	}

	zoomOut() {
		const p = this.zoom.parent;
		if (p) this.zoomTo(p, "out");
	}

	reveal(n: FNode) {
		if (n.children.length) {
			this.zoomTo(n, "in", this.textEnd(n));
			return;
		}
		const parent = n.parent ?? this.doc.root;
		for (let p = n.parent; p && p !== parent; p = p.parent) p.collapsed = false;
		if (parent === this.zoom) this.render(this.textEnd(n));
		else this.zoomTo(parent, "in", this.textEnd(n));
	}

	setSearch(q: string) {
		this.searchEl.value = q;
		this.query = parseQuery(q);
		this.forceShow.clear();
		this.contentEl.toggleClass("is-searching", !this.query.empty);
		this.render(null);
	}

	openJump() {
		new JumpModal(this).open();
	}
}

class JumpModal extends FuzzySuggestModal<FNode> {
	private labels = new Map<FNode, string>();

	constructor(private view: OutlineView) {
		super(view.app);
		this.setPlaceholder("Jump to item…");
		this.setInstructions([
			{ command: "↵", purpose: "zoom to item" },
			{ command: "esc", purpose: "dismiss" },
		]);
	}

	getItems(): FNode[] {
		const out: FNode[] = [];
		const rec = (n: FNode, prefix: string) => {
			for (const c of n.children) {
				const label = plainText(c.text) || "Untitled";
				this.labels.set(c, prefix ? `${label}  ·  ${prefix}` : label);
				out.push(c);
				rec(c, prefix ? `${prefix} › ${label}` : label);
			}
		};
		rec(this.view.doc.root, "");
		return out;
	}

	getItemText(n: FNode): string {
		return this.labels.get(n) ?? n.text;
	}

	onChooseItem(n: FNode): void {
		this.view.reveal(n);
	}
}
