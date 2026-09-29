import type {
	Canvas,
	CharOffset,
	ChapterLink,
	ChapterMaps,
	LinkKind,
	MapNode,
	MapViewModel,
	Pawn,
	PawnTextColor,
	StoredChapterMap,
	ZonePoint,
} from "./types";
import { initialsFromName, PLACEHOLDER_INITIALS } from "./pawns";
import { isZone } from "./hierarchy";
import { isManagedPath } from "./notes";

/**
 * The map store: the single source of truth for chapter maps.
 *
 * Hard architectural rule — this module must NEVER import from "obsidian".
 * Every function is pure and synchronous, operating on the plain `maps` object
 * that lives in data.json. That makes it impossible for the map data layer to
 * touch a file, and trivially unit-testable outside Obsidian.
 *
 * Chapters are bound lazily: `ensureMap` creates an entry on first write, so no
 * caller ever has to special-case "this note has no map yet".
 */

/* -------------------------------------------------------------------------- */
/* Safe coercion: data.json is user input (hand-edited, imported), never trust it */
/* -------------------------------------------------------------------------- */

type Record_ = Record<string, unknown>;

function asRecord(value: unknown): Record_ | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record_) : null;
}

function asString(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

function asNumber(value: unknown): number | null {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(asString).filter((item): item is string => item !== null && item.length > 0);
}

/**
 * A colour, or nothing.
 *
 * Unlike a label, a colour is not a string the plugin reads — it is handed
 * straight to a `fill` attribute. So it is checked rather than coerced: the
 * handful of CSS shapes that are actually useful, and nothing else. A hand-edited
 * "#4f8" works, a stray 42 becomes no colour at all rather than a broken one, and
 * a long run of arbitrary text never reaches the DOM.
 */
function asColor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const color = value.trim();
	if (!color) return null;
	if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return color;
	if (/^(?:rgb|rgba|hsl|hsla)\([0-9a-z%.,\s/-]+\)$/i.test(color)) return color;
	// A named colour, in English only: `currentColor` and friends, never a
	// document-scoped keyword that would resolve against someone else's page.
	if (/^[a-z]+$/i.test(color)) return color;
	return null;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Only markdown notes can host a map.
 *
 * The plugin's own folders are excluded: a note in ".Writer Maps Data/" is the
 * digest of a chapter, and a copy in "Writer Maps Export/" is a copy. Treating
 * either as a chapter would give the digest a map, whose digest would then have
 * a map of its own, forever.
 */
export function isChapterFile(path: string | null | undefined): boolean {
	if (typeof path !== "string") return false;
	if (!path.toLowerCase().endsWith(".md")) return false;
	return !isManagedPath(path);
}

/**
 * Accept every reasonable way of writing a background path, because data.json
 * is edited by hand:
 *   "maps/world.png"   "maps/world.png" (quoted)   [[world.png]]   ![[world.png|600]]
 */
export function normalizeBackgroundPath(raw: string): string {
	let path = raw.trim();

	const quoted = /^(['"])(.*)\1$/.exec(path);
	if (quoted) path = quoted[2].trim();

	return path
		.replace(/^!?\[\[/, "")
		.replace(/(\]\])(\|.*)?$/, "")
		.split("|")[0]
		.replace(/^\.\//, "")
		.trim();
}

/* -------------------------------------------------------------------------- */
/* Normalizing whole data.json fragments                                        */
/* -------------------------------------------------------------------------- */

function parseSize(raw: unknown): { size: [number, number] | null; explicit: boolean } {
	if (Array.isArray(raw) && raw.length >= 2) {
		const width = asNumber(raw[0]);
		const height = asNumber(raw[1]);
		if (width !== null && height !== null && width > 0 && height > 0) {
			return { size: [width, height], explicit: true };
		}
	}

	const record = asRecord(raw);
	if (record) {
		const width = asNumber(record.width);
		const height = asNumber(record.height);
		if (width !== null && height !== null && width > 0 && height > 0) {
			return { size: [width, height], explicit: true };
		}
	}

	return { size: null, explicit: false };
}

/** Coerce hand-written offsets into a clean record; drop the rest. */
function parseCharOffsets(raw: unknown, chars: string[]): Record<string, CharOffset> | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;

	const offsets: Record<string, CharOffset> = {};
	for (const [token, value] of Object.entries(record)) {
		// An offset for a character who is not on the node is a leftover from an
		// earlier edit; keeping it would only bloat data.json.
		if (!chars.includes(token)) continue;
		const pair = asRecord(value);
		if (!pair) continue;
		const x = asNumber(pair.offsetX);
		const y = asNumber(pair.offsetY);
		if (x === null || y === null) continue;
		offsets[token] = { offsetX: x, offsetY: y };
	}
	return Object.keys(offsets).length > 0 ? offsets : undefined;
}

/** Coerce a hand-written outline into clean corners; anything too small is dropped. */
function parseZone(raw: unknown): ZonePoint[] | undefined {
	if (!Array.isArray(raw)) return undefined;

	const corners: ZonePoint[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		if (!record) continue;
		const x = asNumber(record.x);
		const y = asNumber(record.y);
		if (x === null || y === null) continue;
		corners.push({ x, y });
	}

	// Fewer than three corners encloses nothing: that is an outline the author has
	// not finished, not a region. Storing it would make a line clickable.
	return corners.length >= 3 ? corners : undefined;
}

/** Coerce a hand-written anchor; a partial one is no anchor at all. */
function parseAnchor(raw: unknown): { x: number; y: number } | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;
	const x = asNumber(record.x);
	const y = asNumber(record.y);
	if (x === null || y === null) return undefined;
	return { x, y };
}

/**
 * Move a link written in the old direction onto the child, which is where it lives now.
 *
 * A file saved before the direction was inverted stored the edge the other way
 * round: `targetMapId` on the parent, naming what was inside it. Left alone it
 * reads as a level with no children at all — the zones would keep their outlines,
 * but every one of them would be un-enterable, and the writer would watch their
 * own work come back as doors that open onto nothing. This function is the whole
 * difference between a migration and a silent loss.
 *
 * Only the first claim on a child is honoured. `parentId` is a single value, so a
 * child that two parents used to name can belong to one of them, and map order is
 * the only tie-break a reader can predict.
 */
function adoptLegacyLinks(nodes: MapNode[], legacy: readonly LegacyLink[]): void {
	if (legacy.length === 0) return;

	const byId = new Map(nodes.map((node) => [node.id, node]));
	for (const link of legacy) {
		const child = byId.get(link.to);
		if (!child || child.id === link.from || child.parentId !== undefined) continue;
		child.parentId = link.from;
	}
}

/**
 * Cut the links that cannot mean anything, so a map is always a forest.
 *
 * Two ways a hand-edited or imported file gets a link that cannot be walked: the
 * parent does not exist (a zone was deleted), or the chain loops back on itself
 * (two elements naming each other as parent, which a rename or a copy can easily
 * produce). A loop is the dangerous one, because every traversal that respects the
 * links would then run forever — inside a render, on a file load. Cutting the
 * edge that closed the loop keeps the rest of the structure and the writer's work.
 */
function pruneHierarchy(nodes: MapNode[]): void {
	const byId = new Map(nodes.map((node) => [node.id, node]));

	for (const node of nodes) {
		if (node.parentId && !byId.has(node.parentId)) delete node.parentId;
	}

	for (const start of nodes) {
		if (!start.parentId) continue;
		// `seen` only ever grows and is bounded by the node count, so the walk
		// terminates whatever the file said.
		const seen = new Set<string>();
		let current: MapNode | undefined = byId.get(start.parentId);
		while (current) {
			// Coming back to where the walk began means `start` is inside its own
			// subtree, and the edge that did it is the one to cut.
			if (current.id === start.id) {
				delete start.parentId;
				break;
			}
			// Any other repeat is a loop that some other node is already inside, and
			// that node's own pass is what unwinds it.
			if (seen.has(current.id)) break;
			seen.add(current.id);
			current = byId.get(current.parentId ?? "");
		}
	}
}

/** An edge in the direction it used to be stored: parent naming its child. */
interface LegacyLink {
	from: string;
	to: string;
}

function parseNodes(raw: unknown): MapNode[] {
	if (!Array.isArray(raw)) return [];

	const nodes: MapNode[] = [];
	const legacy: LegacyLink[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		if (!record) continue;

		const id = asString(record.id);
		if (!id) continue;

		const chars = asStringArray(record.chars);
		const node: MapNode = {
			id,
			x: asNumber(record.x) ?? 0,
			y: asNumber(record.y) ?? 0,
			chars,
		};

		const label = asString(record.label);
		if (label) node.label = label;

		const offsets = parseCharOffsets(record.charOffsets, chars);
		if (offsets) node.charOffsets = offsets;

		// "zone" is spelled out rather than inferred: an element only becomes a
		// door when the file says so, and a node that is merely a zone with no
		// interior yet stays a pin instead of eating clicks on the map.
		if (asString(record.kind) === "zone") node.kind = "zone";

		const zone = parseZone(record.zone);
		if (zone) node.zone = zone;

		// A node that names itself as its own parent is a door onto nothing,
		// whatever the file says. The loop that spans several nodes is cut in
		// `pruneHierarchy`.
		const parent = asString(record.parentId);
		if (parent && parent !== id) node.parentId = parent;

		// The same edge as it was written before the direction was inverted. Kept
		// only long enough to hand it to `adoptLegacyLinks`, never on the node.
		const legacyTarget = asString(record.targetMapId);
		if (legacyTarget && legacyTarget !== id) legacy.push({ from: id, to: legacyTarget });

		const anchor = parseAnchor(record.anchor);
		if (anchor) node.anchor = anchor;

		const fill = asColor(record.fill);
		if (fill) node.fill = fill;

		nodes.push(node);
	}

	adoptLegacyLinks(nodes, legacy);
	pruneHierarchy(nodes);
	return nodes;
}

/** Coerce one hand-written or imported entry into a valid stored map. */
export function normalizeMap(raw: unknown): StoredChapterMap {
	const record = asRecord(raw);
	if (!record) return { map_bg: null, nodes: [] };

	const bg = asString(record.map_bg);
	const { size, explicit } = parseSize(record.map_size);

	const map: StoredChapterMap = {
		map_bg: bg ? normalizeBackgroundPath(bg) : null,
		nodes: parseNodes(record.nodes),
	};
	if (explicit && size) map.map_size = size;

	// A parent that is not a chapter path at all is a leftover from a rename or
	// a typo. It is kept as written — not resolved and not silently dropped —
	// because the map view turns it into "parent not found, pick another",
	// which is something the writer can act on. `isChapterFile` is what rejects
	// a parent pointing at the plugin's own generated notes, which would
	// otherwise let a digest be inherited from.
	const parent = asString(record.parent_chapter_id);
	if (parent && isChapterFile(parent)) map.parent_chapter_id = parent;

	const links = parseLinks(record.links);
	if (links) map.links = links;

	return map;
}

/** Coerce the whole `maps` object, dropping entries that are not objects. */
export function normalizeMaps(raw: unknown): ChapterMaps {
	const maps: ChapterMaps = {};
	const record = asRecord(raw);
	if (!record) return maps;

	for (const [path, value] of Object.entries(record)) {
		if (!isChapterFile(path)) continue;
		maps[path] = normalizeMap(value);
	}
	return maps;
}

export function normalizePawns(raw: unknown): Pawn[] {
	if (!Array.isArray(raw)) return [];

	const pawns: Pawn[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		if (!record) continue;

		const id = asString(record.id);
		if (!id) continue;

		const name = asString(record.name) ?? id;
		const stored = asString(record.initials);
		const pawn: Pawn = {
			id,
			name,
			// Derive from the name when nothing usable is stored. The "?" placeholder
			// is treated as absent so pawns created through the old editor recover
			// on their own instead of keeping a question mark as a token.
			initials: stored && stored !== PLACEHOLDER_INITIALS ? stored : initialsFromName(name),
			color: asString(record.color) ?? "#888888",
		};

		const avatar = asString(record.avatar);
		if (avatar) pawn.avatar = avatar;
		// `note` was the field name before the rename to `notePath`. Reading both
		// keeps hand-written data.json files working without a migration step.
		const notePath = asString(record.notePath) ?? asString(record.note);
		if (notePath) pawn.notePath = notePath;

		// Absent or unrecognised means "no opinion", not a default. Defaulting to
		// white here would silently rewrite every pawn that relied on the
		// automatic contrast, and the writer would never know their choice was
		// overwritten.
		const textColor = asTextColor(record.textColor);
		if (textColor) pawn.textColor = textColor;

		pawns.push(pawn);
	}
	return pawns;
}

/** White list for the initials colour; anything else is treated as absent. */
function asTextColor(value: unknown): PawnTextColor | null {
	return value === "white" || value === "black" || value === "red" ? value : null;
}

/** White list for a tie between characters; anything else is treated as absent. */
function asLinkKind(value: unknown): LinkKind | null {
	return value === "blood" || value === "debt" || value === "secret" ? value : null;
}

/**
 * Coerce hand-written ties into clean pairs.
 *
 * Three things get dropped, all of them things a hand-edited or older file can
 * contain and none of which can be drawn: an unknown kind, a tie to oneself, and
 * a duplicate of a pair already seen. The pair is normalized so that the same
 * bond written both ways is one entry, which is what lets `removeLink` ignore
 * the order the writer picked the ends in.
 */
function parseLinks(raw: unknown): ChapterLink[] | undefined {
	if (!Array.isArray(raw)) return undefined;

	const links: ChapterLink[] = [];
	const seen = new Set<string>();

	for (const entry of raw) {
		const record = asRecord(entry);
		if (!record) continue;

		const kind = asLinkKind(record.kind);
		if (!kind) continue;

		const first = asString(record.a);
		const second = asString(record.b);
		// A character cannot be related to themselves; that is a mis-click, not
		// a self-looping plot.
		if (!first || !second || first === second) continue;

		const [a, b] = first < second ? [first, second] : [second, first];
		const key = `${a}\0${b}`;
		if (seen.has(key)) continue;
		seen.add(key);
		links.push({ a, b, kind });
	}

	return links.length > 0 ? links : undefined;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                      */
/* -------------------------------------------------------------------------- */

export function hasMap(maps: ChapterMaps, path: string | null | undefined): boolean {
	return typeof path === "string" && isChapterFile(path) && maps[path] !== undefined;
}

/** Resolve what to draw. A missing entry is a normal, empty state — not an error. */
export function readMap(maps: ChapterMaps, path: string | null, fallback: Canvas): MapViewModel {
	const empty: MapViewModel = {
		path: null,
		bg: null,
		canvas: { ...fallback },
		hasExplicitSize: false,
		nodes: [],
		links: [],
		parentChapterId: null,
	};
	if (!hasMap(maps, path)) return empty;

	const stored = maps[path as string];
	const { size, explicit } = parseSize(stored.map_size);

	return {
		path: path as string,
		bg: stored.map_bg,
		canvas: size ? { width: size[0], height: size[1] } : { ...fallback },
		hasExplicitSize: explicit,
		nodes: stored.nodes,
		links: stored.links ?? [],
		parentChapterId: stored.parent_chapter_id ?? null,
	};
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                      */
/* -------------------------------------------------------------------------- */

/** Get the chapter's entry, creating an empty one on first touch (lazy binding). */
export function ensureMap(maps: ChapterMaps, path: string): StoredChapterMap {
	const existing = maps[path];
	if (existing) return existing;

	const created: StoredChapterMap = { map_bg: null, nodes: [] };
	maps[path] = created;
	return created;
}

export function removeMap(maps: ChapterMaps, path: string): boolean {
	if (maps[path] === undefined) return false;
	delete maps[path];
	return true;
}

/**
 * Move a map to a new key after the chapter file was renamed or moved.
 * Refuses to overwrite an existing entry so a rename can never lose data.
 */
export function moveKey(maps: ChapterMaps, oldPath: string, newPath: string): boolean {
	if (oldPath === newPath) return false;
	if (maps[oldPath] === undefined) return false;
	if (maps[newPath] !== undefined) return false;

	maps[newPath] = maps[oldPath];
	delete maps[oldPath];
	return true;
}

/**
 * Re-key every chapter inside a renamed or moved folder.
 * Without this, renaming "Part 1" to "Part 2" would silently orphan every map
 * inside it. Returns how many entries moved.
 */
export function moveKeysForFolder(maps: ChapterMaps, oldPrefix: string, newPrefix: string): number {
	if (oldPrefix === newPrefix) return 0;

	const from = `${oldPrefix.replace(/\/+$/, "")}/`;
	const to = `${newPrefix.replace(/\/+$/, "")}/`;

	// Collect first: mutating while iterating the object's own keys is unsafe.
	const affected = Object.keys(maps)
		.filter((path) => path.startsWith(from))
		.map((path) => ({ from: path, to: `${to}${path.slice(from.length)}` }))
		.filter((entry) => maps[entry.to] === undefined);

	for (const entry of affected) {
		maps[entry.to] = maps[entry.from];
		delete maps[entry.from];
	}
	return affected.length;
}

function findNode(map: StoredChapterMap, nodeId: string): MapNode | undefined {
	return map.nodes.find((node) => node.id === nodeId);
}

function uniqueNodeId(base: string, nodes: readonly MapNode[]): string {
	const taken = new Set(nodes.map((node) => node.id));
	if (!taken.has(base)) return base;
	let suffix = 2;
	while (taken.has(`${base}-${suffix}`)) suffix += 1;
	return `${base}-${suffix}`;
}

/**
 * Create a node at the given canvas coordinates.
 * Returns the id actually used (the requested one may already be taken).
 */
export function addNode(maps: ChapterMaps, path: string, desiredId: string, x: number, y: number): string {
	const map = ensureMap(maps, path);
	const usedId = uniqueNodeId(desiredId, map.nodes);
	map.nodes.push({ id: usedId, x: Math.round(x), y: Math.round(y), chars: [] });
	return usedId;
}

export function moveNode(maps: ChapterMaps, path: string, nodeId: string, x: number, y: number): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node) return false;
	node.x = Math.round(x);
	node.y = Math.round(y);
	return true;
}

/** Rename a node's display label. An empty label falls back to the node id. */
export function renameNode(maps: ChapterMaps, path: string, nodeId: string, label: string): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node) return false;

	const trimmed = label.trim();
	if (trimmed) {
		node.label = trimmed;
	} else {
		delete node.label;
	}
	return true;
}

