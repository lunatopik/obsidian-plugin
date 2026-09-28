/**
 * Minimal stand-in for the `obsidian` runtime so the pure logic can be
 * exercised outside of Obsidian. Only the surface the tested code paths
 * touch is implemented.
 *
 * There is deliberately no `fileManager` here: the plugin must not be able to
 * write to a note, and the test suite should not be able to either.
 */
import { createElement } from "./dom-stub.ts";
import type { FakeElement } from "./dom-stub.ts";

export class TFile {
	extension: string;
	path: string;
	basename: string;

	constructor(path = "", extension = "md") {
		this.path = path;
		this.extension = extension;
		this.basename = path.split("/").pop() ?? "";
	}
}

export class TFolder {
	path = "";
	name = "";
}

export class App {
	metadataCache = {
		getFileCache: (): unknown => undefined,
		getFirstLinkpathDest: (): unknown => null,
	};

	/** Files the stub adapter pretends to hold, for the export test. */
	adapterFiles: Record<string, string> = {};
	/** Folders the stub adapter pretends to hold. */
	adapterFolders: Record<string, string[]> = {};
	/** Every path handed to `adapter.write`, in order, so tests can count writes. */
	adapterWrites: string[] = [];
	/** Every `vault.on` callback, so a test can deliver a real save event. */
	vaultListeners: ((file: TFile) => void)[] = [];
	/** Every `openLinkText` call, newest last. */
	openedLinks: { path: string; source: string; newLeaf: boolean }[] = [];

	leaves: WorkspaceLeaf[] = [];
	activeLeaf: WorkspaceLeaf | null = null;
	activeFile: TFile | null = null;
	/** Text an editor holds for a path, i.e. unsaved changes. */
	openEditorBuffers: Record<string, string> = {};

	vault = {
		adapter: {
			exists: async (path: string): Promise<boolean> =>
				path in this.adapterFiles || path in this.adapterFolders,
			read: async (path: string): Promise<string> => this.adapterFiles[path] ?? "",
			write: async (path: string, data: string): Promise<void> => {
				this.adapterFiles[path] = data;
				this.adapterWrites.push(path);
			},
			mkdir: async (path: string): Promise<void> => {
				this.adapterFolders[path] = [];
			},
			/**
			 * Direct children of a folder: everything strictly below it whose
			 * remainder holds no further slash.
			 *
			 * Two details are load-bearing, and a stub that gets either one wrong
			 * fails in a way the test cannot explain. First, the queried path is
			 * normalised to end in a slash: against ".Writer Maps Data/Книга" the
			 * nested folder's remainder is "/Часть 2", which contains a slash, so
			 * the nesting is never discovered. Second, the match is strictly
			 * below — a bare `startsWith` also accepts the folder itself, since
			 * its remainder is empty and holds no slash. A recursive walk is then
			 * handed its own folder as a child and recurses until the heap gives
			 * out. Real `list` never reports a folder as its own child, and
			 * neither does this.
			 */
			list: async (path: string): Promise<{ files: string[]; folders: string[] }> => {
				const base = path.endsWith("/") ? path : `${path}/`;
				const isChild = (candidate: string): boolean =>
					candidate.startsWith(base) && !candidate.slice(base.length).includes("/");
				return {
					files: Object.keys(this.adapterFiles).filter(isChild),
					folders: Object.keys(this.adapterFolders).filter(isChild),
				};
			},
		},
		getAbstractFileByPath: (): unknown => null,
		getFiles: (): unknown[] => [],
		getResourcePath: (file: TFile): string => `app://local/${file.path}`,
		on: (_name: string, callback: (file: TFile) => void) => {
			this.vaultListeners.push(callback);
			return { unsubscribe: () => undefined };
		},
	};

	workspace = {
		getLeavesOfType: (type: string): WorkspaceLeaf[] =>
			this.leaves.filter((leaf) => leaf.viewState.type === type),
		getRightLeaf: (_split: boolean): WorkspaceLeaf | null => this.newLeaf(),
		getLeaf: (_kind: string): WorkspaceLeaf | null => this.newLeaf(),
		revealLeaf: (leaf: WorkspaceLeaf): void => {
			this.activeLeaf = leaf;
		},
		setActiveLeaf: (leaf: WorkspaceLeaf): void => {
			this.activeLeaf = leaf;
		},
		getActiveFile: (): TFile | null => this.activeFile,
		getActiveViewOfType: (type: string): unknown =>
			this.activeLeaf?.viewState.type === type ? this.activeLeaf.view : null,
		openLinkText: (path: string, source: string, newLeaf: boolean): void => {
			this.openedLinks.push({ path, source, newLeaf });
		},
		on: (_name: string, _callback: (...args: unknown[]) => void) => ({
			unsubscribe: () => undefined,
		}),
	};

