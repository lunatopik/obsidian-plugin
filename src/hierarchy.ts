import type { MapNode, ZonePoint } from "./types";

/**
 * Nested maps: World -> Region -> Location, as buttons rather than as a GIS.
 *
 * The brief is a game-style set of hitboxes: a region is a closed outline the
 * author clicks out, clicking it takes you in, and a trail of breadcrumbs takes
 * you back. There is no projection, no georeferencing, no centroid anywhere in
 * this module — and that is a decision, not an omission. A hand-drawn outline has
 * no meaningful centre, and a centre the writer cannot see is a centre they can
 * never correct, so the one point that needs placing is placed by a click and
 * stored as `anchor`.
 *
 * Like layout.ts and inherit.ts, this module is pure: no DOM, no Obsidian, no
 * filesystem. That matters more here than anywhere else in the plugin, because
 * the interesting bugs are all geometry bugs — a ray that counts a vertex twice,
 * a walk that loops, a polygon that swallows its neighbour — and a browser is a
 * poor place to look for any of them.
 *
 * The nesting itself is a chain over one flat `nodes[]`: `P.targetMapId` names
 * the element inside P, so P's children are that one node. The level the view is
 * showing is not stored, it is derived from the trail the writer walked, so a
 * chapter's data has no opinion about where they were last looking.
 */

/** A point in design-canvas coordinates. */
export interface Point {
	x: number;
	y: number;
}

/**
 * How many characters fit around a zone's anchor before the rest is counted.
 *
 * A ring past this turns into a black band with no readable token in it, and the
 * whole point of the sun is that you can read it at a glance. The overflow is
 * not dropped, it becomes a count you can click — which is strictly better than
 * a hundred overlapping circles and strictly better than lying about the count.
 */
export const SUN_CAP = 8;

/* -------------------------------------------------------------------------- */
/* Is this point inside that outline                                           */
/* -------------------------------------------------------------------------- */

/**
 * Ray casting: cast a ray to the right and count the outline's crossings.
 *
 * Odd crossings mean inside, even mean outside. The whole algorithm is the
 * branch over whether an edge straddles the horizontal line through the point,
 * and the only subtlety is that a corner has to be counted once rather than
 * twice or not at all — hence the half-open comparison on `y`, which makes every
 * vertex belong to the edge above it and to that edge only.
 */
export function pointInPolygon(point: Point, polygon: readonly ZonePoint[]): boolean {
	if (polygon.length < 3) return false;

	// The boundary is checked first, and deliberately. Counting alone cannot
	// answer for a point that sits on an edge — the ray leaves from the very edge
	// it is supposed to cross — and would answer "outside" for one side of it
	// without any way to say so. Here the outline is a hitbox the author clicks
	// on, and they click its corners, so a click on the edge has to land in the
	// zone it drew.
	if (onBoundary(point, polygon)) return true;

	let inside = false;
	// `previous` starts on the last corner so the loop closes itself without
	// copying the array and without a special case for the wrap-around edge.
	let previous = polygon[polygon.length - 1];

	for (const corner of polygon) {
		if (rayCrossesEdge(point, previous, corner)) inside = !inside;
		previous = corner;
	}

	return inside;
}

/** How far off a line a point may be and still count as lying on it. */
const ON_EDGE_EPSILON = 1e-9;

/** Whether the point lies exactly on one of the outline's edges. */
function onBoundary(point: Point, polygon: readonly ZonePoint[]): boolean {
	let previous = polygon[polygon.length - 1];
	for (const corner of polygon) {
		if (onSegment(point, previous, corner)) return true;
		previous = corner;
	}
	return false;
}

/**
 * Collinear and between the ends.
 *
 * The bounding box is what makes this "between" and not merely "on the line" —
 * a point on the extension of an edge is outside the shape, and inside its
 * bounding box often enough that the collinearity test alone would get it wrong.
 */