export function deleteNode(maps: ChapterMaps, path: string, nodeId: string): boolean {
	const map = maps[path];
	if (!map) return false;

	const before = map.nodes.length;
	map.nodes = map.nodes.filter((node) => node.id !== nodeId);
	if (map.nodes.length === before) return false;

	// Anything that was inside the deleted node is let go rather than orphaned. A
	// link to a node that no longer exists is a link nobody can walk, and the things
	// behind it would be on no level at all — invisible but still in data.json,
	// which is the one kind of lost work this plugin does not do. Letting them go
	// puts them back on the world level, where the writer can see and collect them.
	for (const node of map.nodes) {
		if (node.parentId === nodeId) delete node.parentId;
	}

	return true;
}

/**
 * Add a zone: a closed outline the author clicked out.
 *
 * `x`/`y` are the corner the outline started from, which is where its label
 * sits. Deliberately not a computed middle: the outline is whatever shape was
 * drawn, so anything derived from it would be a place the writer never chose.
 * The zone is born without children and therefore cannot be entered yet — that
 * is what `setNodeParent` is for, and a door with nothing behind it is better
 * than a door that opens onto the world.
 */
export function addZone(
	maps: ChapterMaps,
	path: string,
	desiredId: string,
	corners: ZonePoint[],
): string {
	const map = ensureMap(maps, path);
	const usedId = uniqueNodeId(desiredId, map.nodes);
	const first = corners[0] ?? { x: 0, y: 0 };
	map.nodes.push({
		id: usedId,
		x: Math.round(first.x),
		y: Math.round(first.y),
		chars: [],
		kind: "zone",
		zone: corners.map((corner) => ({ x: corner.x, y: corner.y })),
	});
	return usedId;
}

