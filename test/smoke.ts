// Smoke tests for the pure logic. Run: npm run test
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	addNode,
	deleteNode,
	ensureMap,
	findOrphanKeys,
	hasMap,
	isChapterFile,
	mergeMaps,
	mergePawns,
	moveKey,
	moveKeysForFolder,
	moveNode,
	normalizeBackgroundPath,
	normalizeMap,
	normalizeMaps,
	normalizePawns,
	readMap,
	removeLink,
	removeMap,
	renameNode,
	replaceNodeToken,
	setBackground,
	setCanvasSize,
	setNodeAnchor,
	setNodeParent,
	setParentChapter,
	setPawnOnNode,
	setZoneFill,
	setZoneOutline,
	addZone,
	addLink,
	linkBetween,
} from "../src/store.ts";
import { parseSettings } from "../src/storage.ts";
import {
	clampInitials,
	colorForToken,
	createPawn,
	indexPawns,
	initialsFromName,
	isLightColor,
	resolveToken,
	slugify,
	textColorClasses,
	uniquePawnId,
	updatePawn,
} from "../src/pawns.ts";
import { t } from "../src/i18n.ts";
import type { TranslationKey } from "../src/i18n.ts";
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from "../src/types.ts";
import type { ChapterMaps, Pawn, StoredChapterMap, WriterStateMapSettings } from "../src/types.ts";
import { composePawn, PLACEHOLDER_INITIALS } from "../src/pawns.ts";
import { App, noticeLog, openedSuggestModals, TFile, WorkspaceLeaf } from "./obsidian-stub.ts";
import { installDom, FakeElement, pressKey } from "./dom-stub.ts";
import { MapView } from "../src/map-view.ts";
import { RosterView } from "../src/roster-view.ts";
import { RelationshipPanel } from "../src/relationship-panel.ts";
import { pickFromList, pickNote } from "../src/pickers.ts";
import {
	buildNoteBlock,
	chapterForNotePath,
	contentSignature,
	EXPORT_ROOT,
	isExportPath,
	isManagedPath,
	isNotePath,
	mergeNote,
	newNote,
	NOTE_END,
	NOTE_ROOT,
	NOTE_START,
	noteFolderFor,
	notePathFor,
	wikiLink,
} from "../src/notes.ts";
import type { NoteStrings } from "../src/notes.ts";
import { NoteWriter } from "../src/note-writer.ts";
import { isNudged, placedPosition, radialSlot, ringRadius } from "../src/layout.ts";
import { moveCharOffsets, setCharOffset } from "../src/store.ts";
import { inheritFrom, parentCandidates, parentIsStale, previewInherit, suggestParent } from "../src/inherit.ts";
import type { InheritPreview } from "../src/inherit.ts";
import {
	childrenOf,
	collectCast,
	descendantsOf,
	isEnterable,
	isZone,
	levelNodes,
	pointInPolygon,
	rootNodes,
	sunLayout,
	zoneAt,
	zoneSelfIntersects,
	zoneToPoints,
	SUN_CAP,
} from "../src/hierarchy.ts";
import type { MapNode, ZonePoint } from "../src/types.ts";

const FALLBACK = { width: 1024, height: 768 };
const CHAPTER = "Chapters/Chapter 1.md";

/**
 * Let queued microtasks and timers run.
 *
 * Used wherever a test drives something asynchronous: a picker modal, or a
 * deferred write waiting on a vault event.
 */
const settle = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
};

/* ------------------------------------------------------------------ *
 * store.ts: background paths                                          *
 * ------------------------------------------------------------------ */

assert.equal(normalizeBackgroundPath('"maps/world.png"'), "maps/world.png", "quoted path");
assert.equal(normalizeBackgroundPath("[[world.png]]"), "world.png", "wikilink");
assert.equal(normalizeBackgroundPath("![[world.png|600]]"), "world.png", "embed with size hint");
assert.equal(normalizeBackgroundPath("./maps/world.png"), "maps/world.png", "leading ./");
assert.equal(normalizeBackgroundPath("  maps/world.png  "), "maps/world.png", "trims whitespace");

/* ------------------------------------------------------------------ *
 * store.ts: chapter detection                                          *
 * ------------------------------------------------------------------ */

assert.equal(isChapterFile(CHAPTER), true, "markdown is a chapter");
assert.equal(isChapterFile("maps/world.png"), false, "image is not");
assert.equal(isChapterFile("notes/README.MD"), true, "extension match is case-insensitive");
assert.equal(isChapterFile(""), false, "empty path is not");
assert.equal(isChapterFile(null), false, "null is not");
assert.equal(isChapterFile(undefined), false, "undefined is not");

/* ------------------------------------------------------------------ *
 * store.ts: normalizing hand-edited data.json                          *
 * ------------------------------------------------------------------ */

for (const junk of [undefined, null, "string", 42, [], [1, 2]]) {
	assert.deepEqual(normalizeMaps(junk), {}, `junk maps object yields nothing: ${JSON.stringify(junk)}`);
}

assert.deepEqual(
	normalizeMaps({ [CHAPTER]: "junk", "notes.txt": { nodes: [] }, "ok.md": null }),
	{ [CHAPTER]: { map_bg: null, nodes: [] }, "ok.md": { map_bg: null, nodes: [] } },
	"non-object entries are reset, non-markdown keys are dropped",
);

const normalized = normalizeMaps({
	[CHAPTER]: {
		map_bg: "[[maps/world.png|600]]",
		map_size: [800, 600],
		nodes: [
			{ id: "city_A", label: "Город", x: 150, y: 300, chars: ["tom", "ГГ"] },
			{ id: "city_B", x: "450", y: "120" },
			{ id: "broken", x: "not-a-number" },
			{ x: 1, y: 1 },
			null,
		],
	},
})[CHAPTER];

assert.equal(normalized.map_bg, "maps/world.png", "background normalized");
assert.deepEqual(normalized.map_size, [800, 600], "map_size parsed");
assert.equal(normalized.nodes.length, 3, "entries without an id are dropped");
assert.deepEqual(normalized.nodes[1], { id: "city_B", x: 450, y: 120, chars: [] }, "numeric strings coerced");
assert.equal(normalized.nodes[2].x, 0, "unparsable x falls back to 0");
assert.deepEqual(normalized.nodes[0].chars, ["tom", "ГГ"], "chars preserved as written");

assert.deepEqual(normalizeMap({ map_size: { width: 300, height: 200 } }).map_size, [300, 200], "object map_size");
assert.equal(normalizeMap({ map_size: [0, 0] }).map_size, undefined, "zero size is not a size");
assert.equal(normalizeMap({ map_size: "nonsense" }).map_size, undefined, "garbage size is not a size");
assert.equal(normalizeMap({ map_bg: "" }).map_bg, null, "empty background is no background");

assert.deepEqual(normalizePawns("junk"), [], "junk pawns");
assert.deepEqual(
	normalizePawns([{ id: "tom", name: "Tom" }, { name: "no id" }, null]),
	[{ id: "tom", name: "Tom", initials: "To", color: "#888888" }],
	"missing pawn fields are filled in, entries without an id are dropped",
);
assert.equal(
	normalizePawns([{ id: "tom", name: "Tom Sawyer" }])[0].initials,
	"TS",
	"absent initials are derived from the name, not sliced off the id",
);

/* ------------------------------------------------------------------ *
 * store.ts: reading                                                   *
 * ------------------------------------------------------------------ */

assert.deepEqual(readMap({}, null, FALLBACK), {
	path: null,
	bg: null,
	canvas: FALLBACK,
	hasExplicitSize: false,
	nodes: [],
	// Always present, so the graph view can read them without a null check.
	links: [],
	parentChapterId: null,
}, "no chapter is empty");

const missing = readMap({}, CHAPTER, FALLBACK);
assert.equal(missing.path, null, "a chapter without a stored map is still an empty state");
assert.equal(missing.canvas.width, FALLBACK.width, "fallback canvas applies");

const maps: ChapterMaps = {
	[CHAPTER]: {
		map_bg: "maps/world.png",
		map_size: [800, 600],
		nodes: [{ id: "a", x: 1, y: 2, chars: [] }],
	},
	"No size.md": { map_bg: null, nodes: [] },
};

const view = readMap(maps, CHAPTER, FALLBACK);
assert.equal(view.path, CHAPTER, "stored map reports its chapter");
assert.equal(view.bg, "maps/world.png", "background read from the store");
assert.deepEqual(view.canvas, { width: 800, height: 600 }, "explicit size wins");
assert.equal(view.hasExplicitSize, true, "explicit size is flagged");

const noSize = readMap(maps, "No size.md", FALLBACK);
assert.equal(noSize.hasExplicitSize, false, "no size means the image decides");
assert.deepEqual(noSize.canvas, FALLBACK, "fallback used when the image has not loaded yet");

assert.equal(hasMap(maps, CHAPTER), true, "existing map detected");
assert.equal(hasMap(maps, "other.md"), false, "missing map detected");
assert.equal(hasMap(maps, null), false, "null path is never a chapter");
assert.equal(hasMap(maps, "image.png"), false, "non-markdown is never a chapter");

/* ------------------------------------------------------------------ *
 * store.ts: lazy binding                                               *
 * ------------------------------------------------------------------ */

{
	const lazy: ChapterMaps = {};
	assert.equal(hasMap(lazy, CHAPTER), false, "nothing stored before the first action");

	const first = ensureMap(lazy, CHAPTER);
	assert.equal(first.map_bg, null, "a new map has no background");
	assert.deepEqual(first.nodes, [], "a new map has no locations");
	assert.equal(ensureMap(lazy, CHAPTER), first, "ensureMap is idempotent, it never discards data");
	assert.equal(hasMap(lazy, CHAPTER), true, "the entry now exists");
}

assert.equal(removeMap({}, CHAPTER), false, "removing a missing map is a no-op");
{
	const removable: ChapterMaps = { [CHAPTER]: { map_bg: null, nodes: [] } };
	assert.equal(removeMap(removable, CHAPTER), true, "existing map removed");
	assert.deepEqual(removable, {}, "the key is gone");
}

/* ------------------------------------------------------------------ *
 * store.ts: writing                                                    *
 * ------------------------------------------------------------------ */

{
	// The chapter has no map yet: the very first write creates it.
	const lazy: ChapterMaps = {};
	assert.equal(addNode(lazy, CHAPTER, "first", 1, 2), "first", "id assigned on first write");
	assert.deepEqual(lazy[CHAPTER], { map_bg: null, nodes: [{ id: "first", x: 1, y: 2, chars: [] }] }, "entry created lazily");
}

{
	const store: ChapterMaps = { [CHAPTER]: { map_bg: "a.png", map_size: [10, 10], nodes: [{ id: "a", x: 1, y: 2, chars: ["tom"] }] } };

	assert.equal(setPawnOnNode(store, CHAPTER, "a", "anna", true), true, "toggle reports success");
	assert.equal(setPawnOnNode(store, CHAPTER, "a", "tom", false), true, "existing pawn removed");
	assert.equal(setPawnOnNode(store, CHAPTER, "a", "anna", false), true, "added pawn removed");
	assert.equal(setPawnOnNode(store, CHAPTER, "a", "anna", true), true, "re-added");
	assert.deepEqual(store[CHAPTER].nodes[0].chars, ["anna"], "toggle add/remove works");

	assert.equal(moveNode(store, CHAPTER, "a", 640.4, 480.6), true, "move reports success");
	assert.deepEqual(
		{ x: store[CHAPTER].nodes[0].x, y: store[CHAPTER].nodes[0].y },
		{ x: 640, y: 481 },
		"coordinates are rounded to ints",
	);

	assert.equal(renameNode(store, CHAPTER, "a", "North Gate"), true, "rename reports success");
	assert.equal(store[CHAPTER].nodes[0].label, "North Gate", "label written");
	renameNode(store, CHAPTER, "a", "   ");
	assert.equal("label" in store[CHAPTER].nodes[0], false, "empty label is removed, not blank");

	assert.equal(replaceNodeToken(store, CHAPTER, "a", "anna", "tom"), true, "token replaced");
	assert.deepEqual(store[CHAPTER].nodes[0].chars, ["tom"], "replacement has no duplicates");
	assert.equal(replaceNodeToken(store, CHAPTER, "a", "ghost", "tom"), true, "replacement is idempotent");
	assert.deepEqual(store[CHAPTER].nodes[0].chars, ["tom"], "unknown old token is a no-op");

	// Unrelated parts of the same map are never disturbed.
	assert.equal(store[CHAPTER].map_bg, "a.png", "background preserved");
	assert.deepEqual(store[CHAPTER].map_size, [10, 10], "size preserved");

	// Operations on missing nodes are no-ops rather than crashes.
	for (const result of [
		setPawnOnNode(store, CHAPTER, "nope", "x", true),
		moveNode(store, CHAPTER, "nope", 1, 1),
		renameNode(store, CHAPTER, "nope", "y"),
		replaceNodeToken(store, CHAPTER, "nope", "x", "y"),
		deleteNode(store, CHAPTER, "nope"),
		setPawnOnNode(store, "unknown.md", "a", "x", true),
	]) {
		assert.equal(result, false, "missing node or map reports failure without throwing");
	}
}

{
	const store: ChapterMaps = { [CHAPTER]: { map_bg: null, nodes: [{ id: "a" } as never] } };
	assert.equal(addNode(store, CHAPTER, "a", 10, 20), "a-2", "duplicate id is disambiguated");
	assert.equal(addNode(store, CHAPTER, "a", 30, 40), "a-3", "next duplicate continues the counter");
	assert.equal(addNode(store, CHAPTER, "fresh", 50, 60), "fresh", "free id is used as-is");
	assert.deepEqual(store[CHAPTER].nodes, [
		{ id: "a" },
		{ id: "a-2", x: 10, y: 20, chars: [] },
		{ id: "a-3", x: 30, y: 40, chars: [] },
		{ id: "fresh", x: 50, y: 60, chars: [] },
	], "nodes are appended in order");
}

{
	const store: ChapterMaps = { [CHAPTER]: { map_bg: null, nodes: [{ id: "a" }, { id: "b" }] } };
	assert.equal(deleteNode(store, CHAPTER, "a"), true, "delete reports success");
	assert.deepEqual(store[CHAPTER].nodes, [{ id: "b" }], "only the target node is removed");
}

{
	const store: ChapterMaps = {};
	assert.deepEqual(setBackground(store, CHAPTER, "[[maps/world.png|600]]"), { map_bg: "maps/world.png", nodes: [] }, "background set creates the entry and normalizes the path");
	setBackground(store, CHAPTER, null);
	assert.equal(store[CHAPTER].map_bg, null, "background can be cleared");

	setCanvasSize(store, CHAPTER, [800.4, 600.6]);
	assert.deepEqual(store[CHAPTER].map_size, [800, 601], "explicit size stored as ints");
	setCanvasSize(store, CHAPTER, [0, 0]);
	assert.equal(store[CHAPTER].map_size, undefined, "invalid size clears the override");
	setCanvasSize(store, CHAPTER, [1024, 768]);
	setCanvasSize(store, CHAPTER, null);
	assert.equal("map_size" in store[CHAPTER], false, "size key removed, not blanked");
}

/* ------------------------------------------------------------------ *
 * store.ts: ties between characters                                   *
 * ------------------------------------------------------------------ */

{
	// Hand-written and imported data can hold anything, so normalization is
	// where a bad tie has to die: an unknown kind has no line to draw, a
	// character cannot be tied to itself, and the same bond written both ways is
	// one bond.
	const messy = normalizeMap({
		map_bg: null,
		nodes: [],
		links: [
			{ a: "tom", b: "kim", kind: "blood" },
			{ a: "kim", b: "tom", kind: "debt" },
			{ a: "aya", b: "aya", kind: "secret" },
			{ a: "tom", b: "aya", kind: "friendship" },
			{ a: "kim", b: "tom", kind: "blood" },
			"not an object",
			null,
		],
	});

	assert.deepEqual(
		messy.links,
		[
			// Ends normalized, so the mirrored "debt" is recognized as the same
			// pair and dropped instead of drawn as a second line.
			{ a: "kim", b: "tom", kind: "blood" },
		],
		"unknown kinds, self-ties and duplicate pairs are all dropped; the ends are normalized",
	);
}

{
	// A hand-written id that came out as a number is coerced rather than dropped,
	// the same as every other path-ish field in this module: data.json is written
	// by hand, and a lost tie is worse than a surprising id. A pawn id that does
	// not exist is simply not drawn.
	const coerced = normalizeMap({ nodes: [], links: [{ a: 7, b: "kim", kind: "blood" }] });
	assert.deepEqual(coerced.links, [{ a: "7", b: "kim", kind: "blood" }], "a numeric end is read as its string form");
}

{
	// The "no ties" case must not write an empty array: absent and empty are the
	// same thing to the reader, and a shorter data.json is a nicer one.
	assert.equal("links" in normalizeMap({ nodes: [] }), false, "an empty link list is stored as absent");
	assert.equal("links" in normalizeMap({ nodes: [], links: [] }), false, "an explicit empty list is dropped too");
	assert.equal("links" in normalizeMap({ nodes: [], links: "oops" }), false, "a non-array is ignored, not trusted");
}

{
	const store: ChapterMaps = { [CHAPTER]: { map_bg: null, nodes: [] } };

	assert.equal(addLink(store, CHAPTER, "tom", "kim", "blood"), true, "a new tie is written");
	assert.deepEqual(store[CHAPTER].links, [{ a: "kim", b: "tom", kind: "blood" }], "ends are stored in a fixed order");

	// The same bond the other way round has to find the same entry, or the graph
	// would grow a duplicate line on the second click.
	assert.equal(addLink(store, CHAPTER, "tom", "kim", "debt"), true, "changing the kind rewrites the tie");
	assert.deepEqual(store[CHAPTER].links, [{ a: "kim", b: "tom", kind: "debt" }], "still exactly one tie, now a debt");
	assert.equal(linkBetween(store[CHAPTER], "kim", "tom"), "debt", "the tie is found from either end");

	// Re-picking what is already there changes nothing, and says so, so the view
	// does not repaint for a no-op.
	assert.equal(addLink(store, CHAPTER, "kim", "tom", "debt"), false, "re-picking the same kind is a no-op");
	assert.equal(addLink(store, CHAPTER, "tom", "kim", "debt"), false, "and is a no-op from the other end too");

	assert.equal(addLink(store, CHAPTER, "aya", "tom", "secret"), true, "a second, unrelated tie");
	assert.equal(store[CHAPTER].links?.length, 2, "two pairs means two ties");

	assert.equal(removeLink(store, CHAPTER, "tom", "kim"), true, "a tie is cut from either end");
	assert.equal(linkBetween(store[CHAPTER], "tom", "kim"), null, "the cut tie is gone");
	assert.equal(store[CHAPTER].links?.length, 1, "the unrelated tie survives");

	assert.equal(removeLink(store, CHAPTER, "kim", "tom"), false, "cutting an absent tie reports no change");

	// Removing the last one drops the key instead of leaving `[]` behind.
	assert.equal(removeLink(store, CHAPTER, "aya", "tom"), true, "the last tie is cut");
	assert.equal("links" in store[CHAPTER], false, "the key is removed, not blanked");

	// Refusals, none of which may throw.
	for (const result of [
		addLink(store, CHAPTER, "tom", "tom", "blood"),
		addLink(store, "unknown.md", "a", "b", "blood"),
		removeLink(store, "unknown.md", "a", "b"),
		removeLink({ [CHAPTER]: { map_bg: null, nodes: [] } }, CHAPTER, "a", "b"),
	]) {
		assert.equal(result, false, "a self-tie or a missing map reports failure without throwing");
	}
}

{
	// A tie to a pawn that no longer exists must not be drawn as a line to
	// nowhere, and must not take the graph down either. The view filters; the
	// store keeps what was written so a later rename can find it again.
	const store: ChapterMaps = {
		[CHAPTER]: { map_bg: null, nodes: [], links: [{ a: "gone", b: "tom", kind: "secret" }] },
	};
	assert.equal(addLink(store, CHAPTER, "ghost", "tom", "blood"), true, "a tie to a missing pawn is still stored");
	assert.equal(store[CHAPTER].links?.length, 2, "both ties are kept");
}

/* ------------------------------------------------------------------ *
 * store.ts: where a map came from                                     *
 * ------------------------------------------------------------------ */

{
	const other: ChapterMaps = { "Other.md": { map_bg: null, nodes: [] } };
	const store: ChapterMaps = { [CHAPTER]: { map_bg: null, nodes: [] }, ...other };

	assert.equal(setParentChapter(store, CHAPTER, "Other.md"), true, "a parent is recorded");
	assert.equal(store[CHAPTER].parent_chapter_id, "Other.md", "the parent path is written as given");
	assert.equal(readMap(store, CHAPTER, { width: 1, height: 1 }).parentChapterId, "Other.md", "the view model exposes it");

	// These two would either corrupt the lineage or copy from nothing.
	assert.equal(setParentChapter(store, CHAPTER, CHAPTER), false, "a chapter cannot be its own parent");
	assert.equal(setParentChapter(store, CHAPTER, "Nowhere.md"), false, "a chapter that is not in the store is refused");
	assert.equal(store[CHAPTER].parent_chapter_id, "Other.md", "the refused parents left the old one alone");

	assert.equal(setParentChapter(store, CHAPTER, "Other.md"), true, "re-picking the same parent still succeeds");
	assert.equal(setParentChapter(store, CHAPTER, null), true, "the parent can be forgotten");
	assert.equal("parent_chapter_id" in store[CHAPTER], false, "the key is removed, not blanked");
	assert.equal(setParentChapter(store, CHAPTER, null), false, "forgetting a parent that is not there reports no change");
	assert.equal(readMap(store, CHAPTER, { width: 1, height: 1 }).parentChapterId, null, "a hand-built map reports no parent");
}

{
	// A parent pointing at the plugin's own generated note would let a digest be
	// inherited from, and a non-markdown path is not a chapter at all.
	const polluted = normalizeMap({
		nodes: [],
		parent_chapter_id: ".Writer Maps Data/Book/Chapter 1.md",
	});
	assert.equal("parent_chapter_id" in polluted, false, "a parent inside the generated notes folder is refused");

	const other = normalizeMap({ nodes: [], parent_chapter_id: "image.png" });
	assert.equal("parent_chapter_id" in other, false, "a parent that is not a markdown note is refused");

	const good = normalizeMap({ nodes: [], parent_chapter_id: "Book/Chapter 1.md" });
	assert.equal(good.parent_chapter_id, "Book/Chapter 1.md", "a real chapter path is kept");
}

{
	// An older file simply has none of the new fields, and has to load without
	// the views inventing empty ones.
	const old = normalizeMap({ map_bg: "a.png", nodes: [{ id: "a", x: 1, y: 2, chars: ["tom"] }] });
	const view = readMap({ [CHAPTER]: old }, CHAPTER, { width: 1024, height: 768 });
	assert.deepEqual(view.links, [], "a map with no stored ties reads as an empty list, not null");
	assert.equal(view.parentChapterId, null, "and with no parent");
}

{
	// The nested-map fields are read the same way as everything else in a
	// hand-edited data.json: taken at their word, coerced, and never trusted.
	const map = normalizeMap({
		nodes: [
			{
				id: "west",
				x: 0,
				y: 0,
				chars: [],
				kind: "zone",
				zone: [
					{ x: 0, y: 0 },
					{ x: 100, y: 0 },
					{ x: 100, y: 80 },
				],
				anchor: { x: 40, y: 30 },
				fill: "#3355ff",
			},
			{ id: "harbour", x: 10, y: 20, chars: ["tom"], parentId: "west" },
		],
	});

	const [west, harbour] = map.nodes;
	assert.equal(west.kind, "zone", "a zone is a zone because the file says so");
	assert.equal(west.zone?.length, 3, "its three corners are kept");
	assert.equal(harbour.parentId, "west", "and the child names what it is inside");
	assert.equal(west.parentId, undefined, "while the parent says nothing about it");
	assert.deepEqual(west.anchor, { x: 40, y: 30 }, "the author's own anchor survives");
	assert.equal(west.fill, "#3355ff", "as does the custom hover colour");
}

{
	// A file written before the direction was inverted: the edge is on the parent
	// and has to be adopted by the child, or every zone comes back as a door onto
	// an empty level.
	const legacy = normalizeMap({
		nodes: [
			{ id: "west", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], targetMapId: "harbour" },
			{ id: "harbour", x: 10, y: 20, chars: ["tom"] },
		],
	});

	const byLegacy = new Map(legacy.nodes.map((node) => [node.id, node]));
	assert.equal(byLegacy.get("harbour")?.parentId, "west", "the old edge is moved onto the child");
	assert.equal("targetMapId" in (byLegacy.get("west") as object), false, "and taken off the parent it was on");
	assert.deepEqual(collectCast(legacy.nodes, "west"), ["tom"], "so the zone is enterable again, with its cast");

	// Two parents used to name the same child. `parentId` is one value, so only the
	// first claim survives, and map order is the tie-break a reader can predict.
	const contested = normalizeMap({
		nodes: [
			{ id: "east", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], targetMapId: "mill" },
			{ id: "west", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], targetMapId: "mill" },
			{ id: "mill", x: 10, y: 20, chars: [] },
		],
	});
	const byContested = new Map(contested.nodes.map((node) => [node.id, node]));
	assert.equal(byContested.get("mill")?.parentId, "east", "the first claim on a child is the one kept");
}

