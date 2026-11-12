import { Notice, TFile } from "obsidian";
import type WriterStateMapPlugin from "../main";
import type { NoteStrings } from "./notes";
import {
	buildNoteBlock,
	chapterForNotePath,
	contentSignature,
	EXPORT_ROOT,
	exportTextFor,
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
 * The only module in the plugin allowed to touch a markdown file.
 *
 * Two markdown roots are ours and only ours: the notes folder and the export
 * folder. Every single read and write below goes through isManagedPath() first,
 * so a bug upstream cannot turn into "the plugin overwrote my manuscript", and a
 * chapter note can never become a write target even by accident.
 *
 * It goes through `vault.create` / `vault.modify` / `vault.read` and not through
 * `vault.adapter`. The adapter is the low-level escape hatch that can write any
 * path in the vault with no bookkeeping: a write through it updates the file on
 * disk without Obsidian knowing, so a note open in an editor keeps serving a
 * buffer that no longer matches what is there, and every later edit of the map
 * is made against a fiction. The high-level API fires the events that keep the
 * workspace honest, and it is the one that knows what a TFile is.
 *
 * The test suite enforces this: no source may hold the vault adapter except
 * storage.ts, which owns data.json, and no source may call these three APIs
 * except this one.
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
	/**
	 * Every text this module has put on disk, newest last, per path.
	 *
	 * `selfWrites` answers "is the file still exactly what I wrote?", which is
	 * what tells our own echo apart from the author's save. It cannot answer the
	 * question that actually strands a write: *is the editor holding something the
	 * author typed, or something stale that we left there?* An editor opened
	 * before the file existed holds "", and "" is not a deferral-worthy edit — it
	 * is a buffer nobody has touched. This remembers what we have written so a
	 * buffer matching any of it can be recognised as ours and stepped over.
	 *
	 * A short list, not an unbounded log: two entries is enough to cover the
	 * window between a write and the editor picking it up.
	 */
	private readonly written = new Map<string, string[]>();
	/** Cap on remembered texts per path, so a long session cannot grow without end. */
	private static readonly WRITTEN_HISTORY = 3;

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

	private vault() {
		return this.plugin.app.vault;
	}

	/** The markdown file at a path, or null when there is none. */
	private fileAt(path: string): TFile | null {
		const found = this.vault().getAbstractFileByPath(path);
		// `instanceof TFile` and not "not a folder": a path can hold a folder of
		// the same name, and `modify` on one of those is a throw, not a no-op.
		return found instanceof TFile ? found : null;
	}

	/**
	 * Every markdown file under a folder, by prefix.
	 *
	 * `getMarkdownFiles()` rather than a walk of the adapter: it is one call, it
	 * is the list Obsidian itself works from, and it cannot disagree with it.
	 */
	private listMarkdown(root: string): string[] {
		return this.vault()
			.getMarkdownFiles()
			.map((file) => file.path)
			.filter((path) => path.startsWith(root));
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
				if (this.fileAt(target)) return false;
				const s = this.strings();
				const empty = buildNoteBlock({ map_bg: null, nodes: [] }, [], s);
				const created = newNote(empty);
				await this.ensureFolder(noteFolderFor(chapterPath));
				await this.vault().create(target, created);
				// Remembered, because an editor may already be holding a buffer for
				// this path from before the file existed.
				this.rememberWritten(target, created);
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
			const file = this.fileAt(target);
			const existing = file ? await this.vault().read(file) : null;
			if (file) await this.ensureFolder(noteFolderFor(chapterPath));

			// The note is usually open in the sidebar editor. Writing over a buffer
			// the author has not saved yet would throw their text away, so the
			// write waits for the save instead of racing it.
			//
			// "Has not saved yet" is not the same question as "differs from disk",
			// and treating them as one is what wedged the digest: an editor holding
			// a stale buffer — empty, or text from before our last write — differs
			// from disk forever, and since a stale buffer never produces a save
			// event, the deferred write was never released. The file on disk ended
			// up correct and the author was looking at nothing.
			//
			// So the buffer is only treated as the author's when it is neither what
			// is on disk nor anything we have written there. Anything of ours is
			// stale by definition, and writing over it loses nothing.
			//
			// An empty buffer is nobody's draft either. A leaf opened before the
			// note existed holds "", and there is nothing to compare it against in
			// `written` — the first write of a session is the one case the memory
			// cannot vouch for, so the emptiness itself has to carry the weight.
			// It is also safe: there is no author text in an empty buffer to lose,
			// only ours to restore.
			const buffer = this.plugin.noteBuffer(target);
			const unsaved = buffer !== null && buffer.trim() !== "" && buffer !== existing;
			if (unsaved && !this.isOurs(target, buffer)) {
				this.pending.add(chapterPath);
				return false;
			}

			const s = this.strings();
			const merged = mergeNote(existing, buildNoteBlock(map, this.plugin.settings.pawns, s));
			if (!merged.ok) {
				new Notice(this.plugin.t("noticeNoteUnbalanced", { path: target }));
				return false;
			}
			this.pending.delete(chapterPath);
			if (!merged.changed) {
				this.signatures.set(chapterPath, signature);
				return false;
			}

			// Prepending puts our callout above a title the author wrote. That is
			// the only non-destructive option, but it is not a silent one: they get
			// told, because the alternative they would otherwise see is a file that
			// no longer opens the way they left it.
			if (merged.prepended) new Notice(this.plugin.t("noticeNotePrepended", { path: target }));

			this.selfWrites.set(target, merged.text);
			this.rememberWritten(target, merged.text);
			await this.writeFile(target, file, merged.text);
			this.signatures.set(chapterPath, signature);
			return true;
		} catch (error) {
			// A failed write must not leave a self-write marker behind: it would
			// make the next real save of this note look like our own echo.
			this.selfWrites.delete(target);
			this.written.delete(target);
			new Notice(this.plugin.t("noticeNoteFailed", { path: target, message: String(error) }));
			return false;
		}
	}

	/** True when this text is one we wrote, so the editor is showing a stale copy. */
	private isOurs(path: string, text: string): boolean {
		return this.written.get(path)?.includes(text) === true;
	}

	/** Note a text as ours, keeping only the last few for this path. */
	private rememberWritten(path: string, text: string): void {
		const history = this.written.get(path) ?? [];
		history.push(text);
		this.written.set(path, history.slice(-NoteWriter.WRITTEN_HISTORY));
	}

	/** What is on disk for one of our paths, or null when there is no file. */
	async diskText(path: string): Promise<string | null> {
		if (!isManagedPath(path)) return null;
		const file = this.fileAt(path);
		if (!file) return null;
		try {
			return await this.vault().read(file);
		} catch {
			return null;
		}
	}

	/**
	 * Put text at a managed path: modify what is there, create what is not.
	 *
	 * The file argument is the one this write already resolved, rather than
	 * looking it up again — `write` has just read it, and a second lookup could
	 * only return something different if the file had moved underneath us, which
	 * `create` would then refuse anyway.
	 */
	private async writeFile(path: string, file: TFile | null, text: string): Promise<void> {
		if (file) {
			await this.vault().modify(file, text);
			return;
		}
		// A folder is sitting where the note belongs. `create` is not the answer:
		// it either replaces the folder with a file or fails halfway through
		// having done so, and either way the author's folder is gone. Refusing is
		// the only move that leaves something of theirs intact.
		if (this.vault().getAbstractFileByPath(path)) {
			throw new Error(`cannot create the note: ${path} is a folder`);
		}
		await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
		await this.vault().create(path, text);
	}

	/**
	 * Create every missing folder of a path, segment by segment.
	 *
	 * There is no recursive mkdir in the vault API either, and a mirrored note can
	 * sit several folders deep the first time it is written. Each segment is asked
	 * about by path rather than kept in a list of what we created, so a folder the
	 * author created themselves between two writes is found rather than
	 * duplicated.
	 */
	private async ensureFolder(path: string): Promise<void> {
		const vault = this.vault();
		let current = "";
		for (const segment of path.split("/").filter(Boolean)) {
			current = current ? `${current}/${segment}` : segment;
			if (vault.getAbstractFileByPath(current)) continue;
			try {
				await vault.createFolder(current);
			} catch {
				// A concurrent write created it first, or the API rejects a
				// duplicate; either way the next lookup settles it.
				if (!vault.getAbstractFileByPath(current)) throw new Error(`cannot create folder ${current}`);
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
		this.written.clear();
	}

	/**
	 * Forget what we believe is on disk.
	 *
	 * Called after a manual reload or an import: the file may now differ from
	 * anything this session wrote. The remembered texts go with it — they are
	 * claims about what *we* put there, and after an import the answer is unknown.
	 */
	invalidate(): void {
		this.signatures.clear();
		this.selfWrites.clear();
		this.written.clear();
	}

	/* ------------------------------------------------------------------ */
	/* Export                                                               */
	/* ------------------------------------------------------------------ */

	/** What an export would do, so the caller can ask before touching anything. */
	async previewExport(): Promise<ExportPreview> {
		const files = this.listMarkdown(`${NOTE_ROOT}/`);
		return { files, hasContent: files.length > 0 && this.listMarkdown(`${EXPORT_ROOT}/`).length > 0 };
	}

	/**
	 * Copy every note into the export folder, mirroring the structure.
	 *
	 * The copy is not a copy. The callout exists for the note, where the plugin
	 * owns the block and the author needs to see it as one thing; in a file that
	 * has left the vault there is no plugin left to update it, and a reader in
	 * another app sees quote marks and a `[!info]` that renders as nothing. So the
	 * block goes out as plain markdown, and the author's own text — the free zone,
	 * the draft, whatever it is — is carried over exactly as written. Anything
	 * less than that would be exporting our scaffolding and calling it their file.
	 */
	async exportAll(): Promise<number> {
		const source = `${NOTE_ROOT}/`;
		const files = this.listMarkdown(source);
		const s = this.strings();
		let copied = 0;

		for (const path of files) {
			const relative = path.slice(source.length);
			const target = `${EXPORT_ROOT}/${relative}`;
			// Same gate as every other write: the export folder is ours, and
			// nothing outside it may be reached even by a hand-edited path.
			if (!isManagedPath(target)) continue;

			const from = this.fileAt(path);
			if (!from) continue;

			try {
				const text = exportTextFor(await this.vault().read(from), s);
				await this.writeFile(target, this.fileAt(target), text);
			} catch (error) {
				// A half-finished export is still usable, and the next run will
				// pick the file up again; failing the whole export over one
				// unreadable note would be worse than skipping it.
				console.error("Writer's State Map: note export failed", target, error);
				continue;
			}
			copied += 1;
		}
		return copied;
	}
}
