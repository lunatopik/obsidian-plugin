import type { Pawn, StoredChapterMap } from "./types";
import { indexPawns, resolveToken } from "./pawns";

/**
 * The author's notes, kept next to the map in a dot-folder of the vault.
 *
 * A dot-prefixed folder is hidden from Obsidian's file explorer by default while
 * still being an ordinary vault file, which is the whole point: the writer edits
 * them in the real Markdown editor, with live preview and wikilink completion,
 * and they never show up among the chapters.
 *
 * This module is pure. It turns a chapter map plus the roster into markdown,
 * knows where the note lives, and knows how to splice its own block into a file
 * the author also writes in. It never touches the filesystem and must not import
 * `obsidian` — writing is the job of src/note-writer.ts, the single audited
 * module allowed to reach a vault file.
 *
 * The contract with the author's own text is the marker pair: everything between
 * the markers is generated and may be replaced at will, everything outside is the
 * author's and is never read into a decision, rewritten or deleted.
 */

/** Root of the generated notes. Hidden from the file explorer by the dot. */
export const NOTE_ROOT = ".Writer Maps Data";

/** Visible copy of the notes, written only by the explicit export command. */
export const EXPORT_ROOT = "Writer Maps Export";

/** Opening marker of the generated block. */
export const NOTE_START = "%% wsm-summary-start %%";

/** Closing marker of the generated block. Nothing after it is ever rewritten. */
export const NOTE_END = "%% wsm-summary-end %%";

/** User-visible text of the note, injected so this module stays language-free. */
export interface NoteStrings {
	placementTitle: string;
	offStoryTitle: string;
	emptyLocation: string;
	noLocations: string;
	unnamedLocation: string;
	freeZone: string;
}