{
	// Every way the new fields can be wrong, and what has to survive anyway.
	const map = normalizeMap({
		nodes: [
			// A self-reference: an element that is inside itself can never be
			// walked into, and would be a one-node loop to every traversal.
			{ id: "loop", x: 0, y: 0, chars: [], kind: "zone", parentId: "loop", zone: [] },
			// A parent that is not in this map at all.
			{ id: "gone", x: 0, y: 0, chars: [], kind: "zone", parentId: "nowhere" },
			// Two corners is a line, not an interior.
			{ id: "line", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 9, y: 9 }] },
			// Rubbish everywhere, including the two numbers a polygon needs.
			{ id: "junk", x: 0, y: 0, chars: [], zone: "not an array", anchor: { x: 5 }, fill: 42, parentId: 7 },
		],
	});

	const byId = new Map(map.nodes.map((node) => [node.id, node]));
	assert.equal("parentId" in (byId.get("loop") as object), false, "an element inside itself loses the link");
	assert.equal("parentId" in (byId.get("gone") as object), false, "a parent that is not there is dropped");
	assert.equal("parentId" in (byId.get("junk") as object), false, "a parent that is not an id is dropped");
	assert.equal("zone" in (byId.get("line") as object), false, "an unfinished outline is not an interior");
	assert.equal("zone" in (byId.get("junk") as object), false, "a zone that is not an array is dropped");
	assert.equal("anchor" in (byId.get("junk") as object), false, "half an anchor is no anchor");
	assert.equal("fill" in (byId.get("junk") as object), false, "a colour that is not a colour is dropped");
	assert.equal("kind" in (byId.get("junk") as object), false, "and no kind is invented from any of it");
}

{
	// A colour is the one value the plugin does not read but hands to the DOM, so
	// it is checked instead of merely coerced.
	const map = normalizeMap({
		nodes: [
			{ id: "short", x: 0, y: 0, chars: [], fill: "#4f8" },
			{ id: "long", x: 0, y: 0, chars: [], fill: "#4f8a2c" },
			{ id: "alpha", x: 0, y: 0, chars: [], fill: "#4f8a2c80" },
			{ id: "named", x: 0, y: 0, chars: [], fill: "teal" },
			{ id: "func", x: 0, y: 0, chars: [], fill: "rgba(20, 30, 40, 0.4)" },
			{ id: "url", x: 0, y: 0, chars: [], fill: "url(evil.svg)" },
			{ id: "words", x: 0, y: 0, chars: [], fill: "javascript:alert(1)" },
			{ id: "num", x: 0, y: 0, chars: [], fill: 42 },
		],
	});
	const fill = (id: string) => map.nodes.find((node) => node.id === id)?.fill;

	assert.equal(fill("short"), "#4f8", "a short hex is a colour");
	assert.equal(fill("long"), "#4f8a2c", "a long hex is a colour");
	assert.equal(fill("alpha"), "#4f8a2c80", "a hex with an alpha byte is a colour");
	assert.equal(fill("named"), "teal", "a named colour is a colour");
	assert.equal(fill("func"), "rgba(20, 30, 40, 0.4)", "an rgb/rgba function is a colour");
	assert.equal(fill("url"), undefined, "a url() is not a colour and never reaches the DOM");
	assert.equal(fill("words"), undefined, "and neither is arbitrary text that only looks like one");
	assert.equal(fill("num"), undefined, "a number is not silently turned into the string \"42\"");
}

{
	// `kind: "zone"` is not implied by an outline, and an outline alone is not
	// implied to be a door: a pin the author drew around something stays a pin.
	const map = normalizeMap({
		nodes: [
			{
				id: "shape_only",
				x: 0,
				y: 0,
				chars: [],
				zone: [
					{ x: 0, y: 0 },
					{ x: 10, y: 0 },
					{ x: 10, y: 10 },
				],
			},
			{ id: "door_only", x: 0, y: 0, chars: [], kind: "zone" },
		],
	});
	assert.equal("kind" in (map.nodes[0] as object), false, "an outline does not make the element a door");
	assert.equal(map.nodes[1].kind, "zone", "and a door without one is still declared a zone");
}

/* ------------------------------------------------------------------ *
 * inherit.ts: taking one chapter's layout as the next one's start     *
 * ------------------------------------------------------------------ */

{
	// The whole feature rests on this: a writer opening "Глава 2" has to be
	// offered "Глава 1", and opening "Глава 10" has to be offered "Глава 9".
	// Plain lexicographic order gets that wrong, and gets it wrong silently.
	const store: ChapterMaps = {
		"Глава 1.md": { map_bg: null, nodes: [] },
		"Глава 2.md": { map_bg: null, nodes: [] },
		"Глава 10.md": { map_bg: null, nodes: [] },
	};

	assert.equal(suggestParent(store, "Глава 2.md"), "Глава 1.md", "the first chapter after another is offered");
	assert.equal(
		suggestParent(store, "Глава 10.md"),
		"Глава 2.md",
		"Глава 10 is offered Глава 2, not Глава 1 — a string sort would say otherwise",
	);
	assert.equal(suggestParent(store, "Глава 1.md"), null, "the very first chapter has nothing before it");
}

{
	// Case must not split the order into two groups, or "chapter 2" would be
	// offered whatever "Chapter 9" happened to be.
	const store: ChapterMaps = {
		"Chapter 1.md": { map_bg: null, nodes: [] },
		"chapter 2.md": { map_bg: null, nodes: [] },
		"Chapter 3.md": { map_bg: null, nodes: [] },
	};
	assert.equal(suggestParent(store, "Chapter 3.md"), "chapter 2.md", "case does not reorder the chapters");
}

{
	// A chapter with no entry yet still has a place in the order — that is the
	// normal case, since the entry appears when the map is first filled in.
	const store: ChapterMaps = {
		"Глава 1.md": { map_bg: null, nodes: [] },
		"Глава 3.md": { map_bg: null, nodes: [] },
	};
	assert.equal(
		suggestParent(store, "Глава 2.md"),
		"Глава 1.md",
		"a chapter with no map of its own is still ordered, and takes the chapter before it",
	);
	// Глава 2 comes before Глава 3, so the source is the one in the store and
	// never the empty target.
	assert.notEqual(suggestParent(store, "Глава 2.md"), "Глава 2.md", "a chapter is never its own suggestion");
}

{
	// The one case the automatic order gets wrong, and the reason the parent is
	// editable: sorting whole paths puts a whole folder before a later one.
	const store: ChapterMaps = {
		"Часть A/Глава 9.md": { map_bg: null, nodes: [] },
		"Часть B/Глава 1.md": { map_bg: null, nodes: [] },
	};
	assert.equal(
		suggestParent(store, "Часть B/Глава 1.md"),
		"Часть A/Глава 9.md",
		"folders outrank chapter numbers — which is why the parent can be re-pointed by hand",
	);
	assert.deepEqual(
		parentCandidates(store, "Часть B/Глава 1.md"),
		["Часть A/Глава 9.md"],
		"the hand-picked list holds every other chapter, in reading order",
	);
}

{
	// Folders the plugin owns are never offered: inheriting a chapter from a
	// generated digest would give the digest a map, whose digest would then have
	// one of its own, forever.
	const store: ChapterMaps = {
		"Глава 1.md": { map_bg: null, nodes: [] },
		[".Writer Maps Data/Глава 1.md"]: { map_bg: null, nodes: [] },
	};
	assert.deepEqual(
		parentCandidates(store, "Глава 9.md"),
		["Глава 1.md"],
		"a generated note is not a chapter to inherit from",
	);
}

{
	// The preview is what the button says before it is pressed, so it has to
	// count what is actually coming.
	const store: ChapterMaps = {
		"Глава 1.md": {
			map_bg: "maps/harbour.png",
			map_size: [4000, 3000],
			nodes: [
				{ id: "harbour", x: 100, y: 200, chars: ["tom", "kim"], charOffsets: { tom: { offsetX: 3, offsetY: -4 } } },
				{ id: "inn", x: 300, y: 400, chars: ["tom", "aya"] },
			],
			links: [{ a: "kim", b: "tom", kind: "blood" }],
		},
	};

	const preview = previewInherit(store, "Глава 2.md") as InheritPreview;
	assert.ok(preview, "a preview is available when there is a chapter to copy");
	assert.equal(preview.parent, "Глава 1.md", "the preview names the source");
	assert.equal(preview.nodes, 2, "both locations are counted");
	assert.equal(preview.pawns, 3, "three distinct characters: tom, kim, aya — not four");
	assert.equal(preview.links, 1, "the tie comes with it");
	assert.equal(preview.hasBackground, true, "the background is part of what comes");
	assert.equal(preview.hasSize, true, "and so is the canvas size");

	// A chapter in the store with nothing in it: the preview is honest, and the
	// counts are what tells the writer not to bother.
	const empty: ChapterMaps = { "Глава 1.md": { map_bg: null, nodes: [] } };
	const dry = previewInherit(empty, "Глава 2.md") as InheritPreview;
	assert.equal(dry.nodes, 0, "an empty source previews as empty");
	assert.equal(dry.hasBackground, false, "and reports no background");
}

{
	assert.equal(previewInherit({}, "Глава 1.md"), null, "with nothing stored there is no preview");
	assert.equal(
		previewInherit({ "Глава 1.md": { map_bg: null, nodes: [] } }, "Глава 1.md"),
		null,
		"a chapter is never previewed from itself",
	);
	assert.equal(
		previewInherit({ "Глава 1.md": { map_bg: null, nodes: [] } }, "Глава 2.md", "Nowhere.md"),
		null,
		"a source that is not in the store has nothing to copy",
	);
}

{
	// The actual copy: everything that positions a node has to cross, and the
	// entries that are only present sometimes must not appear as nulls.
	const source: ChapterMaps = {
		"Глава 1.md": {
			map_bg: "maps/harbour.png",
			map_size: [4000, 3000],
			nodes: [
				{
					id: "harbour",
					label: "Harbour",
					x: 100,
					y: 200,
					chars: ["tom", "kim"],
					charOffsets: { tom: { offsetX: 3, offsetY: -4 } },
				},
			],
			links: [{ a: "kim", b: "tom", kind: "blood" }],
		},
		"Глава 2.md": { map_bg: null, nodes: [] },
	};

	const result = inheritFrom(source, "Глава 2.md", "Глава 1.md");
	assert.ok(result, "the copy reports what it did");
	const copy = source["Глава 2.md"];

	assert.deepEqual(copy.nodes, source["Глава 1.md"].nodes, "the locations come across whole");
	assert.deepEqual(copy.map_size, [4000, 3000], "the canvas size comes across, so the pins stay on the sheet");
	assert.equal(copy.map_bg, "maps/harbour.png", "the background comes across");
	assert.deepEqual(copy.links, [{ a: "kim", b: "tom", kind: "blood" }], "the ties come across");
	assert.equal(copy.parent_chapter_id, "Глава 1.md", "and the source is recorded");

	// The whole point of a deep copy: the two chapters are now independent, and
	// working in one must not reach into the other. Without this the writer would
	// find last chapter's harbour moving every time they rearranged this one.
	copy.nodes[0].x = 999;
	copy.nodes[0].chars.push("aya");
	copy.nodes[0].charOffsets!.tom.offsetX = 100;
	copy.nodes[0].label = "Renamed";
	copy.links![0].kind = "secret";
	assert.equal(source["Глава 1.md"].nodes[0].x, 100, "moving a copied node leaves the original alone");
	assert.deepEqual(source["Глава 1.md"].nodes[0].chars, ["tom", "kim"], "adding a character does not leak back");
	assert.equal(source["Глава 1.md"].nodes[0].charOffsets!.tom.offsetX, 3, "the nudges are copies too");
	assert.equal(source["Глава 1.md"].nodes[0].label, "Harbour", "the label is a copy as well");
	assert.equal(source["Глава 1.md"].links![0].kind, "blood", "changing a tie in the copy leaves the original alone");
}

{
	// A whole nested map has to arrive, or the new chapter opens on a world with
	// no regions in it. Every field that makes an element a door is copied, and
	// the copy is as independent as the rest.
	const store: ChapterMaps = {
		"Глава 1.md": {
			map_bg: null,
			nodes: [
				{
					id: "west",
					label: "Запад",
					x: 10,
					y: 20,
					chars: [],
					kind: "zone",
					zone: [
						{ x: 0, y: 0 },
						{ x: 100, y: 0 },
						{ x: 100, y: 100 },
					],
					anchor: { x: 40, y: 30 },
					fill: "#3355ff",
				},
				{ id: "harbour", x: 30, y: 40, chars: ["tom"], parentId: "west" },
				{ id: "inn", x: 50, y: 60, chars: ["aya"], parentId: "harbour" },
				{ id: "mill", x: 70, y: 80, chars: ["aya"], parentId: "west" },
			],
		},
		"Глава 2.md": { map_bg: null, nodes: [] },
	};

	inheritFrom(store, "Глава 2.md", "Глава 1.md");
	const copy = store["Глава 2.md"];

	assert.deepEqual(copy.nodes, store["Глава 1.md"].nodes, "the whole forest comes across, links and all");
	assert.deepEqual(levelNodes(copy.nodes, []).map((node) => node.id), ["west"], "and the new chapter opens on the same world");
	assert.deepEqual(
		levelNodes(copy.nodes, ["west"]).map((node) => node.id),
		["harbour", "mill"],
		"with both of the region's towns side by side, which one link per parent could never hold",
	);
	assert.deepEqual(levelNodes(copy.nodes, ["west", "harbour"]).map((node) => node.id), ["inn"], "and the same inn inside that");
	assert.deepEqual(levelNodes(copy.nodes, ["west", "mill"]), [], "while the mill, which holds nothing, is the honest floor");
	assert.deepEqual(collectCast(copy.nodes, "west"), ["tom", "aya"], "and the same cast around its anchor");

	// Independence, corner by corner: a chapter that rearranges its regions must
	// not reach back into the one it was copied from.
	const copiedZone = copy.nodes[0];
	copiedZone.zone![0].x = 500;
	copiedZone.anchor!.y = 500;
	copiedZone.fill = "#ff0000";
	assert.equal(store["Глава 1.md"].nodes[0].zone![0].x, 0, "redrawing a copied outline leaves the original alone");
	assert.equal(store["Глава 1.md"].nodes[0].anchor!.y, 30, "and so does moving its anchor");
	assert.equal(store["Глава 1.md"].nodes[0].fill, "#3355ff", "and recolouring it");
}

{
	// A source that declared neither a background nor a size must not write nulls
	// over the target: nulls would shadow the image and the default size.
	const store: ChapterMaps = {
		"Глава 1.md": {
			map_bg: null,
			nodes: [{ id: "a", x: 1, y: 2, chars: ["tom"] }],
		},
		"Глава 2.md": { map_bg: "maps/other.png", map_size: [800, 600], nodes: [] },
	};
	inheritFrom(store, "Глава 2.md", "Глава 1.md");
	assert.equal(store["Глава 2.md"].map_bg, null, "an absent background clears the target's own");
	assert.equal(store["Глава 2.md"].map_size, undefined, "an absent size removes the key, not blanks it");
}

{
	// A chapter with no entry at all gets one — this is how a fresh chapter is
	// filled in — and the entry is a normal one afterwards.
	const store: ChapterMaps = {
		"Глава 1.md": { map_bg: null, nodes: [{ id: "a", x: 5, y: 6, chars: ["tom"] }] },
	};
	assert.equal("Глава 2.md" in store, false, "the target has no entry yet");
	inheritFrom(store, "Глава 2.md", "Глава 1.md");
	assert.ok("Глава 2.md" in store, "the copy created the entry");
	assert.equal(store["Глава 2.md"].nodes.length, 1, "and filled it");
}

{
	// The refusal that protects work already done. A writer who has drawn a
	// hundred nodes must never lose them to a button pressed once.
	const drawn: ChapterMaps = {
		"Глава 1.md": { map_bg: null, nodes: [{ id: "a", x: 1, y: 2, chars: ["tom"] }] },
		"Глава 2.md": { map_bg: null, nodes: [{ id: "mine", x: 700, y: 800, chars: [] }] },
	};
	assert.equal(inheritFrom(drawn, "Глава 2.md", "Глава 1.md"), null, "a chapter with a location is refused");
	assert.deepEqual(drawn["Глава 2.md"].nodes, [{ id: "mine", x: 700, y: 800, chars: [] }], "and its node is untouched");
	assert.equal(drawn["Глава 2.md"].parent_chapter_id, undefined, "no parent is recorded for a refused copy");

	// The other refusals, none of which may throw.
	const store: ChapterMaps = { "Глава 1.md": { map_bg: null, nodes: [] } };
	assert.equal(inheritFrom(store, "Глава 2.md", "Nowhere.md"), null, "a source that is not in the store is refused");
	assert.equal(inheritFrom(store, "Глава 1.md", "Глава 1.md"), null, "a chapter cannot be copied from itself");
}

{
	// Only the chapter named is read. A lineage is a record of where the layout
	// came from, not a live link that walks up, so a cycle — which a renamed
	// file or a hand-edited field can easily produce — has nothing to loop in.
	const store: ChapterMaps = {
		"Глава 1.md": {
			map_bg: null,
			nodes: [{ id: "a", x: 1, y: 2, chars: ["tom"] }],
			parent_chapter_id: "Глава 3.md",
		},
		"Глава 2.md": { map_bg: null, nodes: [] },
		"Глава 3.md": {
			map_bg: null,
			nodes: [{ id: "b", x: 30, y: 40, chars: ["kim"] }],
			parent_chapter_id: "Глава 1.md",
		},
	};

	inheritFrom(store, "Глава 2.md", "Глава 1.md");
	assert.deepEqual(
		store["Глава 2.md"].nodes.map((node) => node.id),
		["a"],
		"only the named chapter's locations are copied, not its ancestor's or its child's",
	);
	assert.equal(store["Глава 2.md"].parent_chapter_id, "Глава 1.md", "and the lineage stops there");
}

{
	// A renamed chapter leaves the path behind. The answer is re-pointing it, not
	// guessing which chapter was meant, so the only thing to get right is telling
	// the two cases apart.
	const store: ChapterMaps = {
		"Глава 1.md": { map_bg: null, nodes: [] },
		"Глава 2.md": { map_bg: null, nodes: [], parent_chapter_id: "Глава 1.md" },
		"Глава 3.md": { map_bg: null, nodes: [], parent_chapter_id: "Renamed/Глава 2.md" },
		"Глава 4.md": { map_bg: null, nodes: [] },
	};

	assert.equal(parentIsStale(store, "Глава 2.md"), false, "a parent that is still there is not stale");
	assert.equal(parentIsStale(store, "Глава 3.md"), true, "a parent whose file is gone is stale");
	assert.equal(parentIsStale(store, "Глава 4.md"), false, "a hand-built map is not stale, it simply has no parent");

	// And the fix is the same call that re-pointed it in the first place.
	setParentChapter(store, "Глава 3.md", "Глава 2.md");
	assert.equal(parentIsStale(store, "Глава 3.md"), false, "re-pointing clears the staleness");
}

/* ------------------------------------------------------------------ *
 * hierarchy.ts: the nested maps                                        *
 * ------------------------------------------------------------------ */

{
	// A square, drawn the way an author draws one: corners in whatever order the
	// clicks landed. Ray casting answers "inside" for the middle and "outside"
	// for everything beyond the edges.
	const square: ZonePoint[] = [
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 100, y: 100 },
		{ x: 0, y: 100 },
	];

	assert.equal(pointInPolygon({ x: 50, y: 50 }, square), true, "the middle of a square is inside it");
	assert.equal(pointInPolygon({ x: 150, y: 50 }, square), false, "past the right edge is outside");
	assert.equal(pointInPolygon({ x: -1, y: 50 }, square), false, "past the left edge is outside");
	assert.equal(pointInPolygon({ x: 50, y: -1 }, square), false, "above the top edge is outside");
	assert.equal(pointInPolygon({ x: 50, y: 101 }, square), false, "below the bottom edge is outside");

	// The corner cases that make or break a counting algorithm. Each of these has
	// a wrong answer waiting for it, and the wrong answer is always "outside".
	assert.equal(pointInPolygon({ x: 0, y: 0 }, square), true, "a corner counts as inside");
	assert.equal(pointInPolygon({ x: 0, y: 50 }, square), true, "a point on the left edge is inside");
	assert.equal(pointInPolygon({ x: 100, y: 50 }, square), true, "a point on the right edge is inside");
	assert.equal(pointInPolygon({ x: 50, y: 0 }, square), true, "a point on the top edge is inside");
	assert.equal(pointInPolygon({ x: 50, y: 100 }, square), true, "a point on the bottom edge is inside too");
	assert.equal(pointInPolygon({ x: 200, y: 0 }, square), false, "but a point on the line past the edge is not");

	// A concave outline: the notch is outside even though it is inside the
	// bounding box, which is the whole reason a bounding box is not good enough.
	const arrow: ZonePoint[] = [
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 100, y: 100 },
		{ x: 50, y: 40 },
		{ x: 0, y: 100 },
	];
	assert.equal(pointInPolygon({ x: 50, y: 20 }, arrow), true, "the head of the arrow is solid");
	assert.equal(pointInPolygon({ x: 50, y: 80 }, arrow), false, "the notch under it is not, though it shares the bounding box");

	// A triangle, and a figure with a horizontal edge, which the half-open
	// comparison exists for.
	const triangle: ZonePoint[] = [
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 50, y: 100 },
	];
	assert.equal(pointInPolygon({ x: 50, y: 10 }, triangle), true, "inside a triangle near its base");
	assert.equal(pointInPolygon({ x: 50, y: 95 }, triangle), true, "and near its point");
	assert.equal(pointInPolygon({ x: 2, y: 50 }, triangle), false, "outside it, to the left");

	const flat: ZonePoint[] = [
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 100, y: 100 },
		{ x: 50, y: 100 },
		{ x: 50, y: 40 },
		{ x: 0, y: 40 },
	];
	assert.equal(pointInPolygon({ x: 75, y: 20 }, flat), true, "a shape with a horizontal edge is still solid at its top");
	assert.equal(pointInPolygon({ x: 25, y: 70 }, flat), false, "and still has the notch cut out of it");

	// Fewer than three corners encloses nothing, whatever the author meant.
	assert.equal(pointInPolygon({ x: 0, y: 0 }, []), false, "an empty outline contains nothing");
	assert.equal(pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }]), false, "a line contains nothing");
}

{
	// Which zone a click landed in. Overlapping outlines are allowed, and the
	// last one drawn wins — the same rule stacked SVG shapes follow, and the only
	// one the writer can predict from what they did.
	const nodes: MapNode[] = [
		{
			id: "west",
			x: 0,
			y: 0,
			chars: [],
			kind: "zone",
			zone: [
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
				{ x: 100, y: 100 },
				{ x: 0, y: 100 },
			],
		},
		{
			id: "inner",
			x: 0,
			y: 0,
			chars: [],
			kind: "zone",
			zone: [
				{ x: 20, y: 20 },
				{ x: 60, y: 20 },
				{ x: 60, y: 60 },
				{ x: 20, y: 60 },
			],
		},
		{ id: "harbour", x: 30, y: 30, chars: [] },
	];

	assert.equal(zoneAt(nodes, { x: 10, y: 10 })?.id, "west", "a click in the outer outline");
	assert.equal(zoneAt(nodes, { x: 40, y: 40 })?.id, "inner", "a click where two overlap picks the one drawn last");
	assert.equal(zoneAt(nodes, { x: 200, y: 200 }), null, "a click on empty map is in no zone");
	assert.equal(zoneAt(nodes, { x: 30, y: 30 })?.id, "inner", "and a pin inside a zone is not what was hit");

	// A pin is never a zone, however its outline happens to be shaped.
	assert.equal(zoneAt([{ ...nodes[0], kind: "pin" }], { x: 50, y: 50 }), null, "an outline alone does not catch the click");
}