/**
 * Put an element inside a zone, or lift it back out to the top level.
 *
 * Refuses a self-reference, a parent that is not on this chapter's map, a parent
 * that is not a zone — a pin is a place, not a container — and, the one that would
 * be a genuine trap, a parent that already sits inside this element, because that
 * would make the chain a loop the render has to walk.
 */
export function setNodeParent(maps: ChapterMaps, path: string, nodeId: string, parentId: string | null): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node) return false;

	if (parentId === null || parentId === "") {
		if (node.parentId === undefined) return false;
		delete node.parentId;
		return true;
	}

	if (parentId === nodeId) return false;
	const parent = findNode(map, parentId);
	if (!parent || !isZone(parent)) return false;
	// The edge runs upwards, so what has to be checked is whether the prospective
	// parent is already below this node. Pointing one of its own descendants at it
	// would make a loop there is no end of, and the map would have no top level to
	// come back to.
	if (isAncestorId(map.nodes, nodeId, parentId)) return false;

	if (node.parentId === parentId) return false;
	node.parentId = parentId;
	return true;
}

/** Whether `ancestorId` is reached by walking up from `descendantId`. */
function isAncestorId(nodes: readonly MapNode[], ancestorId: string, descendantId: string): boolean {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const seen = new Set<string>();

	let current: MapNode | undefined = byId.get(descendantId);
	while (current?.parentId) {
		if (current.parentId === ancestorId) return true;
		if (seen.has(current.id)) return false;
		seen.add(current.id);
		current = byId.get(current.parentId);
	}

	return false;
}

