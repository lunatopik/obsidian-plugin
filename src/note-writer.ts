import { Notice } from "obsidian";
import type { DataAdapter, ListedFiles } from "obsidian";
import type WriterStateMapPlugin from "../main";
import type { NoteStrings } from "./notes";
import {
	buildNoteBlock,
	chapterForNotePath,
	contentSignature,
	EXPORT_ROOT,
	isManagedPath,
	isNotePath,
	mergeNote,
	newNote,
	noteFolderFor,
	notePathFor,
	NOTE_ROOT,
} from "./notes";

/** Coalescing window, so a burst of edits results in a single write. */
const DEFAULT_DELAY = 1500;

/** How many files the export would copy, and whether the target already has any. */
export interface ExportPreview {
	files: string[];
	hasContent: boolean;
}

/**
 * The only module in the plugin allowed to touch a vault file.
 *
 * Two markdown roots are ours and only ours: the hidden note folder and the
 * visible export folder. Every single read and write below goes through
 * isManagedPath() first, so a bug upstream cannot turn into "the plugin
 * overwrote my manuscript", and a chapter note can never become a write target
 * even by accident.
 *
 * The test suite enforces both halves: no other source may mention the vault
 * adapter at all, and this module may not use the high-level vault or
 * file-manager APIs that would let it reach a chapter.
 *
 * The other job here is not fighting the author. A note is usually open in the
 * real editor, so a write is deferred while that editor holds unsaved changes and
 * retried the moment the file is saved.
 */
export class NoteWriter {
	private readonly plugin: WriterStateMapPlugin;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly signatures = new Map<string, string>();
	/** Chapters whose write was deferred because the editor is dirty. */
	private readonly pending = new Set<string>();
	/**
	 * The exact text this module last wrote, per path.
	 *
	 * Keyed by content rather than by "we wrote here some time ago", because a
	 * plain path set is only correct if every one of our writes is followed by
	 * exactly one modify event. That is not guaranteed: an event can be missed,
	 * coalesced, or arrive after a restart, and a stale marker would then swallow
	 * the author's very next real save and strand the deferred write forever.
	 * Comparing content cannot be fooled that way.
	 */
	private readonly selfWrites = new Map<string, string>();

	// Explicit field instead of a TS parameter property: the test suite loads
	// this module through Node's strip-only TypeScript, which rejects them.
	constructor(plugin: WriterStateMapPlugin) {
		this.plugin = plugin;

		// The author typing in the note is what unblocks a deferred write, so the
		// retry hangs off the file's own save event.
		plugin.registerEvent(
			plugin.app.vault.on("modify", (file) => {
				void this.onFileModified(file.path);
			}),
		);
	}

	/** Translated text of the note, collected without aliasing `t`. */
	private strings(): NoteStrings {
		return {
			placementTitle: this.plugin.t("notePlacementTitle"),
			offStoryTitle: this.plugin.t("noteOffStoryTitle"),
			emptyLocation: this.plugin.t("noteEmptyLocation"),
			noLocations: this.plugin.t("noteNoLocations"),
			unnamedLocation: this.plugin.t("noteUnnamedLocation"),
			freeZone: this.plugin.t("noteFreeZone"),
		};
	}

	private adapter(): DataAdapter {
		return this.plugin.app.vault.adapter;
	}

	/* ------------------------------------------------------------------ */
	/* Scheduling                                                           */
	/* ------------------------------------------------------------------ */

	/**
	 * Queue a refresh for one chapter.
	 *
	 * Skipped when the content signature is unchanged, which is what keeps a
	 * node drag — or an avatar dragged around its pin — from costing a disk
	 * write: coordinates never reach the note.
	 */
	schedule(chapterPath: string, delay = DEFAULT_DELAY): void {
		const map = this.plugin.settings.maps[chapterPath];
		if (!map) return;
		if (this.signatures.get(chapterPath) === contentSignature(map, this.plugin.settings.pawns)) return;

		const pending = this.timers.get(chapterPath);
		if (pending !== undefined) clearTimeout(pending);
		this.timers.set(
			chapterPath,
			setTimeout(() => {
				this.timers.delete(chapterPath);
				void this.write(chapterPath);
			}, delay),
		);
	}