{
	// The forest: World -> Region -> Location, as one flat array, with the edges
	// running upwards. `west` holding two towns is the case the old direction could
	// not express at all, and the reason the direction was inverted.
	const nodes: MapNode[] = [
		{ id: "west", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }] },
		{ id: "harbour", x: 0, y: 0, chars: ["tom"], parentId: "west" },
		{ id: "inn", x: 0, y: 0, chars: ["aya"], parentId: "harbour" },
		{ id: "mill", x: 0, y: 0, chars: ["kim"], parentId: "west" },
		{ id: "east", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] },
		{ id: "mine", x: 0, y: 0, chars: ["bob"], parentId: "east" },
	];

	assert.deepEqual(rootNodes(nodes).map((node) => node.id), ["west", "east"], "only the nodes inside nothing are on top");
	assert.deepEqual(
		childrenOf(nodes, "west").map((node) => node.id),
		["harbour", "mill"],
		"a region holds every element that names it, not just one",
	);
	assert.deepEqual(childrenOf(nodes, "harbour").map((node) => node.id), ["inn"], "and a town holds its own");
	assert.deepEqual(
		descendantsOf(nodes, "west").map((node) => node.id),
		["harbour", "mill", "inn"],
		"the whole subtree below it, breadth first",
	);
	assert.deepEqual(descendantsOf(nodes, "inn"), [], "a location has nothing below it");
	// A leaf is not a root. `inn` is at the bottom of the tree, and how deep it
	// sits says nothing about where it is shown.
	assert.equal(rootNodes(nodes).includes(nodes[2] as MapNode), false, "a leaf inside a region stays inside it");

	// The level the view is showing. An empty stack is the top of the chapter.
	assert.deepEqual(levelNodes(nodes, []).map((node) => node.id), ["west", "east"], "no trail means the world");
	assert.deepEqual(levelNodes(nodes, ["west"]).map((node) => node.id), ["harbour", "mill"], "one step down");
	assert.deepEqual(levelNodes(nodes, ["west", "harbour"]).map((node) => node.id), ["inn"], "two steps down");
	assert.deepEqual(levelNodes(nodes, ["west", "harbour", "inn"]), [], "and the floor is an honest empty level, not the level above");

	// A stack naming a node that was deleted drops the writer back a level
	// instead of to nothing.
	assert.deepEqual(
		levelNodes(nodes, ["west", "gone"]).map((node) => node.id),
		["harbour", "mill"],
		"a level whose node is gone falls back to the level above it",
	);
	assert.deepEqual(levelNodes(nodes, ["gone"]).map((node) => node.id), ["west", "east"], "and to the world when there is no level above");

	assert.equal(isZone(nodes[0]), true, "a zone with three corners is a zone");
	assert.equal(isEnterable(nodes, nodes[0]), true, "and leads somewhere, so it can be entered");
	assert.equal(isEnterable(nodes, nodes[2]), false, "a location leads nowhere");
	assert.equal(isZone({ ...nodes[0], zone: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), false, "an unfinished outline is not a zone");

	// A hand-edited loop is not a level anybody can stand on: every node in it is
	// inside another, so the world would be empty and the writer would have no way
	// back out.
	const loop: MapNode[] = [
		{ id: "a", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }], parentId: "b" },
		{ id: "b", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }], parentId: "a" },
	];
	assert.deepEqual(collectCast(loop, "a").length, 0, "a loop is walked once, not forever");
	assert.deepEqual(levelNodes(loop, ["a"]).map((node) => node.id), ["b"], "and stops at the repeat");
}

{
	// The sun: everyone under a zone, however deep, gathered in one ring.
	const nodes: MapNode[] = [
		{ id: "west", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }] },
		{ id: "harbour", x: 0, y: 0, chars: ["tom", "aya"], parentId: "west" },
		{ id: "inn", x: 0, y: 0, chars: ["tom", "kim"], parentId: "harbour" },
		{ id: "mill", x: 0, y: 0, chars: [], parentId: "west" },
		{ id: "east", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] },
		{ id: "mine", x: 0, y: 0, chars: ["bob"], parentId: "east" },
	];

	assert.deepEqual(
		collectCast(nodes, "west"),
		["tom", "aya", "kim"],
		"the region's own characters and its towns', each one once",
	);
	assert.deepEqual(collectCast(nodes, "harbour"), ["tom", "aya", "kim"], "a town gathers its own and what is under it");
	assert.deepEqual(collectCast(nodes, "inn"), ["tom", "kim"], "a location gathers only its own");
	assert.deepEqual(collectCast(nodes, "east"), ["bob"], "another region is a different sun");

	// A character in two towns of the same region is one token. Drawing them
	// twice would say they were in two places at once, which is the sort of claim
	// the map exists to prevent.
	assert.equal(collectCast(nodes, "west").filter((token) => token === "tom").length, 1, "a character standing twice is still one");

	// The cap. What does not fit is counted, not dropped and not squeezed in.
	const many = Array.from({ length: SUN_CAP + 5 }, (_, i) => `p${i}`);
	const cast: MapNode[] = [
		{ id: "west", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }] },
		{ id: "crowded", x: 0, y: 0, chars: many, parentId: "west" },
	];
	assert.equal(sunLayout(collectCast(cast, "west")).shown.length, SUN_CAP, "the ring draws as many as it can hold");
	assert.equal(sunLayout(collectCast(cast, "west")).overflow, "+5", "and the rest is a count the writer can click");
	assert.equal(sunLayout(["tom", "aya"]).overflow, null, "a cast that fits has no count at all");
}

{
	// The outline as the DOM needs it, and the one shape worth refusing to close.
	assert.equal(
		zoneToPoints([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
		]),
		"0,0 10,0 10,10",
		"corners as an SVG points list",
	);

	assert.equal(zoneSelfIntersects([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), false, "a square is not a bow tie");
	assert.equal(zoneSelfIntersects([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }]), true, "a bow tie is");
	assert.equal(
		zoneSelfIntersects([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 5 }, { x: 0, y: 10 }]),
		false,
		"a notch is a concavity, not a crossing",
	);
	// Two rooms sharing a wall: the corner sits on the other edge, which is a
	// touch and not a crossing, and refusing it would reject a normal drawing.
	assert.equal(
		zoneSelfIntersects([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 10 }, { x: 5, y: 5 }, { x: 0, y: 5 }]),
		false,
		"a shared wall is not a crossing",
	);
	assert.equal(zoneSelfIntersects([{ x: 0, y: 0 }, { x: 10, y: 0 }]), false, "too few corners to cross anything");
}

{
	// The store side of a nested map: making a zone, pointing it somewhere, and
	// taking it apart again without losing what was inside it.
	const store: ChapterMaps = { [CHAPTER]: { map_bg: null, nodes: [] } };
	const square = [
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 100, y: 100 },
		{ x: 0, y: 100 },
	];

	const zoneId = addZone(store, CHAPTER, "zone", square);
	const zone = store[CHAPTER].nodes[0];
	assert.equal(zone.kind, "zone", "a new zone is born a zone");
	assert.deepEqual(zone.zone, square, "with the outline exactly as it was clicked out");
	// The label sits at the corner the outline started from, because nothing here
	// is allowed to work out a middle for it.
	assert.deepEqual({ x: zone.x, y: zone.y }, { x: 0, y: 0 }, "and its label starts at the first corner, not at a computed centre");
	assert.equal(childrenOf(store[CHAPTER].nodes, zoneId).length, 0, "a new zone has nothing behind it yet");
	assert.equal(isEnterable(store[CHAPTER].nodes, zone), false, "so it cannot be entered yet");

	// Into the zone.
	const cityId = addNode(store, CHAPTER, "harbour", 20, 30);
	assert.equal(setNodeParent(store, CHAPTER, cityId, zoneId), true, "an element can be put inside a zone");
	assert.equal(isEnterable(store[CHAPTER].nodes, zone), true, "and the zone becomes a door");
	assert.deepEqual(levelNodes(store[CHAPTER].nodes, [zoneId]).map((node) => node.id), [cityId], "which is what entering it shows");

	// A second town, which is the whole reason the edges point upwards.
	const millId = addNode(store, CHAPTER, "mill", 60, 70);
	assert.equal(setNodeParent(store, CHAPTER, millId, zoneId), true, "and a second one goes in beside it");
	assert.deepEqual(
		levelNodes(store[CHAPTER].nodes, [zoneId]).map((node) => node.id),
		[cityId, millId],
		"so the region holds both at once, in the order they were placed",
	);

	// The anchor, and only the anchor: a point, placed by the author.
	assert.equal(setNodeAnchor(store, CHAPTER, zoneId, 40, 30), true, "the anchor is placed");
	assert.deepEqual(store[CHAPTER].nodes[0].anchor, { x: 40, y: 30 }, "and stored as given");
	assert.deepEqual(collectCast(store[CHAPTER].nodes, zoneId), [], "a zone with nobody in it gathers nobody");

	// The links that cannot be walked.
	assert.equal(setNodeParent(store, CHAPTER, cityId, cityId), false, "nothing can be inside itself");
	assert.equal(setNodeParent(store, CHAPTER, cityId, "nowhere"), false, "nor inside something that is not on the map");
	assert.equal(setNodeParent(store, CHAPTER, cityId, zoneId), false, "putting it back where it was reports no change");
	assert.equal(store[CHAPTER].nodes[1].parentId, zoneId, "and the refused ones left it as it was");

	// A pin is a place, not a container. A tree where a location holds locations
	// has no bottom to it, so the store refuses rather than storing it.
	assert.equal(setNodeParent(store, CHAPTER, millId, cityId), false, "a location cannot hold anything");
	assert.equal(setNodeParent(store, CHAPTER, zoneId, cityId), false, "and a zone cannot sit inside its own town");
	assert.equal("parentId" in store[CHAPTER].nodes[0], false, "the refused links are not written at all");

	// Letting an element back out is allowed: the world is a normal place to be.
	assert.equal(setNodeParent(store, CHAPTER, cityId, null), true, "an element can be lifted back to the world");
	assert.equal("parentId" in store[CHAPTER].nodes[1], false, "the key is removed, not blanked");
	assert.equal(setNodeParent(store, CHAPTER, cityId, null), false, "and doing it twice reports no change");
}

{
	// The hover fill: one value the plugin does not read, only hands to the DOM.
	const store: ChapterMaps = {
		[CHAPTER]: { map_bg: null, nodes: [{ id: "zone", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }] }] },
	};

	assert.equal(setZoneFill(store, CHAPTER, "zone", "#3355ff"), true, "a colour is remembered");
	assert.equal(store[CHAPTER].nodes[0].fill, "#3355ff", "and stored as written");
	assert.equal(setZoneFill(store, CHAPTER, "zone", "3355ff"), false, "a value that is not a colour is refused, not normalised");
	assert.equal(store[CHAPTER].nodes[0].fill, "#3355ff", "so the old one is left alone");
	assert.equal(setZoneFill(store, CHAPTER, "zone", null), true, "and clearing it is a change");
	assert.equal("fill" in store[CHAPTER].nodes[0], false, "the key is removed, not blanked");
	assert.equal(setZoneFill(store, CHAPTER, "zone", null), false, "and doing it twice reports no change");
	assert.equal(setZoneFill(store, CHAPTER, "nowhere", "#000000"), false, "a zone that is not on the map has no colour");
}

{
	// Deleting a zone must not take its contents with it, and must not leave a
	// link pointing at nothing either — either way they would be on no level at all.
	const store: ChapterMaps = {
		[CHAPTER]: {
			map_bg: null,
			nodes: [
				{ id: "zone", x: 0, y: 0, chars: [], kind: "zone", zone: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }] },
				{ id: "harbour", x: 10, y: 20, chars: ["tom"], parentId: "zone" },
				{ id: "mill", x: 30, y: 40, chars: ["kim"] },
			],
		},
	};

	assert.equal(deleteNode(store, CHAPTER, "zone"), true, "the zone goes");
	assert.deepEqual(store[CHAPTER].nodes.map((node) => node.id), ["harbour", "mill"], "and what was inside it is still there");
	assert.equal("parentId" in store[CHAPTER].nodes[0], false, "let go of the link that no longer leads anywhere");
	assert.deepEqual(
		rootNodes(store[CHAPTER].nodes).map((node) => node.id),
		["harbour", "mill"],
		"and back on the world map, where they can be reached again",
	);
}

/* ------------------------------------------------------------------ *
 * store.ts: keeping keys in step with the vault                        *
 * ------------------------------------------------------------------ */

{
	const store: ChapterMaps = { [CHAPTER]: { map_bg: null, nodes: [] } };
	assert.equal(moveKey(store, CHAPTER, "Chapters/Chapter 1 Renamed.md"), true, "renamed chapter carries its map");
	assert.equal(store[CHAPTER], undefined, "old key gone");
	assert.equal(store["Chapters/Chapter 1 Renamed.md"] !== undefined, true, "new key present");
	assert.equal(moveKey(store, CHAPTER, "x.md"), false, "missing old key is a no-op");
	assert.equal(moveKey(store, "Chapters/Chapter 1 Renamed.md", "Chapters/Chapter 1 Renamed.md"), false, "same path is a no-op");

	// A rename onto an existing map must never silently drop data.
	const clash: ChapterMaps = { "a.md": { map_bg: null, nodes: [] }, "b.md": { map_bg: null, nodes: [] } };
	assert.equal(moveKey(clash, "a.md", "b.md"), false, "refuses to overwrite an existing map");
	assert.deepEqual(Object.keys(clash).sort(), ["a.md", "b.md"], "both maps survive the refused move");
}

{
	const store: ChapterMaps = {
		"Book/Part 1/one.md": { map_bg: null, nodes: [] },
		"Book/Part 1/two.md": { map_bg: null, nodes: [] },
		"Book/Part 2/three.md": { map_bg: null, nodes: [] },
		"Book/Part1x/four.md": { map_bg: null, nodes: [] },
	};
	assert.equal(moveKeysForFolder(store, "Book/Part 1", "Book/Part 2"), 2, "every chapter inside the folder moves");
	assert.deepEqual(Object.keys(store).sort(), [
		"Book/Part 2/one.md",
		"Book/Part 2/three.md",
		"Book/Part 2/two.md",
		"Book/Part1x/four.md",
	], "prefix match respects folder boundaries");
	assert.equal(moveKeysForFolder(store, "Book/Part 2", "Book/Part 2"), 0, "renaming to the same path is a no-op");
	assert.equal(moveKeysForFolder(store, "Nothing/Here", "Elsewhere"), 0, "unknown folder moves nothing");

	// A destination that already holds a map wins over the incoming one.
	const clash: ChapterMaps = { "Old/a.md": { map_bg: "keep.md", nodes: [] }, "New/a.md": { map_bg: null, nodes: [] } };
	assert.equal(moveKeysForFolder(clash, "Old", "New"), 0, "existing destination is never overwritten");
	assert.equal(clash["New/a.md"].map_bg, null, "destination untouched");
}

{
	const store: ChapterMaps = {
		"a.md": { map_bg: null, nodes: [] },
		"gone.md": { map_bg: null, nodes: [] },
		"nested/also-gone.md": { map_bg: null, nodes: [] },
	};
	assert.deepEqual(findOrphanKeys(store, ["a.md"]), ["gone.md", "nested/also-gone.md"], "orphans are exactly the missing files");
	assert.deepEqual(findOrphanKeys(store, ["a.md", "gone.md", "nested/also-gone.md"]), [], "nothing orphaned when all files exist");
	assert.deepEqual(findOrphanKeys({}, []), [], "no maps, no orphans");
}

/* ------------------------------------------------------------------ *
 * store.ts: import merging                                             *
 * ------------------------------------------------------------------ */

{
	const current: ChapterMaps = { "a.md": { map_bg: "old.png", nodes: [] }, "b.md": { map_bg: null, nodes: [] } };
	const incoming: ChapterMaps = { "a.md": { map_bg: "new.png", nodes: [] }, "c.md": { map_bg: null, nodes: [] } };

	const merged = mergeMaps(current, incoming);
	assert.deepEqual(Object.keys(merged.maps).sort(), ["a.md", "b.md", "c.md"], "merge keeps local-only keys and adds new ones");
	assert.equal(merged.maps["a.md"].map_bg, "new.png", "incoming wins on a clash");
	assert.equal(merged.maps["b.md"].map_bg, null, "local-only entry untouched");

	const tom: Pawn = { id: "tom", name: "Tom", initials: "To", color: "#111111" };
	const anna: Pawn = { id: "anna", name: "Anna", initials: "An", color: "#222222" };
	const pawns = mergePawns([tom], [{ ...tom, name: "Thomas" }, anna]);
	assert.equal(pawns.pawns.length, 2, "merge does not duplicate a pawn by id");
	assert.deepEqual(pawns.pawns.map((p) => p.id), ["tom", "anna"], "local order is preserved and new pawns appended");
	assert.equal(pawns.pawns[0].name, "Thomas", "incoming pawn wins on a clash");
	assert.equal(pawns.pawns[1], anna, "an untouched pawn keeps its identity");
}

/* ------------------------------------------------------------------ *
 * storage.ts: settings normalization                                   *
 * ------------------------------------------------------------------ */

assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS, "a missing file yields the defaults");
assert.deepEqual(parseSettings("junk"), DEFAULT_SETTINGS, "junk yields the defaults");

{
	const parsed = parseSettings({
		schemaVersion: 0,
		language: "klingon",
		defaultView: "nonsense",
		defaultCanvas: { width: -5, height: "800" },
		exportPath: "   ",
		pawns: "junk",
		maps: "junk",
	});
	assert.equal(parsed.schemaVersion, SCHEMA_VERSION, "the version is stamped after normalizing, not trusted");
	assert.equal(parsed.language, "en", "unknown language falls back");
	assert.equal(parsed.defaultView, "map", "unknown tab falls back");
	assert.equal(parsed.defaultCanvas.width, DEFAULT_SETTINGS.defaultCanvas.width, "negative width falls back");
	assert.equal(parsed.defaultCanvas.height, DEFAULT_SETTINGS.defaultCanvas.height, "non-numeric height falls back");
	assert.equal(parsed.exportPath, DEFAULT_SETTINGS.exportPath, "blank export path falls back");
	assert.deepEqual(parsed.pawns, [], "junk roster is empty, not broken");
	assert.deepEqual(parsed.maps, {}, "junk maps are empty, not broken");
}

{
	const parsed = parseSettings({
		schemaVersion: 1,
		language: "ru",
		defaultView: "roster",
		defaultCanvas: { width: 800, height: 600 },
		exportPath: "Backups/wsm.json",
		pawns: [{ id: "tom", name: "Tom", initials: "To", color: "#111111" }],
		maps: { [CHAPTER]: { map_bg: "maps/world.png", nodes: [{ id: "a", x: 1, y: 2, chars: ["tom"] }] } },
	});
	assert.equal(parsed.language, "ru", "valid values are preserved");
	assert.equal(parsed.defaultView, "roster", "roster tab preserved");
	assert.deepEqual(parsed.defaultCanvas, { width: 800, height: 600 }, "valid canvas preserved");
	assert.equal(parsed.exportPath, "Backups/wsm.json", "valid export path preserved");
	assert.equal(parsed.pawns.length, 1, "roster preserved");
	assert.deepEqual(Object.keys(parsed.maps), [CHAPTER], "map preserved");
	assert.equal(parsed.maps[CHAPTER].nodes[0].chars[0], "tom", "node data preserved");
}

{
	// Every tab the plugin can open on its own, one by one.
	//
	// This is a list because the check used to be `=== "roster" ? "roster" :
	// "map"`, which quietly rewrote every other tab to the map. A writer who had
	// chosen the note tab, and later the relationships tab, found the map open
	// instead with nothing to say why - and the value they stored was simply
	// gone the next time the settings were read.
	for (const view of ["map", "roster"] as const) {
		const parsed = parseSettings({
			schemaVersion: 1,
			language: "en",
			defaultView: view,
			defaultCanvas: { width: 800, height: 600 },
			exportPath: "",
			pawns: [],
			maps: {},
		});
		assert.equal(parsed.defaultView, view, `the ${view} tab survives a load`);
	}
}

{
	// The two tabs that stopped being tabs. Their data survives the refactor, so
	// a vault written by the old build must still load - with the value remapped
	// to a tab that exists, because "open the note tab" now has nothing to open.
	for (const retired of ["note", "relationship"]) {
		const parsed = parseSettings({
			schemaVersion: 1,
			language: "en",
			defaultView: retired,
			defaultCanvas: { width: 800, height: 600 },
			exportPath: "",
			pawns: [],
			maps: {},
		} as unknown as Record<string, unknown>);
		assert.equal(parsed.defaultView, "map", `a stored ${retired} tab loads as the map`);
	}
}

/* ------------------------------------------------------------------ *
 * pawns.ts                                                             *
 * ------------------------------------------------------------------ */

assert.equal(slugify("Том"), "tom", "cyrillic transliteration");
assert.equal(slugify("ГГ"), "gg", "consonant cluster");
assert.equal(slugify("Том Уильямс"), "tom-uilyams", "multi word");
assert.equal(slugify("  The Doctor  "), "the-doctor", "ascii + trim");
assert.equal(slugify("!!!"), "pawn", "empty slug falls back");
assert.equal(slugify("Ёлка"), "elka", "yo transliteration");

assert.equal(uniquePawnId("tom", []), "tom", "no collision");
assert.equal(
	uniquePawnId("tom", [
		{ id: "tom", name: "a", initials: "A", color: "#111111" },
		{ id: "tom-2", name: "b", initials: "B", color: "#222222" },
	]),
	"tom-3",
	"collision counter skips taken ids",
);

assert.equal(initialsFromName("Том Уильямс"), "ТУ", "two words");
assert.equal(initialsFromName("Madonna"), "Ma", "single long word");
assert.equal(initialsFromName("Ed"), "Ed", "single short word");
assert.equal(initialsFromName("   "), "?", "blank name");

assert.equal(clampInitials("ТУЖ", "Tom"), "ТУЖ", "capped at 3");
assert.equal(clampInitials("A B", "Tom"), "AB", "whitespace removed");
assert.equal(clampInitials("", "Том Уильямс"), "ТУ", "blank falls back to name");
assert.equal(clampInitials("  ", "Madonna"), "Ma", "whitespace falls back to name");

assert.equal(isLightColor("#ffffff"), true, "white");
assert.equal(isLightColor("#000000"), false, "black");
assert.equal(isLightColor("#f0e68c"), true, "khaki");
assert.equal(isLightColor("#2c3e50"), false, "navy");
assert.equal(isLightColor("nonsense"), false, "garbage is dark");

