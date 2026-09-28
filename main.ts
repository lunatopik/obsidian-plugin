import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { MapView, VIEW_TYPE_MAP } from "./src/map-view";
import { RosterView, VIEW_TYPE_ROSTER } from "./src/roster-view";
import { RelationshipView, VIEW_TYPE_RELATIONSHIP } from "./src/relationship-view";
import { WriterStateMapSettingTab } from "./src/settings";
import { DataStorage, parseSettings } from "./src/storage";
import { pickFromList, pickNote } from "./src/pickers";
import { composePawn } from "./src/pawns";
import { findOrphanKeys, isChapterFile, moveKey, moveKeysForFolder, removeMap } from "./src/store";
import { EXPORT_ROOT, isManagedPath, isNotePath, notePathFor } from "./src/notes";
import { NoteWriter } from "./src/note-writer";
import { DEFAULT_SETTINGS } from "./src/types";
import type { ChapterMaps, Language, Pawn, WriterStateMapSettings } from "./src/types";
import { TranslationKey, t } from "./src/i18n";

/**
 * Plugin entry point.
 *
 * Map data lives entirely in this plugin's data.json (see storage.ts / store.ts).
 * The author's chapter notes are never read and never written: a chapter
 * contributes nothing but its vault-relative path, which is the key under
 * `settings.maps`.
 *
 * The single deliberate exception is the author's own note, kept in the hidden
 * ".Writer Maps Data/" folder and written only between two marker comments by
 * src/note-writer.ts. See src/notes.ts for the rules.
 */
export default class WriterStateMapPlugin extends Plugin {
	settings: WriterStateMapSettings = { ...DEFAULT_SETTINGS };
	storage!: DataStorage;
	notes!: NoteWriter;

	/** Last known chapter path; survives focus moving into the sidebar. */
	private chapterPath: string | null = null;