/**
 * Place the point a zone's cast is drawn around.
 *
 * The author's own click, stored as given. There is deliberately no fallback to
 * the node's coordinates and nothing derived from the outline: a sun drawn at a
 * point nobody chose is a claim about the story that nobody made.
 */
export function setNodeAnchor(
	maps: ChapterMaps,
	path: string,
	nodeId: string,
	x: number,
	y: number,
): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node) return false;

	node.anchor = { x: Math.round(x), y: Math.round(y) };
	return true;
}

/**
 * Remember the colour a zone fills with on hover, or forget it.
 *
 * Absent means the stylesheet's own default, which is why clearing it deletes the
 * field rather than writing an empty string: a file full of `"fill": ""` is a
 * file nobody can read.
 *
 * Three outcomes, and the middle one matters: `null` (or an empty string) clears
 * the field and reports the change, a value that is not a colour is refused
 * outright and leaves what was there alone, and a colour that is already set
 * reports no change. Conflating a bad value with a clear would let a mistyped
 * colour erase a good one.
 */
export function setZoneFill(maps: ChapterMaps, path: string, nodeId: string, fill: string | null): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node) return false;

	if (fill === null || fill === "") {
		if (node.fill === undefined) return false;
		delete node.fill;
		return true;
	}

	const cleaned = asColor(fill);
	if (cleaned === null) return false;
	if (node.fill === cleaned) return false;

	node.fill = cleaned;
	return true;
}