	/** Create a leaf that already belongs to this workspace, as Obsidian does. */
	newLeaf(): WorkspaceLeaf {
		const leaf = new WorkspaceLeaf(this);
		this.leaves.push(leaf);
		return leaf;
	}

	/** Deliver a vault event, the way a real save does. */
	fireVault(name: "modify", file: TFile): void {
		if (name === "modify") for (const callback of this.vaultListeners) callback(file);
	}

	/**
	 * Save an open editor: the buffer goes to disk, the editor becomes clean,
	 * *then* the event fires.
	 *
	 * The order matters. A test that fires `modify` without writing the buffer
	 * first produces a world that cannot happen — the author's text is on screen
	 * and yet the file behind it is untouched — and code that guards against
	 * clobbering unsaved work will then look broken when it is in fact correct.
	 * Clearing the buffer is the other half of that truth: "unsaved" is a claim
	 * about the editor, not a place the text is kept.
	 */
	saveEditor(path: string): void {
		const buffer = this.openEditorBuffers[path];
		if (buffer === undefined) return;
		this.adapterFiles[path] = buffer;
		delete this.openEditorBuffers[path];
		this.fireVault("modify", { path } as TFile);
	}
}

/**
 * Every notice the plugin has raised, oldest first.
 *
 * Notices are how the plugin answers an action it did not take. Without this
 * log a refusal looks identical to a crash that never ran the code, and the
 * tests would only be able to check the state, not the explanation.
 */
export const noticeLog: string[] = [];

export class Notice {
	message: string;

	constructor(message: string) {
		this.message = message;
		noticeLog.push(message);
	}
}

export function setIcon(): void {
	/* no-op in tests */
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

/* -------------------------------------------------------------------------- *
 * View layer: just enough for the popover and the pawn editor to be tested.  *
 * -------------------------------------------------------------------------- */

/**
 * Every modal opened through the stub, newest last.
 *
 * The real API hands control to Obsidian, so a test cannot reach the modal
 * instance; recording it here is what makes "pick a file, then assert the UI
 * reacted" a test instead of a hope.
 */
export const openedSuggestModals: SuggestModal<unknown>[] = [];

export class WorkspaceLeaf {
	view: unknown = null;
	app: App;
	viewState: { type: string; state?: Record<string, unknown> } = { type: "" };

	constructor(app?: App) {
		// No TS parameter properties: Node runs these files in strip-only mode.
		this.app = app ?? new App();
	}

	async setViewState(state: { type: string; state?: Record<string, unknown> }): Promise<void> {
		this.viewState = state;
	}

	getViewState(): { type: string; state?: Record<string, unknown> } {
		return this.viewState;
	}

	getIcon(): string {
		return "";
	}
}

export class ItemView {
	app: App;
	contentEl: FakeElement;
	leaf: WorkspaceLeaf | null;
	containerEl: FakeElement = createElement();

	constructor(leaf?: WorkspaceLeaf) {
		this.leaf = leaf ?? null;
		this.app = this.leaf?.app ?? new App();
		this.contentEl = createElement();
	}

	getViewType(): string {
		return "";
	}

	getDisplayText(): string {
		return "";
	}

	getIcon(): string {
		return "";
	}

	addAction(): void {
		/* no-op in tests */
	}

	registerEvent(): void {
		/* no-op in tests */
	}

	registerDomEvent(): void {
		/* no-op in tests */
	}
}

export class SuggestModal<T> {
	placeholder = "";
	app: App;

	constructor(app?: App, ..._rest: unknown[]) {
		this.app = app ?? new App();
	}

	/** The real modal registers itself with the workspace; the stub records it. */
	open(): void {
		openedSuggestModals.push(this as unknown as SuggestModal<unknown>);
	}

	setPlaceholder(value: string): void {
		this.placeholder = value;
	}

	getSuggestions(_query: string): T[] {
		return [];
	}

	renderSuggestion(_value: T, _el: FakeElement): void {
		/* no-op in tests */
	}

	onChooseSuggestion(_value: T, _evt: unknown): void {
		/* no-op in tests */
	}
}

export class FuzzySuggestModal<T> extends SuggestModal<T> {
	getItems(): T[] {
		return [];
	}

	getItemText(_item: T): string {
		return "";
	}

	onChooseItem(_item: T, _evt: unknown): void {
		/* no-op in tests */
	}
}

export class Modal {
	app: App;

	constructor(app?: App) {
		this.app = app ?? new App();
	}

	open(): void {
		/* no-op in tests */
	}

	close(): void {
		/* no-op in tests */
	}
}
