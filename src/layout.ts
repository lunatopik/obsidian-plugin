/**
 * The radial fan around a location pin.
 *
 * A location is a small pin; its characters are avatars arranged in a ring
 * around it, joined by thin elastic spokes. This module owns the geometry and
 * nothing else — no DOM, no Obsidian — so the layout can be pinned down by tests
 * and reasoned about without a browser.
 *
 * One subtlety drives most of the design. The map stage is scaled to fit the
 * sidebar with a CSS transform, while the avatars are counter-scaled so they stay
 * legible at any width. A radius expressed in canvas pixels would therefore
 * shrink with the map while the avatars stayed the same size, and the ring would
 * eventually collapse into a pile. So the ring is authored in *screen* pixels and
 * converted to canvas pixels at paint time, which keeps the distance between two
 * neighbouring avatars constant no matter how narrow the sidebar gets.
 */

/** Where a character's slot sits inside the ring, in screen pixels. */
export interface Slot {
	x: number;
	y: number;
}

/** Base ring radius for a lone character. */
export const BASE_RADIUS = 30;

/** Extra radius per additional character, so a crowded ring stays legible. */
export const RADIUS_PER_CHAR = 7;

/** A ring wider than this starts costing more than it helps. */
export const MAX_RADIUS = 120;

/**
 * Ring radius for a given number of characters, in screen pixels.
 *
 * Roughly 14 screen px of edge per avatar at the cap, which is enough room for a
 * 24 px circle plus the gap the spoke needs.
 */
export function ringRadius(count: number): number {
	if (count <= 1) return BASE_RADIUS;
	return Math.min(MAX_RADIUS, BASE_RADIUS + RADIUS_PER_CHAR * (count - 1));
}

/**
 * Slot for one character, in screen pixels relative to the pin.
 *
 * The ring starts at the top (-90°) and runs clockwise, so the first character
 * in `chars` — the one the author ticked first — sits above the pin where it is
 * easiest to find, and the reading order matches the visual one.
 */
export function radialSlot(index: number, count: number, radius = ringRadius(count)): Slot {
	if (count <= 0) return { x: 0, y: 0 };
	// A single avatar sits straight up: the one thing that must be visible at a
	// glance, and a ring of one has no direction of its own.
	const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
	return {
		x: Math.round(Math.cos(angle) * radius * 100) / 100,
		y: Math.round(Math.sin(angle) * radius * 100) / 100,
	};
}

/** Every slot of a ring, in order. */
export function radialSlots(count: number, radius = ringRadius(count)): Slot[] {
	const radiusForRing = radius;
	return Array.from({ length: Math.max(0, count) }, (_, index) => radialSlot(index, count, radiusForRing));
}

/** Where a character actually sits: their slot, plus the author's manual nudge. */
export function placedPosition(
	index: number,
	count: number,
	offset: { offsetX: number; offsetY: number } | undefined,
): Slot {
	const slot = radialSlot(index, count);
	return {
		x: slot.x + (offset?.offsetX ?? 0),
		y: slot.y + (offset?.offsetY ?? 0),
	};
}

/** True when the author has moved this character by hand. */
export function isNudged(offset: { offsetX: number; offsetY: number } | undefined): boolean {
	return Boolean(offset && (offset.offsetX !== 0 || offset.offsetY !== 0));
}