/** Replace a zone's outline wholesale, as a redraw does. */
export function setZoneOutline(
	maps: ChapterMaps,
	path: string,
	nodeId: string,
	corners: ZonePoint[],
): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node || !node.zone) return false;
	if (corners.length < 3) return false;

	node.zone = corners.map((corner) => ({ x: corner.x, y: corner.y }));
	// The label follows the outline's own starting corner, so a redraw that moved
	// the shape does not leave the name behind in the middle of nothing.
	node.x = Math.round(corners[0].x);
	node.y = Math.round(corners[0].y);
	return true;
}

/** Add or remove a pawn token on a node. Used by the node popover checkboxes. */
export function setPawnOnNode(
	maps: ChapterMaps,
	path: string,
	nodeId: string,
	token: string,
	present: boolean,
): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node) return false;

	const without = node.chars.filter((item) => item !== token);
	node.chars = present ? [...without, token] : without;
	// A character who just left the node must not leave a stale nudge behind.
	if (!present) dropCharOffset(node, token);
	return true;
}

/**
 * Remember where the author put one character, or forget it.
 *
 * The offset is relative to the radial slot, so a character the author has
 * never touched simply has no entry and always sits in the ring. Passing null
 * puts them back. Returns false for a node that does not exist.
 */
export function setCharOffset(
	maps: ChapterMaps,
	path: string,
	nodeId: string,
	token: string,
	offset: CharOffset | null,
): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node) return false;
	if (offset) node.charOffsets = { ...node.charOffsets, [token]: offset };
	else dropCharOffset(node, token);
	return true;
}