assert.equal(colorForToken("ghost"), colorForToken("ghost"), "hash color is deterministic");
assert.match(colorForToken("ghost"), /^#[0-9a-f]{6}$/, "hash color is hex");
assert.notEqual(colorForToken("a"), colorForToken("b"), "different tokens differ");

const tom: Pawn = createPawn("Tom", []);
assert.equal(tom.id, "tom", "slugified id");
assert.equal(tom.initials, "To", "auto initials");
assert.match(tom.color, /^#[0-9a-f]{6}$/, "palette color");
const anna = createPawn("Anna", [tom]);
assert.notEqual(anna.color, tom.color, "second pawn gets a different palette color");

const renamed = updatePawn(tom, { name: "Thomas", initials: "" });
assert.equal(renamed.initials, "Th", "initials regenerate from the new name");
assert.equal(updatePawn(tom, { avatar: "" }).avatar, undefined, "blank avatar becomes undefined");
assert.equal(updatePawn(tom, { avatar: "a.png" }).avatar, "a.png", "avatar is kept");
assert.equal(updatePawn(tom, {}).color, tom.color, "empty patch changes nothing");

const roster = [tom, anna];
const index = indexPawns(roster);
assert.equal(resolveToken("tom", index, roster).pawn?.name, "Tom", "resolves by id");
assert.equal(resolveToken("Tom", index, roster).pawn?.name, "Tom", "resolves by name fallback");
assert.equal(resolveToken("  TOM ", index, roster).pawn?.name, "Tom", "name fallback is case-insensitive");
assert.equal(resolveToken("ГГ", index, roster).pawn, null, "unknown token stays unknown");
assert.equal(resolveToken("nobody", index, roster).token, "nobody", "unknown token is preserved as written");

/* ------------------------------------------------------------------ *
 * i18n                                                                *
 * ------------------------------------------------------------------ */

assert.equal(t("en", "viewMap"), "Map", "english lookup");
assert.equal(t("ru", "viewMap"), "Карта", "russian lookup");
assert.ok(t("ru", "rosterDeleteConfirm", { name: "Том" }).includes("Том"), "variables interpolate");
assert.ok(t("en", "noticeSaveFailed", { message: "boom" }).endsWith("boom"), "message interpolates");
assert.equal(t("en", "noticeSaveFailed", { message: "boom" }).includes("{message}"), false, "placeholder consumed");
assert.equal(t("ru", "rosterDeleteConfirm", { name: "Том" }).includes("{name}"), false, "ru placeholder consumed");
assert.ok(
	t("en", "emptyBrokenBgHint", { path: "a/b.png" }).includes("a/b.png"),
	"unknown keys still interpolate",
);
assert.ok(t("en", "noticeImported", { maps: 2, pawns: 5 }).includes("2"), "numbers interpolate");
assert.deepEqual(DEFAULT_SETTINGS.pawns, [], "no pawns by default");
assert.deepEqual(DEFAULT_SETTINGS.maps, {}, "no maps by default");

// The UI must not claim it writes to the author's notes.
for (const key of ["emptyNoFileHint", "emptyNoBgHint", "rosterDeleteConfirm", "noticeSaveFailed", "settingsPrivacy"] as const) {
	for (const lang of ["en", "ru"] as const) {
		assert.equal(
			/(frontmatter|фронтматтер)/i.test(t(lang, key)),
			false,
			`"${key}" (${lang}) must not mention frontmatter any more`,
		);
	}
}

/* ------------------------------------------------------------------ *
 * view-scale math: coordinates must survive a round trip              *
 * ------------------------------------------------------------------ */

{
	// Mirrors MapView.applyScale / toCanvasCoords.
	const canvas = { width: 1024, height: 768 };
	const sidebar = 320;
	const scale = Math.min(1, sidebar / canvas.width);

	const clientX = 17.5;
	const rectLeft = 12;
	const canvasX = (clientX - rectLeft) / scale;
	const backToClient = rectLeft + canvasX * scale;
	assert.ok(Math.abs(backToClient - clientX) < 1e-9, "canvas coords round-trip to client coords");

	// The counter-scale must always be >= 1, otherwise tokens shrink.
	assert.ok(1 / scale >= 1, "counter-scale never shrinks tokens");

	// A node placed at the canvas corner stays inside the scaled stage.
	const nodeX = canvas.width - 1;
	assert.ok(nodeX * scale <= sidebar, "right-edge node fits the sidebar");
}

/* ------------------------------------------------------------------ *
 * Isolation guards                                                    *
 * The plugin's promise is that it never touches the author's notes.    *
 * These assertions are the mechanical guard for that promise.          *
 * ------------------------------------------------------------------ */

const repoFile = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative: string): string => readFileSync(repoFile(relative), "utf8");

/** Comments are stripped first: these files *document* the rules they follow. */
const code = (relative: string): string =>
	read(relative)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * Two modules may hold the vault adapter, each for a different and narrow reason:
 *
 * - storage.ts owns this plugin's own data.json, backup and export copy;
 * - note-writer.ts owns the author's notes, gated on isManagedPath().
 *
 * Nothing else may reach for it, and storage.ts must never be pointed at a note.
 */
const WRITER = "../src/note-writer.ts";
const DATA_STORE = "../src/storage.ts";

{
	const storeSource = code("../src/store.ts");
	assert.equal(
		/from\s+["']obsidian["']/.test(storeSource),
		false,
		"src/store.ts must not import obsidian: the map layer cannot touch the filesystem",
	);
	assert.equal(
		/\b(processFrontMatter|fileManager|vault\.modify|vault\.create|vault\.delete)\b/.test(storeSource),
		false,
		"src/store.ts must contain no file-writing API",
	);
}

const sources = ["../main.ts", ...readdirSync(repoFile("../src")).map((name) => `../src/${name}`)];
for (const source of sources) {
	const text = code(source);

	assert.equal(
		text.includes("processFrontMatter"),
		false,
		`${source} must not reference processFrontMatter`,
	);
	assert.equal(
		/\b(vault\.modify|vault\.create|vault\.delete|app\.fileManager)\b/.test(text),
		false,
		`${source} must not write to a vault file`,
	);
	assert.equal(
		text.includes("getFileCache"),
		false,
		`${source} must not read a note's frontmatter`,
	);

	// `vault.adapter` is the low-level escape hatch: it can write any path at
	// all. Only the two audited modules above may hold it.
	if (source === WRITER) {
		assert.ok(
			text.includes("isManagedPath"),
			"src/note-writer.ts must gate its writes on isManagedPath()",
		);
	} else if (source === DATA_STORE) {
		assert.equal(
			/["'`]\s*\.md\b/.test(text),
			false,
			"src/storage.ts must not name a markdown file: it owns data.json only",
		);
	} else {
		assert.equal(
			/vault\.adapter|\badapter\s*\./.test(text),
			false,
			`${source} must not touch the vault adapter: only storage.ts and note-writer.ts may`,
		);
	}
}

{
	// The stub itself must not offer a frontmatter writer either.
	const stub = code("./obsidian-stub.ts");
	assert.equal(stub.includes("processFrontMatter"), false, "the test stub must not be able to write frontmatter");
	assert.equal(stub.includes("fileManager"), false, "the test stub must not expose fileManager");
}

{
	// A tab that is registered but never reachable is invisible: no command, no
	// icon, no way in from the default-view setting. Every VIEW_TYPE_* the
	// plugin mentions has to be registered, openable, and kept in step with the
	// chapters - the same wiring in three places, which is exactly the shape of
	// bug that leaves a tab looking broken with nothing in the console.
	//
	// Exactly two, deliberately: the command centre is the map plus the roster
	// side by side. Notes are ordinary files in the main area and relationships
	// are an overlay on the map, so neither is a tab to keep wired.
	const mainSource = code("../main.ts");
	// Distinct constants, not occurrences: each VIEW_TYPE_* is named at its
	// declaration and again at every use, so counting matches would have made
	// "how many tabs are there" a question about how often the names appear.
	const viewTypes = new Set(
		[...mainSource.matchAll(/VIEW_TYPE_[A-Z_]+/g)].map((match) => match[0]),
	);
	assert.equal(viewTypes.size, 2, "the plugin has exactly two tabs");
	assert.deepEqual(
		[...viewTypes].sort(),
		["VIEW_TYPE_MAP", "VIEW_TYPE_ROSTER"],
		"and they are the map and the roster",
	);

	for (const viewType of viewTypes) {
		assert.ok(
			new RegExp(`registerView\\(\\s*${viewType}\\b`).test(mainSource),
			`${viewType} must be registered with the workspace`,
		);
		// Used at least once more than it is declared: a type that only ever
		// appears in its import and its own export can never be opened.
		const uses = mainSource.split(new RegExp(`\\b${viewType}\\b`)).length - 1;
		assert.ok(uses >= 2, `${viewType} must be used, not just mentioned`);
	}

	// The tabs `openTab` accepts, and the ones something actually asks it for,
	// are two more places a new tab has to be added. Deriving the first keeps
	// the check honest as tabs are added.
	const openTab = mainSource.slice(mainSource.indexOf("async openTab("));
	const accepted = openTab.slice(0, openTab.indexOf(")")).match(/"[a-z]+"/g) ?? [];
	assert.deepEqual(accepted, ['"map"', '"roster"'], "openTab opens the map and the roster, nothing else");
	for (const tab of accepted) {
		const name = tab.slice(1, -1);
		assert.ok(
			new RegExp(`openTab\\("${name}"\\)`).test(mainSource),
			`nothing asks for the ${name} tab, so it cannot be opened`,
		);
	}

	// The retired tabs must stay retired. Their constants are gone, so a stray
	// string left behind would fail at runtime with no tab to open.
	for (const retired of ["note", "relationship"]) {
		assert.ok(
			!new RegExp(`openTab\\(\\s*"${retired}"`).test(mainSource),
			`the ${retired} tab is not a tab any more and must not be opened as one`,
		);
	}
}

{
	// The map store only ever asks notes.ts whether a path is one of *ours*.
	// If that gate ever moved into the store itself, the rule above would still
	// pass while a chapter note became writable, so pin the dependency down.
	const storeSource = code("../src/store.ts");
	assert.ok(
		/from\s+["']\.\/notes["']/.test(storeSource),
		"src/store.ts must reject the plugin's own notes through notes.isManagedPath()",
	);
	assert.ok(
		/isManagedPath\(/.test(storeSource),
		"src/store.ts must call isManagedPath() so a generated note is never bound as a chapter",
	);
}

{
	// If the bundle has been built, prove the promise holds in shipped code.
	// The adapter call count is compared against the audited module: that is
	// what stops a second module from reaching for the same escape hatch after
	// minification has merged everything into one file.
	const bundle = repoFile("../main.js");
	if (existsSync(bundle)) {
		const text = readFileSync(bundle, "utf8");
		assert.equal(
			text.includes("processFrontMatter"),
			false,
			"the built main.js must not contain processFrontMatter",
		);
		const inBundle = (text.match(/\.adapter\b/g) ?? []).length;
		const inAudited = [WRITER, DATA_STORE].reduce(
			(total, source) => total + (code(source).match(/\.adapter\b/g) ?? []).length,
			0,
		);
		assert.ok(inAudited > 0, "the audited writers are expected to use the adapter");
		assert.equal(
			inBundle,
			inAudited,
			"the built main.js must use the vault adapter exactly as often as storage.ts + note-writer.ts do",
		);
	}
}


{
	// Dead translation keys are cruft: every key must be referenced somewhere.
	const keys = [...new Set([...code("../src/i18n.ts").matchAll(/^\t([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]))];
	const used = [...sources.map(code), code("./smoke.ts")].join("\n");

	for (const key of keys) {
		assert.equal(used.includes(`"${key}"`), true, `translation key "${key}" is defined but never used`);
	}
	assert.ok(keys.length > 50, `the dictionary was actually parsed (${keys.length} keys)`);
}

/* ------------------------------------------------------------------ *
 * Guard: no detached method references                                 *
 *                                                                     *
 * Regression. `const t = this.plugin.t` looked harmless, but a method   *
 * copied off its object loses `this`, so every call blew up on          *
 * `this.settings` and the node popover died before it rendered. Aliases *
 * of *getters* are fine; aliases of *methods* never are.                *
 * ------------------------------------------------------------------ */

{
	const allowedGetters = new Set([
		"settings",
		"pawns",
		"chapterPath",
		"activeChapterPath",
		"app",
		"vault",
		"storage",
		"manifest",
	]);
	const alias = /(?:const|let|var)\s+\w+\s*=\s*this\.(?:plugin|app|storage)\.(\w+)\s*;/g;

	for (const source of sources) {
		const text = code(source);
		for (const match of text.matchAll(alias)) {
			const name = match[1];
			assert.equal(
				allowedGetters.has(name),
				true,
				`${source}: "const x = this.plugin.${name}" detaches a method and loses "this" — call it directly instead`,
			);
		}
	}
}

/* ------------------------------------------------------------------ *
 * View layer: the popover and the pawn editor must actually work       *
 *                                                                     *
 * These cover the two bugs that shipped silently: a popover that threw *
 * while building (no rename, no delete, no pawn checkboxes) and pawn    *
 * initials frozen on the "?" placeholder.                               *
 * ------------------------------------------------------------------ */

installDom();

interface FakePlugin {
	settings: WriterStateMapSettings;
	activeChapterPath: string | null;
	readonly pawns: Pawn[];
	t(key: TranslationKey, vars?: Record<string, string | number>): string;
	updateMap<T>(path: string, mutate: (maps: ChapterMaps, mapPath: string) => T): T;
	addPawn(name: string, overrides?: Partial<Pawn>): Pawn | null;
	updatePawn(pawn: Pawn): void;
	openTab(): void;
	refreshAllViews(): void;
	notices: string[];
	/** Set by `withApp`, so noteBuffer can see what the editors actually hold. */
	app: App | null;
	noteBuffer(path: string): string | null;
	registerEvent(ref: unknown): void;
	/** Every ref handed to registerEvent, so a test can prove it was wired. */
	events: unknown[];
	/* The command centre. Recorded rather than performed, because what these tests
	   are about is whether the toolbar button is wired to the right call - the
	   calls themselves belong to main.ts, which is checked by reading its source. */
	openNoteCalls: number;
	openTabCalls: string[];
	forgetCalls: number;
	openNote(): void;
	forgetChapter(): Promise<void>;
}

/**
 * Give a fake plugin the workspace it will be asked about.
 *
 * The buffer lives on the app, not on the plugin, because that is where the real
 * editors are: `noteBuffer` asks the workspace, and a test that faked the answer
 * on the plugin instead would be testing a different plugin than the real one.
 */
function withApp(plugin: FakePlugin, app: App): FakePlugin & { app: App } {
	const attached = plugin as FakePlugin & { app: App };
	attached.app = app;
	return attached;
}

function makePlugin(chapterPath: string | null, pawns: Pawn[] = []): FakePlugin {
	const settings: WriterStateMapSettings = {
		...DEFAULT_SETTINGS,
		maps: {},
		pawns,
		language: "en",
	};

	// Real methods on a real object, and they read `this` exactly like the
	// plugin's do. Detaching one must fail loudly — that is the regression.
	const plugin: FakePlugin = {
		settings,
		activeChapterPath: chapterPath,
		get pawns(): Pawn[] {
			return settings.pawns;
		},
		t(this: FakePlugin, key: TranslationKey, vars?: Record<string, string | number>): string {
			return t(this.settings.language, key, vars);
		},
		updateMap<T>(this: FakePlugin, path: string, mutate: (maps: ChapterMaps, mapPath: string) => T): T {
			return mutate(this.settings.maps, path);
		},
		addPawn(name: string, overrides?: Partial<Pawn>): Pawn | null {
			const pawn = composePawn(name, settings.pawns, overrides);
			if (!pawn) return null;
			settings.pawns = [...settings.pawns, pawn];
			return pawn;
		},
		updatePawn(pawn: Pawn): void {
			settings.pawns = settings.pawns.map((item) => (item.id === pawn.id ? pawn : item));
		},
		openTab(this: FakePlugin, tab?: string): void {
			this.openTabCalls.push(tab ?? "");
		},
		openNote(this: FakePlugin): void {
			this.openNoteCalls += 1;
		},
		forgetChapter(this: FakePlugin): Promise<void> {
			this.forgetCalls += 1;
			return Promise.resolve();
		},
		refreshAllViews(): void {
			/* no-op in tests */
		},
		noteBuffer(this: FakePlugin, path: string): string | null {
			const app = this.app;
			return app ? (app.openEditorBuffers[path] ?? null) : null;
		},
		registerEvent(this: FakePlugin, ref: unknown): void {
			this.events.push(ref);
		},
		events: [],
		app: null,
		notices: [],
		openNoteCalls: 0,
		openTabCalls: [],
		forgetCalls: 0,
	};

	assert.throws(
		() => {
			const detached = plugin.t;
			detached("viewRoster");
		},
		TypeError,
		"sanity: detaching plugin.t throws — this is exactly what broke the popover",
	);

	return plugin;
}

/** The view fields the tests poke at, without loosening the classes. */
interface MapViewInternals {
	root: FakeElement;
	nodesEl: FakeElement;
	popoverEl: FakeElement | null;
	openPopover(nodeId: string, focusName: boolean): void;
	scale: number;
	applyScale(): void;
}

interface RosterViewInternals {
	root: FakeElement;
	editor: { mode: string; draft: Pawn } | null;
	openEditor(mode: "create" | "edit", existing?: Pawn): void;
	save(): void;
}

const CHAPTER_MAP = "Chapters/Chapter 1.md";
const pawn: Pawn = { id: "tom", name: "Tom", initials: "To", color: "#e05c5c" };

/* ---- the popover ---- */

{
	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();

	const internals = view as unknown as MapViewInternals;

	// Double-click on empty canvas: creates the location AND opens its editor.
	internals.nodesEl.fire("dblclick", { clientX: 40, clientY: 40 });
	const created = plugin.settings.maps[CHAPTER_MAP].nodes;
	assert.equal(created.length, 1, "double-click creates a location");
	assert.ok(internals.popoverEl, "the new location opens its popover right away");

	const pop = internals.popoverEl as FakeElement;
	const nameField = pop.find((el) => el.classes.has("wsm-pop__name"));
	assert.ok(nameField, "the popover has a name field");
	assert.equal(nameField.focused, true, "the name field is focused for a fresh location");

	// Rename: type and press Enter.
	nameField.value = "Castle Black";
	nameField.fire("keydown", { key: "Enter" });
	assert.equal(
		plugin.settings.maps[CHAPTER_MAP].nodes[0].label,
		"Castle Black",
		"Enter in the name field renames the location",
	);

	// Attach a pawn through its checkbox.
	const checkbox = pop.find((el) => el.tag === "input" && el.type === "checkbox");
	assert.ok(checkbox, "the popover lists the roster as checkboxes");
	checkbox.checked = true;
	checkbox.fire("change");
	assert.deepEqual(
		plugin.settings.maps[CHAPTER_MAP].nodes[0].chars,
		["tom"],
		"ticking a pawn adds its token to the location",
	);

	// Untick it again.
	checkbox.checked = false;
	checkbox.fire("change");
	assert.deepEqual(plugin.settings.maps[CHAPTER_MAP].nodes[0].chars, [], "unticking removes the token");

	// Delete the location.
	const deleteButton = pop.find((el) => el.classes.has("wsm-pop__danger"));
	assert.ok(deleteButton, "the popover offers a delete action");
	deleteButton.fire("click");
	assert.equal(plugin.settings.maps[CHAPTER_MAP].nodes.length, 0, "delete removes the location");
	assert.equal(internals.popoverEl, null, "the popover closes after deleting");
}

/* ---- renaming from a click on an existing location ---- */

{
	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	plugin.settings.maps[CHAPTER_MAP] = { map_bg: null, nodes: [{ id: "node", x: 10, y: 10, chars: [] }] };

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as MapViewInternals;

	internals.openPopover("node", false);
	const pop = internals.popoverEl as FakeElement;
	const nameField = pop.find((el) => el.classes.has("wsm-pop__name")) as FakeElement;
	assert.ok(nameField, "clicking a location opens its popover");

	nameField.value = "Winterfell";
	nameField.fire("blur");
	assert.equal(plugin.settings.maps[CHAPTER_MAP].nodes[0].label, "Winterfell", "leaving the field commits the rename");

	// A second rename in the same popover must not be compared against a stale label.
	nameField.value = "Riverrun";
	nameField.fire("blur");
	assert.equal(plugin.settings.maps[CHAPTER_MAP].nodes[0].label, "Riverrun", "a second rename in one session sticks");
}

/* ---- dragging, and the units it is stored in ---- */

{
	// The stage is scaled down to fit the sidebar, so a screen gesture and a
	// stored coordinate are different numbers. The pin lives in canvas px; a
	// nudge is measured in screen px, because the ring layout divides by the
	// scale *after* the offset is added. Storing the canvas figure for a nudge
	// would divide it twice, and the avatar would creep back towards its slot
	// every time the sidebar narrowed.
	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	plugin.settings.maps[CHAPTER_MAP] = {
		map_bg: null,
		nodes: [{ id: "node", x: 100, y: 100, chars: ["tom"] }],
	};

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as MapViewInternals;
	internals.applyScale();

	// A deliberately cramped sidebar, so a screen pixel is not a canvas pixel.
	assert.ok(internals.scale < 1, `the stage is scaled down (got ${internals.scale})`);

	/**
	 * A committed drag repaints the map from storage, which replaces every
	 * element. The elements are therefore looked up again after each gesture
	 * rather than captured once, exactly as a real pointer would meet fresh
	 * nodes every time.
	 */
	const live = (): { anchor: FakeElement; pin: FakeElement; avatar: FakeElement; layer: FakeElement } => {
		const anchor = internals.nodesEl.find((el) => el.dataset.nodeId === "node") as FakeElement;
		assert.ok(anchor, "the location is on the map");
		const pin = anchor.find((el) => el.getAttribute("data-drag") === "node") as FakeElement;
		const avatar = anchor.find((el) => el.getAttribute("data-drag") === "char") as FakeElement;
		const layer = anchor.find((el) => el.getAttribute("data-drag") === "fan") as FakeElement;
		assert.ok(pin && avatar && layer, "the pin, the avatar and the ring layer are all present");
		return { anchor, pin, avatar, layer };
	};

	// The gesture is listened for on the anchor, and the moves go to whichever
	// element took the pointer: the ring layer for a whole-sun drag, the avatar
	// for one character, the anchor for the pin itself.
	{
		const { anchor, pin, layer } = live();
		anchor.fire("pointerdown", { clientX: 0, clientY: 0, button: 0, shiftKey: true, target: pin });
		layer.fire("pointermove", { clientX: 64, clientY: 40, pointerId: 1 });
		layer.fire("pointerup", { clientX: 64, clientY: 40, pointerId: 1 });
		await settle();
	}

	assert.equal(
		plugin.settings.maps[CHAPTER_MAP].nodes[0].x,
		100,
		"Shift turns a grab of the pin into a move of the whole sun, leaving the pin put",
	);
	assert.deepEqual(
		plugin.settings.maps[CHAPTER_MAP].nodes[0].charOffsets?.tom,
		{ offsetX: 64, offsetY: 40 },
		"and the ring keeps the gesture in screen px, not divided by the scale",
	);

	// Now a plain avatar drag, on top of the nudge that is already there.
	{
		const { anchor, avatar } = live();
		anchor.fire("pointerdown", { clientX: 0, clientY: 0, button: 0, target: avatar });
		avatar.fire("pointermove", { clientX: 24, clientY: -16, pointerId: 2 });
		avatar.fire("pointerup", { clientX: 24, clientY: -16, pointerId: 2 });
		await settle();
	}

	assert.deepEqual(
		plugin.settings.maps[CHAPTER_MAP].nodes[0].charOffsets?.tom,
		{ offsetX: 88, offsetY: 24 },
		"a second drag adds to the nudge instead of replacing it",
	);

	// A cancelled gesture is a gesture that never happened.
	{
		const before = JSON.stringify(plugin.settings.maps[CHAPTER_MAP].nodes[0]);
		const { anchor, pin, layer } = live();
		anchor.fire("pointerdown", { clientX: 0, clientY: 0, button: 0, shiftKey: true, target: pin });
		layer.fire("pointermove", { clientX: 500, clientY: 500, pointerId: 3 });
		layer.fire("pointercancel", { clientX: 500, clientY: 500, pointerId: 3 });
		await settle();
		assert.equal(
			JSON.stringify(plugin.settings.maps[CHAPTER_MAP].nodes[0]),
			before,
			"a pointer the browser takes away persists nothing",
		);
	}

	// And the pin itself does move, in canvas px.
	{
		const { anchor, pin } = live();
		anchor.fire("pointerdown", { clientX: 0, clientY: 0, button: 0, target: pin });
		anchor.fire("pointermove", { clientX: 64, clientY: 0, pointerId: 4 });
		anchor.fire("pointerup", { clientX: 64, clientY: 0, pointerId: 4 });
		await settle();
	}
	assert.equal(
		plugin.settings.maps[CHAPTER_MAP].nodes[0].x,
		100 + Math.round(64 / internals.scale),
		"the pin is stored in canvas px, so it travels further than the cursor",
	);

	// A double-click on the pin is not a reset: the pin is not a character.
	{
		const { anchor, pin } = live();
		anchor.fire("dblclick", { target: pin });
		await settle();
	}
	assert.deepEqual(
		plugin.settings.maps[CHAPTER_MAP].nodes[0].charOffsets?.tom,
		{ offsetX: 88, offsetY: 24 },
		"a double-click on the pin leaves every character where it was",
	);

	// Double-clicking an avatar drops its nudge and snaps it back into the ring.
	{
		const { anchor, avatar } = live();
		anchor.fire("dblclick", { target: avatar });
		await settle();
	}
	assert.equal(
		plugin.settings.maps[CHAPTER_MAP].nodes[0].charOffsets,
		undefined,
		"a double-click on the avatar takes the nudge away, and the key with it",
	);
}

/* ---- the pawn editor ---- */

{
	const plugin = makePlugin(null);
	const view = new RosterView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as RosterViewInternals;

	internals.openEditor("create");
	const editor = internals.root.find((el) => el.classes.has("wsm-editor"));
	assert.ok(editor, "the roster opens an editor for a new pawn");

	const nameField = editor.find((el) => el.tag === "input" && el.type === "text") as FakeElement;
	assert.ok(nameField, "the editor has a name field");

	// Typing a name must keep the token preview in sync.
	nameField.value = "Tom Sawyer";
	nameField.fire("input");
	assert.equal(internals.editor?.draft.name, "Tom Sawyer", "typing updates the draft name");
	assert.equal(internals.editor?.draft.initials, "TS", "initials follow the name while untouched");

	// Hand-written initials win and stop the auto-derivation.
	const initialsField = editor.find(
		(el) => el.tag === "input" && el.maxLength === 3,
	) as FakeElement;
	initialsField.value = "T";
	initialsField.fire("input");
	nameField.value = "Tom Sawyer Jr";
	nameField.fire("input");
	assert.equal(internals.editor?.draft.initials, "T", "manual initials are not overwritten by the name");

	internals.save();
	assert.equal(plugin.settings.pawns.length, 1, "saving stores the pawn");
	assert.equal(plugin.settings.pawns[0].initials, "T", "the stored pawn keeps the manual initials");
}

/* ---- an untouched draft must not save a literal "?" ---- */

{
	const plugin = makePlugin(null);
	const view = new RosterView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as RosterViewInternals;

	internals.openEditor("create");
	const editor = internals.root.find((el) => el.classes.has("wsm-editor")) as FakeElement;
	const nameField = editor.find((el) => el.tag === "input" && el.type === "text") as FakeElement;

	nameField.value = "Arya Stark";
	nameField.fire("input");
	internals.save();

	assert.equal(plugin.settings.pawns[0].initials, "AS", "a pawn saved from a fresh draft gets real initials");
	assert.notEqual(plugin.settings.pawns[0].initials, PLACEHOLDER_INITIALS, 'no pawn is stored with a "?" token');
}

/* ------------------------------------------------------------------ *
 * Initials colour (Iteration 4)                                      *
 * ------------------------------------------------------------------ */

/* ---- an explicit colour survives the round trip to disk ---- */

{
	// A pawn with a colour, plus one with a junk value, plus one with none.
	const good: Pawn = { id: "tom", name: "Tom", initials: "To", color: "#e05c5c", textColor: "red" };
	const bad = { id: "kim", name: "Kim", initials: "Ki", color: "#33aa55", textColor: "chartreuse" } as Pawn;
	const bare: Pawn = { id: "aya", name: "Aya", initials: "Ay", color: "#f0c000" };

	const normalized = normalizePawns([good, bad, bare]);
	assert.equal(normalized[0].textColor, "red", "a valid colour is kept");
	assert.equal(normalized[1].textColor, undefined, "a colour that does not exist is dropped, not stored");
	assert.equal(normalized[2].textColor, undefined, "a pawn without the field stays without it");
}

{
	// The empty string means "back to automatic". Storing it would put a value
	// in the file that is not one of the three the editor offers.
	const pawnWithRed: Pawn = { id: "tom", name: "Tom", initials: "To", color: "#e05c5c", textColor: "red" };
	assert.equal(
		updatePawn(pawnWithRed, { textColor: "" as Pawn["textColor"] }).textColor,
		undefined,
		"clearing the colour removes the field instead of storing an empty string",
	);
	assert.equal(
		updatePawn(pawnWithRed, {}).textColor,
		"red",
		"a patch that says nothing about the colour leaves it alone",
	);
}

{
	// The editor builds a new pawn from a patch. If the colour is not passed
	// through, the choice made in the form is dropped on create.
	const created = composePawn("Tom", [], { textColor: "white" } as Partial<Pawn>);
	assert.ok(created, "composePawn still creates the pawn");
	assert.equal(created.textColor, "white", "a colour chosen in the editor is stored on the new pawn");
}

{
	// One helper, so the map and the roster cannot disagree about what a pawn
	// looks like.
	const whiteBg: Pawn = { id: "a", name: "A", initials: "A", color: "#ffffff" };
	const darkBg: Pawn = { id: "b", name: "B", initials: "B", color: "#000000" };

	assert.equal(
		textColorClasses({ ...whiteBg, textColor: "black" }, whiteBg.color),
		"text-black",
		"an explicit colour wins over a light background",
	);
	assert.equal(textColorClasses(whiteBg, whiteBg.color), "is-light", "no explicit colour keeps the automatic light test");
	assert.equal(textColorClasses(darkBg, darkBg.color), "", "a dark background with no choice gets no class");
	assert.equal(
		textColorClasses({ ...darkBg, textColor: "red" }, darkBg.color),
		"text-red",
		"an explicit colour wins over a dark background",
	);
}

/* ---- the editor offers the choice and stores it ---- */

{
	const plugin = makePlugin(null);
	const view = new RosterView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as RosterViewInternals;

	internals.openEditor("create");
	const editor = internals.root.find((el) => el.classes.has("wsm-editor")) as FakeElement;
	const nameField = editor.find((el) => el.tag === "input" && el.type === "text") as FakeElement;
	nameField.value = "Tom Sawyer";
	nameField.fire("input");

	const select = editor.find((el) => el.tag === "select") as FakeElement;
	assert.ok(select, "the editor has a colour dropdown");

	// Four choices: the automatic default plus the three explicit colours.
	const values = select.children
		.filter((child) => child.tag === "option")
		.map((child) => (child as unknown as FakeElement).value);
	assert.deepEqual(
		values,
		["", "white", "black", "red"],
		'the dropdown offers automatic, white, black and red — "" for automatic',
	);
	assert.equal(select.value, "", "the draft starts on automatic");

	select.value = "red";
	select.fire("change");
	assert.equal(internals.editor?.draft.textColor, "red", "picking a colour updates the draft");

	// The preview has to follow, or the form would lie about the result.
	const preview = internals.root.find((el) => el.classes.has("wsm-token--lg")) as FakeElement;
	assert.ok(preview, "the editor shows a token preview");
	assert.ok(preview.classes.has("text-red"), "the preview shows the chosen colour");

	internals.save();
	assert.equal(plugin.settings.pawns[0].textColor, "red", "saving stores the chosen colour");
}

{
	// Picking automatic again has to clear the field, not store "".
	const existing: Pawn = { id: "tom", name: "Tom", initials: "To", color: "#e05c5c", textColor: "red" };
	const plugin = makePlugin(null, [existing]);
	const view = new RosterView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as RosterViewInternals;

	internals.openEditor("edit", existing);
	const editor = internals.root.find((el) => el.classes.has("wsm-editor")) as FakeElement;
	const select = editor.find((el) => el.tag === "select") as FakeElement;
	assert.equal(select.value, "red", "editing shows the stored colour");

	select.value = "";
	select.fire("change");
	internals.save();
	assert.equal(plugin.settings.pawns[0].textColor, undefined, "choosing automatic removes the stored colour");
}

/* ---- the map paints the same choice the roster shows ---- */

{
	const coloured: Pawn = { id: "tom", name: "Tom", initials: "To", color: "#ffffff", textColor: "black" };
	const plugin = makePlugin(CHAPTER_MAP, [coloured]);
	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();

	const internals = view as unknown as MapViewInternals;
	internals.nodesEl.fire("dblclick", { clientX: 40, clientY: 40 });
	// Put the character on the new location and redraw.
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		setPawnOnNode(maps, p, plugin.settings.maps[CHAPTER_MAP].nodes[0].id, "tom", true);
	});
	view.refresh();

	const avatar = internals.nodesEl.find((el) => el.classes.has("wsm-avatar")) as FakeElement;
	assert.ok(avatar, "the map draws an avatar for the pawn");
	assert.ok(
		avatar.classes.has("text-black"),
		"the map uses the pawn's own colour, not the automatic one for its white token",
	);
	assert.equal(
		avatar.classes.has("is-light"),
		false,
		"an explicit colour and the automatic class never appear together",
	);
}

/* ------------------------------------------------------------------ *
 * The background can be taken away again                              *
 * ------------------------------------------------------------------ */

{
	interface MapViewInternalsBg {
		root: FakeElement;
		refresh(): void;
		clearBackground(): void;
	}

	const plugin = makePlugin(CHAPTER_MAP, []);
	const app = new App();
	// A file to point the background at, so the map has something to clear.
	app.adapterFiles["maps/plan.jpg"] = "jpeg";
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = { nodes: [{ id: "harbor", x: 300, y: 200, chars: [] }] };
		// The image brings its own design size, which is the whole reason the
		// size has to be cleared together with it.
		setBackground(maps, p, "maps/plan.jpg");
		setCanvasSize(maps, p, [4000, 3000]);
	});

	const view = new MapView(new WorkspaceLeaf(app), plugin as never);
	await view.onOpen();
	const internals = view as unknown as MapViewInternalsBg;

	assert.equal(plugin.settings.maps[CHAPTER_MAP].map_bg, "maps/plan.jpg", "the map has a background to clear");
	assert.deepEqual(plugin.settings.maps[CHAPTER_MAP].map_size, [4000, 3000], "the image brought its own canvas size");

	const tools = internals.root.find((el) => el.classes.has("wsm-map__tools")) as FakeElement;
	const buttons = tools.children.filter((child) => child.tag === "button");
	// Looked up by `data-tool` rather than by position: the toolbar grew a zone
	// tool and an anchor tool after this was written, and a test that counted
	// buttons would have kept passing while quietly pointing at the wrong one.
	const clearBg = buttons.find((button) => button.title === "Remove background");
	assert.ok(clearBg, "the toolbar has a set-background and a clear-background button");
	assert.equal(clearBg.disabled, false, "clearing is available while there is a background");

	// A click, not a direct call: the button is what the reader actually uses,
	// and wiring it up is the part that can silently go missing.
	clearBg.fire("click");

	assert.equal(plugin.settings.maps[CHAPTER_MAP].map_bg, null, "clicking the button removes the background");
	// The point of the fix: the canvas does not stay at the picture's size.
	assert.equal(
		plugin.settings.maps[CHAPTER_MAP].map_size,
		undefined,
		"clearing the background also clears the canvas size it set",
	);
	assert.equal(
		readMap(plugin.settings.maps, CHAPTER_MAP, { width: 1024, height: 768 }).canvas.width,
		1024,
		"the map falls back to the default canvas from the settings",
	);

	const after = internals.root.find((el) => el.classes.has("wsm-map__tools")) as FakeElement;
	const afterButtons = after.children.filter((child) => child.tag === "button");
	const afterClearBg = afterButtons.find((button) => button.title === "Remove background");
	assert.equal(afterClearBg?.disabled, true, "with no background left the button is disabled");
}

/* ------------------------------------------------------------------ *
 * Walking into a zone and back out again                              *
 * ------------------------------------------------------------------ */

{
	interface ZoneNavInternals {
		root: FakeElement;
		nodesEl: FakeElement;
		zonesEl: FakeElement;
		crumbsEl: FakeElement;
		backEl: FakeElement;
		stageEl: FakeElement;
		nodeIds: string[];
		popoverEl: FakeElement | null;
	}

	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			nodes: [
				{
					id: "west",
					x: 100,
					y: 100,
					chars: [],
					kind: "zone",
					zone: [
						{ x: 0, y: 0 },
						{ x: 400, y: 0 },
						{ x: 400, y: 400 },
						{ x: 0, y: 400 },
					],
				},
				{ id: "mill", x: 600, y: 300, chars: [], parentId: "west" },
				// Outside the outline: a sibling that must not answer clicks meant
				// for the region, and the reason `zoneAt` is given the level rather
				// than the whole map.
				{ id: "east", x: 700, y: 100, chars: [], kind: "zone", zone: [
					{ x: 600, y: 0 },
					{ x: 900, y: 0 },
					{ x: 900, y: 300 },
				] },
			],
		};
		// A canvas exactly as wide as the stub's wrap, so the stage scales 1:1 and a
		// `clientX` in a test is the same number as the canvas x. Without this every
		// coordinate below would have to be pre-divided by 0.3125, and a test whose
		// numbers only work because of an arithmetic slip is worse than no test.
		setCanvasSize(maps, p, [320, 320]);
	});

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as ZoneNavInternals;

	// At the top: only what has no parent, and the town's own pin is not drawn.
	assert.equal(internals.nodeIds.length, 0, "a fresh chapter opens on the world");
	const pins = (): FakeElement[] => internals.nodesEl.findAll((el) => el.dataset.nodeId !== undefined);
	// The two regions are here because their labels carry `data-node-id` now -
	// that is what lets a right-click on a label find its zone. `mill` is the
	// point of the test: a location inside a region belongs to the level below.
	assert.deepEqual(
		pins().map((el) => el.dataset.nodeId),
		["west", "east"],
		"the world level shows the regions and nothing inside them",
	);
	assert.ok(
		!pins().some((el) => el.dataset.nodeId === "mill"),
		"a location inside a region is not on the world level",
	);

	// The trail starts at the world, and "Back" is offered with nowhere to go back to.
	const crumbText = (): string[] =>
		internals.crumbsEl.all().filter((el) => el.classes.has("wsm-map__crumb")).map((el) => el.text);
	assert.deepEqual(crumbText(), ["World"], "the trail starts with the world and nothing else");
	assert.equal(internals.backEl.classes.has("is-hidden"), true, "Back is hidden with no history to undo");

	// A click inside the outline goes in. Fired on the polygon itself, which is
	// what a real pointer hits when it lands on the border's fill area.
	const west = internals.zonesEl.find((el) => el.dataset.zoneId === "west") as FakeElement;
	assert.ok(west, "the region is drawn on the world level");
	assert.equal(west.tag, "polygon", "a zone is a real polygon, not a div pretending to be one");
	west.fire("click", { clientX: 200, clientY: 200 });
	assert.deepEqual(internals.nodeIds, ["west"], "clicking inside a zone goes into it");

	// Now inside: the town's pin appears, the outline does not, and the trail
	// has grown a crumb.
	assert.deepEqual(
		pins().map((el) => el.dataset.nodeId),
		["mill"],
		"the location inside the region is drawn on this level",
	);
	assert.equal(
		internals.zonesEl.find((el) => el.dataset.zoneId === "west"),
		null,
		"the region you are standing in is not drawn as an outline of itself",
	);
	assert.deepEqual(crumbText(), ["World", "west"], "the trail names the level entered");
	assert.equal(internals.backEl.classes.has("is-hidden"), false, "Back appears once there is somewhere to go");

	// A double-click here makes a child of the zone, not of the world.
	internals.stageEl.fire("dblclick", { clientX: 500, clientY: 500 });
	const stored = plugin.settings.maps[CHAPTER_MAP].nodes;
	const made = stored[stored.length - 1];
	assert.equal(made.parentId, "west", "a new location inside a region is its child");
	assert.ok(internals.popoverEl, "and its popover opens straight away, as on the world level");

	// Back out: the level changes, and the town's pin leaves the screen because it
	// belongs one level down now.
	internals.backEl.fire("click");
	assert.deepEqual(internals.nodeIds, [], "Back leaves the region");
	assert.ok(
		!pins().some((el) => el.dataset.nodeId === "mill"),
		"and the location that was inside it is no longer on the world level",
	);
	assert.equal(internals.backEl.disabled, true, "with the history spent, Back is disabled rather than live");
}