function onSegment(point: Point, from: ZonePoint, to: ZonePoint): boolean {
	if (
		point.x < Math.min(from.x, to.x) - ON_EDGE_EPSILON ||
		point.x > Math.max(from.x, to.x) + ON_EDGE_EPSILON ||
		point.y < Math.min(from.y, to.y) - ON_EDGE_EPSILON ||
		point.y > Math.max(from.y, to.y) + ON_EDGE_EPSILON
	) {
		return false;
	}

	const cross =
		(to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x);
	return Math.abs(cross) <= ON_EDGE_EPSILON;
}

/** One edge of the crossing count: does the ray through `point` meet it? */
function rayCrossesEdge(point: Point, from: ZonePoint, to: ZonePoint): boolean {
	if (!straddles(point.y, from.y, to.y)) return false;
	// The crossing sits at some x. Comparing it with the point's x is a division
	// per edge; comparing the two sides of it is the same test without one.
	return crossesToTheRight(point.x, from, to, point.y);
}

/**
 * Whether `y` falls between two corner heights, counting a shared corner once.
 *
 * `low <= y < high` rather than `low < y < high`: a vertex that two edges both
 * touch would otherwise be counted twice (so a square would read as outside) or,
 * with the other choice, not at all.
 */
function straddles(y: number, a: number, b: number): boolean {
	const low = Math.min(a, b);
	const high = Math.max(a, b);
	return y >= low && y < high;
}

/**
 * Whether the edge's crossing at height `y` lies right of the point.
 *
 * The crossing sits at `from.x + (y - from.y) * (to.x - from.x) / (to.y - from.y)`,
 * and the whole test is whether that exceeds `pointX`. Multiplying it out avoids
 * the division — which matters because a horizontal edge has a zero denominator,
 * and `straddles` has already rejected those, so the only question left is the
 * sign of the resulting fraction. `dy` is never zero here, which is exactly what
 * the half-open comparison in `straddles` buys.
 */
function crossesToTheRight(pointX: number, from: ZonePoint, to: ZonePoint, y: number): boolean {
	// A vertical edge sits at one x, and every y on it is a real crossing.
	if (from.x === to.x) return from.x > pointX;

	const dy = to.y - from.y;
	// (x - pointX) * dy, with the sign of dy folded in, so the comparison below
	// is a plain greater-than instead of a fraction with a signed denominator.
	const numerator = (from.x - pointX) * dy + (y - from.y) * (to.x - from.x);
	return dy > 0 ? numerator > 0 : numerator < 0;
}

/**
 * The zone under a point, or null.
 *
 * A file is free to hold overlapping outlines, and then "which one did I click"
 * is a question with no good answer. The last one in map order wins, which is
 * the same rule the browser applies to stacked SVG shapes and — more to the
 * point — the same one the writer can predict, because the order they drew in is
 * the order they are stored in.
 */
export function zoneAt(nodes: readonly MapNode[], point: Point): MapNode | null {
	let found: MapNode | null = null;
	for (const node of nodes) {
		if (isZone(node) && pointInPolygon(point, node.zone as ZonePoint[])) found = node;
	}
	return found;
}

/* -------------------------------------------------------------------------- */
/* The forest                                                                   */
/* -------------------------------------------------------------------------- */

/** True when a node is a zone with an interior worth hitting. */
export function isZone(node: MapNode): boolean {
	return node.kind === "zone" && Array.isArray(node.zone) && node.zone.length >= 3;
}

/** True when a node can be entered — it is a zone that leads somewhere. */
export function isEnterable(nodes: readonly MapNode[], node: MapNode): boolean {
	return isZone(node) && childrenOf(nodes, node.id).length > 0;
}

/**
 * Id → node, built once per call.
 *
 * Every walk in this file starts here rather than filtering the array inline, so
 * a five-node chain costs five lookups instead of five scans of the whole map.
 */
function indexNodes(nodes: readonly MapNode[]): Map<string, MapNode> {
	return new Map(nodes.map((node) => [node.id, node]));
}

