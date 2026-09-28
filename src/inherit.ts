import type { CharOffset, ChapterLink, ChapterMaps, MapNode } from "./types";
import { ensureMap, isChapterFile } from "./store";

/**
 * Taking a chapter's starting state from the chapter before it.
 *
 * A writer does not want to redraw the harbour, the inn and the four people
 * standing in them at the top of every new chapter — and they certainly do not
 * want the canvas to be a different size each time, so the pins land off-screen.
 * This module copies that state forward once, on request, and records where it
 * came from.
 *
 * Like layout.ts, it is pure: no filesystem, no Obsidian, no DOM. Every decision
 * it makes is a decision the tests can pin down, which matters because the
 * interesting failure here is silent — a wrong guess looks exactly like an
 * empty chapter until the writer has already drawn a hundred nodes over it.
 *
 * Two rules make that failure impossible:
 *   1. Nothing is copied into a chapter that already has nodes. The copy is a
 *      starting point, not a merge, so it can never be half-applied over work
 *      that is already there.
 *   2. Exactly one chapter is read, and it is read by the caller naming it. There
 *      is no walk up a parent chain, so a lineage that loops — which a renamed
 *      file or a hand-edited field can easily create — cannot loop here.
 */

/** What an inheritance would bring, counted so the button can say so up front. */
export interface InheritPreview {
	/** The chapter being copied from. */
	parent: string;
	/** How many locations come with it. */
	nodes: number;
	/** How many distinct characters are placed on those locations. */
	pawns: number;
	/** How many ties between them come with it. */
	links: number;
	/** True when the parent's background image would be copied too. */
	hasBackground: boolean;
	/** True when the parent's canvas size would be copied too. */
	hasSize: boolean;
}

/**
 * Order two chapters the way a reader would say them.
 *
 * `numeric` is what makes "Глава 2" sort before "Глава 10"; without it every
 * chapter with two or more digits lands in the wrong place and the suggestion
 * silently points at the wrong chapter. `sensitivity: "base"` ignores case, so
 * "chapter 2" and "Chapter 2" are neighbours rather than two groups.
 *
 * This sorts whole paths, so folders outrank file names: everything under
 * "Часть B/" comes after everything under "Часть A/", whatever the chapters are
 * called inside. That is the one case the author has to correct by hand, which
 * is exactly why the parent is editable and not just automatic.
 */