/* ------------------------------------------------------------------ *
 * Back is a history, not a parent                                      *
 * ------------------------------------------------------------------ */

{
	interface ZoneNavInternals2 {
		nodeIds: string[];
		backEl: FakeElement;
		crumbsEl: FakeElement;
	}

	const plugin = makePlugin(CHAPTER_MAP, []);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			nodes: [
				{ id: "a", x: 0, y: 0, chars: [], kind: "zone", zone: [
					{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 } ] },
				{ id: "b", x: 0, y: 0, chars: [], kind: "zone", parentId: "a", zone: [
					{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 } ] },
			],
		};
	});

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as ZoneNavInternals2;

	// Two descents in a row, then one Back: a parent-link "up" would have landed
	// on the world, but the history says where the writer actually was.
	(view as unknown as { goInto(id: string): void }).goInto("a");
	(view as unknown as { goInto(id: string): void }).goInto("b");
	assert.deepEqual(internals.nodeIds, ["a", "b"], "two levels deep");

	internals.backEl.fire("click");
	assert.deepEqual(internals.nodeIds, ["a"], "one Back undoes one descent, not the whole branch");
	internals.backEl.fire("click");
	assert.deepEqual(internals.nodeIds, [], "and the second Back returns to the world");
}

/* ------------------------------------------------------------------ *
 * Hovering a zone says so                                             *
 * ------------------------------------------------------------------ */

{
	interface ZoneHoverInternals {
		zonesEl: FakeElement;
		stageEl: FakeElement;
		nodeIds: string[];
	}

	const plugin = makePlugin(CHAPTER_MAP, []);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		setCanvasSize(maps, p, [320, 320]);
		maps[p] = {
			nodes: [
				{ id: "a", x: 0, y: 0, chars: [], kind: "zone", zone: [
					{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 } ] },
				{ id: "b", x: 0, y: 0, chars: [], kind: "zone", zone: [
					{ x: 400, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 300 } ] },
			],
		};
		setCanvasSize(maps, p, [320, 320]);
	});

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as ZoneHoverInternals;

	internals.stageEl.fire("pointermove", { clientX: 150, clientY: 150 });
	const hovered = (): FakeElement | null => internals.zonesEl.find((el) => el.classes.has("is-hover"));
	assert.equal(hovered()?.dataset.zoneId, "a", "the zone under the pointer lights up");

	// Off every outline: nothing is lit, and the previous one is not left behind.
	internals.stageEl.fire("pointermove", { clientX: 900, clientY: 900 });
	assert.equal(hovered(), null, "moving off every outline clears the highlight");

	// A drawing tool owns the pointer, so a hover would be a lie about what the
	// next click will do.
	(view as unknown as { toggleTool(tool: string): void }).toggleTool("zone");
	internals.stageEl.fire("pointermove", { clientX: 150, clientY: 150 });
	assert.equal(hovered(), null, "no zone highlights while a tool is armed");
}

/* ------------------------------------------------------------------ *
 * Drawing a zone                                                      *
 * ------------------------------------------------------------------ */

{
	interface ZoneDrawInternals {
		nodesEl: FakeElement;
		zonesEl: FakeElement;
		stageEl: FakeElement;
		nodeIds: string[];
	}

	const plugin = makePlugin(CHAPTER_MAP, []);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => setCanvasSize(maps, p, [320, 320]));
	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as ZoneDrawInternals;

	const toolButton = (internals as unknown as { root: FakeElement })
		.root.find((el) => el.dataset.tool === "zone") as FakeElement;
	assert.ok(toolButton, "the toolbar has a zone tool");
	toolButton.fire("click");
	assert.equal(toolButton.classes.has("is-active"), true, "the armed tool says so in the toolbar");

	// Three corners, then back to the first: the shape closes.
	internals.stageEl.fire("click", { clientX: 100, clientY: 100 });
	internals.stageEl.fire("click", { clientX: 400, clientY: 100 });
	internals.stageEl.fire("click", { clientX: 300, clientY: 400 });
	assert.deepEqual(
		plugin.settings.maps[CHAPTER_MAP]?.nodes ?? [],
		[],
		"three corners is not a zone yet, and nothing is written to disk",
	);
	assert.equal(
		internals.zonesEl.findAll((el) => el.classes.has("wsm-draft")).length,
		1,
		"the outline being drawn is visible before it is committed",
	);

	internals.stageEl.fire("click", { clientX: 101, clientY: 101 });
	const zone = plugin.settings.maps[CHAPTER_MAP].nodes[0];
	assert.equal(zone.kind, "zone", "clicking back at the first corner closes the outline into a zone");
	assert.equal(zone.zone?.length, 3, "and it keeps the three corners that were clicked");
	assert.equal(
		zone.parentId ?? null,
		internals.nodeIds[internals.nodeIds.length - 1] ?? null,
		"the zone is a child of the level it was drawn on, not of whatever was under the cursor",
	);
	// Drawing a zone does not change the level. Going in used to, and it was
	// wrong twice over: the writer was moved out from under the tool they had just
	// picked, and a nested zone landed one level deeper than they drew it.
	// Naming it here is what the gesture was for, so the popover opens instead.
	assert.deepEqual(
		internals.nodeIds,
		[],
		"a freshly drawn zone leaves the level alone, so the tool stays where it was",
	);
	assert.ok(internals.popoverEl, "and the new zone's popover opens straight away, to name it");
	const nameField = internals.popoverEl!.find((el) => el.classes.has("wsm-pop__name"));
	assert.ok(nameField, "with the name field on it, ready to type into");
	assert.equal(
		(nameField as unknown as { focused: boolean }).focused,
		true,
		"and focused, because the first thing a zone needs is a name",
	);
	assert.equal(
		internals.zonesEl.find((el) => el.classes.has("wsm-draft")),
		null,
		"the draft is gone once the zone is stored",
	);
}

/* ------------------------------------------------------------------ *
 * A bow tie is refused                                                *
 * ------------------------------------------------------------------ */

{
	const plugin = makePlugin(CHAPTER_MAP, []);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => setCanvasSize(maps, p, [320, 320]));
	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as { stageEl: FakeElement; zonesEl: FakeElement };

	(view as unknown as { toggleTool(tool: string): void }).toggleTool("zone");
	// A shape that crosses itself: its "inside" is decided by a counting rule
	// rather than by what was drawn, so which half answers a click is a guess.
	internals.stageEl.fire("click", { clientX: 0, clientY: 0 });
	internals.stageEl.fire("click", { clientX: 300, clientY: 0 });
	internals.stageEl.fire("click", { clientX: 0, clientY: 300 });
	internals.stageEl.fire("click", { clientX: 300, clientY: 300 });
	internals.stageEl.fire("click", { clientX: 0, clientY: 0 });

	assert.deepEqual(
		plugin.settings.maps[CHAPTER_MAP]?.nodes ?? [],
		[],
		"a self-crossing outline is never stored",
	);
	assert.ok(
		internals.zonesEl.find((el) => el.classes.has("wsm-draft")),
		"and the corners stay on screen, so the writer can fix the shape rather than start again",
	);
}

/* ------------------------------------------------------------------ *
 * A zone's sun                                                        *
 * ------------------------------------------------------------------ */

{
	interface SunInternals {
		nodesEl: FakeElement;
		nodeIds: string[];
	}

	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			nodes: [
				{
					id: "region",
					x: 0,
					y: 0,
					chars: [],
					kind: "zone",
					anchor: { x: 200, y: 200 },
					zone: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }],
				},
				{ id: "town", x: 10, y: 10, chars: ["tom"], parentId: "region" },
			],
		};
	});

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as SunInternals;

	const sun = internals.nodesEl.find((el) => el.classes.has("wsm-sun"));
	assert.ok(sun, "a zone with an anchor draws its sun");
	assert.equal(
		sun.find((el) => el.getAttribute("data-drag") === "char") !== null,
		true,
		"the sun holds an avatar for a character who is one level down, inside the town",
	);
	assert.equal(sun.find((el) => el.classes.has("wsm-sun__more")), null, "one character fits, so there is no overflow badge");
}

/* ------------------------------------------------------------------ *
 * The spokes get a real box                                          *
 * ------------------------------------------------------------------ */

{
	// The layer used to be a 0x0 SVG whose lines only showed if
	// `overflow: visible` happened to hold. Now it is a real viewport centred
	// on the pin, and the two halves of that fact — the code and the stylesheet
	// — are compared here so they cannot drift apart.
	const css = code("../styles.css");
	const spokeRule = css.match(/\.wsp-spokes\s*\{([^}]*)\}/);
	assert.ok(spokeRule, "styles.css has a .wsp-spokes rule");
	const block = spokeRule[1];

	const left = block.match(/left:\s*(-?\d+)px/);
	const top = block.match(/top:\s*(-?\d+)px/);
	const width = block.match(/width:\s*(\d+)px/);
	const height = block.match(/height:\s*(\d+)px/);
	assert.ok(left && top && width && height, ".wsp-spokes is given a real box, not left at 0x0");

	assert.equal(left[1], "-2048", "the box starts 2048px to the left of the pin");
	assert.equal(top[1], "-2048", "and 2048px above it");
	assert.equal(width[1], "4096", "so the pin sits in the middle horizontally");
	assert.equal(height[1], "4096", "and vertically");
	assert.match(block, /z-index:\s*1/, "the layer is above the background and below the avatars");

	// Avatars are drawn over the layer, so the two need an order between them.
	const avatarRule = css.match(/\.wsm-avatar\s*\{([^}]*)\}/);
	assert.ok(avatarRule, "styles.css has a .wsm-avatar rule");
	assert.match(avatarRule[1], /z-index:\s*2/, "avatars sit above the spoke layer");

	// The box has to be big enough for the widest spoke at the smallest usable
	// scale, or the guarantee above is worthless.
	const HALF = 2048;
	const ringPx = 120; // MAX_RADIUS
	const sidebarPx = 320;
	const widestStagePx = ringPx * (1024 / sidebarPx);
	assert.ok(
		widestStagePx < HALF,
		`the box holds the widest spoke even in a narrow sidebar (${widestStagePx.toFixed(0)}px of ${HALF}px)`,
	);
}

{
	// And the geometry itself: every line starts at the middle of the box and
	// ends at the avatar's position, in the same units the avatar is placed in.
	interface MapViewInternalsSpokes {
		nodesEl: FakeElement;
		scale: number;
		refresh(): void;
	}

	const pawnOnNode: Pawn = { id: "tom", name: "Tom", initials: "To", color: "#e05c5c" };
	const plugin = makePlugin(CHAPTER_MAP, [pawnOnNode]);
	plugin.settings.maps[CHAPTER_MAP] = { nodes: [{ id: "harbor", x: 300, y: 200, chars: [] }] };

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as MapViewInternalsSpokes;

	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		setPawnOnNode(maps, p, "harbor", "tom", true);
	});
	view.refresh();

	const svg = internals.nodesEl.find((el) => el.tag === "svg") as FakeElement;
	assert.ok(svg, "the character ring draws one SVG layer");
	assert.equal(svg.style.width, "4096px", "the layer is a real 4096px box in the DOM too");

	const line = svg.children[0] as unknown as FakeElement;
	const x1 = Number(line.getAttribute("x1"));
	const y1 = Number(line.getAttribute("y1"));
	const x2 = Number(line.getAttribute("x2"));
	const y2 = Number(line.getAttribute("y2"));

	assert.equal(x1, 2048, "the line starts at the middle of the box, not at 0");
	assert.equal(y1, 2048, "on both axes");

	// The far end has to be the avatar's position, offset by the same centre.
	// One division by this.scale for both, which is the whole point: the ring is
	// authored in screen px and the stage is scaled, so the two only meet when
	// the same number is used here.
	const avatar = internals.nodesEl.find((el) => el.classes.has("wsm-avatar")) as FakeElement;
	const avatarLeft = Number.parseFloat(avatar.style.left);
	const avatarTop = Number.parseFloat(avatar.style.top);
	const expected = placedPosition(0, 1, undefined);

	assert.equal(avatarLeft, expected.x / internals.scale, "the avatar is placed in canvas px");
	assert.equal(x2, 2048 + avatarLeft, "the line reaches exactly the avatar horizontally");
	assert.equal(y2, 2048 + avatarTop, "and vertically");
	assert.notEqual(Number.isNaN(x2) || Number.isNaN(y2), true, "the line has real numbers in both attributes");
}

/* ---- an empty name is still rejected ---- */

{
	assert.equal(composePawn("   ", []), null, "a blank pawn name is rejected");
	assert.equal(composePawn("Tom Sawyer", [], { initials: PLACEHOLDER_INITIALS })?.initials, "TS", 'a "?" override is ignored');
	assert.equal(composePawn("Tom Sawyer", [], { initials: "TS" })?.initials, "TS", "a real initials override is kept");
}

{
	// Existing data repaired on load: a pawn stored with the placeholder token
	// recovers its initials from its own name.
	const repaired = normalizePawns([{ id: "arya", name: "Arya Stark", initials: "?", color: "#4a90d9" }]);
	assert.equal(repaired[0].initials, "AS", 'a stored "?" is replaced by initials from the name');
}

{
	// `note` became `notePath`; a hand-edited data.json still has the old key.
	const legacy = normalizePawns([
		{ id: "kai", name: "Кай", initials: "К", color: "#888", note: "Персонажи/Кай.md" },
	]);
	assert.equal(legacy[0].notePath, "Персонажи/Кай.md", 'a legacy "note" is migrated to notePath on load');

	const current = normalizePawns([
		{ id: "kai", name: "Кай", initials: "К", color: "#888", notePath: "Персонажи/Кай.md" },
	]);
	assert.equal(current[0].notePath, "Персонажи/Кай.md", "notePath is read as-is");
}