	async onload(): Promise<void> {
		this.storage = new DataStorage(this);
		await this.loadSettings();
		this.notes = new NoteWriter(this);

		this.registerView(VIEW_TYPE_MAP, (leaf) => new MapView(leaf, this));
		this.registerView(VIEW_TYPE_ROSTER, (leaf) => new RosterView(leaf, this));
		this.registerView(VIEW_TYPE_RELATIONSHIP, (leaf) => new RelationshipView(leaf, this));
		this.addSettingTab(new WriterStateMapSettingTab(this.app, this));

		this.addRibbonIcon("map", t(this.settings.language, "viewMap"), () => {
			void this.openTab("map");
		});
		this.addRibbonIcon("file-text", t(this.settings.language, "viewNote"), () => {
			void this.openTab("note");
		});

		this.addCommand({ id: "open-map", name: t(this.settings.language, "commandOpenMap"), callback: () => void this.openTab("map") });
		this.addCommand({
			id: "open-note",
			name: t(this.settings.language, "commandOpenNote"),
			callback: () => void this.openTab("note"),
		});
		this.addCommand({
			id: "open-roster",
			name: t(this.settings.language, "commandOpenRoster"),
			callback: () => void this.openTab("roster"),
		});
		this.addCommand({
			id: "open-relationship",
			name: t(this.settings.language, "commandOpenRelationship"),
			callback: () => void this.openTab("relationship"),
		});
		this.addCommand({
			id: "forget-chapter",
			name: t(this.settings.language, "commandForgetChapter"),
			callback: () => void this.forgetChapter(),
		});
		this.addCommand({
			id: "attach-map",
			name: t(this.settings.language, "commandAttachMap"),
			callback: () => void this.attachOrphanMap(),
		});
		this.addCommand({
			id: "cleanup-orphans",
			name: t(this.settings.language, "commandCleanupOrphans"),
			callback: () => void this.cleanupOrphanMaps(),
		});
		this.addCommand({
			id: "export-data",
			name: t(this.settings.language, "commandExportData"),
			callback: () => void this.exportData(),
		});
		this.addCommand({
			id: "import-data",
			name: t(this.settings.language, "commandImportData"),
			callback: () => void this.importData("merge"),
		});
		this.addCommand({
			id: "reload-data",
			name: t(this.settings.language, "commandReloadData"),
			callback: () => void this.reloadData(),
		});
		this.addCommand({
			id: "update-note",
			name: t(this.settings.language, "commandUpdateNote"),
			callback: () => void this.updateNoteNow(),
		});
		this.addCommand({
			id: "export-notes",
			name: t(this.settings.language, "commandExportNotes"),
			callback: () => void this.exportNotes(),
		});

		// Chapter switching. Leaves that are our own views are ignored: clicking
		// into the sidebar must not clear the map.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
				if (leaf && this.isOurLeaf(leaf)) return;
				this.syncChapter();
			}),
		);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.syncChapter()));

		// Maps are keyed by path, so a renamed chapter has to carry its map along.
		// Deleting a file deliberately does nothing: the map is kept, not lost.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const moved =
					file instanceof TFile
						? moveKey(this.settings.maps, oldPath, file.path)
						: moveKeysForFolder(this.settings.maps, oldPath, file.path);
				if (!moved) return;
				this.storage.requestSave();
				if (oldPath === this.chapterPath) this.syncChapter();
				else this.refreshAllViews();
			}),
		);

		this.app.workspace.onLayoutReady(() => this.syncChapter());
	}

	onunload(): void {
		void this.storage?.dispose();
		this.notes?.cancelAll();
		this.chapterPath = null;
	}

	/* ------------------------------------------------------------------ */
	/* Settings                                                             */
	/* ------------------------------------------------------------------ */

	async loadSettings(): Promise<void> {
		this.settings = parseSettings(await this.loadData());
	}

	/** Queue a debounced, serialized write. Every mutation goes through here. */
	requestSave(): void {
		this.storage.requestSave();
	}

	/** Write immediately, for the rare case a caller must not return before it lands. */
	async flushSettings(): Promise<void> {
		await this.storage.flush();
	}

	/** Translate using the currently configured language. */
	t(key: TranslationKey, vars?: Record<string, string | number>): string {
		return t(this.settings.language, key, vars);
	}

	setLanguage(language: Language): void {
		this.settings.language = language;
		this.requestSave();
		this.refreshAllViews();
	}

	/* ------------------------------------------------------------------ */
	/* The single write funnel                                               */
	/* ------------------------------------------------------------------ */

	/**
	 * Mutate one chapter's map and queue a save. This is the only way a map may
	 * be changed, so a write can never target the wrong chapter by accident —
	 * the path handed to `mutate` is the one this call was given.
	 * Repainting is the caller's business: a view already showing the change
	 * only needs to re-render itself.
	 */
	updateMap<T>(path: string, mutate: (maps: ChapterMaps, mapPath: string) => T): T {
		const result = mutate(this.settings.maps, path);
		this.requestSave();
		// The note is content-driven: a pure node drag leaves the fingerprint
		// unchanged and costs no disk write.
		this.notes?.schedule(path);
		return result;
	}

	/** Mutate anything structural in settings, then repaint every view. */
	mutateSettings<T>(mutate: (settings: WriterStateMapSettings) => T): T {
		const result = mutate(this.settings);
		this.requestSave();
		this.refreshAllViews();
		return result;
	}

	/* ------------------------------------------------------------------ */
	/* Roster                                                               */
	/* ------------------------------------------------------------------ */

	get pawns(): Pawn[] {
		return this.settings.pawns;
	}

	/** Create a pawn and persist it. Returns null when the name is empty. */
	addPawn(name: string, overrides?: Partial<Pawn>): Pawn | null {
		const pawn = composePawn(name, this.settings.pawns, overrides);
		if (!pawn) return null;

		this.settings.pawns = [...this.settings.pawns, pawn];
		this.requestSave();
		this.notes?.scheduleAll();
		this.refreshAllViews();
		return pawn;
	}

	updatePawn(pawn: Pawn): void {
		this.settings.pawns = this.settings.pawns.map((item) => (item.id === pawn.id ? pawn : item));
		this.requestSave();
		this.notes?.scheduleAll();
		this.refreshAllViews();
	}

	removePawn(id: string): void {
		this.settings.pawns = this.settings.pawns.filter((pawn) => pawn.id !== id);
		this.requestSave();
		this.notes?.scheduleAll();
		this.refreshAllViews();
	}

	/* ------------------------------------------------------------------ */
	/* Map housekeeping                                                     */
	/* ------------------------------------------------------------------ */

	/** Maps whose chapter file is gone from the vault. */
	orphanMapKeys(): string[] {
		return findOrphanKeys(this.settings.maps, this.app.vault.getFiles().map((file) => file.path));
	}

	async forgetChapter(): Promise<void> {
		const path = this.chapterPath;
		if (!path) {
			new Notice(this.t("noticeNoChapter"));
			return;
		}
		if (!window.confirm(this.t("confirmForgetChapter", { path }))) return;

		this.mutateSettings((settings) => removeMap(settings.maps, path));
		new Notice(this.t("noticeMapForgotten", { path }));
	}

	async attachOrphanMap(): Promise<void> {
		const orphans = this.orphanMapKeys();
		if (orphans.length === 0) {
			new Notice(this.t("noticeNoOrphans"));
			return;
		}

		const orphan =
			orphans.length === 1 ? orphans[0] : await pickFromList(this.app, this.settings.language, orphans, "pickerOrphanPlaceholder");
		if (!orphan) return;

		const file = await pickNote(this.app, this.settings.language);
		if (!file) return;

		this.mutateSettings((settings) => moveKey(settings.maps, orphan, file.path));
		new Notice(this.t("noticeMapAttached", { path: file.path }));
	}

	async cleanupOrphanMaps(): Promise<void> {
		const orphans = this.orphanMapKeys();
		if (orphans.length === 0) {
			new Notice(this.t("noticeNoOrphans"));
			return;
		}
		if (!window.confirm(this.t("confirmCleanupOrphans", { count: orphans.length }))) return;

		this.mutateSettings((settings) => {
			for (const path of orphans) delete settings.maps[path];
		});
		new Notice(this.t("noticeOrphansCleaned", { count: orphans.length }));
	}

	async exportData(): Promise<void> {
		try {
			const target = await this.storage.exportTo(this.settings.exportPath);
			new Notice(this.t("noticeExported", { path: target }));
		} catch (error) {
			new Notice(this.t("noticeSaveFailed", { message: String(error) }));
		}
	}

	async importData(mode: "merge" | "replace"): Promise<void> {
		try {
			const result = await this.storage.importFrom(this.settings.exportPath, mode);
			// What is on disk no longer matches what this session wrote.
			this.notes.invalidate();
			this.notes.scheduleAll(0);
			new Notice(this.t("noticeImported", { maps: result.maps, pawns: result.pawns }));
		} catch (error) {
			new Notice(this.t("noticeSaveFailed", { message: String(error) }));
		}
	}

	async reloadData(): Promise<void> {
		if (!window.confirm(this.t("confirmReload"))) return;
		await this.storage.reloadFromDisk();
		this.notes.invalidate();
		this.syncChapter();
		new Notice(this.t("noticeReloaded"));
	}

	/** Manual escape hatch: rewrite the note of the open chapter right now. */
	async updateNoteNow(): Promise<void> {
		const path = this.chapterPath;
		if (!path) {
			new Notice(this.t("noticeNoChapter"));
			return;
		}
		const written = await this.notes.write(path, true);
		if (written) new Notice(this.t("noticeNoteUpdated", { path: notePathFor(path) }));
	}

	/**
	 * Copy every note into a plain, visible folder.
	 *
	 * The working notes hide behind a dot so they never crowd the author's
	 * chapters; this is the one deliberate way to get them out where any other
	 * tool can see them.
	 */
	async exportNotes(): Promise<void> {
		const preview = await this.notes.previewExport();
		if (preview.files.length === 0) {
			new Notice(this.t("noticeNoteExportEmpty"));
			return;
		}
		if (
			preview.hasContent &&
			!window.confirm(this.t("confirmNoteExport", { count: preview.files.length }))
		) {
			return;
		}

		try {
			const copied = await this.notes.exportAll();
			new Notice(this.t("noticeNoteExported", { count: copied, path: EXPORT_ROOT }));
		} catch (error) {
			new Notice(this.t("noticeSaveFailed", { message: String(error) }));
		}
	}

	async restoreBackup(): Promise<void> {
		try {
			if (!(await this.storage.restoreBackup())) {
				new Notice(this.t("noticeNoBackup"));
				return;
			}
			this.syncChapter();
			new Notice(this.t("noticeBackupRestored"));
		} catch (error) {
			new Notice(this.t("noticeSaveFailed", { message: String(error) }));
		}
	}

	/* ------------------------------------------------------------------ */
	/* Views & tabs                                                         */
	/* ------------------------------------------------------------------ */

	/** Path of the chapter the map should render, or null when none is open. */
	get activeChapterPath(): string | null {
		return this.chapterPath && isChapterFile(this.chapterPath) ? this.chapterPath : null;
	}

	get activeChapterFile(): TFile | null {
		const path = this.activeChapterPath;
		if (!path) return null;
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private mapView(): MapView | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_MAP)[0];
		return leaf?.view instanceof MapView ? leaf.view : null;
	}

	private rosterView(): RosterView | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_ROSTER)[0];
		return leaf?.view instanceof RosterView ? leaf.view : null;
	}

	private relationshipView(): RelationshipView | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RELATIONSHIP)[0];
		return leaf?.view instanceof RelationshipView ? leaf.view : null;
	}

	refreshAllViews(): void {
		this.mapView()?.refresh();
		this.rosterView()?.onExternalChange();
		this.relationshipView()?.onExternalChange();
	}

	/**
	 * Detect the active markdown file and hand its path to the views.
	 *
	 * The plugin's own folders are excluded twice over: isChapterFile() already
	 * rejects them, and the explicit check keeps the reason visible — a note in
	 * ".Writer Maps Data/" is the digest of a chapter, so treating it as a chapter
	 * would give the digest a map, whose digest would then have one too, forever.
	 */
	private syncChapter(): void {
		const file = this.app.workspace.getActiveFile();
		const next = file && isChapterFile(file.path) && !isManagedPath(file.path) ? file.path : null;
		if (next === this.chapterPath) return;
		const previous = this.chapterPath;
		this.chapterPath = next;

		this.mapView()?.setChapter(this.chapterPath);
		this.rosterView()?.onExternalChange();
		this.relationshipView()?.onExternalChange();
		if (previous !== this.chapterPath) this.retargetNoteTab();
	}

	/* ------------------------------------------------------------------ */
	/* The note tab                                                          */
	/* ------------------------------------------------------------------ */

	/**
	 * The leaf showing the author's note, or null.
	 *
	 * getLeavesOfType("markdown") returns every markdown leaf in the workspace,
	 * including the main editor, so the path — not the type — is what identifies
	 * ours.
	 */
	private noteLeaf(): WorkspaceLeaf | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const file = (leaf.getViewState().state as { file?: string } | undefined)?.file;
			if (typeof file === "string" && isNotePath(file)) return leaf;
		}
		return null;
	}

	/**
	 * Text an open editor holds for a path, or null when nothing is open.
	 *
	 * A buffer that differs from the file on disk means the author has unsaved
	 * changes, and the note writer has to wait instead of writing over them.
	 */
	noteBuffer(path: string): string | null {
		const leaf = this.noteLeaf();
		if (!leaf) return null;
		if (((leaf.getViewState().state as { file?: string } | undefined)?.file ?? "") !== path) return null;

		// No `getMode()` check on purpose. In Live Preview `editor.getValue()`
		// still returns the whole document, so treating that mode as "no buffer"
		// would have the note writer overwrite text the author is mid-edit on.
		const view = leaf.view as { editor?: { getValue?: () => string } } | null;
		const value = view?.editor?.getValue?.();
		return typeof value === "string" ? value : null;
	}

	/**
	 * Point the existing note tab at the current chapter.
	 *
	 * Obsidian saves the open editor on its own, so there is no window in which
	 * a swap can throw work away and no reason to hold the tab hostage. The
	 * chapter note is created first, because retargeting a tab at a file that
	 * does not exist leaves an error tab in the sidebar.
	 */
	private retargetNoteTab(): void {
		void this.retargetNoteTabAsync();
	}

	private async retargetNoteTabAsync(): Promise<void> {
		const leaf = this.noteLeaf();
		if (!leaf || !this.chapterPath) return;

		const target = notePathFor(this.chapterPath);
		const current = (leaf.getViewState().state as { file?: string } | undefined)?.file ?? "";
		if (current === target) return;

		// Create the file before pointing a tab at it.
		await this.notes.ensure(this.chapterPath);
		// No `mode: "source"`: the tab stays in whatever the reader uses, and
		// forcing source mode is what used to hide the WYSIWYG view.
		await leaf.setViewState({ type: "markdown", state: { file: target }, active: true });
		this.renameNoteTab(leaf);
	}

	/**
	 * Label the tab the way the plugin wants it, not the way the file name reads.
	 *
	 * There is no API for a tab title, so this goes after the two things
	 * Obsidian does use: `getDisplayText` is what the tab header asks for, and
	 * `tabHeaderEl` is the element it ends up in. Both are internal, hence the
	 * optional calls and the try/catch — an Obsidian release that drops either
	 * one costs a nicer name, nothing more.
	 */
	private renameNoteTab(leaf: WorkspaceLeaf): void {
		const label = this.t("viewNote");
		const view = leaf.view as { getDisplayText?: () => string } | null;
		try {
			if (view && typeof view.getDisplayText === "function") {
				view.getDisplayText = () => label;
			}
			// The header is only rebuilt when it is already there; Obsidian fills
			// it in on first layout, and the label survives into the leaf state.
			// Not part of the public type, hence the cast.
			const header = (leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement }).tabHeaderEl;
			header?.setText?.(label);
		} catch {
			// Cosmetic only.
		}
	}

	/**
	 * Open a tab in the right sidebar, right next to its sibling.
	 * Reuses an existing tab of the requested kind instead of duplicating it.
	 */
	async openTab(which: "map" | "note" | "roster" | "relationship"): Promise<void> {
		if (which === "note") return this.openNoteTab();

		const viewType = which === "map" ? VIEW_TYPE_MAP : which === "roster" ? VIEW_TYPE_ROSTER : VIEW_TYPE_RELATIONSHIP;
		const existing = this.app.workspace.getLeavesOfType(viewType)[0];
		if (existing) {
			this.app.workspace.revealLeaf(existing);
			return;
		}

		// Append next to whichever sibling already exists, so the three tabs keep
		// a stable order in the sidebar.
		const sibling = this.app.workspace.getLeavesOfType(VIEW_TYPE_ROSTER)[0] ?? this.noteLeaf();
		const leaf = sibling
			? this.tabBeside(sibling)
			: this.app.workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({ type: viewType, active: true });
		this.app.workspace.revealLeaf(leaf);

		if (which === "map") this.mapView()?.setChapter(this.chapterPath);
	}

	/** A new tab in the same group as an existing leaf. */
	private tabBeside(sibling: WorkspaceLeaf): WorkspaceLeaf | null {
		// `getLeaf("tab")` appends to the group of the *active* leaf, so the
		// sibling has to be active first.
		this.app.workspace.setActiveLeaf(sibling, { focus: false });
		return this.app.workspace.getLeaf("tab");
	}

	/**
	 * Open the note of the active chapter in the sidebar, creating it if needed.
	 *
	 * Opening the tab is itself the author's intent, so the note is generated
	 * before the leaf ever shows an empty file.
	 */
	private async openNoteTab(): Promise<void> {
		const chapter = this.activeChapterPath;
		if (!chapter) {
			new Notice(this.t("noticeNoChapter"));
			return;
		}

		await this.notes.ensure(chapter);
		const target = notePathFor(chapter);
		if (!isNotePath(target)) return;

		const existing = this.noteLeaf();
		if (existing) {
			if (((existing.getViewState().state as { file?: string } | undefined)?.file ?? "") !== target) {
				await existing.setViewState({ type: "markdown", state: { file: target }, active: true });
			}
			this.renameNoteTab(existing);
			this.app.workspace.revealLeaf(existing);
			return;
		}

		// Prefer sitting next to the map: the note is the map's own text.
		const anchor = this.mapViewLeaf() ?? this.rosterViewLeaf();
		const leaf = anchor ? this.tabBeside(anchor) : this.app.workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({ type: "markdown", state: { file: target }, active: true });
		this.renameNoteTab(leaf);
		this.app.workspace.revealLeaf(leaf);
	}

	private mapViewLeaf(): WorkspaceLeaf | null {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE_MAP)[0] ?? null;
	}

	private rosterViewLeaf(): WorkspaceLeaf | null {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE_ROSTER)[0] ?? null;
	}

	/** True for the plugin's own leaves, so the map does not clear on focus. */
	private isOurLeaf(leaf: WorkspaceLeaf): boolean {
		if (leaf.view instanceof MapView || leaf.view instanceof RosterView) return true;
		if (leaf.view instanceof RelationshipView) return true;
		if (leaf.getViewState().type !== "markdown") return false;
		const file = (leaf.getViewState().state as { file?: string } | undefined)?.file;
		return typeof file === "string" && isManagedPath(file);
	}
}
