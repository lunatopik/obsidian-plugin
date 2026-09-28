import type { Pawn, ResolvedPawn } from "./types";

/** Maximum number of symbols a pawn token can display. */
export const MAX_INITIALS = 3;

/**
 * What `initialsFromName` returns for an empty name. It is a display
 * placeholder, never a value worth saving into data.json.
 */
export const PLACEHOLDER_INITIALS = "?";

/** Palette used to hand out colors to newly created pawns. */
export const PAWN_PALETTE = [
	"#e05c5c",
	"#e08a3c",
	"#d9b23c",
	"#5cb85c",
	"#3cb8a0",
	"#4a90d9",
	"#7b6bd9",
	"#c65ca8",
] as const;

/**
 * Cyrillic -> Latin transliteration so that ids stay ascii and readable in YAML
 * (`"Том Уильямс"` -> `"tom-uilms"`). Non-Cyrillic input is passed through.
 */
const TRANSLIT: Record<string, string> = {
	а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
	и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
	с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
	ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Normalize any name into a safe, url-friendly pawn id. */
export function slugify(name: string): string {
	const transliterated = name
		.toLowerCase()
		.split("")
		.map((char) => (char in TRANSLIT ? TRANSLIT[char] : char))
		.join("");

	const slug = transliterated
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return slug || "pawn";
}

/** Ensure the generated id does not collide with an existing pawn. */
export function uniquePawnId(base: string, pawns: Pawn[]): string {
	const taken = new Set(pawns.map((pawn) => pawn.id));
	if (!taken.has(base)) return base;

	let suffix = 2;
	while (taken.has(`${base}-${suffix}`)) suffix += 1;
	return `${base}-${suffix}`;
}

/**
 * Auto-generate initials from a name: one symbol per word, up to two words.
 * Single-word names fall back to the first two characters so that short
 * western names ("Ed") still get a readable two-letter token.
 */
export function initialsFromName(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return PLACEHOLDER_INITIALS;
	if (words.length === 1) return words[0].slice(0, 2);
	return `${words[0][0]}${words[1][0]}`;
}

/**
 * Sanitize user-typed initials: no whitespace, no line breaks, at most
 * MAX_INITIALS symbols. Falls back to the auto-generated value when emptied.
 */
export function clampInitials(raw: string, fallbackName: string): string {
	const cleaned = raw.replace(/\s+/g, "").slice(0, MAX_INITIALS);
	return cleaned || initialsFromName(fallbackName);
}

/** Deterministic hsl -> hex, so an unknown token always looks the same. */
function hslToHex(h: number, s: number, l: number): string {
	const sat = s / 100;
	const lig = l / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = sat * Math.min(lig, 1 - lig);
	const channel = (n: number) => {
		const value = lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
		return Math.round(255 * value)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Stable color for a token that is not in the roster yet. */export function colorForToken(token: string): string {
	let hash = 0;
	for (let i = 0; i < token.length; i += 1) {
		hash = (hash << 5) - hash + token.charCodeAt(i);
		hash |= 0;
	}
	const hue = Math.abs(hash) % 360;
	return hslToHex(hue, 55, 45);
}

/** Next palette color that is not used by any existing pawn. */
export function nextPawnColor(pawns: Pawn[]): string {
	const used = new Set(pawns.map((pawn) => pawn.color.toLowerCase()));
	return PAWN_PALETTE.find((color) => !used.has(color.toLowerCase())) ?? colorForToken(String(pawns.length));
}

/**
 * Rough luminance test, used to decide whether initials on a token need dark
 * text. Accepts any `#rgb`/`#rrggbb` value; anything else is treated as dark.
 */
export function isLightColor(hex: string): boolean {
	const normalized = hex.replace("#", "").trim();
	const full =
		normalized.length === 3
			? normalized
					.split("")
					.map((char) => char + char)
					.join("")
			: normalized;
	if (full.length !== 6) return false;

	const r = Number.parseInt(full.slice(0, 2), 16);
	const g = Number.parseInt(full.slice(2, 4), 16);
	const b = Number.parseInt(full.slice(4, 6), 16);
	if ([r, g, b].some(Number.isNaN)) return false;

	return (r * 299 + g * 587 + b * 114) / 1000 > 165;
}

/**
 * The initials classes a token needs, as one class string.
 *
 * An explicit `textColor` wins outright, which is the whole point of setting
 * it: the automatic test can only look at the solid colour and has no idea what
 * the avatar image behind it actually looks like. With no explicit choice the
 * automatic answer stands, so a pawn saved before the field existed keeps the
 * contrast it was created with.
 */
export function textColorClasses(pawn: Pawn | null, background: string): string {
	const explicit = pawn?.textColor;
	if (explicit) return `text-${explicit}`;
	return isLightColor(background) ? "is-light" : "";
}

/** Build a fresh pawn from a name; all other fields get sensible defaults. */
export function createPawn(name: string, pawns: Pawn[]): Pawn {
	const trimmed = name.trim();
	return {
		id: uniquePawnId(slugify(trimmed), pawns),
		name: trimmed,
		initials: initialsFromName(trimmed),
		color: nextPawnColor(pawns),
	};
}

/**
 * Create the pawn that will actually be stored.
 *
 * A draft coming from the roster editor starts life with the "?" placeholder,
 * so an override carrying "?" means "the writer never got to this field" and
 * must not win over the initials derived from the name.
 */
export function composePawn(name: string, pawns: Pawn[], overrides?: Partial<Pawn>): Pawn | null {
	const trimmed = name.trim();
	if (!trimmed) return null;

	const base = createPawn(trimmed, pawns);
	const wanted = overrides?.initials;
	return updatePawn(base, {
		name: trimmed,
		initials: wanted && wanted !== PLACEHOLDER_INITIALS ? wanted : base.initials,
		color: overrides?.color ?? base.color,
		avatar: overrides?.avatar,
		notePath: overrides?.notePath,
		// Listed field by field on purpose: an override that is not named here is
		// simply dropped, which is how a colour chosen in the editor used to
		// disappear the moment the pawn was created.
		textColor: overrides?.textColor,
	});
}

/** Apply a patch while keeping invariants (non-empty id, clamped initials). */
export function updatePawn(pawn: Pawn, patch: Partial<Omit<Pawn, "id">>): Pawn {
	const next: Pawn = { ...pawn, ...patch };
	next.name = patch.name !== undefined ? patch.name.trim() : pawn.name;
	next.initials = clampInitials(
		patch.initials !== undefined ? patch.initials : pawn.initials,
		next.name,
	);
	next.color = patch.color !== undefined ? patch.color : pawn.color;
	next.avatar = patch.avatar !== undefined ? (patch.avatar || undefined) : pawn.avatar;
	next.notePath = patch.notePath !== undefined ? (patch.notePath || undefined) : pawn.notePath;
	// An empty string means "back to automatic", so it has to clear the field
	// rather than store a colour that does not exist.
	next.textColor = patch.textColor !== undefined ? (patch.textColor || undefined) : pawn.textColor;
	return next;
}

/** Remove a pawn by id. Returns a new array (settings are immutable). */
export function removePawn(pawns: Pawn[], id: string): Pawn[] {
	return pawns.filter((pawn) => pawn.id !== id);
}

/** Index the roster by id for O(1) lookups while rendering. */
export function indexPawns(pawns: Pawn[]): Map<string, Pawn> {
	return new Map(pawns.map((pawn) => [pawn.id, pawn]));
}

/**
 * Resolve a `chars[]` token against the roster.
 *
 * Primary key is the pawn id (what the plugin writes). The name lookup is a
 * compatibility fallback so that hand-written chapters such as
 * `chars: ["ГГ", "Друг"]` keep working without a migration step.
 */
export function resolveToken(token: string, index: Map<string, Pawn>, pawns: Pawn[]): ResolvedPawn {
	const byId = index.get(token);
	if (byId) return { token, pawn: byId };

	const lower = token.trim().toLowerCase();
	const byName = pawns.find((pawn) => pawn.name.toLowerCase() === lower);
	return { token, pawn: byName ?? null };
}

/** Display name for a resolved (or unresolved) token. */
export function resolvedName(resolved: ResolvedPawn): string {
	return resolved.pawn?.name ?? resolved.token;
}