/** Normalize a vault path the way Obsidian does, without importing anything. */
function normalize(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

/**
 * Vault path of the note for a chapter: "Book/Chapter.md" mirrors to
 * ".Writer Maps Data/Book/Chapter.md".
 *
 * Idempotent, so a note can never be made a chapter's note a second time and
 * spiral into ".Writer Maps Data/.Writer Maps Data/...".
 */
export function notePathFor(chapterPath: string): string {
	const trimmed = normalize(chapterPath);
	if (!trimmed) return "";
	if (isNotePath(trimmed)) return trimmed;
	return `${NOTE_ROOT}/${trimmed}`;
}

/** The folder that has to exist before the note file can be created. */
export function noteFolderFor(chapterPath: string): string {
	const path = notePathFor(chapterPath);
	const slash = path.lastIndexOf("/");
	return slash > 0 ? path.slice(0, slash) : NOTE_ROOT;
}

/** Inverse of notePathFor: which chapter a note belongs to, if any. */
export function chapterForNotePath(path: string): string {
	const clean = normalize(path);
	if (!isNotePath(clean)) return "";
	return clean.slice(NOTE_ROOT.length + 1);
}

/** True when a path lives in the generated notes folder. */
export function isNotePath(path: string): boolean {
	return normalize(path).startsWith(`${NOTE_ROOT}/`) && normalize(path).endsWith(".md");
}

/** True when a path lives in the visible export folder. */
export function isExportPath(path: string): boolean {
	return normalize(path).startsWith(`${EXPORT_ROOT}/`) && normalize(path).endsWith(".md");
}

/**
 * True when the plugin itself owns a path and may therefore write to it.
 *
 * This is the hard gate in front of every single write: the two roots above are
 * the only markdown the plugin is ever allowed to touch, which is what keeps a
 * bug upstream from turning into "the plugin overwrote my manuscript". Anything
 * that fails this test is refused before an adapter call is even made.
 */
export function isManagedPath(path: string): boolean {
	return isNotePath(path) || isExportPath(path);
}

/**
 * Render a pawn name as an Obsidian wikilink.
 *
 * Newlines would break the line structure, and a pipe would be read as an alias
 * separator, so both are neutralized.
 */
export function wikiLink(name: string): string {
	const clean = name.replace(/\s+/g, " ").trim();
	return `[[${clean.replace(/\|/g, "\\|")}]]`;
}

/** Locations sorted by label for a stable file; unnamed ones go last. */
function sortedNodes(map: StoredChapterMap): StoredChapterMap["nodes"] {
	return [...map.nodes].sort((a, b) => {
		const left = (a.label ?? "").trim();
		const right = (b.label ?? "").trim();
		if (!left && !right) return a.id.localeCompare(b.id);
		if (!left) return 1;
		if (!right) return -1;
		const byLabel = left.localeCompare(right, undefined, { sensitivity: "base" });
		return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
	});
}

/**
 * Build the generated block, markers included.
 *
 * The placement section lists every location with its characters as wikilinks;
 * the off-story section lists roster members that appear in no location of this
 * chapter, and is omitted when there are none.
 */
export function buildNoteBlock(map: StoredChapterMap, pawns: Pawn[], s: NoteStrings): string {
	const index = indexPawns(pawns);
	const lines: string[] = [NOTE_START, s.placementTitle];

	if (map.nodes.length === 0) {
		lines.push(s.noLocations);
	} else {
		for (const node of sortedNodes(map)) {
			const label = node.label?.trim() || s.unnamedLocation;
			// Char order is the writer's own (the order they ticked the boxes).
			const names = node.chars
				.map((token) => resolveToken(token, index, pawns).pawn)
				.filter((pawn): pawn is Pawn => pawn !== null)
				.map((pawn) => wikiLink(pawn.name));
			lines.push(
				names.length > 0
					? `- **${label}**: ${names.join(", ")}`
					: `- **${label}**: ${s.emptyLocation}`,
			);
		}
	}

	const placed = new Set<string>();
	for (const node of map.nodes) {
		for (const token of node.chars) {
			const { pawn } = resolveToken(token, index, pawns);
			if (pawn) placed.add(pawn.id);
		}
	}
	const pool = pawns.filter((pawn) => !placed.has(pawn.id));
	if (pool.length > 0) {
		lines.push("", s.offStoryTitle);
		const sorted = [...pool].sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
		for (const pawn of sorted) lines.push(`- ${wikiLink(pawn.name)}`);
	}

	lines.push(NOTE_END);
	return lines.join("\n");
}

/** File text for a note that does not exist yet: the block plus a free zone. */
export function newNote(block: string, s: NoteStrings): string {
	const merged = mergeNote(null, block, s);
	// `mergeNote(null, ...)` can only succeed; the branch keeps the return type
	// honest without a cast at every call site.
	return merged.ok ? merged.text : `${block}\n\n${s.freeZone}\n`;
}

/** Outcome of splicing a generated block into a file. */
export type MergeResult =
	| { ok: true; text: string; changed: boolean }
	| { ok: false; reason: "unbalanced" };

/**
 * Splice the generated block into the current file contents.
 *
 * - `existing === null`: the file is created with the block and a free zone.
 * - Both markers present: exactly the span between them is replaced, and the
 *   author's text before and after survives byte for byte.
 * - No markers: the block is prepended and the whole existing text is kept —
 *   the only non-destructive option for a file the plugin did not create.
 * - Exactly one marker: the file was edited by hand, so we refuse rather than
 *   guess where the block should end.
 */
export function mergeNote(existing: string | null, block: string, s: NoteStrings): MergeResult {
	if (existing === null) {
		return { ok: true, text: `${block}\n\n${s.freeZone}\n`, changed: true };
	}

	const start = existing.indexOf(NOTE_START);
	const end = existing.indexOf(NOTE_END);

	if (start === -1 && end === -1) {
		return { ok: true, text: `${block}\n\n${existing}`, changed: true };
	}
	if (start === -1 || end === -1 || end < start) {
		return { ok: false, reason: "unbalanced" };
	}

	const before = existing.slice(0, start);
	const after = existing.slice(end + NOTE_END.length);
	const text = `${before}${block}${after}`;
	return { ok: true, text, changed: text !== existing };
}

/**
 * Fingerprint of everything the note actually shows: labels, characters and
 * names. Coordinates are deliberately excluded, so dragging a node — or an
 * avatar around its pin — produces the same signature and skips the write.
 */
export function contentSignature(map: StoredChapterMap, pawns: Pawn[]): string {
	const nodes = [...map.nodes]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((node) => [node.id, node.label ?? "", [...node.chars]]);
	const roster = pawns
		.map((pawn) => [pawn.id, pawn.name])
		.sort((a, b) => a[0].localeCompare(b[0]));
	return JSON.stringify([nodes, roster]);
}