/* ------------------------------------------------------------------ *
 * map-view: taking the last chapter as the starting point              *
 * ------------------------------------------------------------------ */

interface MapViewInternalsInherit {
	root: FakeElement;
	refresh(): void;
	runInherit(parent: string): void;
	forgetParent(): void;
}

/** The buttons in the map's empty state, in the order they are offered. */
function emptyActions(root: FakeElement): FakeElement[] {
	const empty = root.find((el) => el.classes.has("wsm-map__empty"));
	assert.ok(empty, "the map has an empty state element");
	return (empty as FakeElement).findAll((el) => el.classes.has("wsm-empty__copy"));
}

const tomPawn: Pawn = { id: "tom", name: "Tom", initials: "To", color: "#e05c5c" };

/** All the text under a node, including the spans a label is split across. */
function labelOf(el: FakeElement): string {
	return [el.text, ...el.children.map((child) => labelOf(child))]
		.filter((part) => part !== "")
		.join(" ");
}

{
	// The button the whole feature exists for. Nothing is copied until it is
	// pressed — an automatic copy would be a guess about which chapter came
	// first, made on the writer's behalf and into their data.
	const plugin = makePlugin("Глава 2.md", [tomPawn]);
	plugin.updateMap("Глава 2.md", (maps, p) => {
		maps[p] = { map_bg: null, nodes: [] };
	});
	plugin.updateMap("Глава 1.md", (maps, p) => {
		maps[p] = {
			map_bg: "maps/harbour.png",
			map_size: [4000, 3000],
			nodes: [{ id: "harbour", x: 100, y: 200, chars: ["tom"] }],
			links: [{ a: "tom", b: "aya", kind: "blood" }],
		};
	});

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as MapViewInternalsInherit;

	const actions = emptyActions(internals.root);
	const inherit = actions.find((el) => labelOf(el).includes("Глава 1")) as FakeElement | undefined;
	assert.ok(inherit, "the empty state offers to inherit from the preceding chapter");
	// The counts are in the tooltip: the label has to fit a narrow sidebar, and
	// which chapter is about to be copied is the part that must not be truncated.
	assert.match(
		inherit.title,
		/1/,
		"the button says how much is coming before anything is copied",
	);
	assert.equal("Глава 2.md" in plugin.settings.maps, true, "the empty chapter has an entry, created by the test setup");
	assert.equal(plugin.settings.maps["Глава 2.md"].nodes.length, 0, "and it is still empty before the click");

	inherit.fire("click");

	const copied = plugin.settings.maps["Глава 2.md"];
	assert.equal(copied.nodes.length, 1, "the location came across");
	assert.equal(copied.nodes[0].id, "harbour", "with its id");
	assert.deepEqual(copied.nodes[0].chars, ["tom"], "and its character");
	assert.deepEqual(copied.map_size, [4000, 3000], "and the canvas size, so the pins stay on the sheet");
	assert.equal(copied.map_bg, "maps/harbour.png", "and the background");
	assert.equal(copied.links?.length, 1, "and the tie");
	assert.equal(copied.parent_chapter_id, "Глава 1.md", "and a record of where it came from");

	// With locations on the map there is nothing to offer: the copy would be
	// refused, and a button that can only fail is worse than none.
	const after = emptyActions(internals.root);
	assert.equal(
		after.some((el) => labelOf(el).includes("Inherit from")),
		false,
		"the inherit button is gone once the map is no longer empty",
	);
}

{
	// Nothing to copy from means no button. An offer that silently did nothing
	// would be worse than an absent one.
	const plugin = makePlugin("Глава 1.md", [pawn]);
	plugin.updateMap("Глава 1.md", (maps, p) => {
		maps[p] = { map_bg: null, nodes: [] };
	});
	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as MapViewInternalsInherit;

	const labels = emptyActions(internals.root).map((el) => el.text);
	assert.equal(
		labels.some((text) => text.includes("Inherit from")),
		false,
		"the very first chapter is offered no source to inherit from",
	);
	assert.ok(labels.length > 0, "but it is still offered a way to start");
}

{
	// The refusal has to be visible. A writer who clicks this on a map they have
	// already filled in would otherwise see nothing happen and assume a bug.
	const plugin = makePlugin("Глава 2.md", [tomPawn]);
	plugin.updateMap("Глава 2.md", (maps, p) => {
		maps[p] = { map_bg: null, nodes: [{ id: "mine", x: 5, y: 6, chars: [] }] };
	});
	plugin.updateMap("Глава 1.md", (maps, p) => {
		maps[p] = { map_bg: null, nodes: [{ id: "theirs", x: 100, y: 200, chars: ["tom"] }] };
	});

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as MapViewInternalsInherit;

	noticeLog.length = 0;
	internals.runInherit("Глава 1.md");
	assert.deepEqual(
		plugin.settings.maps["Глава 2.md"].nodes.map((node) => node.id),
		["mine"],
		"a map that already has a location is not overwritten",
	);
	assert.equal(plugin.settings.maps["Глава 2.md"].parent_chapter_id, undefined, "and no parent is recorded");
	assert.deepEqual(
		noticeLog,
		[t("en", "noticeInheritRefused")],
		"the refusal is reported rather than swallowed",
	);
}

/* ---- the provenance line ---- */

{
	const plugin = makePlugin("Глава 2.md", [tomPawn]);
	plugin.updateMap("Глава 1.md", (maps, p) => {
		maps[p] = { map_bg: null, nodes: [{ id: "harbour", x: 100, y: 200, chars: ["tom"] }] };
	});

	const view = new MapView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as MapViewInternalsInherit;

	assert.equal(
		internals.root.find((el) => el.classes.has("wsm-map__from")),
		null,
		"a map with no source shows no provenance line",
	);

	// Fill it in the way the button does, then repaint.
	plugin.updateMap("Глава 2.md", (maps, p) => {
		maps[p] = { map_bg: null, nodes: [] };
	});
	internals.runInherit("Глава 1.md");

	const row = internals.root.find((el) => el.classes.has("wsm-map__from")) as FakeElement;
	assert.ok(row, "after inheriting, the map says where it came from");
	assert.ok(labelOf(row).includes("Глава 1"), "naming the chapter");
	assert.equal(row.classes.has("is-stale"), false, "and it is not flagged as missing");

	// A rename leaves the path behind. The line has to say so, because the
	// alternative is a provenance claim that quietly points at nothing.
	plugin.updateMap("Глава 1.md", (maps, p) => {
		delete maps[p];
	});
	view.refresh();
	const stale = internals.root.find((el) => el.classes.has("wsm-map__from")) as FakeElement;
	assert.ok(stale.classes.has("is-stale"), "a source that is gone is flagged");
	assert.ok(labelOf(stale).length > 0, "and still says something about it");
	// One line, however many times the view repaints. A leftover row would keep
	// asserting the old state, which is worse than showing nothing.
	assert.equal(
		internals.root.findAll((el) => el.classes.has("wsm-map__from")).length,
		1,
		"repainting replaces the line rather than stacking another one",
	);

	// Forgetting the source leaves the layout alone: it only claims the map was
	// built by hand, which after heavy editing is often the truth.
	internals.forgetParent();
	assert.equal(plugin.settings.maps["Глава 2.md"].parent_chapter_id, undefined, "the source is forgotten");
	assert.equal(
		plugin.settings.maps["Глава 2.md"].nodes.length,
		1,
		"and the locations the writer inherited are still there",
	);
	assert.equal(
		internals.root.find((el) => el.classes.has("wsm-map__from")),
		null,
		"with no source there is no line to show",
	);
}

/* ======================================================================== *
 * The author's note: paths, the generated block, and the merge            *
 * ======================================================================== */

/** Russian strings, so the golden block below is the format writers will read. */
const RU: NoteStrings = {
	placementTitle: t("ru", "notePlacementTitle"),
	offStoryTitle: t("ru", "noteOffStoryTitle"),
	emptyLocation: t("ru", "noteEmptyLocation"),
	noLocations: t("ru", "noteNoLocations"),
	unnamedLocation: t("ru", "noteUnnamedLocation"),
	freeZone: t("ru", "noteFreeZone"),
};

const yana = { id: "yan", name: "Ян", initials: "Ян", color: "#e05c5c" };
const kai = { id: "kai", name: "Кай", initials: "К", color: "#e08a3c" };
const liran = { id: "liran", name: "Лиран", initials: "Л", color: "#3cb8a0" };
const mother = { id: "pmk", name: "Приемная Мать Кая", initials: "ПМ", color: "#7b6bd9" };

{
	// The whole point of the hidden folder: the path is mirrored, not renamed.
	// Renaming would break wikilinks from other notes and make the export guess.
	assert.equal(NOTE_ROOT, ".Writer Maps Data", "notes live in a dot-folder inside the vault");
	assert.equal(EXPORT_ROOT, "Writer Maps Export", "the export copy is a visible folder");
	assert.equal(
		notePathFor("Кровь и Искра/Восстание Искры.md"),
		".Writer Maps Data/Кровь и Искра/Восстание Искры.md",
		"a nested chapter keeps its folder and filename verbatim",
	);
	assert.equal(
		notePathFor("Глава 1.md"),
		".Writer Maps Data/Глава 1.md",
		"a chapter at the vault root still lands inside the dot-folder",
	);
	assert.equal(notePathFor(""), "", "an empty path yields no target");
	assert.equal(
		noteFolderFor("Кровь и Искра/Восстание Искры.md"),
		".Writer Maps Data/Кровь и Искра",
		"the folder is the chapter's own folder, for the recursive mkdir",
	);
	assert.equal(noteFolderFor("Глава 1.md"), NOTE_ROOT, "a root chapter needs only the root folder");
	assert.equal(
		chapterForNotePath(".Writer Maps Data/Кровь и Искра/Восстание Искры.md"),
		"Кровь и Искра/Восстание Искры.md",
		"the mirror is reversible, so the note tab can be mapped back to its chapter",
	);
	assert.equal(
		chapterForNotePath("Кровь и Искра/Восстание Искры.md"),
		"",
		"an ordinary note belongs to no chapter, and says so with an empty path",
	);
	assert.equal(
		chapterForNotePath(""),
		"",
		"an empty path is nobody's note",
	);
}

{
	// The managed-path gate is the only thing standing between the writer and
	// the author's own vault, so every shape it must refuse is spelled out.
	assert.equal(isManagedPath(".Writer Maps Data/Глава.md"), true, "a note is ours");
	assert.equal(isManagedPath("Writer Maps Export/Глава.md"), true, "an exported note is ours");
	assert.equal(isManagedPath("Глава.md"), false, "an ordinary chapter is not");
	assert.equal(isManagedPath(".Writer Maps Data"), false, "the folder itself is not a note");
	assert.equal(isManagedPath(".Writer Maps Data/"), false, "a trailing slash is not a note");
	assert.equal(isManagedPath("Writer Maps Data/Глава.md"), false, "a near-miss folder name is not ours");
	assert.equal(isManagedPath("Writer Maps Export"), false, "the export folder itself is not a note");
	assert.equal(isManagedPath(".Writer Maps Data/notes.txt"), false, "only markdown is a note");
	assert.equal(isNotePath(".Writer Maps Data/Глава.md"), true, "a note is recognized by itself");
	assert.equal(isNotePath("Writer Maps Export/Глава.md"), false, "an export copy is not a note");
	assert.equal(isExportPath("Writer Maps Export/Глава.md"), true, "an export copy is recognized by itself");
}

{
	assert.equal(wikiLink("Кай"), "[[Кай]]", "a name becomes a wikilink");
	assert.equal(wikiLink("Кай  \n Литл"), "[[Кай Литл]]", "newlines cannot break the line structure");
	assert.equal(wikiLink("Кай|Джон"), "[[Кай\\|Джон]]", "a pipe cannot turn into an alias");
}

{
	// The exact format from the spec, pinned as a golden test: this is the text
	// the writer reads in Obsidian.
	const map: StoredChapterMap = {
		map_bg: null,
		nodes: [
			{ id: "n2", label: "Деревня Яна", x: 0, y: 0, chars: ["yan", "kai", "liran"] },
			{ id: "n1", label: "Академия Магов", x: 0, y: 0, chars: [] },
		],
	};
	const block = buildNoteBlock(map, [yana, kai, liran, mother], RU);

	assert.equal(
		block,
		[
			"%% wsm-summary-start %%",
			"### 📍 Размещение персонажей в этой главе:",
			"- **Академия Магов**: *Локация пуста*",
			"- **Деревня Яна**: [[Ян]], [[Кай]], [[Лиран]]",
			"",
			"### ⚠️ Вне сюжета (остались в пуле):",
			"- [[Приемная Мать Кая]]",
			"%% wsm-summary-end %%",
		].join("\n"),
		"the generated block matches the agreed format",
	);

	// No off-story members: the section would be noise.
	const tight = buildNoteBlock(
		{ map_bg: null, nodes: [{ id: "n1", label: "Яна", x: 0, y: 0, chars: ["yan"] }] },
		[yana],
		RU,
	);
	assert.equal(tight.includes("Вне сюжета"), false, "an empty off-story pool is omitted");
	assert.equal(tight.includes("- **Яна**: [[Ян]]"), true, "a filled location lists its characters");

	// A chapter with no locations at all.
	const bare = buildNoteBlock({ map_bg: null, nodes: [] }, [yana], RU);
	assert.equal(bare.includes(RU.noLocations), true, "a chapter without locations says so");

	// An unnamed location still gets a line rather than "**undefined**".
	const unnamed = buildNoteBlock(
		{ map_bg: null, nodes: [{ id: "n1", x: 0, y: 0, chars: [] }] },
		[],
		RU,
	);
	assert.equal(unnamed.includes(`- **${RU.unnamedLocation}**`), true, "an unnamed location falls back to a label");

	// A token pointing at a deleted pawn has no name to link.
	const stale = buildNoteBlock(
		{ map_bg: null, nodes: [{ id: "n1", label: "Яна", x: 0, y: 0, chars: ["ghost"] }] },
		[],
		RU,
	);
	assert.equal(stale.includes("ghost"), false, "a token with no roster entry is skipped");
}

{
	// The map is a tree and the digest has to read like one.
	//
	// A flat list of every node made the summary contradict the map: Ян stands in
	// Причал, Причал is inside Гавань, and the flat version listed Ян against the
	// Причал while Гавань read as empty. A writer who trusts the note to say who
	// is where would conclude the region was abandoned.
	const nested: StoredChapterMap = {
		map_bg: null,
		nodes: [
			{
				id: "harbour",
				label: "Гавань",
				kind: "zone",
				zone: [
					{ x: 0, y: 0 },
					{ x: 10, y: 0 },
					{ x: 10, y: 10 },
				],
				x: 0,
				y: 0,
				chars: [],
			},
			{ id: "pier", label: "Причал", x: 1, y: 1, chars: ["yan"], parentId: "harbour" },
			{ id: "inn", label: "Харчевня", x: 2, y: 2, chars: ["kai"], parentId: "harbour" },
			// A plain location at the top level, so the two shapes are in one file.
			{ id: "road", label: "Дорога", x: 3, y: 3, chars: ["liran"] },
		],
	};

	assert.equal(
		buildNoteBlock(nested, [yana, kai, liran], RU),
		[
			"%% wsm-summary-start %%",
			"### 📍 Размещение персонажей в этой главе:",
			// The zone's line is its whole cast, so a reader can stop at the region.
			"- **Гавань**: [[Ян]], [[Кай]]",
			"  - **Причал**: [[Ян]]",
			"  - **Харчевня**: [[Кай]]",
			"- **Дорога**: [[Лиран]]",
			"%% wsm-summary-end %%",
		].join("\n"),
		"a zone nests what it contains and speaks for the whole subtree",
	);

	// A character listed twice - once directly, once in a child - is one token on
	// the region's line, not a claim they are in two places.
	const shared: StoredChapterMap = {
		map_bg: null,
		nodes: [
			{
				id: "harbour",
				label: "Гавань",
				kind: "zone",
				zone: [
					{ x: 0, y: 0 },
					{ x: 10, y: 0 },
					{ x: 10, y: 10 },
				],
				x: 0,
				y: 0,
				chars: ["yan"],
			},
			{ id: "pier", label: "Причал", x: 1, y: 1, chars: ["yan"], parentId: "harbour" },
		],
	};
	const once = buildNoteBlock(shared, [yana], RU);
	assert.equal(
		once.split("[[Ян]]").length - 1,
		2,
		"a character in a zone and in its town appears once per line that mentions them",
	);

	// Three deep, because two deep would not prove the recursion goes all the way.
	const deep: StoredChapterMap = {
		map_bg: null,
		nodes: [
			{
				id: "a",
				label: "Область",
				kind: "zone",
				zone: [
					{ x: 0, y: 0 },
					{ x: 10, y: 0 },
					{ x: 10, y: 10 },
				],
				x: 0,
				y: 0,
				chars: [],
			},
			{
				id: "b",
				label: "Город",
				kind: "zone",
				parentId: "a",
				zone: [
					{ x: 0, y: 0 },
					{ x: 5, y: 0 },
					{ x: 5, y: 5 },
				],
				x: 1,
				y: 1,
				chars: [],
			},
			{ id: "c", label: "Улица", x: 2, y: 2, chars: ["yan"], parentId: "b" },
		],
	};
	assert.equal(
		buildNoteBlock(deep, [yana], RU),
		[
			"%% wsm-summary-start %%",
			"### 📍 Размещение персонажей в этой главе:",
			"- **Область**: [[Ян]]",
			"  - **Город**: [[Ян]]",
			"    - **Улица**: [[Ян]]",
			"%% wsm-summary-end %%",
		].join("\n"),
		"nesting goes all the way down, two spaces per level",
	);

	// A location is not a zone: its line is its own people, not a subtree that
	// happens to be empty. Reading "the people here" as everything below would
	// be a claim about a hierarchy the map does not have.
	const location = buildNoteBlock(
		{ map_bg: null, nodes: [{ id: "p", label: "Причал", x: 0, y: 0, chars: ["yan"] }] },
		[yana],
		RU,
	);
	assert.equal(
		location.includes("- **Причал**: [[Ян]]"),
		true,
		"a plain location lists exactly its own characters",
	);

	// A child of a node that is gone. The tree is in pieces, and the writer still
	// needs to see where they are - hiding them would silently drop a location
	// out of the digest.
	const orphaned: StoredChapterMap = {
		map_bg: null,
		nodes: [{ id: "orphan", label: "Потерянка", x: 0, y: 0, chars: ["yan"], parentId: "deleted" }],
	};
	assert.equal(
		buildNoteBlock(orphaned, [yana], RU).includes("- **Потерянка**: [[Ян]]"),
		true,
		"a location whose parent is missing is listed at the top rather than dropped",
	);

	// A cycle: a is inside b and b is inside a. There is no root to walk from, so
	// a naive walk prints nothing at all - the digest would claim the chapter has
	// no locations while the map clearly has two. It has to terminate and print
	// both, exactly once.
	const looped: StoredChapterMap = {
		map_bg: null,
		nodes: [
			{ id: "a", label: "А", x: 0, y: 0, chars: ["yan"], parentId: "b" },
			{ id: "b", label: "Б", x: 1, y: 1, chars: ["kai"], parentId: "a" },
		],
	};
	const loopedBlock = buildNoteBlock(looped, [yana, kai], RU);
	assert.equal(
		(loopedBlock.match(/- \*\*/g) ?? []).length,
		2,
		"a parent cycle still lists every location once instead of hanging or printing nothing",
	);
	assert.equal(loopedBlock.includes("Б"), true, "and both are really in there");
}

{
	// The signature has to see the shape of the tree, because the digest does.
	// Moving a town into a region rewrites the file; if the signature ignored
	// `parentId` the old nesting would sit there and nothing would look wrong.
	const before = contentSignature(
		{
			map_bg: null,
			nodes: [
				{ id: "pier", label: "Причал", x: 0, y: 0, chars: ["yan"] },
				{ id: "harbour", label: "Гавань", x: 0, y: 0, chars: [], kind: "zone" },
			],
		},
		[yana],
	);
	const after = contentSignature(
		{
			map_bg: null,
			nodes: [
				{ id: "pier", label: "Причал", x: 0, y: 0, chars: ["yan"], parentId: "harbour" },
				{ id: "harbour", label: "Гавань", x: 0, y: 0, chars: [], kind: "zone" },
			],
		},
		[yana],
	);
	assert.notEqual(before, after, "re-parenting a location changes the signature");

	// Still no write for a drag, which is the whole point of excluding geometry.
	const dragged = contentSignature(
		{
			map_bg: null,
			nodes: [
				{ id: "pier", label: "Причал", x: 400, y: 900, chars: ["yan"], parentId: "harbour" },
				{ id: "harbour", label: "Гавань", x: 0, y: 0, chars: [], kind: "zone" },
			],
		},
		[yana],
	);
	assert.equal(dragged, after, "but dragging a location does not");
}

{
	const block = buildNoteBlock(
		{ map_bg: null, nodes: [{ id: "n1", label: "Яна", x: 0, y: 0, chars: ["yan"] }] },
		[yana],
		RU,
	);

	// 1. The file does not exist yet.
	const created = mergeNote(null, block, RU);
	assert.equal(created.ok, true, "a missing file is created");
	assert.equal(created.ok && created.text.startsWith(NOTE_START), true, "the new file opens with the block");
	assert.equal(created.ok && created.text.includes(RU.freeZone), true, "a new file gets a free zone");
	assert.equal(
		created.ok && created.text === newNote(block, RU),
		true,
		"newNote and a null merge agree: the two ways of making a file cannot drift",
	);

	// 2. Both markers: only the span between them changes.
	const handWritten = [
		"# Восстание Искры",
		"",
		"Мои заметки до слота.",
		"",
		NOTE_START,
		"старый слот",
		NOTE_END,
		"",
		"Свободная зона автора. Не трогать!",
	].join("\n");
	const updated = mergeNote(handWritten, block, RU);
	assert.equal(updated.ok, true, "an existing slot is rewritten");
	if (updated.ok) {
		assert.equal(updated.changed, true, "replacing old content reports a change");
		assert.equal(updated.text.includes("Мои заметки до слота."), true, "text above the slot survives");
		assert.equal(updated.text.includes("Свободная зона автора. Не трогать!"), true, "text below the slot survives");
		assert.equal(updated.text.includes("старый слот"), false, "the old generated block is gone");
	}

	// 3. Idempotency: writing the same state again must not change a byte.
	const again = mergeNote(updated.ok ? updated.text : "", block, RU);
	assert.equal(again.ok && again.changed, false, "regenerating unchanged data is a no-op");

	// 4. No markers: prepend, never destroy a file we did not create.
	const foreign = "# Чужой файл\n\nМой текст.";
	const prepended = mergeNote(foreign, block, RU);
	assert.equal(prepended.ok, true, "a file without markers is accepted");
	if (prepended.ok) {
		assert.equal(prepended.text.includes("Мой текст."), true, "a foreign file keeps all of its text");
		assert.equal(prepended.text.startsWith(NOTE_START), true, "the block is prepended");
	}

	// 5. Unbalanced markers: refuse rather than guess.
	const broken = `${NOTE_START}\nслот без конца`;
	assert.deepEqual(mergeNote(broken, block, RU), { ok: false, reason: "unbalanced" }, "a half slot is refused");
	const inverted = `${NOTE_END}\n${NOTE_START}`;
	assert.deepEqual(mergeNote(inverted, block, RU), { ok: false, reason: "unbalanced" }, "inverted markers are refused");
}

{
	const before = {
		map_bg: null,
		nodes: [{ id: "n1", label: "Яна", x: 10, y: 10, chars: ["yan"] }],
	};
	const moved = {
		map_bg: null,
		nodes: [{ id: "n1", label: "Яна", x: 480, y: 260, chars: ["yan"] }],
	};
	assert.equal(
		contentSignature(before, [yana]),
		contentSignature(moved, [yana]),
		"dragging a node does not change what the note shows",
	);
	// ...and neither does dragging a character around the ring, which is the
	// whole reason offsets live outside the signature.
	const nudged = {
		map_bg: null,
		nodes: [{ id: "n1", label: "Яна", x: 10, y: 10, chars: ["yan"], charOffsets: { yan: { offsetX: 9, offsetY: -4 } } }],
	};
	assert.equal(
		contentSignature(before, [yana]),
		contentSignature(nudged, [yana]),
		"dragging a character around the pin does not change the note either",
	);
	const added = { map_bg: null, nodes: [{ id: "n1", label: "Яна", x: 10, y: 10, chars: ["yan", "kai"] }] };
	assert.notEqual(
		contentSignature(before, [yana]),
		contentSignature(added, [yana, kai]),
		"ticking a character does change the note",
	);
	const renamed = [yana, { ...kai, name: "Кай Других" }];
	assert.notEqual(
		contentSignature(before, [yana, kai]),
		contentSignature(before, renamed),
		"a rename changes every chapter's off-story pool",
	);
}

/* ======================================================================== *
 * The radial ring: geometry                                              *
 * ======================================================================== */

