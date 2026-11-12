import type { MapNode, Pawn, StoredChapterMap } from "./types";
import { indexPawns, resolveToken } from "./pawns";
import { childrenOf, collectCast, isZone } from "./hierarchy";

/**
 * The author's notes, kept in a visible folder of the vault, beside the map.
 *
 * The folder is deliberately not hidden any more. A dot-folder meant the writer
 * could not find the file they were told about, and every "where did it go?"
 * was answered by a path they had to paste in. Here the file is an ordinary
 * markdown file they can open, edit with live preview, and link to — and the
 * plugin still owns exactly one span of it.
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

/** Root of the generated notes: a visible folder, so the writer can find them. */
export const NOTE_ROOT = "Writer Maps Notes";

/** Visible copy of the notes, written only by the explicit export command. */
export const EXPORT_ROOT = "Writer Maps Export";

/**
 * Opening marker of the generated block.
 *
 * An HTML comment, and it sits *outside* the callout. A marker inside a callout
 * is not hidden by Live Preview: the callout is its own block, so the comment
 * renders as a stray line above the first quote. Outside, it is a real comment
 * and disappears.
 */
export const NOTE_START = "<!-- wsm:summary:start -->";

/** Closing marker of the generated block. Nothing after it is ever rewritten. */
export const NOTE_END = "<!-- wsm:summary:end -->";

/**
 * The block as a whole, with the span between the markers captured.
 *
 * Tolerating whitespace inside the comments is not decoration. Live Preview, a
 * formatter and a hand-editing session all rewrite `<!--wsm:summary:start-->`
 * into spaced variants, and a matcher that insists on the exact string would
 * stop finding its own block and prepend a second one on top of the first.
 */
export const NOTE_BLOCK_RE = /<!--\s*wsm:summary:start\s*-->([\s\S]*?)<!--\s*wsm:summary:end\s*-->/;

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
 * "Writer Maps Notes/Book/Chapter.md".
 *
 * Idempotent, so a note can never be made a chapter's note a second time and
 * spiral into "Writer Maps Notes/Writer Maps Notes/...".
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
 * Remove square brackets from a name or a label.
 *
 * Names are printed as plain text, not as `[[wikilinks]]`: inside a callout a
 * wikilink is one more thing that either renders as an unresolved link or, in
 * Live Preview, swallows the keystrokes that follow it. But a stray bracket in a
 * name still has to go, because `[` is how markdown, and Obsidian's own link
 * syntax, reads "this is a link from here on". A name of `Кай[старший]` would
 * otherwise swallow the rest of the line.
 *
 * The first pass removes the double-bracket wikilink form, the second any
 * bracket left over. The first is redundant given the second and is kept
 * because it documents the intent: this exists to make plain text safe to print.
 */
export function stripBrackets(text: string): string {
	return text.replace(/\[\[|\]\]/g, "").replace(/[\[\]]/g, "");
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
 * The block is an Obsidian callout, so it reads as one object in Live Preview
 * and can be folded or moved as a unit. The markers sit outside it, which is the
 * whole reason the block is quoted: an HTML comment inside a callout is a line
 * the reader sees, and one above it is a line the reader does not.
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
	// `body` holds the callout's own lines, unquoted. The quoting is applied
	// once, at the end, so nothing in here has to remember it is inside a
	// callout — and a forgotten `> ` would be a line that silently escapes the
	// block and becomes the author's text.
	const body: string[] = [`[!info] ${stripBrackets(s.placementTitle)}`];

	if (map.nodes.length === 0) {
		body.push("", s.noLocations);
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
				body.push(...describe(node, 0));
			}
		}
		// Whatever is left is in a cycle, or is a child of a node already printed
		// under another parent. Both have to appear once rather than not at all.
		for (const node of sortedNodes(map.nodes)) {
			if (!seen.has(node.id)) body.push(...describe(node, 0));
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
		body.push("", s.offStoryTitle);
		const sorted = [...pool].sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
		for (const pawn of sorted) body.push(`- ${stripBrackets(pawn.name)}`);
	}

	// The free-zone reminder is *inside* the block, not after the closing marker.
	// It is a line about the note's own structure, so it belongs to the part the
	// plugin regenerates: an author who deletes it gets it back on the next write,
	// and the export can strip it along with the rest of the callout.
	body.push("", `*${stripBrackets(s.freeZone)}*`);

	return [NOTE_START, ...body.map(quote), NOTE_END].join("\n");
}

