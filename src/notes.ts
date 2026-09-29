import type { MapNode, Pawn, StoredChapterMap } from "./types";
import { indexPawns, resolveToken } from "./pawns";
import { childrenOf, collectCast, isZone } from "./hierarchy";

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
function sortedNodes(nodes: readonly MapNode[]): MapNode[] {
	return [...nodes].sort((a, b) => {
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
 * The map is a tree — a region holds towns, a town holds districts — and this
 * reads it as one, because a flat list of every node made the digest contradict
 * the map it was summarising: a character standing in a town was listed against
 * the town while the region above it read as empty. A zone now prints everyone
 * under it, recursively, and nests what it contains.
 *
 * A zone's line is its whole cast, so a reader can stop at the level they care
 * about; a plain location's line is only its own characters, because "the people
 * here" means exactly that and nothing more.
 *
 * Every node is printed exactly once, whatever shape the file is in. That is not
 * defensive padding: a location whose `parentId` names a node that is not there
 * is invisible to a walk from the roots, and dropping it would put a place the
 * writer drew silently out of the digest. A cycle in a hand-edited file would
 * hang the walk instead, so anything the walk does not reach is printed at the
 * top level on the way out.
 *
 * The off-story pool is everyone in the roster who appears nowhere in the chapter.
 */
export function buildNoteBlock(map: StoredChapterMap, pawns: Pawn[], s: NoteStrings): string {
	const index = indexPawns(pawns);
	const lines: string[] = [NOTE_START, s.placementTitle];

	if (map.nodes.length === 0) {
		lines.push(s.noLocations);
	} else {
		const known = new Set(map.nodes.map((node) => node.id));
		// Marks a node as printed, and is what stops a cycle from recursing
		// forever. A root is a node with no parent, plus a node whose parent is
		// not in this file: as far as the digest is concerned it has nowhere to
		// hang, so it gets the top level rather than vanishing.
		const seen = new Set<string>();
		const describe = (node: MapNode, depth: number): string[] => {
			if (seen.has(node.id)) return [];
			seen.add(node.id);
			return describeNode(map.nodes, node, depth, index, s, describe);
		};

		for (const node of sortedNodes(map.nodes)) {
			if (node.parentId === undefined || !known.has(node.parentId)) {
				lines.push(...describe(node, 0));
			}
		}
		// Whatever is left is in a cycle, or is a child of a node already printed
		// under another parent. Both have to appear once rather than not at all.
		for (const node of sortedNodes(map.nodes)) {
			if (!seen.has(node.id)) lines.push(...describe(node, 0));
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

/**
 * Markdown lines for one node and, indented under it, everything it contains.
 *
 * The `describe` callback rather than a direct self-call, because the closure in
 * `buildNoteBlock` owns the "printed once" bookkeeping that a cycle needs.
 */
function describeNode(
	nodes: readonly MapNode[],
	node: MapNode,
	depth: number,
	index: Map<string, Pawn>,
	s: NoteStrings,
	describe: (node: MapNode, depth: number) => string[],
): string[] {
	// A zone speaks for its whole subtree; a location speaks only for itself.
	const tokens = isZone(node) ? collectCast(nodes, node.id) : node.chars;
	const names = tokens
		.map((token) => index.get(token)?.name)
		.filter((name): name is string => name !== undefined)
		.map((name) => wikiLink(name));

	// Char order is the writer's own (the order they ticked the boxes).
	const indent = "  ".repeat(depth);
	const label = node.label?.trim() || s.unnamedLocation;
	const lines = [`${indent}- **${label}**: ${names.length > 0 ? names.join(", ") : s.emptyLocation}`];

	for (const child of sortedNodes(childrenOf(nodes, node.id))) {
		lines.push(...describe(child, depth + 1));
	}
	return lines;
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
 * Fingerprint of everything the note actually shows: the shape of the tree, the
 * labels, the characters and the names.
 *
 * `parentId` is in here because the digest nests by it — moving a town into a
 * region changes the file, and a signature blind to that would leave the old
 * nesting in place with no error. Coordinates are deliberately excluded, so
 * dragging a node — or an avatar around its pin — produces the same signature
 * and skips the write.
 */
export function contentSignature(map: StoredChapterMap, pawns: Pawn[]): string {
	const nodes = [...map.nodes]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((node) => [node.id, node.parentId ?? "", node.label ?? "", [...node.chars]]);
	const roster = pawns
		.map((pawn) => [pawn.id, pawn.name])
		.sort((a, b) => a[0].localeCompare(b[0]));
	return JSON.stringify([nodes, roster]);
}