{
	// A ring of one has no direction, so it sits straight above the pin where
	// the eye lands first.
	assert.equal(ringRadius(1), 30, "a lone character keeps a tight ring");
	assert.equal(ringRadius(0), 30, "an empty ring still has a radius");
	assert.equal(ringRadius(2), 37, "two characters get a little more room");
	assert.equal(ringRadius(6), 65, "the ring grows with the crowd");
	assert.equal(ringRadius(200), 120, "the radius is capped, or a huge cast loses its pin");

	assert.deepEqual(radialSlot(0, 1), { x: 0, y: -30 }, "a single character sits above the pin");
	assert.deepEqual(radialSlot(0, 0), { x: 0, y: 0 }, "an empty ring has no slots");

	// Four characters at 90°: one per compass point, starting at the top.
	const four = [0, 1, 2, 3].map((i) => radialSlot(i, 4, 100));
	assert.deepEqual(four[0], { x: 0, y: -100 }, "slot 0 is north");
	assert.deepEqual(four[1], { x: 100, y: 0 }, "slot 1 is east, running clockwise");
	assert.deepEqual(four[2], { x: 0, y: 100 }, "slot 2 is south");
	assert.deepEqual(four[3], { x: -100, y: 0 }, "slot 3 is west");

	// The property the ring actually depends on: neighbours never overlap and
	// no slot ever lands on the pin itself.
	for (const count of [1, 2, 3, 5, 8, 13, 40]) {
		const radius = ringRadius(count);
		const slots = Array.from({ length: count }, (_, i) => radialSlot(i, count, radius));
		for (const slot of slots) {
			assert.ok(
				Math.hypot(slot.x, slot.y) > 0,
				`no character in a ring of ${count} lands on the pin`,
			);
		}
		for (let a = 0; a < count; a += 1) {
			for (let b = a + 1; b < count; b += 1) {
				const gap = Math.hypot(slots[a].x - slots[b].x, slots[a].y - slots[b].y);
				assert.ok(
					gap >= 13,
					`two characters in a ring of ${count} keep a finger between them (got ${gap.toFixed(1)})`,
				);
			}
		}
	}

	// The nudge is additive and the only record of a hand-placed character.
	assert.deepEqual(
		placedPosition(0, 1, undefined),
		radialSlot(0, 1),
		"an untouched character sits exactly in its slot",
	);
	assert.deepEqual(
		placedPosition(0, 1, { offsetX: 12, offsetY: -7 }),
		{ x: radialSlot(0, 1).x + 12, y: radialSlot(0, 1).y - 7 },
		"a nudge is added to the slot, not substituted for it",
	);
	assert.equal(isNudged(undefined), false, "a character in a fresh ring was never moved");
	assert.equal(isNudged({ offsetX: 0, offsetY: 0 }), false, "a zero nudge is not a nudge");
	assert.equal(isNudged({ offsetX: 0, offsetY: 3 }), true, "any non-zero nudge counts");
}

{
	// The offsets survive a round trip through data.json, and a hand-edited
	// file cannot smuggle NaN or a stranger's offset into the map.
	const maps: ChapterMaps = {
		[CHAPTER]: {
			map_bg: null,
			nodes: [
				{
					id: "n1",
					x: 0,
					y: 0,
					chars: ["tom", "kai"],
					charOffsets: { tom: { offsetX: -8, offsetY: 14 }, ghost: { offsetX: 1, offsetY: 1 } },
				},
			],
		},
	};
	assert.equal(readMap(maps, CHAPTER, FALLBACK).nodes[0].charOffsets?.tom.offsetX, -8, "a stored nudge is read back");

	// The *loading* path is where junk gets dropped: readMap hands back the live
	// objects, so a hand-edited or imported file is only cleaned by normalizeMaps.
	const loaded = normalizeMaps({
		[CHAPTER]: {
			map_bg: null,
			nodes: [
				{
					id: "n1",
					x: 0,
					y: 0,
					chars: ["tom", "kai"],
					charOffsets: {
						tom: { offsetX: -8, offsetY: 14 },
						ghost: { offsetX: 1, offsetY: 1 },
						broken: { offsetX: "left", offsetY: null },
					},
				},
			],
		},
	});
	const loadedOffsets = loaded[CHAPTER].nodes[0].charOffsets;
	assert.deepEqual(loadedOffsets, { tom: { offsetX: -8, offsetY: 14 } }, "a good nudge survives loading");
	assert.equal(loadedOffsets?.ghost, undefined, "a nudge for someone not on the node is dropped");
	assert.equal(loadedOffsets?.broken, undefined, "a nudge that is not a number pair is dropped");
	assert.equal(
		normalizeMaps({
			[CHAPTER]: { map_bg: null, nodes: [{ id: "n1", x: 0, y: 0, chars: [], charOffsets: {} }] },
		})[CHAPTER].nodes[0].charOffsets,
		undefined,
		"an empty offsets object is not written into data.json at all",
	);

	const set = setCharOffset(maps, CHAPTER, "n1", "kai", { offsetX: 5, offsetY: 5 });
	assert.equal(set, true, "a nudge can be set");
	assert.deepEqual(
		readMap(maps, CHAPTER, FALLBACK).nodes[0].charOffsets?.kai,
		{ offsetX: 5, offsetY: 5 },
		"the new nudge is stored",
	);

	// Shift-drag on a ring where only one character was ever nudged: everybody
	// has to receive the delta, or the untouched ones stay in place and the
	// ring visibly comes apart.
	const dragged = moveCharOffsets(maps, CHAPTER, "n1", 10, -3);
	assert.equal(dragged, true, "a fan drag reports a change");
	const offsets = readMap(maps, CHAPTER, FALLBACK).nodes[0].charOffsets;
	assert.deepEqual(offsets?.tom, { offsetX: 2, offsetY: 11 }, "an existing nudge keeps its shape");
	assert.deepEqual(offsets?.kai, { offsetX: 15, offsetY: 2 }, "an untouched character joins the fan");
	assert.equal(moveCharOffsets(maps, CHAPTER, "n1", 0, 0), false, "a drag that moved nothing writes nothing");
	assert.equal(moveCharOffsets(maps, CHAPTER, "nope", 5, 5), false, "an unknown node is not a fan");
	assert.equal(
		moveCharOffsets(maps, CHAPTER, "n1", 0, 0),
		false,
		"the second no-op call does not invent an entry either",
	);

	// Resetting the last nudge drops the field, so data.json stays small.
	setCharOffset(maps, CHAPTER, "n1", "tom", null);
	setCharOffset(maps, CHAPTER, "n1", "kai", null);
	assert.equal(
		readMap(maps, CHAPTER, FALLBACK).nodes[0].charOffsets,
		undefined,
		"a ring with no nudges left carries no offsets at all",
	);

	const broken: ChapterMaps = {
		[CHAPTER]: {
			map_bg: null,
			nodes: [
				{
					id: "n1",
					x: 0,
					y: 0,
					chars: ["tom"],
					charOffsets: { tom: { offsetX: "left", offsetY: null } as never },
				},
			],
		},
	};
	assert.equal(
		readMap(broken, CHAPTER, FALLBACK).nodes[0].charOffsets?.tom.offsetX,
		"left" as never,
		"readMap hands the live object straight through: it is normalizeMaps, not the view, that sanitises",
	);
}

/* ======================================================================== *
 * NoteWriter: what it is allowed to touch, and when                         *
 * ======================================================================== */

{
	const chapter = "Кровь и Искра/Восстание Искры.md";
	const target = notePathFor(chapter);
	const app = new App();

	const plugin = makePlugin(chapter, [yana, kai, mother]);
	// The writer formats through the plugin's own dictionary, so the assertions
	// below read Russian because the plugin is set to Russian.
	plugin.settings.language = "ru";
	plugin.settings.maps[chapter] = {
		map_bg: null,
		nodes: [{ id: "n1", label: "Деревня Яна", x: 0, y: 0, chars: ["yan"] }],
	};
	const writer = new NoteWriter(withApp(plugin, app) as never);

	assert.equal(
		plugin.events.length,
		1,
		"the writer subscribes to the vault, otherwise a deferred write could never resume",
	);

	assert.equal(await writer.write(chapter), true, "the note is created on the first write");
	assert.deepEqual(app.adapterWrites, [target], "the write lands on the mirrored note, never on the chapter");
	assert.equal(app.adapterFiles[chapter], undefined, "the chapter note is not created or touched");
	assert.equal(app.adapterFiles[target].includes("[[Ян]]"), true, "the note lists the character as a wikilink");
	assert.deepEqual(
		Object.keys(app.adapterFolders),
		[".Writer Maps Data", ".Writer Maps Data/Кровь и Искра"],
		"the mirrored folders are created segment by segment, because the adapter has no recursive mkdir",
	);

	// Second write with the same data: nothing to do.
	assert.equal(await writer.write(chapter), false, "unchanged data is not rewritten");
	assert.equal(app.adapterWrites.length, 1, "and costs no second write");

	// Unticking a character rewrites the block, and the author's zone survives.
	app.adapterFiles[target] = `${app.adapterFiles[target]}\n\nМоя свободная зона.`;
	const map = plugin.settings.maps[chapter];
	map.nodes[0].chars = [];
	assert.equal(await writer.write(chapter), true, "a character change rewrites the note");
	assert.equal(app.adapterFiles[target].includes("Моя свободная зона."), true, "the author's own text is preserved");
	assert.equal(
		app.adapterFiles[target].includes("- **Деревня Яна**: *Локация пуста*"),
		true,
		"the emptied location says so",
	);
	assert.equal(
		app.adapterFiles[target].includes(RU.offStoryTitle) && app.adapterFiles[target].includes("- [[Ян]]"),
		true,
		"a removed character moves to the off-story pool, it is not lost",
	);
	assert.equal(
		app.adapterFiles[target].indexOf("- [[Ян]]") > app.adapterFiles[target].indexOf(RU.offStoryTitle),
		true,
		"the pool is listed under its own heading",
	);

	// Dragging a node, and dragging a character around its pin: the signature is
	// unchanged, so neither costs a disk write.
	const before = app.adapterWrites.length;
	map.nodes[0].x = 999;
	assert.equal(await writer.write(chapter), false, "a node drag writes nothing");
	map.nodes[0].charOffsets = { yan: { offsetX: 40, offsetY: 12 } };
	assert.equal(await writer.write(chapter), false, "dragging a character around the pin writes nothing");
	assert.equal(app.adapterWrites.length, before, "neither drag costs a write");

	// The signature cache can be dropped, since a reload or an import may have
	// changed the file behind our back.
	writer.invalidate();
	assert.equal(await writer.write(chapter), false, "after invalidation the unchanged file is still not rewritten");
}

{
	// A chapter whose markers were broken by hand must be left completely alone.
	const chapter = "Глава.md";
	const target = notePathFor(chapter);
	const app = new App();
	app.adapterFiles[target] = `${NOTE_START}\nбез конца`;

	const plugin = makePlugin(chapter, [yana]);
	plugin.settings.maps[chapter] = { map_bg: null, nodes: [{ id: "n1", label: "Яна", x: 0, y: 0, chars: ["yan"] }] };
	const writer = new NoteWriter(withApp(plugin, app) as never);

	assert.equal(await writer.write(chapter), false, "an unbalanced file is not written");
	assert.deepEqual(app.adapterWrites, [], "not a single byte was written");
	assert.equal(app.adapterFiles[target], `${NOTE_START}\nбез конца`, "and the broken file is exactly as it was");
}

{
	// The writer refuses any target that is not a mirrored note, whatever it is
	// handed. This is the guard that keeps the plugin out of the author's vault.
	const app = new App();
	const plugin = makePlugin("Глава.md", [yana]);
	plugin.settings.maps["Глава.md"] = { map_bg: null, nodes: [] };
	plugin.settings.maps[notePathFor("Глава.md")] = { map_bg: null, nodes: [] };
	const writer = new NoteWriter(withApp(plugin, app) as never);

	assert.equal(await writer.write("Нет такой главы.md"), false, "an unknown chapter is skipped");
	assert.equal(
		await writer.write(notePathFor("Глава.md")),
		false,
		"a note is never given a note of its own, or the folders would nest forever",
	);
	assert.equal(await writer.diskText("Глава.md"), null, "reading is gated too, not just writing");
	assert.deepEqual(app.adapterWrites, [], "nothing outside the managed roots is ever written");
}

{
	// Opening the note tab is the author's intent, so a chapter with no map yet
	// still gets a note — an empty one, with the free zone already in place.
	const chapter = "Новая Глава.md";
	const target = notePathFor(chapter);
	const app = new App();
	const plugin = makePlugin(chapter, [yana]);
	const writer = new NoteWriter(withApp(plugin, app) as never);

	assert.equal(await writer.ensure(chapter), true, "a chapter without a map still gets a note");
	assert.equal(app.adapterFiles[target].startsWith(NOTE_START), true, "the note opens with the generated block");
	assert.equal(
		app.adapterFiles[target].includes(t("en", "noteNoLocations")),
		true,
		"and admits there is no map yet",
	);
	assert.equal(await writer.ensure(chapter), false, "opening the tab twice does not rewrite it");
}

{
	// An unsaved editor must win over a scheduled write. The note is usually open
	// in the sidebar, and overwriting a buffer the author has not saved yet would
	// throw their text away.
	const chapter = "Глава.md";
	const target = notePathFor(chapter);
	const app = new App();
	const plugin = makePlugin(chapter, [yana]);
	plugin.settings.maps[chapter] = { map_bg: null, nodes: [{ id: "n1", label: "Яна", x: 0, y: 0, chars: ["yan"] }] };
	const writer = new NoteWriter(withApp(plugin, app) as never);

	await writer.write(chapter);
	const written = app.adapterFiles[target];
	app.adapterWrites.length = 0;

	// The author types and has not saved: the buffer no longer matches the disk.
	app.openEditorBuffers[target] = `${written}\n\nчерновик, который не сохранён`;
	plugin.settings.maps[chapter].nodes[0].chars = [];

	assert.equal(await writer.write(chapter), false, "a dirty editor defers the write");
	assert.deepEqual(app.adapterWrites, [], "nothing is written over an unsaved buffer");
	assert.deepEqual(writer.deferredChapters(), [chapter], "the chapter is remembered as waiting for a save");

	// Saving writes the buffer out and then fires vault.on("modify"), which is
	// what releases the deferred write.
	app.saveEditor(target);
	await settle();
	await settle();
	await settle();

	assert.deepEqual(app.adapterWrites, [target], "the deferred write lands once the buffer is saved");
	assert.equal(
		app.adapterFiles[target].includes("черновик, который не сохранён"),
		true,
		"the author's unsaved line is still there: the merge only owns its own block",
	);
	assert.deepEqual(writer.deferredChapters(), [], "the chapter is no longer waiting");
}

{
	// The writer's own write must not look like the author's save, or every
	// generated update would release a deferred write twice over and the two
	// would fight. The echo of our own write is recognised by its content.
	const chapter = "Глава.md";
	const target = notePathFor(chapter);
	const app = new App();
	// Both characters must exist in the roster: a token with no roster entry is
	// skipped by the block, so ticking "kai" alone would not change a byte.
	const plugin = makePlugin(chapter, [yana, kai]);
	plugin.settings.maps[chapter] = { map_bg: null, nodes: [{ id: "n1", label: "Яна", x: 0, y: 0, chars: ["yan"] }] };
	const writer = new NoteWriter(withApp(plugin, app) as never);
	assert.equal(await writer.write(chapter), true, "the first write goes through");
	assert.deepEqual(app.adapterWrites, [target], "exactly one write so far");

	// Our own write coming back as an event must not produce a second write.
	for (const listener of app.vaultListeners) listener({ path: target } as never);
	await settle();
	await settle();
	assert.equal(app.adapterWrites.length, 1, "the echo of our own write is not mistaken for a save");

	// And a real save of the author's text does release a deferred write.
	app.openEditorBuffers[target] = `${app.adapterFiles[target]}\n\nправка автора`;
	plugin.settings.maps[chapter].nodes[0].chars = ["yan", "kai"];
	assert.equal(await writer.write(chapter), false, "a second change is deferred while the buffer is dirty");
	app.adapterWrites.length = 0;

	app.saveEditor(target);
	await settle();
	await settle();
	await settle();
	assert.deepEqual(app.adapterWrites, [target], "a genuine save releases the deferred write exactly once");
	assert.equal(
		app.adapterFiles[target].includes("правка автора"),
		true,
		"and the author's line survives it",
	);
	assert.deepEqual(writer.deferredChapters(), [], "nothing is left waiting");
}

{
	// The bug, exactly as it was reported: the file on disk was correct and the
	// editor showed nothing.
	//
	// A leaf that was opened before the note existed holds "". An empty buffer is
	// not a deferral-worthy edit - it is a buffer nobody has touched - but "does it
	// match disk" said no, so the write was parked. A parked write is only released
	// by a save, and an empty buffer the author never typed in never produces one.
	// The digest was therefore written once and never again, and the writer stared
	// at an empty pane while the file underneath them was fine.
	const chapter = "Глава.md";
	const target = notePathFor(chapter);
	const app = new App();
	const plugin = makePlugin(chapter, [yana]);
	plugin.settings.maps[chapter] = { map_bg: null, nodes: [{ id: "n1", label: "Яна", x: 0, y: 0, chars: ["yan"] }] };

	// The editor is open on the path before there is a file to open. This is the
	// whole situation: a stale buffer, not an unsaved edit.
	app.openEditorBuffers[target] = "";

	const writer = new NoteWriter(withApp(plugin, app) as never);
	assert.equal(await writer.write(chapter), true, "an untouched empty buffer does not defer the first write");
	assert.equal(app.adapterWrites.length, 1, "and the file is written");
	assert.equal(
		app.adapterFiles[target].includes("[[Ян]]"),
		true,
		"so the digest is on disk rather than waiting for a save that will never come",
	);
	assert.deepEqual(writer.deferredChapters(), [], "and nothing is left waiting");

	// The same trap one step along, and this is the case the memory of our own
	// writes exists for: the editor is holding text *we* put there, and the file
	// on disk is no longer that text - a sync, a revert, another machine. The
	// buffer differs from disk, so "does it differ" says defer, and it would wait
	// for a save that has nothing to save. Ours is not the author's to protect.
	const ours = app.adapterFiles[target];
	app.openEditorBuffers[target] = ours;
	// The file moves underneath: a revert, a sync, another machine. Now the buffer
	// and the disk genuinely differ, and neither is empty.
	app.adapterFiles[target] = ours.replace(/- \*\*Яна\*\*/, "- **Старое имя**");
	assert.notEqual(
		app.adapterFiles[target],
		app.openEditorBuffers[target],
		"the pretense is real: disk and buffer hold different text",
	);

	plugin.settings.maps[chapter].nodes[0].label = "Порт Яна";
	assert.equal(
		await writer.write(chapter, true),
		true,
		"a buffer holding our own text does not defer, even when the file moved under it",
	);
	assert.equal(
		app.adapterFiles[target].includes("Порт Яна"),
		true,
		"the rename reached the disk behind the stale pane",
	);
	assert.deepEqual(writer.deferredChapters(), [], "with nothing left waiting");

	// The one case that must still wait: the author is typing. Their text is not
	// on disk and is not anything we wrote, so it is theirs and the write waits.
	const mine = app.adapterFiles[target];
	app.openEditorBuffers[target] = `${mine}\n\nсвоими словами`;
	plugin.settings.maps[chapter].nodes[0].label = "Город Яна";
	assert.equal(await writer.write(chapter, true), false, "a real unsaved edit is still deferred");
	assert.deepEqual(writer.deferredChapters(), [chapter], "and the chapter is remembered as waiting");
	assert.equal(
		app.adapterFiles[target].includes("Город Яна"),
		false,
		"with nothing written over the author's words",
	);
}

{
	// A stale buffer is not always something we wrote. Obsidian hands out a
	// markdown file it found already in the vault, and if the writer has not typed
	// in it, it is a buffer with no unsaved changes in it - `null` is the honest
	// answer there, and the write goes straight through.
	const chapter = "Глава.md";
	const target = notePathFor(chapter);
	const app = new App();
	const plugin = makePlugin(chapter, [yana]);
	plugin.settings.maps[chapter] = { map_bg: null, nodes: [{ id: "n1", label: "Яна", x: 0, y: 0, chars: ["yan"] }] };
	app.openEditorBuffers[target] = undefined as never;

	const writer = new NoteWriter(withApp(plugin, app) as never);
	assert.equal(await writer.write(chapter), true, "a leaf that reports no buffer never defers");
	assert.deepEqual(writer.deferredChapters(), [], "nothing to wait for");
}

{
	// Export: everything under the hidden folder, mirrored into the visible one.
	const app = new App();
	const plugin = makePlugin(null, [yana]);
	plugin.settings.maps["Книга/Глава 1.md"] = { map_bg: null, nodes: [] };
	plugin.settings.maps["Книга/Часть 2/Глава 2.md"] = { map_bg: null, nodes: [] };
	const writer = new NoteWriter(withApp(plugin, app) as never);

	await writer.write("Книга/Глава 1.md");
	await writer.write("Книга/Часть 2/Глава 2.md");
	app.adapterWrites.length = 0;

	const preview = await writer.previewExport();
	assert.deepEqual(
		[...preview.files].sort(),
		[".Writer Maps Data/Книга/Глава 1.md", ".Writer Maps Data/Книга/Часть 2/Глава 2.md"],
		"the preview sees every note, nested folders included",
	);
	assert.equal(preview.hasContent, false, "an empty export folder needs no confirmation");

	assert.equal(await writer.exportAll(), 2, "both notes are copied out");
	assert.equal(
		app.adapterFiles["Writer Maps Export/Книга/Глава 1.md"],
		app.adapterFiles[".Writer Maps Data/Книга/Глава 1.md"],
		"the exported note is a byte-for-byte copy",
	);
	assert.equal(
		app.adapterFiles["Writer Maps Export/Книга/Часть 2/Глава 2.md"] !== undefined,
		true,
		"the nested folder structure is mirrored, not flattened",
	);
	assert.ok(
		"Writer Maps Export/Книга/Часть 2" in app.adapterFolders,
		"and the missing export folders are created on the way",
	);
	assert.equal(
		app.adapterWrites.every((path) => path.startsWith(`${EXPORT_ROOT}/`)),
		true,
		"an export only ever writes inside the export folder",
	);

	const second = await writer.previewExport();
	assert.equal(second.hasContent, true, "a second export asks before overwriting");
}

/* ======================================================================== *
 * Binding a character note: the reported bug, end to end                    *
 * ======================================================================== */

interface NoteEditorInternals extends RosterViewInternals {
	repaintEditor(): void;
}

/** Find a button in the editor by its visible label. */
function buttonByText(editor: FakeElement, label: string): FakeElement | null {
	return editor.find(
		(el) => el.tag === "button" && el.text === label,
	) as FakeElement | null;
}

{
	// The reported steps: edit Kai, bind "Персонажи/Кай.md", and expect the
	// label above the button to change right away. The whole picker path runs
	// for real here, only the workspace is a stub.
	const plugin = makePlugin(null);
	const view = new RosterView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as NoteEditorInternals;

	const kai = { id: "kai", name: "Кай", initials: "К", color: "#e08a3c" };
	plugin.settings.pawns = [kai];
	internals.openEditor("edit", kai);

	const editor = internals.root.find((el) => el.classes.has("wsm-editor")) as FakeElement;
	const label = editor.find((el) => el.classes.has("wsm-editor__note")) as FakeElement;
	const bind = buttonByText(editor, t("en", "rosterNoteBind"));
	const unbind = buttonByText(editor, t("en", "rosterNoteClear"));

	assert.ok(bind && unbind && label, "the editor offers a note row");
	assert.equal(label.text, t("en", "rosterNoNote"), "an unbound character shows the placeholder");
	assert.equal(unbind?.disabled, true, "unbind starts disabled");

	openedSuggestModals.length = 0;
	bind?.fire("click");
	const modal = openedSuggestModals.at(-1);
	assert.ok(modal, "the note picker opened");
	modal?.onChooseItem(new TFile("Персонажи/Кай.md"), null);
	await settle();

	assert.equal(
		label.text,
		"Персонажи/Кай.md",
		"picking a file updates the label in the same tick",
	);
	assert.equal(unbind?.disabled, false, "unbind becomes available at once");
	assert.equal(internals.editor?.draft.notePath, "Персонажи/Кай.md", "the draft carries the binding");

	// And it survives a save.
	internals.save();
	assert.equal(plugin.settings.pawns[0].notePath, "Персонажи/Кай.md", "the binding is persisted");
}