/**
 * Drag the whole fan as one piece.
 *
 * Every character on the node has to receive the delta, not just the ones the
 * author had already nudged: the others sit in their ring slot, so if their
 * offset stayed at zero they would stay behind while the rest slid away and the
 * ring would come apart mid-drag. Writing the same delta to everybody keeps the
 * shape the author arranged.
 */
export function moveCharOffsets(
	maps: ChapterMaps,
	path: string,
	nodeId: string,
	deltaX: number,
	deltaY: number,
): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node || node.chars.length === 0) return false;
	if (deltaX === 0 && deltaY === 0) return false;

	const moved: Record<string, CharOffset> = {};
	for (const token of node.chars) {
		const previous = node.charOffsets?.[token];
		moved[token] = {
			offsetX: Math.round((previous?.offsetX ?? 0) + deltaX),
			offsetY: Math.round((previous?.offsetY ?? 0) + deltaY),
		};
	}
	node.charOffsets = moved;
	return true;
}

function dropCharOffset(node: MapNode, token: string): void {
	if (!node.charOffsets || !(token in node.charOffsets)) return;
	const next = { ...node.charOffsets };
	delete next[token];
	if (Object.keys(next).length === 0) delete node.charOffsets;
	else node.charOffsets = next;
}

/**
 * Swap a legacy/unknown token for a real pawn id in one step.
 * Used when a pawn is created straight from an unknown token on a node.
 */