/** Prefix one line for a callout. An empty line stays an empty quote line. */
function quote(line: string): string {
	return line === "" ? ">" : `> ${line}`;
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
		.map((name) => stripBrackets(name));

	// Char order is the writer's own (the order they ticked the boxes). Two spaces
	// per level: a callout is quoted, so a four-space indent would read as a code
	// block once the `> ` is added.
	const indent = "  ".repeat(depth);
	const label = stripBrackets(node.label?.trim() || s.unnamedLocation);
	// The colon goes inside the emphasis: `- **Лес:** Ян` reads as a field name,
	// while `- **Лес**: Ян` leaves a colon hanging outside the bold and makes the
	// list look like it is announcing something rather than naming it.
	const lines = [`${indent}- **${label}:** ${names.length > 0 ? names.join(", ") : s.emptyLocation}`];

	for (const child of sortedNodes(childrenOf(nodes, node.id))) {
		lines.push(...describe(child, depth + 1));
	}
	return lines;
}

/** File text for a note that does not exist yet. */
export function newNote(block: string): string {
	const merged = mergeNote(null, block);
	// `mergeNote(null, ...)` can only succeed; the branch keeps the return type
	// honest without a cast at every call site.
	return merged.ok ? merged.text : `${block}\n`;
}

/** Outcome of splicing a generated block into a file. */
export type MergeResult =
	| { ok: true; text: string; changed: boolean; prepended?: boolean }
	| { ok: false; reason: "unbalanced" };

/** The block found in a file, and the author's text on either side of it. */
interface BlockSpan {
	/** The callout itself: what is between the two markers. */
	inner: string;
	/** Everything before the opening marker, byte for byte. */
	before: string;
	/** Everything after the closing marker, byte for byte. */
	after: string;
}

/**
 * Find our block, or nothing.
 *
 * `exec` rather than `match` because only `exec` guarantees an `index`, and
 * both callers need one to slice the file without touching the parts that are
 * not theirs.
 */
function findBlock(source: string): BlockSpan | null {
	const match = NOTE_BLOCK_RE.exec(source);
	if (!match) return null;
	const at = match.index;
	return {
		inner: match[1] ?? "",
		before: source.slice(0, at),
		after: source.slice(at + match[0].length),
	};
}

/** Whether the file holds one marker of the pair, or the pair the wrong way round. */
function hasHalfBlock(source: string): boolean {
	return /<!--\s*wsm:summary:start\s*-->/.test(source) || /<!--\s*wsm:summary:end\s*-->/.test(source);
}

/**
 * Splice the generated block into the current file contents.
 *
 * - `existing === null`: the file is created with the block.
 * - Both markers present: exactly the span between them is replaced, and the
 *   author's text before and after survives byte for byte.
 * - No markers: the block goes in at the very top, blank line and all, and
 *   `prepended` says so. That is the only non-destructive option for a file the
 *   plugin did not create — but it does put a callout above a title the author
 *   wrote, so the caller is expected to tell them rather than do it quietly.
 * - Exactly one marker, or the pair the wrong way round: the file was edited by
 *   hand, so we refuse rather than guess where the block should end.
 *
 * The match runs through `NOTE_BLOCK_RE`, not `indexOf` on the exact constants,
 * so a marker that a formatter respaced is still found. An `indexOf` here is
 * what would silently prepend a second block to a file that already has a
 * perfectly good one.
 */
