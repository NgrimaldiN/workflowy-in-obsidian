import {
	App,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	ViewState,
	WorkspaceLeaf,
	debounce,
	normalizePath,
} from "obsidian";
import { OutlineView, VIEW_TYPE } from "./view";
import { createNode, insertAt, parseOutline, serializeOutline } from "./model";

interface Settings {
	homeFile: string;
	showCompleted: boolean;
}

interface OutlineState {
	collapsed: string[];
	zoom: string;
}

interface Data {
	settings: Settings;
	states: Record<string, OutlineState>;
}

const DEFAULTS: Settings = { homeFile: "Outline.md", showCompleted: true };
const FRONTMATTER_KEY = "flow-outliner";

const WELCOME = `- Welcome to your outline. Everything here is a bullet, saved as a plain Markdown list.
	- Press Enter for a new bullet, Tab / Shift-Tab to indent and outdent
	- Click any bullet to zoom into it. The breadcrumbs above take you back out.
		- You can nest as deep as you like
			- Really deep
	- Cmd-Enter completes an item, Cmd-↑ / Cmd-↓ collapse and expand
	- Drag a bullet to move it, or use Cmd-Shift-↑ / ↓
	- Shift-Enter adds a note under an item
	  Notes are for longer text that shouldn't be its own bullet.
	- Type [[ to link a note from your vault, # to tag. Click a #tag to filter.
	- Cmd-K jumps to any item, Cmd-F searches this outline
	- Esc selects the current item; then Shift-↑ / ↓ selects more
- Inbox
- Projects
- Someday
`;

export default class FlowPlugin extends Plugin {
	settings: Settings = { ...DEFAULTS };
	private states: Record<string, OutlineState> = {};
	/** Leaves where the user explicitly asked for Markdown, and for which file. */
	private markdownLeaves = new WeakMap<WorkspaceLeaf, string>();
	private saveDataSoon = debounce(() => void this.persist(), 1000, true);

	async onload() {
		const data = ((await this.loadData()) ?? {}) as Partial<Data>;
		this.settings = { ...DEFAULTS, ...(data.settings ?? {}) };
		this.states = data.states ?? {};

		this.registerView(VIEW_TYPE, (leaf) => new OutlineView(leaf, this));
		this.registerHoverLinkSource(VIEW_TYPE, { display: "Flow Outliner", defaultMod: true });
		this.addRibbonIcon("list-tree", "Open outline", () => void this.openHome());

		this.addCommand({ id: "open-home", name: "Open home outline", callback: () => void this.openHome() });
		this.addCommand({
			id: "toggle-view",
			name: "Toggle outline / Markdown view for this note",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				const view = leaf?.view;
				const ok = view instanceof OutlineView || (view instanceof MarkdownView && !!view.file);
				if (ok && !checking && leaf) void this.toggleViewMode(leaf);
				return ok;
			},
		});
		this.addCommand({
			id: "jump",
			name: "Jump to item",
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(OutlineView);
				if (v && !checking) v.openJump();
				return !!v;
			},
		});
		this.addCommand({
			id: "quick-capture",
			name: "Quick capture to home outline",
			callback: () => new CaptureModal(this.app, (t) => void this.capture(t)).open(),
		});
		this.addCommand({
			id: "toggle-completed",
			name: "Show / hide completed items",
			callback: () => this.toggleShowCompleted(),
		});
		this.addCommand({
			id: "expand-all",
			name: "Expand all",
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(OutlineView);
				if (v && !checking) v.expandAll(true);
				return !!v;
			},
		});
		this.addCommand({
			id: "collapse-all",
			name: "Collapse all",
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(OutlineView);
				if (v && !checking) v.expandAll(false);
				return !!v;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (leaf?.view instanceof OutlineView) return;
				menu.addItem((i) =>
					i
						.setTitle("Open as outline")
						.setIcon("list-tree")
						.onClick(() => void this.openAsOutline(file, leaf)),
				);
			}),
		);

		// Files that are outlines (the home file, or `flow-outliner: true` in frontmatter) open in the outline
		// view. Done at the source (like the Kanban plugin) so it works for every way a file gets opened.
		this.patchSetViewState();

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (this.states[oldPath]) {
					this.states[file.path] = this.states[oldPath];
					delete this.states[oldPath];
					this.saveDataSoon();
				}
				if (oldPath === this.settings.homeFile) {
					this.settings.homeFile = file.path;
					this.saveDataSoon();
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (this.states[file.path]) {
					delete this.states[file.path];
					this.saveDataSoon();
				}
			}),
		);

		this.addSettingTab(new FlowSettingTab(this.app, this));
	}

	onunload() {
		this.saveDataSoon.run();
	}

	private patchSetViewState() {
		const plugin = this;
		const proto = WorkspaceLeaf.prototype as unknown as {
			setViewState: (this: WorkspaceLeaf, state: ViewState, eState?: unknown) => Promise<void>;
		};
		const orig = proto.setViewState;
		let enabled = true;
		const patched = function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
			const path = state?.state?.file;
			if (enabled && state?.type === "markdown" && typeof path === "string" && plugin.markdownLeaves.get(this) !== path) {
				const f = plugin.app.vault.getAbstractFileByPath(path);
				if (f instanceof TFile && plugin.isOutlineFile(f)) state = { ...state, type: VIEW_TYPE };
			}
			return orig.call(this, state, eState);
		};
		proto.setViewState = patched;
		this.register(() => {
			enabled = false;
			if (proto.setViewState === patched) proto.setViewState = orig;
		});
	}

	private async persist() {
		await this.saveData({ settings: this.settings, states: this.states } satisfies Data);
	}

	saveSettings() {
		this.saveDataSoon();
	}

	getOutlineState(path: string): OutlineState | null {
		return this.states[path] ?? null;
	}

	setOutlineState(path: string, st: OutlineState) {
		if (!st.collapsed.length && !st.zoom) delete this.states[path];
		else this.states[path] = st;
		this.saveDataSoon();
	}

	isOutlineFile(file: TFile): boolean {
		if (file.path === this.settings.homeFile) return true;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return !!fm && (fm[FRONTMATTER_KEY] === true || fm[FRONTMATTER_KEY] === "true");
	}

	outlineViews(): OutlineView[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v): v is OutlineView => v instanceof OutlineView);
	}

	toggleShowCompleted() {
		this.settings.showCompleted = !this.settings.showCompleted;
		this.saveSettings();
		for (const v of this.outlineViews()) v.render();
		new Notice(this.settings.showCompleted ? "Showing completed items" : "Hiding completed items", 1500);
	}

	private async homeFile(): Promise<TFile> {
		const path = normalizePath(this.settings.homeFile || DEFAULTS.homeFile);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
		return this.app.vault.create(path, WELCOME);
	}

	async openHome() {
		const file = await this.homeFile();
		// match on the saved state too: background tabs restored at startup are "deferred" (not loaded yet)
		const open = this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.find((l) => (l.view as OutlineView).file?.path === file.path || l.getViewState().state?.file === file.path);
		if (open) {
			await this.app.workspace.revealLeaf(open);
			this.app.workspace.setActiveLeaf(open, { focus: true });
			return;
		}
		await this.openAsOutline(file, this.app.workspace.getLeaf(false));
	}

	async openAsOutline(file: TFile, leaf?: WorkspaceLeaf | null) {
		const target = leaf ?? this.app.workspace.getLeaf(false);
		this.markdownLeaves.delete(target);
		await target.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
	}

	async toggleViewMode(leaf: WorkspaceLeaf) {
		const view = leaf.view;
		if (view instanceof OutlineView) {
			const file = view.file;
			if (!file) return;
			this.markdownLeaves.set(leaf, file.path);
			await leaf.setViewState({ type: "markdown", state: { file: file.path }, active: true });
		} else if (view instanceof MarkdownView && view.file) {
			await this.openAsOutline(view.file, leaf);
		}
	}

	async capture(text: string) {
		text = text.replace(/\s*\n\s*/g, " ").trim();
		if (!text) return;
		const file = await this.homeFile();
		const view = this.outlineViews().find((v) => v.file?.path === file.path);
		if (view) view.addTopLevel(text);
		else {
			await this.app.vault.process(file, (data) => {
				const doc = parseOutline(data);
				const n = createNode(text);
				insertAt(doc.root, n, 0);
				return serializeOutline(doc);
			});
		}
		new Notice(`Added to ${file.basename}`, 1500);
	}
}