	/**
	 * Queue a refresh for every known chapter.
	 *
	 * Needed after a character change: the off-story pool is global, so a renamed
	 * character changes the note of every chapter that has one.
	 */
	scheduleAll(delay = DEFAULT_DELAY): void {
		for (const chapterPath of Object.keys(this.plugin.settings.maps)) {
			this.schedule(chapterPath, delay);
		}
	}

	/**
	 * Make sure the note exists, without waiting for a content change.
	 *
	 * This is what runs when the author opens the note tab: a chapter with no map
	 * yet still gets a note, because the tab itself is the author's intent.
	 */
	async ensure(chapterPath: string): Promise<boolean> {
		if (this.plugin.settings.maps[chapterPath] === undefined) {
			const target = notePathFor(chapterPath);
			if (!isManagedPath(target) || isNotePath(chapterPath)) return false;
			try {
				if (await this.adapter().exists(target)) return false;
				const s = this.strings();
				const empty = buildNoteBlock({ map_bg: null, nodes: [] }, [], s);
				await this.ensureFolder(noteFolderFor(chapterPath));
				await this.adapter().write(target, newNote(empty, s));
				return true;
			} catch (error) {
				new Notice(this.plugin.t("noticeNoteFailed", { path: target, message: String(error) }));
				return false;
			}
		}
		return this.write(chapterPath, true);
	}

	/* ------------------------------------------------------------------ */
	/* Writing                                                              */
	/* ------------------------------------------------------------------ */

	/**
	 * Write the note of one chapter. Returns true when the file changed.
	 *
	 * `force` bypasses the signature check so opening the tab and the manual
	 * command always do what the writer asked, even if the plugin believes the
	 * file is current.
	 */
	async write(chapterPath: string, force = false): Promise<boolean> {
		const map = this.plugin.settings.maps[chapterPath];
		if (!map) return false;

		const target = notePathFor(chapterPath);
		// Hard gate: never write a chapter note, and never nest a note in a note.
		if (!isManagedPath(target) || isNotePath(chapterPath)) return false;

		const signature = contentSignature(map, this.plugin.settings.pawns);
		if (!force && this.signatures.get(chapterPath) === signature) return false;

		try {
			const existing = await this.diskText(target);
			await this.ensureFolder(noteFolderFor(chapterPath));

			// The note is usually open in the sidebar editor. Writing over a buffer
			// the author has not saved yet would throw their text away, so the
			// write waits for the save instead of racing it.
			const buffer = this.plugin.noteBuffer(target);
			if (buffer !== null && buffer !== existing) {
				this.pending.add(chapterPath);
				return false;
			}

			const s = this.strings();
			const merged = mergeNote(existing, buildNoteBlock(map, this.plugin.settings.pawns, s), s);
			if (!merged.ok) {
				new Notice(this.plugin.t("noticeNoteUnbalanced", { path: target }));
				return false;
			}
			this.pending.delete(chapterPath);
			if (!merged.changed) {
				this.signatures.set(chapterPath, signature);
				return false;
			}

			this.selfWrites.set(target, merged.text);
			await this.adapter().write(target, merged.text);
			this.signatures.set(chapterPath, signature);
			return true;
		} catch (error) {
			// A failed write must not leave a self-write marker behind: it would
			// make the next real save of this note look like our own echo.
			this.selfWrites.delete(target);
			new Notice(this.plugin.t("noticeNoteFailed", { path: target, message: String(error) }));
			return false;
		}
	}