export function mergeNote(existing: string | null, block: string): MergeResult {
	if (existing === null) {
		return { ok: true, text: `${block}\n`, changed: true };
	}

	const span = findBlock(existing);
	if (span) {
		const text = `${span.before}${block}${span.after}`;
		return { ok: true, text, changed: text !== existing };
	}

	// No complete pair. A lone marker means the file was hand-edited into a state
	// we cannot interpret, and guessing is how a plugin eats a manuscript.
	if (hasHalfBlock(existing)) return { ok: false, reason: "unbalanced" };

	// A blank file is not a file anyone wrote in; there is nothing to displace.
	if (existing.trim() === "") {
		return { ok: true, text: `${block}\n`, changed: true };
	}

	return { ok: true, text: `${block}\n\n${existing}`, changed: true, prepended: true };
}

/**
 * The exported copy of a note: clean markdown, author's text untouched.
 *
 * Everything between the markers is ours to rewrite, and it is rewritten down to
 * what the block actually said: a heading, and a list. Everything outside is the
 * author's and is carried over byte for byte, free zone and all — the point of
 * the export is to get their file out where another app can open it, not to tidy
 * it on the way.
 *
 * The callout becomes a heading, its `> ` quotes come off, its `[!info]` header
 * goes, and the free-zone reminder goes with it: in the copy there is no plugin
 * block left to remind anyone about, and the line would just sit as noise
 * between the list and the author's prose.
 *
 * A file with no complete block comes back unchanged. There is nothing of ours
 * in it, and inventing a heading above text we know nothing about is the one
 * thing an export must never do.
 */
export function exportTextFor(source: string, s: NoteStrings): string {
	const span = findBlock(source);
	if (!span) return source;

	const heading = `### 🗺️ ${stripBrackets(s.placementTitle)}`;
	// Unquoted and trimmed, because the gap that surrounded the block in the note
	// is not part of the block: `mergeNote` leaves a newline either side of the
	// markers, and re-adding them here would stack blank lines into the copy.
	const body = trimBlank(span.inner.split("\n").map((line) => line.replace(/^>\s?/, "")));
	const lines: string[] = [];

	for (const [at, line] of body.entries()) {
		// A blank line inside the callout separates the location list from the
		// off-story pool, and that separation is content — it is the only thing
		// telling the reader those are two different lists. Collapsed to one, so
		// the copy does not inherit whatever the author did to the spacing.
		if (line === "") {
			if (lines[lines.length - 1] !== "") lines.push("");
			continue;
		}
		// The callout's own header is replaced by the heading, not kept.
		if (/^\[!\w+\]/.test(line)) {
			lines.push(heading);
			continue;
		}
		// The free-zone reminder is the last thing the plugin writes, and it is
		// italic. Matching it by position rather than by wording is what keeps an
		// export from carrying a stale copy: reword the translation, or have the
		// author translated it by hand, and the line is still recognised. Matching
		// the text would leave the old sentence sitting in every exported file,
		// which is the one artefact nothing else can clean up afterwards.
		if (at === body.length - 1 && /^\*[^*].*\*$/.test(line.trim())) continue;

		// `- ` becomes `* `, so the top level of the exported list reads like the
		// heading above it: two different bullet marks, one visual weight.
		lines.push(line.replace(/^(\s*)-\s/, "$1* "));
	}

	// The author's own text, byte for byte, behind one blank line. Its own leading
	// newlines are dropped: the separation is ours to provide, and the note's
	// version of it is measured against a marker that is no longer in the file.
	const tail = span.before + span.after;
	return [lines.join("\n").trim(), tail.trim()].filter((part) => part !== "").join("\n\n");
}

/** Drop the blank lines at both ends of a list of lines, and collapse runs to one. */
function trimBlank(lines: string[]): string[] {
	const isBlank = (line: string): boolean => line.trim() === "";
	let first = 0;
	let last = lines.length;
	while (first < last && isBlank(lines[first])) first += 1;
	while (last > first && isBlank(lines[last - 1])) last -= 1;
	return lines.slice(first, last);
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
