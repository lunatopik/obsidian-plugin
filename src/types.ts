/**
 * Shared type definitions for the "Writer's State Map" plugin.
 *
 * Data flow overview:
 *   data.json (pawns + maps)  <->  store.ts   <->  map-view.ts / roster-view.ts
 *   data.json (bytes)         <->  storage.ts <->  main.ts
 *   map + roster              <->  notes.ts   <->  note-writer.ts -> .Writer Maps Data/
 *
 * Isolation rule: the plugin never reads the author's chapter notes and never
 * writes to one. A chapter contributes nothing but its path, which is the key
 * under `maps`.
 *
 * The one deliberate exception is the author's own note, kept in the hidden
 * ".Writer Maps Data/" folder and written only between two marker comments by
 * src/note-writer.ts — the single audited module allowed to reach a vault file.
 * Everything the author writes outside those markers is never read, rewritten or
 * removed.
 */

/** Supported interface languages. */
export type Language = "en" | "ru";

/** Current data.json layout. Bump only on breaking changes. */
export const SCHEMA_VERSION = 1;

/**
 * Colour of the initials drawn on top of a token.
 *
 * Deliberately a closed set: these are the only three that stay legible over an
 * arbitrary avatar or solid colour, and they are what the stylesheet can offer
 * as classes. `undefined` means "no opinion" and leaves the automatic choice
 * alone (dark text over a light background, white over a dark one) — a pawn
 * saved before this field existed must not suddenly turn unreadable.
 */
export type PawnTextColor = "white" | "black" | "red";

/** A character pawn, stored in the plugin's data.json (manual sandbox). */
export interface Pawn {
	/** Stable, unique id. Referenced from `maps[].nodes[].chars`. */
	id: string;
	/** Human readable name, e.g. "Том". */
	name: string;
	/** 1-3 symbols rendered on top of the token background. Auto-generated, but always overridable. */
	initials: string;
	/** Solid background color, used when no avatar image is set. */
	color: string;
	/** Optional vault path of an avatar image. Set only by an explicit user action. */
	avatar?: string;
	/** Optional vault path of the character's note. Attached via an on-demand quick switcher. */
	notePath?: string;
	/** Optional explicit colour for the initials. Absent = automatic by background. */
	textColor?: PawnTextColor;
}

/**
 * Result of resolving a raw `chars[]` token against the roster.
 * `pawn` is null when the token is not present in the roster (deleted pawn,
 * hand-written leftover, typo). Such tokens are still rendered, flagged as unknown.
 */
export interface ResolvedPawn {
	/** Raw value as stored in data.json. */
	token: string;
	/** Matched pawn, or null when unknown. */
	pawn: Pawn | null;
}

/**
 * A character's manual nudge away from its radial slot.
 *
 * Stored relative to the computed slot, so reordering the roster never moves an
 * avatar the author placed by hand.
 */
export interface CharOffset {
	offsetX: number;
	offsetY: number;
}

/**
 * One corner of a zone outline, in the same design-canvas pixels as `x`/`y`.
 *
 * Zones are drawn by clicking the map, so the points are whatever the author
 * happened to hit — never derived, never snapped to a grid.
 */
export interface ZonePoint {
	x: number;
	y: number;
}

/**
 * What an element of the map is: a plain pin, or a zone you can fall into.
 *
 * Absent means "pin", so every data.json written before zones existed keeps
 * loading and keeps behaving exactly as it did.
 */
export type NodeKind = "pin" | "zone";

/** A single map location, stored in a chapter's `nodes[]` array. */
export interface MapNode {
	id: string;
	/** Optional display label. Falls back to `id`. */
	label?: string;
	/** Horizontal position in canvas pixels. */
	x: number;
	/** Vertical position in canvas pixels. */
	y: number;
	/** Roster ids (or legacy names) of the pawns present at this node. */
	chars: string[];
	/** Manual nudges, keyed by the same token as `chars`. Absent = all radial. */
	charOffsets?: Record<string, CharOffset>;

	/* ---- the nested-map fields: World -> Region -> Location ---- */