/** Look a node up by id. */
export function nodeById(nodes: readonly MapNode[], id: string): MapNode | null {
	return indexNodes(nodes).get(id) ?? null;
}

/**
 * What is inside `id`.
 *
 * The link runs the way the writer walks it: `targetMapId` is where a click on an
 * element takes you, so it names the element *inside* it. That is also why a
 * region holding several towns is drawn as a region zone with a town zone inside
 * it rather than one zone listing its towns — the same shape a strategy game
 * uses, and the only one a single link per element can express.
 *
 * A link that names a node which is not on this map resolves to nothing. The
 * store drops those on load, but a walk that depended on that would be one
 * refactor away from hanging on a dangling id.
 */
export function childrenOf(nodes: readonly MapNode[], id: string): MapNode[] {
	const node = indexNodes(nodes).get(id);
	if (!node?.targetMapId) return [];
	const child = indexNodes(nodes).get(node.targetMapId);
	return child ? [child] : [];
}

/**
 * Every node below `id`, following the chain, excluding `id` itself.
 *
 * `seen` is what makes a hand-edited file safe: a chain that loops — two
 * elements naming each other, which a rename or a copy produces easily — would
 * otherwise be walked forever, inside a render, on a file load.
 */
export function descendantsOf(nodes: readonly MapNode[], id: string): MapNode[] {
	const byId = indexNodes(nodes);
	const seen = new Set<string>([id]);
	const out: MapNode[] = [];

	let current = byId.get(id);
	while (current?.targetMapId) {
		const next = byId.get(current.targetMapId);
		if (!next || seen.has(next.id)) break;
		seen.add(next.id);
		out.push(next);
		current = next;
	}

	return out;
}

/**
 * The roots of the forest: the elements nothing switches to.
 *
 * Note the direction — "no node names this one as its target", not "this one
 * names no target". A location at the end of a chain is the second question, and
 * that says nothing about where it is shown.
 */
export function rootNodes(nodes: readonly MapNode[]): MapNode[] {
	const entered = new Set(nodes.map((node) => node.targetMapId).filter((id): id is string => Boolean(id)));
	return nodes.filter((node) => !entered.has(node.id));
}

/**
 * The nodes on the level `stack` names.
 *
 * An empty stack is the top of the chapter. Two failures are handled apart, and
 * the difference matters:
 *
 *   - the id is gone (the node was deleted while the writer stood inside it), so
 *     fall back to the level above rather than to nothing;
 *   - the id is there and simply has no children, which is an honest empty
 *     level — the floor of the chain — and is returned as such. Falling back here
 *     instead would quietly re-open the parent, and a stack that keeps regaining
 *     a level could never come to rest.
 */
export function levelNodes(nodes: readonly MapNode[], stack: readonly string[]): MapNode[] {
	if (stack.length === 0) return rootNodes(nodes);

	const current = stack[stack.length - 1];
	if (indexNodes(nodes).has(current)) return childrenOf(nodes, current);

	const above = stack.length > 1 ? stack[stack.length - 2] : null;
	return above ? childrenOf(nodes, above) : rootNodes(nodes);
}

/* -------------------------------------------------------------------------- */
/* The cast around a zone's anchor                                             */
/* -------------------------------------------------------------------------- */

/**
 * Everyone inside a zone, however deep they are.
 *
 * This is the "sun": the characters of a region and of every town under it,
 * gathered in one ring so the writer can see at a glance who is in that part of
 * the world. The first occurrence wins, so a character standing in two towns of
 * the same region is one token, not two — a ring that drew them twice would say
 * they were in two places, which is exactly the sort of thing the map is
 * supposed to prevent.
 *
 * Note what is deliberately not here: no centre is computed, and the node's own
 * `x`/`y` is not used as a fallback. If the writer has not placed the anchor,
 * there is no sun, because a sun at an arbitrary point is a claim about the
 * story that nobody made.
 */