{
	// The same flow, but the editor DOM is rebuilt while the picker is open.
	// This is the shape of the bug that was reported: the state was saved while
	// the sidebar still claimed nothing was bound.
	const plugin = makePlugin(null);
	const view = new RosterView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as NoteEditorInternals;

	const liran = { id: "liran", name: "Лиран", initials: "Л", color: "#3cb8a0" };
	plugin.settings.pawns = [liran];
	internals.openEditor("edit", liran);

	const editor = internals.root.find((el) => el.classes.has("wsm-editor")) as FakeElement;
	const bind = buttonByText(editor, t("en", "rosterNoteBind"));

	openedSuggestModals.length = 0;
	bind?.fire("click");
	// The workspace tears the row out from under the view (a layout re-render),
	// while the editor state survives. The widgets the view remembers are now
	// detached, which is exactly the state in which the binding used to be saved
	// to data.json while the sidebar still showed "not bound".
	editor.remove();
	const modal = openedSuggestModals.at(-1);
	modal?.onChooseItem(new TFile("Персонажи/Лиран.md"), null);
	await settle();

	const rebuilt = internals.root.find((el) => el.classes.has("wsm-editor")) as FakeElement | null;
	assert.ok(rebuilt, "an editor whose DOM was torn down is rebuilt on the next paint");
	const label = rebuilt.find((el) => el.classes.has("wsm-editor__note")) as FakeElement;
	const unbind = buttonByText(rebuilt, t("en", "rosterNoteClear"));

	assert.equal(
		label?.text,
		"Персонажи/Лиран.md",
		"a row torn down mid-pick still shows the bound file",
	);
	assert.equal(unbind?.disabled, false, "and its unbind button is live");
}

{
	// Ordering insurance: if the workspace reports the close before the choice,
	// the file still wins.
	const plugin = makePlugin(null);
	const view = new RosterView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as NoteEditorInternals;

	const kai = { id: "kai", name: "Кай", initials: "К", color: "#e08a3c" };
	plugin.settings.pawns = [kai];
	internals.openEditor("edit", kai);

	const editor = internals.root.find((el) => el.classes.has("wsm-editor")) as FakeElement;
	const bind = buttonByText(editor, t("en", "rosterNoteBind"));

	openedSuggestModals.length = 0;
	bind?.fire("click");
	const modal = openedSuggestModals.at(-1) as unknown as {
		onClose(): void;
		onChooseItem(file: TFile, evt: unknown): void;
	};
	modal?.onClose();
	modal?.onChooseItem(new TFile("Персонажи/Кай.md"), null);
	await settle();

	assert.equal(
		internals.editor?.draft.notePath,
		"Персонажи/Кай.md",
		"a same-tick choice beats an earlier close",
	);
}

{
	// A view that reopens must not keep an editor whose DOM is gone.
	const plugin = makePlugin(null);
	const view = new RosterView(new WorkspaceLeaf(new App()), plugin as never);
	await view.onOpen();
	const internals = view as unknown as RosterViewInternals;

	internals.openEditor("create");
	assert.ok(internals.editor, "the editor is open");
	await view.onOpen();
	assert.equal(internals.editor, null, "reopening the view drops the orphaned editor state");
	assert.equal(
		internals.root.find((el) => el.classes.has("wsm-editor")),
		null,
		"and no leftover editor is left in the DOM",
	);
}

{
	// A genuine cancel must still resolve — the deferral above is insurance, not
	// a way to leave the promise hanging forever.
	const app = new App();
	const pending = pickNote(app, "en");
	openedSuggestModals.at(-1)?.onClose();
	assert.equal(await pending, null, "cancelling the note picker resolves null");
}

{
	// Same for the list picker, which renames a map.
	const pending = pickFromList(new App(), "en", ["Старая глава"], "mapRenamePlaceholder");
	openedSuggestModals.at(-1)?.onClose();
	assert.equal(await pending, null, "cancelling the list picker resolves null");
}

/* ------------------------------------------------------------------ *
 * the relationship overlay                                              *
 * ------------------------------------------------------------------ */

interface RelInternals {
	root: FakeElement;
	pick(token: string): void;
}

/**
 * Mount a panel the way the map does: a plain element to build into.
 *
 * It is not a view any more, so there is no leaf, no `onOpen` and no lifecycle
 * to drive — the constructor paints, which is the whole point of the refactor.
 */
function mountRel(plugin: unknown): { panel: RelationshipPanel; host: FakeElement } {
	const host = new FakeElement() as unknown as HTMLElement;
	const panel = new RelationshipPanel(host, plugin as never);
	return { panel, host: host as unknown as FakeElement };
}

function relGraph(panel: RelationshipPanel): FakeElement {
	const root = (panel as unknown as RelInternals).root as unknown as FakeElement;
	const graph = root.find((el) => el.classes.has("wsm-rel__graph"));
	assert.ok(graph, "the panel has a graph area");
	return graph as FakeElement;
}

/**
 * True when the element's `class` attribute contains a name.
 *
 * SVG children are classed with `setAttribute("class", …)`, which is what the
 * real DOM wants, and it lands in the attribute store rather than in the class
 * set the Obsidian helpers maintain. Reading the attribute is what the browser
 * does when it matches a selector, so this is the honest check.
 */
function hasAttrClass(el: FakeElement, name: string): boolean {
	return (el.getAttribute("class") ?? "").split(/\s+/).includes(name);
}

function relNodes(panel: RelationshipPanel): FakeElement[] {
	return relGraph(panel).findAll((el) => hasAttrClass(el, "wsm-rel__node"));
}

function relLines(panel: RelationshipPanel): FakeElement[] {
	return relGraph(panel).findAll((el) => hasAttrClass(el, "wsm-rel__line"));
}

{
	// A chapter with nobody on the map has nothing to draw, and says so instead
	// of showing an empty circle the writer has to interpret.
	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	// The panel paints itself on construction, so there is no onOpen to await.
	const { panel: view } = mountRel(plugin);

	assert.equal(relNodes(view).length, 0, "no character on the map means no vertex");
	assert.ok(
		labelOf((view as unknown as RelInternals).root).includes("Nobody stands"),
		"and the tab says why",
	);
}

{
	// Two clicks and a choice of kind. This is the whole gesture the feature is,
	// so each step is checked on its own.
	const aya: Pawn = { id: "aya", name: "Aya", initials: "Ay", color: "#3cb8a0" };
	const plugin = makePlugin(CHAPTER_MAP, [pawn, aya]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [
				{ id: "pier", x: 10, y: 20, chars: ["tom"] },
				{ id: "inn", x: 30, y: 40, chars: ["aya"] },
			],
		};
	});

	// The panel paints itself on construction, so there is no onOpen to await.
	const { panel: view } = mountRel(plugin);
	const internals = view as unknown as RelInternals;

	assert.equal(relNodes(view).length, 2, "both characters standing on the map get a vertex");
	assert.equal(relLines(view).length, 0, "and no line between them yet");

	// First click: remember who starts the tie, and say so.
	internals.pick("tom");
	assert.equal(
		relNodes(view).filter((el) => hasAttrClass(el, "is-picked")).length,
		1,
		"the first pick is shown as picked",
	);
	assert.ok(
		labelOf((view as unknown as RelInternals).root).includes("Now click"),
		"and the tab asks for the other end",
	);

	// Second click: the kind is asked for, not guessed.
	internals.pick("aya");
	const kinds = relGraph(view).findAll((el) => el.classes.has("wsm-rel__kind"));
	assert.deepEqual(
		kinds.map((el) => labelOf(el)),
		["Blood", "Debt", "Secret"],
		"all three kinds are offered for the pair",
	);
	assert.equal(
		plugin.settings.maps[CHAPTER_MAP].links,
		undefined,
		"and nothing is written until the writer says which kind",
	);

	// Choosing one writes it and draws it.
	const blood = kinds[0];
	blood.fire("click");
	assert.deepEqual(
		plugin.settings.maps[CHAPTER_MAP].links,
		// Stored in a fixed order, not the order they were clicked: a tie is
		// between a pair, and which of the two came first is not a fact about it.
		[{ a: "aya", b: "tom", kind: "blood" }],
		"the chosen kind is stored, with the ends in a fixed order",
	);
	assert.equal(relLines(view).length, 1, "and the tie is drawn");
	assert.ok(hasAttrClass(relLines(view)[0], "is-blood"), "in the colour and dash of its kind");
	assert.equal(
		relLines(view)[0].getAttribute("vector-effect"),
		"non-scaling-stroke",
		"and pinned to the screen, so a narrow sidebar does not fatten the thread",
	);
	assert.ok(
		labelOf((view as unknown as RelInternals).root).includes("Tom"),
		"the list underneath spells the pair out in names",
	);
}

{
	// One pair, one tie. Picking the same character twice must not tie it to
	// itself, and choosing a different kind for a pair that already has one
	// replaces it rather than adding a second line between the same two points.
	const aya: Pawn = { id: "aya", name: "Aya", initials: "Ay", color: "#3cb8a0" };
	const plugin = makePlugin(CHAPTER_MAP, [pawn, aya]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [
				{ id: "pier", x: 10, y: 20, chars: ["tom"] },
				{ id: "inn", x: 30, y: 40, chars: ["aya"] },
			],
			links: [{ a: "tom", b: "aya", kind: "blood" }],
		};
	});

	// The panel paints itself on construction, so there is no onOpen to await.
	const { panel: view } = mountRel(plugin);
	const internals = view as unknown as RelInternals;

	// Same character twice: the pick is dropped, not a tie to itself.
	internals.pick("tom");
	internals.pick("tom");
	assert.equal(
		relGraph(view).findAll((el) => el.classes.has("wsm-rel__kind")).length,
		0,
		"clicking the same character twice cancels instead of asking for a kind",
	);
	assert.deepEqual(
		plugin.settings.maps[CHAPTER_MAP].links,
		[{ a: "tom", b: "aya", kind: "blood" }],
		"and changes nothing",
	);

	// The same pair, a different kind: one line, not two.
	internals.pick("aya");
	internals.pick("tom");
	const debt = relGraph(view).findAll((el) => el.classes.has("wsm-rel__kind"))[1];
	debt.fire("click");
	assert.deepEqual(
		plugin.settings.maps[CHAPTER_MAP].links,
		[{ a: "tom", b: "aya", kind: "debt" }],
		"the same pair keeps a single tie, and only its kind is replaced",
	);
	assert.equal(relLines(view).length, 1, "so the graph still has one line between them");
	assert.ok(hasAttrClass(relLines(view)[0], "is-debt"), "now in the new kind's style");
}

{
	// A tie involving someone who is not on this chapter's map cannot be drawn.
	// It is still listed, because hiding it would make the tab look emptier than
	// the writer's data actually is.
	const aya: Pawn = { id: "aya", name: "Aya", initials: "Ay", color: "#3cb8a0" };
	const plugin = makePlugin(CHAPTER_MAP, [pawn, aya]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [{ id: "pier", x: 10, y: 20, chars: ["tom"] }],
			links: [
				{ a: "tom", b: "aya", kind: "debt" },
				{ a: "aya", b: "ghost", kind: "secret" },
			],
		};
	});

	// The panel paints itself on construction, so there is no onOpen to await.
	const { panel: view } = mountRel(plugin);

	assert.equal(relNodes(view).length, 1, "only the character on the map gets a vertex");
	assert.equal(relLines(view).length, 0, "and no line is drawn to or from thin air");
	const list = (view as unknown as RelInternals).root.find((el) => el.classes.has("wsm-rel__list")) as FakeElement;
	assert.equal(
		list.findAll((el) => el.classes.has("wsm-rel__row")).length,
		2,
		"both ties are listed anyway",
	);
	assert.ok(labelOf(list).includes("not on this map"), "and the one that is not drawn says so");
}

{
	// A character placed on two locations is one person, and gets one vertex.
	// Drawing them twice would make a tie look like it belonged to one of the
	// two places in particular.
	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [
				{ id: "pier", x: 10, y: 20, chars: ["tom"] },
				{ id: "inn", x: 30, y: 40, chars: ["tom"] },
			],
		};
	});
	// The panel paints itself on construction, so there is no onOpen to await.
	const { panel: view } = mountRel(plugin);
	assert.equal(relNodes(view).length, 1, "the same character on two locations is one vertex");
}

{
	// Removing a tie has to reach the data, not just the picture.
	const aya: Pawn = { id: "aya", name: "Aya", initials: "Ay", color: "#3cb8a0" };
	const plugin = makePlugin(CHAPTER_MAP, [pawn, aya]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [
				{ id: "pier", x: 10, y: 20, chars: ["tom"] },
				{ id: "inn", x: 30, y: 40, chars: ["aya"] },
			],
			links: [{ a: "tom", b: "aya", kind: "secret" }],
		};
	});
	// The panel paints itself on construction, so there is no onOpen to await.
	const { panel: view } = mountRel(plugin);

	const remove = (view as unknown as RelInternals).root.find((el) => el.classes.has("wsm-rel__remove")) as FakeElement;
	assert.ok(remove, "each listed tie offers a way to take it back");
	remove.fire("click");
	assert.equal(
		plugin.settings.maps[CHAPTER_MAP].links,
		undefined,
		"the tie is gone from the data, and an empty list is not left behind",
	);
	assert.equal(relLines(view).length, 0, "and from the graph");
}

{
	// The tab follows the chapter. A tie recorded against another chapter must
	// not be drawn here.
	const aya: Pawn = { id: "aya", name: "Aya", initials: "Ay", color: "#3cb8a0" };
	const plugin = makePlugin(CHAPTER_MAP, [pawn, aya]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [
				{ id: "pier", x: 10, y: 20, chars: ["tom"] },
				{ id: "inn", x: 30, y: 40, chars: ["aya"] },
			],
			links: [{ a: "tom", b: "aya", kind: "blood" }],
		};
	});
	plugin.updateMap("Chapters/Chapter 2.md", (maps, p) => {
		maps[p] = { map_bg: null, nodes: [{ id: "gate", x: 5, y: 5, chars: ["tom"] }] };
	});

	// The panel paints itself on construction, so there is no onOpen to await.
	const { panel: view } = mountRel(plugin);
	assert.equal(relLines(view).length, 1, "chapter 1 draws its own tie");

	plugin.activeChapterPath = "Chapters/Chapter 2.md";
	(view as unknown as RelInternals).pick("tom");
	view.onExternalChange();
	assert.equal(relLines(view).length, 0, "chapter 2 draws none of it");
	assert.equal(relNodes(view).length, 1, "and shows only its own character");
}

{
	// A half-finished pick must not survive the chapter changing underneath it.
	// The second click would otherwise land on a tie nobody was looking at.
	const aya: Pawn = { id: "aya", name: "Aya", initials: "Ay", color: "#3cb8a0" };
	const plugin = makePlugin(CHAPTER_MAP, [pawn, aya]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [
				{ id: "pier", x: 10, y: 20, chars: ["tom"] },
				{ id: "inn", x: 30, y: 40, chars: ["aya"] },
			],
		};
	});
	plugin.updateMap("Chapters/Chapter 2.md", (maps, p) => {
		maps[p] = { map_bg: null, nodes: [{ id: "gate", x: 5, y: 5, chars: ["tom"] }] };
	});

	// The panel paints itself on construction, so there is no onOpen to await.
	const { panel: view } = mountRel(plugin);
	(view as unknown as RelInternals).pick("aya");

	plugin.activeChapterPath = "Chapters/Chapter 2.md";
	view.onExternalChange();
	(view as unknown as RelInternals).pick("tom");
	assert.equal(
		relGraph(view).findAll((el) => el.classes.has("wsm-rel__kind")).length,
		0,
		"the pick from the previous chapter is forgotten, not completed",
	);
}

/* ------------------------------------------------------------------ *
 * the command centre                                                    *
 * ------------------------------------------------------------------ */

{
	// Four tabs became two, and the four things a tab used to do became four
	// buttons in one row on the map. Each button is checked against the call it
	// is supposed to make, because a button wired to the wrong call is the kind
	// of thing that works right until it does not.
	const app = new App();
	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [{ id: "n1", label: "Яна", x: 10, y: 10, chars: ["tom"] }],
		};
	});
	setCanvasSize(plugin.settings.maps, CHAPTER_MAP, [320, 320]);

	const view = new MapView(new WorkspaceLeaf(app), plugin as never);
	await view.onOpen();
	const internals = view as unknown as {
		root: FakeElement;
		toolsEl: FakeElement;
		forgetButton: FakeElement;
		nodeIds: string[];
		stageEl: FakeElement;
		zonesEl: FakeElement;
	};

	const tool = (title: string): FakeElement => {
		const button = internals.toolsEl.children.find(
			(child) => child.tag === "button" && child.title === title,
		);
		assert.ok(button, `the toolbar has a "${title}" button`);
		return button;
	};

	// The note is a file in the main area, so the button opens it rather than
	// asking for a tab that no longer exists.
	const note = tool("WSM: Chapter Note");
	assert.equal(note.title, "WSM: Chapter Note", "the note button is titled with its action");
	note.fire("click");
	assert.equal(plugin.openNoteCalls, 1, "the note button opens the chapter note");

	// The roster is the one other tab, so this one still goes through openTab -
	// and with the name of the tab, not a bare call.
	const roster = tool("Characters");
	roster.fire("click");
	assert.deepEqual(plugin.openTabCalls, ["roster"], "the roster button opens the roster tab");

	// The graph is an overlay on this view, so its button asks this view and
	// nothing global: no tab, no second view to keep in step.
	const rel = tool("Relationships");
	assert.equal(internals.root.find((el) => el.classes.has("wsm-overlay")), null, "no overlay before the click");
	rel.fire("click");
	assert.ok(
		internals.root.find((el) => el.classes.has("wsm-overlay")),
		"the relationships button opens the overlay over the map",
	);
	rel.fire("click");
	assert.equal(
		internals.root.find((el) => el.classes.has("wsm-overlay")),
		null,
		"and pressing it again closes it, the way every other toggle behaves",
	);

	// The destructive one is last in the row, and disabled when there is nothing
	// to destroy: a button that confirms the deletion of nothing is worse than a
	// greyed-out one.
	assert.equal(internals.forgetButton.disabled, false, "forget is live while the chapter has a map");
	const tools = internals.toolsEl.children.filter((child) => child.tag === "button");
	assert.equal(tools[tools.length - 1], internals.forgetButton, "and it is the last button in the row");

	const noMap = makePlugin("Chapters/Chapter 2.md", [pawn]);
	const emptyView = new MapView(new WorkspaceLeaf(new App()), noMap as never);
	await emptyView.onOpen();
	assert.equal(
		(emptyView as unknown as { forgetButton: FakeElement }).forgetButton.disabled,
		true,
		"a chapter with no map of its own has nothing to forget",
	);
}

{
	// The overlay closes the way any dialog does, and closing it gives the pending
	// pick back rather than stranding it on a panel that is about to be thrown away.
	const app = new App();
	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [
				{ id: "pier", x: 10, y: 10, chars: ["tom"] },
				{ id: "inn", x: 20, y: 20, chars: ["tom"] },
			],
		};
	});
	setCanvasSize(plugin.settings.maps, CHAPTER_MAP, [320, 320]);

	const view = new MapView(new WorkspaceLeaf(app), plugin as never);
	await view.onOpen();
	const internals = view as unknown as {
		root: FakeElement;
		relOverlay: FakeElement | null;
		relPanel: RelationshipPanel | null;
	};

	internals.root.find((el) => el.classes.has("wsm-map__tools"))!
		.children.find((child) => child.tag === "button" && child.title === "Relationships")!
		.fire("click");
	assert.ok(internals.relOverlay, "the overlay is open");
	assert.ok(internals.relPanel, "with a live panel inside it");

	// Escape is the view's own handler, wired once for the whole view, and it is
	// on the document rather than the pane: a key press in an editor has to reach
	// it too. It goes to the topmost thing, so the writer's hands never have to
	// find a close button.
	pressKey("Escape");
	assert.equal(internals.relOverlay, null, "Escape closes the overlay");
	assert.equal(internals.relPanel, null, "and drops the panel with it");

	// The scrim, not the card. Clicking the card is reading.
	internals.root.find((el) => el.classes.has("wsm-map__tools"))!
		.children.find((child) => child.tag === "button" && child.title === "Relationships")!
		.fire("click");
	const overlay = internals.relOverlay!;
	overlay.fire("click", { target: overlay });
	assert.equal(internals.relOverlay, null, "clicking the scrim closes the overlay");

	// Reopening rebuilds the panel from scratch, so a half-finished pair from the
	// last session is not waiting for a second click that never meant to pair with it.
	internals.root.find((el) => el.classes.has("wsm-map__tools"))!
		.children.find((child) => child.tag === "button" && child.title === "Relationships")!
		.fire("click");
	(internals.relPanel as unknown as RelInternals).pick("tom");
	assert.equal(
		(internals.relPanel as unknown as RelInternals).root
			.find((el) => el.classes.has("wsm-rel__kinds")),
		null,
		"one pick alone is not a pair",
	);
	pressKey("Escape");
	internals.root.find((el) => el.classes.has("wsm-map__tools"))!
		.children.find((child) => child.tag === "button" && child.title === "Relationships")!
		.fire("click");
	assert.equal(
		(internals.relPanel as unknown as RelInternals).root
			.find((el) => el.classes.has("wsm-rel__kinds")),
		null,
		"and the pick did not survive the reopen",
	);
}

{
	// An armed tool owns the click, everywhere it can land.
	//
	// The stage handler has always checked the tool first, and it still does — but
	// a click inside a zone arrives at the polygon first, and that used to drill in
	// and stop the event before the stage ever saw it. The same was true of a zone's
	// label and of the "+K" key. So the guard in one place is not enough: every
	// element that sits over the stage has to let the tool through as well.
	const app = new App();
	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [
				{
					id: "west",
					label: "Запад",
					kind: "zone",
					zone: [
						{ x: 0, y: 0 },
						{ x: 160, y: 0 },
						{ x: 160, y: 160 },
						{ x: 0, y: 160 },
					],
					x: 0,
					y: 0,
					chars: [],
				},
				{ id: "inn", label: "Харчевня", x: 50, y: 50, chars: ["tom"], parentId: "west" },
			],
		};
	});
	setCanvasSize(plugin.settings.maps, CHAPTER_MAP, [320, 320]);

	const view = new MapView(new WorkspaceLeaf(app), plugin as never);
	await view.onOpen();
	const internals = view as unknown as {
		root: FakeElement;
		nodesEl: FakeElement;
		zonesEl: FakeElement;
		stageEl: FakeElement;
		nodeIds: string[];
		tool: string;
	};

	const zoneTool = (internals.root as FakeElement)
		.find((el) => el.dataset.tool === "zone") as FakeElement;
	zoneTool.fire("click");
	assert.equal(internals.tool, "zone", "the zone tool is armed");

	// On the polygon itself, which is where a writer drawing a zone spends the
	// whole time.
	const polygon = internals.zonesEl.children[0];
	polygon.fire("click", { clientX: 80, clientY: 80 });
	assert.deepEqual(
		internals.nodeIds,
		[],
		"a click inside an existing zone draws a corner instead of going in",
	);

	// On the zone's label, which is the smallest target on the map and the easiest
	// to hit by accident.
	const label = internals.nodesEl.find((el) => el.dataset.nodeId === "west") as FakeElement;
	assert.ok(label, "the zone label carries its id, which is how a right-click finds it");
	label.fire("click", { clientX: 0, clientY: 0 });
	assert.deepEqual(internals.nodeIds, [], "and a click on the label does not go in either");

	// On the keyboard affordance for a new location, which is the same gesture by
	// another route and had the same problem.
	const plusK = internals.nodesEl.find((el) => el.dataset.addChar !== undefined);
	if (plusK) {
		plusK.fire("click");
		assert.deepEqual(internals.nodeIds, [], "and neither does the +K button");
	}

	// With the tool put away, the very same click means "go in" again. Without this
	// half the test would pass for a view that simply ignored clicks.
	internals.tool = "none";
	label.fire("click", { clientX: 0, clientY: 0 });
	polygon.fire("click", { clientX: 80, clientY: 80 });
	assert.deepEqual(
		internals.nodeIds,
		["west"],
		"once the tool is away a click on the zone goes in, as it always did",
	);
}

{
	// A right-click on a zone opens its card. The label has to be findable for
	// that to work, and the card opens for the zone the writer pointed at rather
	// than for whatever happens to be first.
	const app = new App();
	const plugin = makePlugin(CHAPTER_MAP, [pawn]);
	plugin.updateMap(CHAPTER_MAP, (maps, p) => {
		maps[p] = {
			map_bg: null,
			nodes: [
				{
					id: "west",
					label: "Запад",
					kind: "zone",
					zone: [
						{ x: 0, y: 0 },
						{ x: 160, y: 0 },
						{ x: 160, y: 160 },
					],
					x: 0,
					y: 0,
					chars: [],
				},
				{
					id: "east",
					label: "Восток",
					kind: "zone",
					zone: [
						{ x: 200, y: 0 },
						{ x: 300, y: 0 },
						{ x: 300, y: 160 },
					],
					x: 200,
					y: 0,
					chars: [],
				},
			],
		};
	});
	setCanvasSize(plugin.settings.maps, CHAPTER_MAP, [320, 320]);

	const view = new MapView(new WorkspaceLeaf(app), plugin as never);
	await view.onOpen();
	const internals = view as unknown as { root: FakeElement; nodesEl: FakeElement; popoverEl: FakeElement | null };

	const labelFor = (id: string): FakeElement => {
		const el = internals.nodesEl.find((node) => node.dataset.nodeId === id) as FakeElement;
		assert.ok(el, `the ${id} zone has a label`);
		return el;
	};

	labelFor("east").fire("contextmenu");
	assert.equal(
		internals.popoverEl?.dataset.nodeId,
		"east",
		"a right-click on a label opens that zone's card, not the first one",
	);

	labelFor("west").fire("contextmenu");
	assert.equal(
		internals.popoverEl?.dataset.nodeId,
		"west",
		"and the other one opens the other one",
	);
}

console.log("all smoke tests passed");