export function replaceNodeToken(
	maps: ChapterMaps,
	path: string,
	nodeId: string,
	oldToken: string,
	newToken: string,
): boolean {
	const map = maps[path];
	const node = map && findNode(map, nodeId);
	if (!node) return false;

	const next = node.chars.filter((item) => item !== oldToken);
	if (!next.includes(newToken)) next.push(newToken);
	node.chars = next;
	return true;
}

/**
 * Point a map at the chapter it was inherited from, or cut the tie.
 *
 * Free-form on purpose: the caller has already offered a list of real chapters,
 * and the field is provenance rather than a foreign key with a cascade. Pass
 * null to forget the parent, which is what "I built this myself" means.
 */
export function setParentChapter(maps: ChapterMaps, path: string, parent: string | null): boolean {
	const map = ensureMap(maps, path);

	if (parent === null) {
		if (map.parent_chapter_id === undefined) return false;
		delete map.parent_chapter_id;
		return true;
	}

	// A chapter cannot be its own ancestor, and inheriting from a chapter that is
	// not in the store would copy from nothing. Both are refused here rather than
	// at the call site, because there are several call sites.
	if (parent === path || !maps[parent]) return false;

	map.parent_chapter_id = parent;
	return true;
}

/** The two ends of a pair in a fixed order, so "same pair" is a string compare. */
/**
 * Whether a stored tie is the same pair, whichever end it was written first.
 *
 * Order-insensitive on purpose. The stored ends are normally normalized, so
 * comparing sorted positions would usually work — but a data.json edited by
 * hand, or written before normalization existed, can hold a pair the other way
 * round, and then the writer would end up with two lines between the same two
 * people, which is the one outcome this whole design exists to prevent.
 */