function chapterOrder(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * The chapter to copy from, if the store suggests one.
 *
 * Only chapters that already have a map can be a source — there is nothing to
 * copy out of an empty one — and the suggestion is the entry immediately before
 * this chapter in reading order, not the most recently edited one. Editing time
 * would make the answer change under the writer's feet the moment they went back
 * to fix a typo in an earlier chapter.
 *
 * Returns null for the first chapter: there is nothing before it, and offering
 * the next one instead would be a guess dressed up as a default.
 */
export function suggestParent(maps: ChapterMaps, path: string): string | null {
	const known = Object.keys(maps).filter(isChapterFile).sort(chapterOrder);
	// The chapter being filled in often has no entry yet, so it takes part in the
	// ordering without being a possible source.
	const index = known.indexOf(path);
	if (index >= 0) return index > 0 ? known[index - 1] : null;

	const ordered = [...known, path].sort(chapterOrder);
	const at = ordered.indexOf(path);
	return at > 0 ? ordered[at - 1] : null;
}

/** Every chapter that could be picked by hand, in reading order. */
export function parentCandidates(maps: ChapterMaps, path: string): string[] {
	return Object.keys(maps).filter((key) => isChapterFile(key) && key !== path).sort(chapterOrder);
}

/**
 * Deep copy of one location.
 *
 * Written out rather than handed to `structuredClone` so the shape of the copy
 * is visible and so it stays in step with `MapNode`: a new field added there and
 * forgotten here would be silently dropped, and a dropped field is a pawn that
 * quietly snaps back into its ring.
 */
function cloneNode(node: MapNode): MapNode {
	const copy: MapNode = {
		id: node.id,
		x: node.x,
		y: node.y,
		chars: [...node.chars],
	};
	if (node.label !== undefined) copy.label = node.label;
	if (node.charOffsets) {
		const offsets: Record<string, CharOffset> = {};
		for (const [token, offset] of Object.entries(node.charOffsets)) {
			offsets[token] = { offsetX: offset.offsetX, offsetY: offset.offsetY };
		}
		copy.charOffsets = offsets;
	}
	return copy;
}

function cloneLink(link: ChapterLink): ChapterLink {
	return { a: link.a, b: link.b, kind: link.kind };
}

/** How many distinct characters the given locations hold. */
function countPawns(nodes: readonly MapNode[]): number {
	const tokens = new Set<string>();
	for (const node of nodes) for (const token of node.chars) tokens.add(token);
	return tokens.size;
}

/**
 * What inheriting from `parent` would bring, without touching anything.
 *
 * The counts go straight into the button, because the whole risk of this feature
 * is doing it to the wrong chapter — so the writer is told which chapter, and
 * how much, before the click. `parent` defaults to the suggested one.
 */
export function previewInherit(maps: ChapterMaps, path: string, parent?: string | null): InheritPreview | null {
	const source = parent === undefined ? suggestParent(maps, path) : parent;
	if (!source || source === path) return null;

	const from = maps[source];
	// No entry means no layout to copy. Reporting "0 nodes" for a chapter that
	// is not in the store would offer a button that does nothing.
	if (!from) return null;

	return {
		parent: source,
		nodes: from.nodes.length,
		pawns: countPawns(from.nodes),
		links: from.links?.length ?? 0,
		hasBackground: Boolean(from.map_bg),
		hasSize: from.map_size !== undefined,
	};
}

/**
 * Copy a chapter's starting state into another, once.
 *
 * Refuses — returning null — when the source is not in the store, when the
 * source is the target, or when the target already holds a location. The last
 * one is the important one: this is a starting point, and a writer who has
 * already drawn something must never have it overwritten by a button they
 * pressed once.
 *
 * Everything that positions a node comes across, including the background and
 * the canvas size. The size matters as much as the pins: the coordinates are
 * meaningless outside the canvas they were drawn on, so copying a 4000x3000
 * layout onto a default 1024x768 one would put the harbour off the visible
 * sheet with no way to tell why.
 */
export function inheritFrom(maps: ChapterMaps, path: string, parent: string): InheritPreview | null {
	const preview = previewInherit(maps, path, parent);
	if (!preview) return null;

	const from = maps[preview.parent];
	// The guard above only proves the entry exists and is not the target; the
	// emptiness check is here, where the decision is made.
	if (maps[path] && maps[path].nodes.length > 0) return null;

	const to = ensureMap(maps, path);
	to.nodes = from.nodes.map(cloneNode);
	if (from.links) to.links = from.links.map(cloneLink);
	else delete to.links;

	// A parent that declared neither of these leaves the target as it was, rather
	// than writing nulls that would shadow the image and the default size.
	if (from.map_size) to.map_size = [...from.map_size];
	else delete to.map_size;
	if (from.map_bg) to.map_bg = from.map_bg;
	else to.map_bg = null;

	to.parent_chapter_id = preview.parent;
	return preview;
}

/** Last segment of a vault path: the name a reader would call the chapter. */
export function basename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * Whether the stored parent still points at a chapter that exists.
 *
 * A renamed or moved chapter leaves the path behind, and the answer is the only
 * way the map can tell "inherited from a chapter I no longer have" apart from
 * "built by hand". The fix is re-pointing it, not guessing which chapter was
 * meant.
 */
export function parentIsStale(maps: ChapterMaps, path: string): boolean {
	const parent = maps[path]?.parent_chapter_id;
	return Boolean(parent) && !hasOwn(maps, parent as string);
}

function hasOwn(object: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}