	/** What is on disk for one of our paths, or null when there is no file. */
	async diskText(path: string): Promise<string | null> {
		if (!isManagedPath(path)) return null;
		try {
			return (await this.adapter().exists(path)) ? await this.adapter().read(path) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Create every missing folder of a path, segment by segment.
	 *
	 * Obsidian's adapter has no recursive mkdir, and a mirrored note can sit
	 * several folders deep the first time it is written.
	 */
	private async ensureFolder(path: string): Promise<void> {
		const adapter = this.adapter();
		let current = "";
		for (const segment of path.split("/").filter(Boolean)) {
			current = current ? `${current}/${segment}` : segment;
			if (await adapter.exists(current)) continue;
			try {
				await adapter.mkdir(current);
			} catch {
				// A concurrent write created it first, or the adapter rejects a
				// duplicate; either way the next exists() check settles it.
				if (!(await adapter.exists(current))) throw new Error(`cannot create folder ${current}`);
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Deferred writes                                                      */
	/* ------------------------------------------------------------------ */

	/**
	 * A note was saved. Is it us echoing our own write, or the author?
	 *
	 * The two look identical from the outside — both arrive as a `modify` event
	 * for the same path — so the only honest way to tell them apart is to look at
	 * what is actually on disk now.
	 */
	private async onFileModified(path: string): Promise<void> {
		const ours = this.selfWrites.get(path);
		if (ours !== undefined) {
			this.selfWrites.delete(path);
			// Still exactly our text: this event *is* our own write coming back.
			if ((await this.diskText(path)) === ours) return;
		}
		const chapter = chapterForNotePath(path);
		if (!chapter || !this.pending.has(chapter)) return;
		await this.write(chapter, true);
	}

	/** Chapters whose write is waiting for the author to save. For diagnostics. */
	deferredChapters(): string[] {
		return [...this.pending];
	}

	/** Drop queued writes, e.g. when the plugin unloads. */
	cancelAll(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.pending.clear();
		this.selfWrites.clear();
	}

	/**
	 * Forget what we believe is on disk.
	 *
	 * Called after a manual reload or an import: the file may now differ from
	 * anything this session wrote.
	 */
	invalidate(): void {
		this.signatures.clear();
		this.selfWrites.clear();
	}

	/* ------------------------------------------------------------------ */
	/* Export                                                               */
	/* ------------------------------------------------------------------ */

	/** What an export would do, so the caller can ask before touching anything. */
	async previewExport(): Promise<ExportPreview> {
		const files = await this.listMarkdown(`${NOTE_ROOT}/`);
		return { files, hasContent: files.length > 0 && (await this.hasAnyMarkdown(`${EXPORT_ROOT}/`)) };
	}

	/**
	 * Copy every note into the visible export folder, mirroring the structure.
	 *
	 * The dot keeps the working notes out of the writer's sight; this is the
	 * deliberate way to get them out where any other app can reach them.
	 */
	async exportAll(): Promise<number> {
		const adapter = this.adapter();
		const source = `${NOTE_ROOT}/`;
		const files = await this.listMarkdown(source);
		let copied = 0;

		for (const file of files) {
			const relative = file.slice(source.length);
			const target = `${EXPORT_ROOT}/${relative}`;
			// Same gate as every other write: the export folder is ours, and
			// nothing outside it may be reached even by a hand-edited path.
			if (!isManagedPath(target)) continue;
			await this.ensureFolder(target.slice(0, target.lastIndexOf("/")));

			const text = await adapter.read(file);
			try {
				this.selfWrites.set(target, text);
				await adapter.write(target, text);
			} catch (error) {
				// A half-finished export is still usable, and the next run will
				// pick the file up again; failing the whole export over one
				// unreadable note would be worse than skipping it.
				this.selfWrites.delete(target);
				console.error("Writer's State Map: note export failed", target, error);
				continue;
			}
			copied += 1;
		}
		return copied;
	}

	/** Every markdown file under a folder, depth first, vault paths. */
	private async listMarkdown(root: string): Promise<string[]> {
		const found: string[] = [];
		const walk = async (folder: string): Promise<void> => {
			let listing: ListedFiles;
			try {
				listing = await this.adapter().list(folder);
			} catch {
				// The folder does not exist yet: nothing to copy.
				return;
			}
			for (const file of listing.files) {
				if (file.toLowerCase().endsWith(".md")) found.push(file);
			}
			for (const sub of listing.folders) await walk(sub);
		};
		await walk(root);
		return found;
	}

	private async hasAnyMarkdown(root: string): Promise<boolean> {
		return (await this.listMarkdown(root)).length > 0;
	}
}