class CaptureModal extends Modal {
	constructor(app: App, private onSubmit: (text: string) => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Quick capture");
		const input = this.contentEl.createEl("input", {
			cls: "flow-capture-input",
			attr: { type: "text", placeholder: "Add to the top of your outline…" },
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				this.onSubmit(input.value);
				this.close();
			}
		});
		window.setTimeout(() => input.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}

const SHORTCUTS: [string, string][] = [
	["Enter", "New item (splits the text at the cursor)"],
	["Shift-Enter", "Add / edit the note under an item"],
	["Tab / Shift-Tab", "Indent / outdent"],
	["Cmd-Enter", "Complete / uncomplete"],
	["Cmd-↑ / Cmd-↓", "Collapse / expand"],
	["Cmd-Shift-↑ / ↓ (or Alt-Shift)", "Move item up / down"],
	["Cmd-Alt-→ / Cmd-Alt-← (or Cmd-] / Cmd-[)", "Zoom in / zoom out"],
	["Click a bullet", "Zoom in · drag it to move the item · right-click for more"],
	["Cmd-K", "Jump to any item"],
	["Cmd-F", "Search this outline (supports -word, \"phrase\", is:complete)"],
	["Esc, then Shift-↑ / ↓", "Select several items (then Tab, Cmd-Enter, Backspace, Cmd-C…)"],
	["Cmd-L", "Toggle checkbox"],
	["Cmd-B / Cmd-I", "Bold / italic"],
	["Cmd-Shift-D", "Duplicate item"],
	["Cmd-Shift-Backspace", "Delete item"],
	["Cmd-Z / Cmd-Shift-Z", "Undo / redo"],
];

class FlowSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: FlowPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Home outline")
			.setDesc("The note opened by the ribbon icon and used by quick capture. Created on first use.")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULTS.homeFile)
					.setValue(this.plugin.settings.homeFile)
					.onChange((v) => {
						let p = v.trim() || DEFAULTS.homeFile;
						if (!p.endsWith(".md")) p += ".md";
						this.plugin.settings.homeFile = normalizePath(p);
						this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Show completed items")
			.setDesc("Completed items stay visible, struck through. Turn off to hide them.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showCompleted).onChange(() => {
					this.plugin.toggleShowCompleted();
				}),
			);
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: `Any note with "${FRONTMATTER_KEY}: true" in its frontmatter also opens as an outline. Use the command "Toggle outline / Markdown view" to switch back and forth.`,
		});

		new Setting(containerEl).setName("Keyboard shortcuts").setHeading();
		const table = containerEl.createEl("table", { cls: "flow-shortcuts" });
		for (const [k, d] of SHORTCUTS) {
			const tr = table.createEl("tr");
			tr.createEl("td").createEl("kbd", { text: k });
			tr.createEl("td", { text: d });
		}
	}
}