function samePair(link: ChapterLink, a: string, b: string): boolean {
	return (link.a === a && link.b === b) || (link.a === b && link.b === a);
}

/**
 * Tie two characters together, or change what their existing tie means.
 *
 * One tie per pair, deliberately. Two lines between the same two people would
 * have to run parallel to stay readable, and which of the two belongs to which
 * character becomes a question the writer has to answer every time they look at
 * the graph. So picking a different kind replaces the old one, and the two ends
 * are normalized on the way in so the order they were clicked in does not
 * matter.
 *
 * Returns true when the stored ties actually changed, which is false both for a
 * refusal (self-tie, missing map) and for a no-op — re-picking the kind that is
 * already there. The view repaints on change only.
 */
export function addLink(maps: ChapterMaps, path: string, a: string, b: string, kind: LinkKind): boolean {
	const map = maps[path];
	if (!map || !a || !b || a === b) return false;

	const [first, second] = a < b ? [a, b] : [b, a];
	const existing = map.links?.find((link) => samePair(link, a, b));

	if (existing) {
		// Same tie, same meaning: nothing to write, and reporting success would
		// make the view repaint for no reason.
		if (existing.kind === kind) return false;
		existing.kind = kind;
		return true;
	}

	map.links = [...(map.links ?? []), { a: first, b: second, kind }];
	return true;
}

/** Cut the tie between two characters, whichever end was clicked first. */
export function removeLink(maps: ChapterMaps, path: string, a: string, b: string): boolean {
	const map = maps[path];
	if (!map?.links) return false;

	const before = map.links.length;
	const next = map.links.filter((link) => !samePair(link, a, b));
	if (next.length === before) return false;

	if (next.length === 0) delete map.links;
	else map.links = next;
	return true;
}

/** True when these two are already tied, and to what. */
export function linkBetween(map: StoredChapterMap | undefined, a: string, b: string): LinkKind | null {
	return map?.links?.find((link) => samePair(link, a, b))?.kind ?? null;
}

export function setBackground(maps: ChapterMaps, path: string, bg: string | null): StoredChapterMap {
	const map = ensureMap(maps, path);
	map.map_bg = bg ? normalizeBackgroundPath(bg) : null;
	return map;
}

/** Set or clear the explicit design size. Pass null to let the image decide. */
export function setCanvasSize(maps: ChapterMaps, path: string, size: [number, number] | null): StoredChapterMap {
	const map = ensureMap(maps, path);
	if (size && size[0] > 0 && size[1] > 0) {
		map.map_size = [Math.round(size[0]), Math.round(size[1])];
	} else {
		delete map.map_size;
	}
	return map;
}

/* -------------------------------------------------------------------------- */
/* Maintenance                                                                  */
/* -------------------------------------------------------------------------- */

/** Keys whose chapter file no longer exists in the vault. */
export function findOrphanKeys(maps: ChapterMaps, existingPaths: Iterable<string>): string[] {
	const known = new Set<string>(existingPaths);
	return Object.keys(maps).filter((path) => !known.has(path));
}

/** Merge imported maps into the current ones. Incoming entries win on id clash. */
export function mergeMaps(current: ChapterMaps, incoming: ChapterMaps): { maps: ChapterMaps; added: number } {
	const maps: ChapterMaps = { ...current, ...incoming };
	return { maps, added: Object.keys(incoming).length };
}

/** Merge imported pawns by id, keeping the local order and appending newcomers. */
export function mergePawns(current: Pawn[], incoming: Pawn[]): { pawns: Pawn[]; added: number } {
	const byId = new Map(current.map((pawn) => [pawn.id, pawn]));
	for (const pawn of incoming) byId.set(pawn.id, pawn);
	return { pawns: [...byId.values()], added: incoming.length };
}