export function collectCast(nodes: readonly MapNode[], id: string): string[] {
	const seen = new Set<string>();
	const cast: string[] = [];

	for (const node of descendantsOf(nodes, id)) {
		for (const token of node.chars) {
			if (seen.has(token)) continue;
			seen.add(token);
			cast.push(token);
		}
	}

	return cast;
}

/** How the cast is drawn around an anchor: what fits, and what the rest is. */
export interface SunLayout {
	/** The characters actually drawn, in order, at most `SUN_CAP` of them. */
	shown: string[];
	/** How many are left over, and what the token says. Null when nothing was cut. */
	overflow: string | null;
}

/**
 * Split a cast into what the ring can hold and a count for the rest.
 *
 * The count is a string because it is going to be drawn inside a small circle:
 * building it here keeps the view from having to know the cap, and keeps the
 * decision to drop characters in one testable place.
 */
export function sunLayout(cast: readonly string[]): SunLayout {
	if (cast.length <= SUN_CAP) return { shown: [...cast], overflow: null };
	return { shown: cast.slice(0, SUN_CAP), overflow: `+${cast.length - SUN_CAP}` };
}

/* -------------------------------------------------------------------------- */
/* Drawing a zone outline                                                       */
/* -------------------------------------------------------------------------- */

/** One closed outline as an SVG `points` list. */
export function zoneToPoints(zone: readonly ZonePoint[]): string {
	return zone.map((corner) => `${corner.x},${corner.y}`).join(" ");
}

/**
 * Whether a closed outline would cross itself.
 *
 * Closing a self-intersecting outline would hand the writer a shape whose inside
 * is decided by a counting rule rather than by what they drew: a bow tie has two
 * interiors, and which half responds to a click is not something anybody could
 * predict by looking at the picture. Refusing the close, while the outline is
 * still being drawn, is the only moment where saying no is cheap.
 */
export function zoneSelfIntersects(corners: readonly ZonePoint[]): boolean {
	const count = corners.length;
	if (count < 4) return false;

	for (let i = 0; i < count; i += 1) {
		const a1 = corners[i];
		const a2 = corners[(i + 1) % count];
		// Every pair of edges that are not neighbours: neighbours always meet at
		// the corner they share, which is not a crossing.
		for (let j = i + 1; j < count; j += 1) {
			if (j === i + 1 || (i === 0 && j === count - 1)) continue;
			const b1 = corners[j];
			const b2 = corners[(j + 1) % count];
			if (segmentsCross(a1, a2, b1, b2)) return true;
		}
	}

	return false;
}

function segmentsCross(a1: ZonePoint, a2: ZonePoint, b1: ZonePoint, b2: ZonePoint): boolean {
	return (
		properlyStraddles(a1, a2, b1, b2) &&
		properlyStraddles(b1, b2, a1, a2) &&
		orientation(a1, a2, b1) !== orientation(a1, a2, b2) &&
		orientation(b1, b2, a1) !== orientation(b1, b2, a2)
	);
}

function properlyStraddles(a1: ZonePoint, a2: ZonePoint, b1: ZonePoint, b2: ZonePoint): boolean {
	return (
		pointOnOppositeSides(b1, b2, a1, a2) && pointOnOppositeSides(a1, a2, b1, b2)
	);
}

/**
 * Whether `b` and `c` are strictly on different sides of the line through `a`.
 *
 * Strict on purpose: a corner sitting exactly on another edge is a touch, not a
 * crossing, and treating it as one would reject an outline the author drew
 * deliberately — two rooms sharing a wall is a normal thing to draw.
 */
function pointOnOppositeSides(b: ZonePoint, c: ZonePoint, a: ZonePoint, d: ZonePoint): boolean {
	const left = orientation(a, d, b);
	const right = orientation(a, d, c);
	return (left > 0) !== (right > 0) && left !== 0 && right !== 0;
}

function orientation(a: ZonePoint, b: ZonePoint, c: ZonePoint): number {
	const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	return value > 0 ? 1 : value < 0 ? -1 : 0;
}