	/**
	 * What this element is. Absent = "pin", which is every node of an older file.
	 *
	 * A "zone" is a closed outline the author clicks out; a "pin" is a point. The
	 * field exists so a zone is not inferred from "has a zone outline" — a
	 * half-finished outline must not turn a location into a door.
	 */
	kind?: NodeKind;
	/**
	 * The closed outline of a zone, in canvas pixels.
	 *
	 * Absent, or fewer than three corners, and the element has no interior: it is
	 * drawn but cannot be entered. Three corners is the smallest figure that
	 * encloses anything at all, so anything less is a line the author has not
	 * finished, not a shape.
	 */
	zone?: ZonePoint[];
	/**
	 * The map a click on this element switches to.
	 *
	 * The link runs the way the writer walks it: `P.targetMapId` names the element
	 * *inside* P, so `childrenOf(P)` is that one node. This is also why a region
	 * holding several towns is drawn as a region zone with a town zone inside it,
	 * rather than one zone listing its towns — the shape a strategy game uses, and
	 * the only one a single link per element can express.
	 *
	 * Kept as an id and not as an index so that adding, deleting or reordering
	 * nodes cannot silently re-point it, and so a hand-edited file stays readable.
	 * The store drops a link to a node that is not in this map, and a link that
	 * would close a loop back onto an ancestor.
	 */
	targetMapId?: string;
	/**
	 * Where this element's cast is drawn on its parent's map.
	 *
	 * Placed by a click and never computed: there is no centroid here on purpose.
	 * A region drawn as a jagged border has no meaningful middle, and a middle
	 * the writer cannot see is a middle they cannot correct.
	 */
	anchor?: { x: number; y: number };
	/** Colour of the zone's hover fill. Absent = the stylesheet's default. */
	fill?: string;
}

/** Design canvas the stored coordinates refer to. */
export interface Canvas {
	width: number;
	height: number;
}

/**
 * What a line between two characters means.
 *
 * A closed set, like `PawnTextColor`: these three are the only ones the
 * relationship graph draws, and each has a fixed look (see styles.css) that the
 * writer learns to read without the legend. Unknown values are dropped on load
 * rather than rendered as a fourth mystery style.
 */
export type LinkKind = "blood" | "debt" | "secret";

/**
 * A connection between two characters, inside one chapter.
 *
 * `a` and `b` are pawn ids and the order between them is not meaningful — a
 * family bond and a debt are the same edge seen from either end. The store
 * normalizes the pair (see `addLink`) so the same bond cannot be stored twice
 * just because the writer picked the other end first, and so removal does not
 * have to guess which half to look for.
 */
export interface ChapterLink {
	a: string;
	b: string;
	kind: LinkKind;
}

/**
 * A chapter map exactly as persisted in data.json under `maps[path]`.
 * `map_size` is optional: when absent the background image's natural size wins,
 * and `defaultCanvas` is the last resort.
 */
export interface StoredChapterMap {
	/** Vault path of the background image, or null. */
	map_bg: string | null;
	/** Explicit design size. Absent when the image (or the global default) decides. */
	map_size?: [number, number];
	/**
	 * Chapter this map was inherited from, as a vault path. Absent when the map
	 * was built by hand.
	 *
	 * Provenance, not a live link: nothing re-reads the parent afterwards, so
	 * editing the earlier chapter never rewrites this one. The field exists to
	 * answer "where did this layout come from?" and to be re-pointed by hand
	 * when the parent is renamed. Written in snake_case to sit with `map_bg`
	 * and `map_size`; the pawn fields above are camelCase, and the map fields
	 * predate that, so both are now load-bearing.
	 */
	parent_chapter_id?: string;
	nodes: MapNode[];
	/** Ties between characters. Absent when there are none. */
	links?: ChapterLink[];
}

/** Every map in the vault, keyed by the chapter's vault-relative path. */
export type ChapterMaps = Record<string, StoredChapterMap>;

/** Everything the view needs to paint, resolved from storage. */
export interface MapViewModel {
	/** Chapter this map belongs to, or null when no markdown note is open. */
	path: string | null;
	bg: string | null;
	canvas: Canvas;
	/** True when the stored map declares `map_size`. */
	hasExplicitSize: boolean;
	nodes: MapNode[];
	/** Never null: an empty array means "no ties", not "unknown". */
	links: ChapterLink[];
	/** Chapter this map was inherited from, or null when built by hand. */
	parentChapterId: string | null;
}

/** Plugin settings persisted in data.json — the only place plugin data lives. */
export interface WriterStateMapSettings {
	/** Layout version of this file. */
	schemaVersion: number;
	language: Language;
	/** Which tab to focus when the right sidebar is (re)opened. */
	defaultView: "map" | "note" | "roster" | "relationship";
	/** Canvas size used when a map has no `map_size` and no background image. */
	defaultCanvas: Canvas;
	/** Vault path for the portable export/import file. */
	exportPath: string;
	/** The master roster. Managed manually inside the plugin, never scanned from the vault. */
	pawns: Pawn[];
	/** Chapter maps, created lazily on first interaction. */
	maps: ChapterMaps;
}

export const DEFAULT_SETTINGS: WriterStateMapSettings = {
	schemaVersion: SCHEMA_VERSION,
	language: "en",
	defaultView: "map",
	defaultCanvas: { width: 1024, height: 768 },
	exportPath: "Writer Maps/wsm-data.json",
	pawns: [],
	maps: {},
};
