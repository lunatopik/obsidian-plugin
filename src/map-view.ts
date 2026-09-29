import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type WriterStateMapPlugin from "../main";
import { pickFromList, pickImage } from "./pickers";
import {
	addNode,
	addZone,
	deleteNode,
	ensureMap,
	hasMap,
	moveCharOffsets,
	moveNode,
	readMap,
	renameNode,
	replaceNodeToken,
	setBackground,
	setCanvasSize,
	setCharOffset,
	setNodeAnchor,
	setNodeParent,
	setParentChapter,
	setPawnOnNode,
	setZoneFill,
	setZoneOutline,
} from "./store";
import type { MapNode, Pawn, ZonePoint } from "./types";
import {
	childrenOf,
	collectCast,
	levelNodes,
	nodeById,
	sunLayout,
	zoneAt,
	zoneSelfIntersects,
	zoneToPoints,
	isZone,
} from "./hierarchy";
import { clampInitials, colorForToken, indexPawns, initialsFromName, resolveToken, textColorClasses } from "./pawns";
import { isNudged, placedPosition } from "./layout";
import { basename, inheritFrom, parentCandidates, parentIsStale, previewInherit } from "./inherit";
import { RelationshipPanel } from "./relationship-panel";

export const VIEW_TYPE_MAP = "writer-state-map-map";

/** Pointer travel (screen px) after which a pointer-down becomes a drag. */
const DRAG_THRESHOLD = 4;

/**
 * How close (screen px) a click has to be to the first corner to close an outline.
 *
 * In screen pixels, not canvas ones, because this is a "did you mean to click
 * there?" tolerance and the writer is aiming with a cursor, not with numbers. The
 * caller divides by the scale; a map scaled to 0.3 therefore keeps the same
 * finger-sized target instead of shrinking to a few pixels.
 */
const CLOSE_RADIUS = 12;

/**
 * Half the side of the box the spoke layer occupies around a pin.
 *
 * The spokes hang off a 0x0 anchor, so the SVG used to be 0x0 as well and every
 * line relied on `overflow: visible` surviving on a zero-sized viewport. When it
 * did not, the threads vanished while the avatars stayed. A real box removes the
 * question: the pin sits at the centre of the box and each line runs from there
 * to its own avatar, so nothing can be clipped no matter where a character is
 * nudged.
 *
 * It has to be big enough for the widest ring at the smallest usable scale. The
 * ring never exceeds MAX_RADIUS (120 screen px) and a 1024px canvas in a 320px
 * sidebar scales by ~0.31, so 120 / 0.31 ≈ 390 stage px — a 2048px half-width
 * leaves room for the map to be scaled down several times further.
 *
 * The same number is in styles.css as `left`/`top` and the width/height of
 * `.wsp-spokes`; a test compares the two so they cannot drift apart.
 */
const SPOKE_VIEWPORT = 2048;

/**
 * What a drag is moving. The pin moves the location, an avatar moves one
 * character, and the spokes area moves the whole fan as a rigid shape.
 */
type DragMode = "node" | "char" | "fan";

/**
 * What a click on empty stage space means right now.
 *
 * A mode rather than a boolean because the two drawing tools have to coexist in
 * one toolbar, and the "add a location by double-clicking" gesture is the default
 * that has to be switched *off* while a zone is being drawn — otherwise the two
 * halves of that double-click would place a location and a zone corner at the
 * same pixel.
 */
type MapTool = "none" | "zone" | "anchor";

/** One avatar in a ring, with the elastic thread that follows it. */
interface AvatarHandle {
	token: string;
	el: HTMLElement;
	spoke: SVGLineElement | null;
	/** Canvas-px position at the moment the drag started. */
	startX: number;
	startY: number;
}

interface DragState {
	mode: DragMode;
	nodeId: string;
	/** The element that follows the pointer. */
	el: HTMLElement;
	startX: number;
	startY: number;
	moved: boolean;
	/** "node": where the location was before the drag. */
	originX: number;
	originY: number;
	/** "char": the character being dragged. */
	token: string;
	/** Current travel in canvas px, recomputed on every pointermove. */
	deltaX: number;
	deltaY: number;
	/**
	 * The same travel in *screen* px, which is what a stored nudge is measured
	 * in: `placedPosition` speaks screen px and the layout divides by the scale
	 * only afterwards. Persisting the canvas figure would divide it a second
	 * time, and a character would drift towards its slot as the sidebar
	 * narrowed — the one thing a hand-placed avatar must never do.
	 */
	screenDeltaX: number;
	screenDeltaY: number;
	avatars: AvatarHandle[];
}

/**
 * The map tab.
 *
 * Layout strategy: the stored coordinates are expressed in "canvas pixels" of a
 * fixed design surface. The whole surface is scaled down with a CSS transform so
 * it always fits the (usually narrow) right sidebar, while the pin and the
 * avatars are counter-scaled by `1/k`. That keeps them readable no matter how
 * small the sidebar is.
 *
 * A location is a small pin, and its characters are avatars in a ring around it
 * joined by thin elastic spokes — a sun on a rubber band. The ring radius is
 * authored in screen pixels (see layout.ts) so the gap between two neighbours
 * survives any sidebar width, and each avatar can be dragged off its slot; the
 * nudge is stored on the node and survives reopening the chapter.
 *
 * Zones are the other half. A zone is an outline the writer clicked out and a
 * container: clicking it goes in, and the pins that come out are its children.
 * The level on screen is chosen by `nodeIds` — a stack of zone ids, empty for the
 * top of the chapter — and everything rendered is read through `levelNodes`, so
 * "what is on screen" and "what is stored" cannot drift apart.
 *
 * The view only ever knows the chapter's path. Map data comes from the plugin's
 * data.json through the store; the note itself is never opened.
 */
export class MapView extends ItemView {
	private root!: HTMLElement;
	private fileLabel!: HTMLElement;
	private hintEl!: HTMLElement;
	private toolsEl!: HTMLElement;
	/** Disabled while there is no background, so it cannot be clicked for nothing. */
	private clearBgButton!: HTMLButtonElement;
	/** Disabled while there is no chapter open, so it cannot wipe nothing. */
	private forgetButton!: HTMLButtonElement;
	private wrapEl!: HTMLElement;
	private sizerEl!: HTMLElement;
	private stageEl!: HTMLElement;
	private bgImg!: HTMLImageElement;
	/**
	 * The zone outlines, in one SVG that spans the whole stage.
	 *
	 * A separate layer rather than per-zone elements because an outline is a
	 * polygon, and a `<div>` cannot be one. It sits under `nodesEl` so pins and
	 * suns paint over it, and it is the only part of the stage that is *not*
	 * counter-scaled — a shape has to grow and shrink with the map, or it would
	 * stop tracing the border the writer drew.
	 */
	private zonesEl!: SVGSVGElement;
	private nodesEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private crumbsEl!: HTMLElement;
	/** Floats over the map's top-right corner, inside the scroll container. */
	private backEl!: HTMLButtonElement;
	private provenanceEl: HTMLElement | null = null;
	private popoverEl: HTMLElement | null = null;

	private path: string | null = null;
	private map = readMap({}, null, { width: 1024, height: 768 });
	/** Set when `map_bg` points at a file that cannot be resolved. */
	private brokenBg: string | null = null;
	private scale = 1;
	private scaleApplied = false;
	private scaledWidth = "";
	private scaledHeight = "";
	private drag: DragState | null = null;
	private resizeObserver: ResizeObserver | null = null;

	/* ---- where we are inside the map, and what a click will do ---- */

	/**
	 * The chain of zones the writer has gone into, outermost first.
	 *
	 * Session state on purpose: it belongs to this sitting in front of the map, not
	 * to the story. Reopening the chapter in a week should open the world, not drop
	 * you inside a tavern three levels down, and nothing in data.json should have
	 * to be written to remember a place nobody asked to remember.
	 */
	private nodeIds: string[] = [];
	/**
	 * Where the writer has been, so "Back" can mean something.
	 *
	 * Every descent is recorded, including one made from a breadcrumb: the trail is
	 * the only way out of a deep level once the labels are all off-screen, and a
	 * breadcrumb that cannot be undone is a trap.
	 */
	private history: string[][] = [];
	private tool: MapTool = "none";
	/** Corners placed so far by the zone tool. Empty unless the tool is active. */
	private draftCorners: ZonePoint[] = [];
	/**
	 * The zone a live draft is replacing, or null when a new one is being drawn.
	 *
	 * Separate from `draftCorners` because "drawing" and "redrawing" differ only in
	 * what happens at the end, and keeping them in one variable would mean a flag
	 * checked in three places. It is nulled by `cancelTool`, so Escape abandons a
	 * redraw exactly as it abandons a new zone and leaves the old outline intact.
	 */
	private redrawingZoneId: string | null = null;
	private hoverZoneId: string | null = null;

	/**
	 * The relationship graph, shown over the map.
	 *
	 * Held rather than rebuilt per render so the panel keeps its half-finished
	 * pair while the writer edits the map behind the scrim, and so `closeOverlay`
	 * has something to hand back its pending pick to.
	 */
	private relOverlay: HTMLElement | null = null;
	private relPanel: RelationshipPanel | null = null;

	private readonly plugin: WriterStateMapPlugin;

	// Explicit field instead of a TS parameter property: the test suite runs
	// these files through Node's strip-only TypeScript, which rejects them.
	constructor(leaf: WorkspaceLeaf, plugin: WriterStateMapPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_MAP;
	}

	getDisplayText(): string {
		return this.plugin.t("viewMap");
	}

	getIcon(): string {
		return "map";
	}

	/* ------------------------------------------------------------------ */
	/* Lifecycle                                                            */
	/* ------------------------------------------------------------------ */

	async onOpen(): Promise<void> {
		this.root = this.contentEl;
		this.root.empty();
		this.root.addClass("wsm-map");

		this.buildToolbar();
		this.buildStage();
		this.buildEmptyState();

		// The roster button lives in the toolbar row now, beside every other action
		// the map offers, so the view header keeps nothing but Obsidian's own.
		this.addAction("refresh-cw", "Refresh", () => this.refresh());

		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => this.applyScale());
			this.resizeObserver.observe(this.wrapEl);
		}

		// Always on, not tied to the popover: a half-drawn zone is exactly the state
		// where the writer reaches for Escape, and a listener that only exists while
		// a card is open would leave them stuck in a tool with no way out.
		document.addEventListener("keydown", this.onEscape);

		this.setChapter(this.plugin.activeChapterPath);
	}

	/**
	 * Escape backs out of the most recent thing, and the overlay is on top of the
	 * tools, so it goes first.
	 *
	 * One listener for the whole view rather than one per overlay, so the tool
	 * escape keeps working before and after the graph has been opened and closed
	 * a dozen times.
	 */
	private onEscape = (evt: KeyboardEvent): void => {
		if (evt.key !== "Escape") return;
		if (this.relOverlay) {
			this.closeRelationshipOverlay();
			evt.stopPropagation();
			return;
		}
		if (this.tool !== "none") {
			this.cancelTool();
			evt.stopPropagation();
		}
	};

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		document.removeEventListener("keydown", this.onEscape);
		this.cancelTool();
		this.closePopover();
		this.closeRelationshipOverlay();
	}

	/* ------------------------------------------------------------------ */
	/* The relationship overlay                                             */
	/* ------------------------------------------------------------------ */

	/**
	 * Show the relationship graph over the map.
	 *
	 * A scrim and a card rather than a tab, and not a popover either: the graph
	 * is a 320px canvas plus the list of every tie, and squeezing that into a
	 * 236px card anchored to a toolbar button turns the one thing the writer
	 * opened it to read into a scroll. The map stays mounted behind it, so
	 * closing the overlay puts the writer back exactly where they were.
	 *
	 * Pressing the button again closes it, the same as every other toggle in the
	 * toolbar.
	 */
	openRelationshipOverlay(): void {
		if (this.relOverlay) {
			this.closeRelationshipOverlay();
			return;
		}

		const overlay = this.root.createDiv({ cls: "wsm-overlay" });
		const card = overlay.createDiv({ cls: "wsm-overlay__card" });

		const head = card.createDiv({ cls: "wsm-overlay__head" });
		head.createDiv({ cls: "wsm-overlay__title", text: this.plugin.t("viewRelationship") });
		const close = head.createEl("button", { cls: "wsm-overlay__close" });
		setIcon(close, "x");
		close.title = this.plugin.t("relCancel");
		close.addEventListener("click", () => this.closeRelationshipOverlay());

		const body = card.createDiv({ cls: "wsm-overlay__body" });
		this.relPanel = new RelationshipPanel(body, this.plugin);

		// The scrim, not the card: clicking the card itself is reading, and a
		// click that lands on neither a vertex nor a row should not dismiss.
		overlay.addEventListener("click", (evt) => {
			if (evt.target === overlay) this.closeRelationshipOverlay();
		});

		this.relOverlay = overlay;
	}

	private closeRelationshipOverlay(): void {
		this.relPanel?.dispose();
		this.relPanel = null;
		this.relOverlay?.remove();
		this.relOverlay = null;
	}

	/* ------------------------------------------------------------------ */
	/* DOM construction                                                     */
	/* ------------------------------------------------------------------ */

	private buildToolbar(): void {
		const toolbar = this.root.createDiv({ cls: "wsm-map__toolbar" });
		this.fileLabel = toolbar.createDiv({ cls: "wsm-map__file" });

		// World → region → town, as buttons. Built here and filled by
		// `renderCrumbs`, because the trail changes on every descent.
		this.crumbsEl = toolbar.createDiv({ cls: "wsm-map__crumbs" });

		this.hintEl = toolbar.createDiv({ cls: "wsm-map__hint" });

		this.toolsEl = toolbar.createDiv({ cls: "wsm-map__tools" });
		const bgButton = this.toolsEl.createEl("button", { cls: "wsm-map__tool" });
		setIcon(bgButton, "image");
		bgButton.title = this.plugin.t("mapSetBackground");
		bgButton.addEventListener("click", () => void this.chooseBackground());

		this.clearBgButton = this.toolsEl.createEl("button", { cls: "wsm-map__tool" });
		setIcon(this.clearBgButton, "image-off");
		this.clearBgButton.title = this.plugin.t("mapClearBackground");
		this.clearBgButton.addEventListener("click", () => this.clearBackground());

		const zoneTool = this.toolsEl.createEl("button", { cls: "wsm-map__tool" });
		setIcon(zoneTool, "hexagon");
		zoneTool.title = this.plugin.t("mapDrawZone");
		zoneTool.dataset.tool = "zone";
		zoneTool.addEventListener("click", () => this.toggleTool("zone"));

		const anchorTool = this.toolsEl.createEl("button", { cls: "wsm-map__tool" });
		setIcon(anchorTool, "crosshair");
		anchorTool.title = this.plugin.t("mapPlaceAnchor");
		anchorTool.dataset.tool = "anchor";
		anchorTool.addEventListener("click", () => this.toggleTool("anchor"));

		// The single command centre: everything the plugin can do from one row,
		// so the sidebar carries two tabs instead of four.
		const noteButton = this.toolsEl.createEl("button", { cls: "wsm-map__tool" });
		setIcon(noteButton, "file-text");
		noteButton.title = this.plugin.t("viewNote");
		noteButton.addEventListener("click", () => void this.plugin.openNote());

		const relButton = this.toolsEl.createEl("button", { cls: "wsm-map__tool" });
		setIcon(relButton, "git-fork");
		relButton.title = this.plugin.t("viewRelationship");
		relButton.addEventListener("click", () => this.openRelationshipOverlay());

		const rosterButton = this.toolsEl.createEl("button", { cls: "wsm-map__tool" });
		setIcon(rosterButton, "users");
		rosterButton.title = this.plugin.t("viewRoster");
		rosterButton.addEventListener("click", () => void this.plugin.openTab("roster"));

		// Last, and the only destructive one: it is the button a mis-click costs
		// the most, so it gets the end of the row rather than a place among the
		// everyday ones.
		this.forgetButton = this.toolsEl.createEl("button", { cls: "wsm-map__tool wsm-map__tool--danger" });
		setIcon(this.forgetButton, "trash-2");
		this.forgetButton.title = this.plugin.t("commandForgetChapter");
		this.forgetButton.addEventListener("click", () => void this.forgetChapter());
	}

	/**
	 * Empty this chapter's map, after asking.
	 *
	 * The plugin owns the confirmation because it owns the data: it removes the
	 * chapter's record and nothing else. The map tab stays open on purpose — the
	 * writer's next move is almost always to draw a new map, and a tab that
	 * vanished under the cursor would read as the app having closed itself. The
	 * roster is global and is never touched.
	 */
	private forgetChapter(): void {
		void this.plugin.forgetChapter();
	}

	/**
	 * Take the background away, and the size that came with it.
	 *
	 * Clearing only the image would leave the canvas at the picture's dimensions,
	 * which after a large map means an enormous field of empty grid with a few
	 * pins in one corner. The size was the image's, so it goes with the image and
	 * the map falls back to the canvas configured in the plugin settings.
	 */
	private clearBackground(): void {
		const path = this.path;
		if (!path) return;

		this.plugin.updateMap(path, (maps, p) => {
			setBackground(maps, p, null);
			setCanvasSize(maps, p, null);
		});
		this.refresh();
	}

	private buildStage(): void {
		this.wrapEl = this.root.createDiv({ cls: "wsm-map__wrap" });

		// The sizer reserves the *scaled* footprint so the scroll container knows
		// how much room the transform-free layout needs; the stage itself is
		// absolutely positioned inside it.
		this.sizerEl = this.wrapEl.createDiv({ cls: "wsm-map__sizer" });
		this.stageEl = this.sizerEl.createDiv({ cls: "wsm-map__stage" });
		this.stageEl.style.setProperty("--wsm-inv", "1");

		this.bgImg = this.stageEl.createEl("img", { cls: "wsm-map__bg" });
		this.bgImg.alt = "";

		// Outlines, then the stuff that sits on top of them. One SVG for the whole
		// level: a polygon per zone, each sized by the stage rather than by its own
		// shape, so a zone anywhere on a 4000px canvas is drawn by the same code.
		this.zonesEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.zonesEl.setAttribute("class", "wsm-zones");
		this.stageEl.appendChild(this.zonesEl);

		this.nodesEl = this.stageEl.createDiv({ cls: "wsm-map__nodes" });

		// "Back" floats over the map rather than living in the toolbar: once you are
		// four levels down and scrolled away from the toolbar row, a button that is
		// itself in the scroll flow is exactly where you cannot reach.
		this.backEl = this.wrapEl.createEl("button", { cls: "wsm-map__back" });
		setIcon(this.backEl, "arrow-left");
		this.backEl.createSpan({ text: this.plugin.t("mapBack") });
		this.backEl.addEventListener("click", () => this.goBack());

		// The stage, not `nodesEl`: a click that misses every pin has to reach the
		// handler, and the zone SVG is painted between the two. The zone tool needs
		// every click, and hover needs the whole surface.
		this.stageEl.addEventListener("dblclick", (evt) => this.onStageDoubleClick(evt));
		this.stageEl.addEventListener("click", (evt) => this.onStageClick(evt));
		this.stageEl.addEventListener("pointermove", (evt) => this.onStagePointerMove(evt));
		this.stageEl.addEventListener("pointerleave", () => this.clearZoneHover());
	}

	/**
	 * Where this map came from, and the two things the writer can do about it.
	 *
	 * A record, not a live link: nothing is re-copied when the source changes.
	 * That is what makes "Сменить источник" safe to offer — it only re-points the
	 * provenance — and it is why a renamed source shows up here as a line to fix
	 * rather than as a layout that quietly reset itself.
	 */
	private renderProvenance(): void {
		this.provenanceEl?.remove();
		this.provenanceEl = null;

		const path = this.path;
		if (!path) return;

		const parent = this.map.parentChapterId;
		if (!parent) return;

		const stale = parentIsStale(this.plugin.settings.maps, path);
		const row = this.root.createDiv({ cls: "wsm-map__from" });
		if (stale) row.addClass("is-stale");
		this.provenanceEl = row;

		const text = stale
			? this.plugin.t("mapParentMissing")
			: this.plugin.t("mapInheritedFrom", { path: basename(parent) });
		row.createSpan({ cls: "wsm-map__from-text", text });

		const change = row.createEl("button", { cls: "wsm-map__from-btn" });
		change.createSpan({ text: this.plugin.t("mapChangeParent") });
		change.addEventListener("click", () => void this.chooseParent());

		// Forgetting the source leaves the layout exactly as it is. It only says
		// "I built this myself", which is sometimes the truth after heavy editing.
		const forget = row.createEl("button", { cls: "wsm-map__from-btn wsm-map__from-btn--icon" });
		setIcon(forget, "x");
		forget.title = this.plugin.t("mapForgetParent");
		forget.addEventListener("click", () => this.forgetParent());
	}

	private async chooseParent(): Promise<void> {
		const path = this.path;
		if (!path) return;

		const candidates = parentCandidates(this.plugin.settings.maps, path);
		if (candidates.length === 0) {
			new Notice(this.plugin.t("noticeNoOrphans"));
			return;
		}

		const chosen = await pickFromList(
			this.app,
			this.plugin.settings.language,
			candidates.map(basename),
			"mapPickParent",
		);
		// The list shows names, not paths, so the choice comes back as a name and
		// has to be matched against the paths. First match wins, which is the
		// same rule the picker itself shows.
		const parent = chosen ? candidates.find((key) => basename(key) === chosen) : undefined;
		if (!parent) return;

		this.plugin.updateMap(path, (maps, p) => setParentChapter(maps, p, parent));
		this.refresh();
		new Notice(this.plugin.t("noticeParentSet", { path: basename(parent) }));
	}

	private forgetParent(): void {
		const path = this.path;
		if (!path) return;

		this.plugin.updateMap(path, (maps, p) => setParentChapter(maps, p, null));
		this.refresh();
		new Notice(this.plugin.t("noticeParentCleared"));
	}

	private buildEmptyState(): void {
		this.emptyEl = this.root.createDiv({ cls: "wsm-map__empty" });
	}

	/* ------------------------------------------------------------------ */
	/* Data                                                                 */
	/* ------------------------------------------------------------------ */

	/** Called by the plugin whenever the active chapter changes. */
	setChapter(path: string | null): void {
		this.path = path;
		// Another chapter is a different place, whatever the level was here. The
		// zone ids in the stack belong to the old map and mean nothing in the new
		// one, so the walk starts again at its world.
		this.nodeIds = [];
		this.history = [];
		this.cancelTool();
		this.closePopover();
		this.refresh();
	}

	/** Re-read the map from data.json and repaint. */
	refresh(): void {
		this.map = readMap(this.plugin.settings.maps, this.path, this.plugin.settings.defaultCanvas);
		this.pruneNavigation();
		this.fileLabel.setText(this.path ? basename(this.path) : "");
		// Nothing to remove means nothing to click.
		this.clearBgButton.disabled = !this.map.bg;
		// Same for the map itself: with no chapter open, or a chapter that was
		// never mapped, there is no record to forget. A button that confirms a
		// deletion of nothing is worse than a greyed-out one.
		this.forgetButton.disabled = !hasMap(this.plugin.settings.maps, this.path);
		// The overlay is a child of this view now, so it repaints with it. It
		// used to be a tab with its own vault subscription; routing the change
		// through refresh keeps exactly one listener and one source of truth, and
		// an open overlay that did not follow a rename would show stale names.
		this.relPanel?.onExternalChange();
		this.renderBackground();
		this.renderCrumbs();
		this.renderZones();
		this.renderNodes();
		// After the pins, not before: `renderNodes` empties the layer it writes to,
		// so a zone's name and sun drawn earlier would be swept away with the pins.
		this.renderZoneNodes();
		this.renderDraft();
		this.renderEmptyState();
		this.renderProvenance();
		this.applyScale();
	}

	/* ------------------------------------------------------------------ */
	/* Walking in and out of zones                                          */
	/* ------------------------------------------------------------------ */

	/** The pins and zones on the level the writer is currently looking at. */
	private currentLevel(): MapNode[] {
		return levelNodes(this.map.nodes, this.nodeIds);
	}

	/** The zone being looked at, if the level is inside one. */
	private currentZone(): MapNode | null {
		const top = this.nodeIds[this.nodeIds.length - 1];
		return top ? nodeById(this.map.nodes, top) : null;
	}

	/**
	 * Drop the trail down to levels that still exist.
	 *
	 * Deleting a region while standing inside it used to be the one way to end up
	 * staring at an empty map with no way back: the id on the stack names nothing,
	 * so nothing could be drawn and no breadcrumb could be pressed. `levelNodes`
	 * already falls back a level when the id is gone, but the stack itself would
	 * keep the dead id in the trail, so it is trimmed here.
	 */
	private pruneNavigation(): void {
		const alive = this.nodeIds.filter((id) => nodeById(this.map.nodes, id) !== null);
		if (alive.length === this.nodeIds.length) return;
		this.nodeIds = alive;
	}

	/**
	 * Step into a zone.
	 *
	 * Refuses a zone that is not a zone, so a click that reaches this from a
	 * keyboard or a test cannot produce a stack pointing at a pin.
	 */
	private goInto(nodeId: string): void {
		const node = nodeById(this.map.nodes, nodeId);
		if (!node || !isZone(node)) return;
		if (this.nodeIds[this.nodeIds.length - 1] === nodeId) return;

		// The trail is recorded *before* moving, so Back returns to the level the
		// writer actually came from rather than to a level computed afterwards.
		this.history.push([...this.nodeIds]);
		this.nodeIds.push(nodeId);
		this.closePopover();
		this.cancelTool();
		this.refresh();
	}

	/**
	 * Leave the current zone.
	 *
	 * Undoes the last descent, which is not always the last thing the writer did:
	 * two descents in a row and one Back should put them two levels out, not one.
	 */
	private goBack(): void {
		const previous = this.history.pop();
		if (!previous) return;
		this.nodeIds = previous;
		this.closePopover();
		this.cancelTool();
		this.refresh();
	}

	/** Jump straight to a level from the breadcrumb trail. */
	private goToLevel(depth: number): void {
		const target = depth <= 0 ? [] : this.nodeIds.slice(0, depth);
		if (target.length === this.nodeIds.length) return;

		this.history.push([...this.nodeIds]);
		this.nodeIds = target;
		this.closePopover();
		this.cancelTool();
		this.refresh();
	}

	/**
	 * World → region → town, as buttons.
	 *
	 * The last crumb is the level being shown and is not a button: pressing it
	 * would have to be a no-op, and a control that does nothing when pressed is
	 * worse than a piece of text.
	 */
	private renderCrumbs(): void {
		this.crumbsEl.empty();
		if (!this.path) return;

		const entries: { label: string; depth: number }[] = [
			{ label: this.plugin.t("mapLevelWorld"), depth: 0 },
		];
		for (let i = 0; i < this.nodeIds.length; i += 1) {
			const node = nodeById(this.map.nodes, this.nodeIds[i]);
			// A missing crumb is dropped rather than shown as a blank: `pruneNavigation`
			// will have removed it from the stack by the time this runs, so this only
			// happens if a node has no label at all.
			if (!node) continue;
			entries.push({ label: node.label ?? node.id, depth: i + 1 });
		}

		entries.forEach((entry, index) => {
			if (index > 0) this.crumbsEl.createSpan({ cls: "wsm-map__crumb-sep", text: "/" });
			const isLast = index === entries.length - 1;
			if (isLast) {
				this.crumbsEl.createSpan({ cls: "wsm-map__crumb is-current", text: entry.label });
				return;
			}
			const button = this.crumbsEl.createEl("button", { cls: "wsm-map__crumb", text: entry.label });
			button.addEventListener("click", () => this.goToLevel(entry.depth));
		});

		this.backEl.toggleClass("is-hidden", this.history.length === 0);
		this.backEl.disabled = this.history.length === 0;
	}

	/* ------------------------------------------------------------------ */
	/* Background                                                           */
	/* ------------------------------------------------------------------ */

	private resolveVaultFile(path: string): TFile | null {
		const direct = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (direct instanceof TFile) return direct;

		// Fall back to link resolution so a bare `world.png` works from any folder.
		const linked = this.app.metadataCache.getFirstLinkpathDest(path, this.path ?? "");
		return linked instanceof TFile ? linked : null;
	}

	private async chooseBackground(): Promise<void> {
		const path = this.path;
		if (!path) return;

		const file = await pickImage(this.app, this.plugin.settings.language);
		if (!file) return;

		this.plugin.updateMap(path, (maps, p) => setBackground(maps, p, file.path));
		this.refresh();
	}

	private renderBackground(): void {
		this.stageEl.removeClass("is-broken");
		this.brokenBg = null;

		if (!this.map.bg) {
			// No background chosen: show a neutral grid so nodes still have a home.
			this.bgImg.removeAttribute("src");
			this.stageEl.addClass("is-placeholder");
			return;
		}

		const bgFile = this.resolveVaultFile(this.map.bg);
		if (!bgFile) {
			this.brokenBg = this.map.bg;
			this.bgImg.removeAttribute("src");
			this.stageEl.removeClass("is-placeholder");
			return;
		}

		this.stageEl.removeClass("is-placeholder");
		this.bgImg.onload = () => {
			// Without an explicit map_size the image's natural size defines the canvas.
			if (!this.map.hasExplicitSize && this.bgImg.naturalWidth > 0) {
				this.map.canvas = { width: this.bgImg.naturalWidth, height: this.bgImg.naturalHeight };
				this.applyScale();
			}
		};
		this.bgImg.src = this.app.vault.getResourcePath(bgFile);
	}

	/* ------------------------------------------------------------------ */
	/* Scale                                                                */
	/* ------------------------------------------------------------------ */

	private applyScale(): void {
		// The sizer is the scrollable content, so its width is the real budget.
		const available = this.wrapEl.clientWidth;
		if (available <= 0) return;

		const k = Math.min(1, available / this.map.canvas.width);
		const scale = k > 0 ? k : 1;
		const canvasWidth = `${this.map.canvas.width}px`;
		const canvasHeight = `${this.map.canvas.height}px`;
		const scaledWidth = `${Math.round(this.map.canvas.width * scale)}px`;
		const scaledHeight = `${Math.round(this.map.canvas.height * scale)}px`;

		// Bail out when nothing changed, otherwise the ResizeObserver that
		// triggered this call would keep re-triggering itself.
		if (
			this.scaleApplied &&
			this.scaledWidth === scaledWidth &&
			this.scaledHeight === scaledHeight &&
			this.stageEl.style.width === canvasWidth &&
			this.stageEl.style.height === canvasHeight
		) {
			return;
		}
		this.scaleApplied = true;
		this.scale = scale;
		this.scaledWidth = scaledWidth;
		this.scaledHeight = scaledHeight;

		this.stageEl.style.setProperty("--wsm-inv", String(1 / scale));
		this.stageEl.style.width = canvasWidth;
		this.stageEl.style.height = canvasHeight;
		this.stageEl.style.transform = `scale(${scale})`;

		// The sizer reserves the scaled footprint; the stage is taken out of flow
		// and painted on top of it, so the transform never affects layout.
		this.sizerEl.style.width = scaledWidth;
		this.sizerEl.style.height = scaledHeight;
	}

	/** Convert a pointer event into canvas coordinates. */
	private toCanvasCoords(evt: MouseEvent | PointerEvent): { x: number; y: number } {
		const rect = this.stageEl.getBoundingClientRect();
		return {
			x: (evt.clientX - rect.left) / this.scale,
			y: (evt.clientY - rect.top) / this.scale,
		};
	}

	/* ------------------------------------------------------------------ */
	/* Tools: draw a zone, place an anchor                                  */
	/* ------------------------------------------------------------------ */

	/**
	 * Turn a drawing tool on, or off if it is already the current one.
	 *
	 * A toggle rather than a one-way switch because a tool with no off switch is
	 * a trap: the next double-click on empty canvas would place a zone corner where
	 * the writer meant to put a location, and there would be no visible state that
	 * explains it.
	 */
	private toggleTool(tool: MapTool): void {
		if (this.tool === tool) {
			this.cancelTool();
			return;
		}
		if (!this.path) return;
		if (!hasMap(this.plugin.settings.maps, this.path)) {
			new Notice(this.plugin.t("emptyCreateMap"));
			return;
		}

		this.tool = tool;
		this.draftCorners = [];
		this.redrawingZoneId = null;
		this.stageEl.toggleClass("is-drawing", tool !== "none");
		this.renderToolState();
		this.renderDraft();
	}

	/** Leave the tool, discarding anything half-drawn. */
	private cancelTool(): void {
		if (this.tool === "none" && this.draftCorners.length === 0) return;
		this.tool = "none";
		this.draftCorners = [];
		this.redrawingZoneId = null;
		this.stageEl.removeClass("is-drawing");
		this.renderToolState();
		this.renderDraft();
	}

	/** Reflect the active tool in the toolbar and the hint line. */
	private renderToolState(): void {
		for (const button of Array.from(this.toolsEl.querySelectorAll<HTMLElement>("[data-tool]"))) {
			button.toggleClass("is-active", button.dataset.tool === this.tool);
		}

		if (this.tool === "zone") {
			this.hintEl.setText(this.plugin.t("mapDrawZoneHint"));
			return;
		}
		if (this.tool === "anchor") {
			this.hintEl.setText(this.plugin.t("mapPlaceAnchorHint"));
			return;
		}
		// Back to the normal line: the level's own state, or nothing at all.
		this.renderHint();
	}

	/** The line under the toolbar that says what the current level expects. */
	private renderHint(): void {
		if (this.tool !== "none") return;
		if (!this.path) {
			this.hintEl.setText("");
			return;
		}
		if (this.currentLevel().length === 0) {
			this.hintEl.setText(this.plugin.t("emptyNoNodesHint"));
			return;
		}
		const zone = this.currentZone();
		if (!zone) {
			this.hintEl.setText("");
			return;
		}
		const count = childrenOf(this.map.nodes, zone.id).length;
		this.hintEl.setText(count === 0 ? this.plugin.t("popoverZoneEmpty") : "");
	}

	/**
	 * The outline being drawn, as a polygon plus one dot per corner.
	 *
	 * The rubber band is a *polygon* rather than a path so that closing it needs no
	 * separate "finish" gesture: the moment a third corner exists the shape is
	 * already closed, and the writer just has to look at it. A path with an open
	 * end would need a mode to close it, and a mode to close it is a mode to get
	 * stuck in.
	 */
	private renderDraft(): void {
		for (const el of Array.from(this.zonesEl.querySelectorAll(".wsm-draft"))) el.remove();

		if (this.draftCorners.length === 0) return;

		const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
		// `classList`, not `setAttribute("class", ...)`: a class set as an attribute
		// and a class set through the list are the same thing in a browser but not
		// in every DOM implementation, and the one that differs is the test's.
		poly.classList.add("wsm-zone", "wsm-draft");
		poly.setAttribute("points", zoneToPoints(this.draftCorners));
		poly.setAttribute("vector-effect", "non-scaling-stroke");
		this.zonesEl.appendChild(poly);

		this.draftCorners.forEach((corner, index) => {
			const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
			dot.classList.add("wsm-draft__corner");
			dot.setAttribute("cx", String(corner.x));
			dot.setAttribute("cy", String(corner.y));
			// The first corner closes the shape, so it is drawn larger than the rest.
			dot.setAttribute("r", index === 0 ? "7" : "4");
			// A screen-constant dot on a scaled-down stage, like the pin.
			dot.setAttribute("vector-effect", "non-scaling-stroke");
			this.zonesEl.appendChild(dot);
		});
	}

	/* ------------------------------------------------------------------ */
	/* Nodes                                                                */
	/* ------------------------------------------------------------------ */

	/**
	 * The outlines of every zone on this level.
	 *
	 * Rebuilt from scratch each time instead of diffed: a level holds a handful of
	 * shapes, and a polygon that survives a re-render with stale points is a hole
	 * in the world the writer believes they drew.
	 */
	private renderZones(): void {
		this.zonesEl.empty();
		// The SVG covers the design surface, and the stage is scaled down with a CSS
		// transform, so the outline scales with everything else and the border stays
		// where it was drawn.
		this.zonesEl.setAttribute("viewBox", `0 0 ${this.map.canvas.width} ${this.map.canvas.height}`);
		this.zonesEl.setAttribute("width", String(this.map.canvas.width));
		this.zonesEl.setAttribute("height", String(this.map.canvas.height));

		for (const node of this.currentLevel()) {
			if (!node.zone || node.zone.length < 3) continue;
			const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
			polygon.setAttribute("points", zoneToPoints(node.zone));
			polygon.classList.add("wsm-zone");
			polygon.dataset.zoneId = node.id;
			// Non-scaling keeps a one-pixel border a one-pixel border at every zoom.
			polygon.setAttribute("vector-effect", "non-scaling-stroke");
			// A zone you cannot click is a drawing, and a drawing cannot be walked
			// into. The listener is here rather than on the stage so that a click on
			// the outline says "inside this zone" without a raycast.
			//
			// The tool gate is the whole point of this handler. The polygon covers
			// the zone's area and `stopPropagation` would end the event here, so
			// while a tool is armed the click must be *let through* to the stage:
			// otherwise picking "place an anchor" and clicking the zone drills the
			// writer in and the tool appears broken. Only a click with no tool
			// armed means "go in", and only then is the event consumed.
			polygon.addEventListener("click", (evt) => {
				if (this.tool !== "none") return;
				evt.stopPropagation();
				this.goInto(node.id);
			});
			// Right-click opens the zone's card — name, colour, redraw, delete.
			// The left button is spoken for, and these are things a writer does to
			// a zone deliberately, not on the way to somewhere else.
			polygon.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				if (this.tool !== "none") return;
				this.openPopover(node.id, false);
			});
			if (node.fill) polygon.setAttribute("style", `--wsm-zone-fill: ${node.fill};`);
			if (node.id === this.hoverZoneId) polygon.classList.add("is-hover");
			this.zonesEl.appendChild(polygon);
		}
	}

	/**
	 * The names and suns of the zones on this level.
	 *
	 * A separate pass from `renderZones` because the two write to different layers
	 * with different lifetimes: the outlines live in the SVG, which is emptied and
	 * rebuilt, while the names and rings share the nodes layer with the pins, which
	 * is emptied on its own schedule. Running them in one function meant whichever
	 * came second silently deleted the other's output.
	 */
	private renderZoneNodes(): void {
		for (const node of this.currentLevel()) {
			if (!isZone(node)) continue;
			this.nodesEl.appendChild(this.buildZone(node));
			// A sibling, not a child of the label. The label is a small box with
			// `overflow: hidden` on it, so a sun nested inside was clipped to the
			// size of the name — which is a ring with no ring in it, on exactly the
			// zones that have a cast worth seeing.
			if (node.anchor) this.nodesEl.appendChild(this.buildSun(node));
		}
	}

	/**
	 * A zone's label.
	 *
	 * The label sits on the zone's own stored corner — the point the writer started
	 * drawing at, not the middle of the shape, because the middle is something the
	 * renderer would have invented.
	 *
	 * `data-node-id` as well as `data-zone-id`: the popover is anchored by looking
	 * the node up in the nodes layer, and a zone that only carried `data-zone-id`
	 * was not findable there, so the card could be built but never opened.
	 */
	private buildZone(node: MapNode): HTMLElement {
		const el = this.nodesEl.createDiv({ cls: "wsm-zone-label", text: node.label ?? node.id });
		el.style.left = `${node.x}px`;
		el.style.top = `${node.y}px`;
		el.dataset.zoneId = node.id;
		el.dataset.nodeId = node.id;
		el.title = node.label ?? node.id;

		// Clicking the name goes in, same as clicking the shape. A label that only
		// names the zone would force the writer to aim at the outline itself.
		// The tool gate, and the event left to bubble, for the reason given on the
		// polygon above: a click on the label lands here first.
		el.addEventListener("click", (evt) => {
			if (this.tool !== "none") return;
			evt.stopPropagation();
			this.goInto(node.id);
		});
		el.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			if (this.tool !== "none") return;
			this.openPopover(node.id, false);
		});

		return el;
	}

	/**
	 * Everyone inside a zone, in a ring around its anchor.
	 *
	 * The cast is gathered from the whole subtree rather than from this level, which
	 * is the point of a sun: standing in a region and seeing only the characters on
	 * the region itself would answer the wrong question. The cap is decided in
	 * `hierarchy.ts` and the remainder becomes a clickable count, because "there
	 * are more" is only useful if the more can be reached.
	 */
	private buildSun(node: MapNode): HTMLElement {
		const cast = collectCast(this.map.nodes, node.id);
		const layout = sunLayout(cast);

		const sun = this.nodesEl.createDiv({ cls: "wsm-sun" });
		sun.style.left = `${node.anchor?.x ?? node.x}px`;
		sun.style.top = `${node.anchor?.y ?? node.y}px`;

		// A zone with no cast gets no sun: an empty ring of nothing would read as
		// "nobody here", which is true, but it would also read as a control.
		if (layout.shown.length === 0) return sun;

		// The fan is built from a stand-in node so `buildFan` can stay the one place
		// that knows how a ring is drawn. The offsets are the zone's own, which is
		// correct: a hand-nudged avatar belongs to the ring it was nudged in.
		sun.appendChild(this.buildFan({ ...node, chars: layout.shown }).layer);

		if (layout.overflow) {
			const more = sun.createDiv({ cls: "wsm-sun__more", text: layout.overflow });
			more.title = this.plugin.t("mapSunOverflow", {
				count: collectCast(this.map.nodes, node.id).length - layout.shown.length,
			});
			// The count is a door, not a label: pressing it opens the level where the
			// remaining characters actually are. Gated like the polygon — an armed
			// tool owns the click, or the writer is placing an anchor and gets
			// teleported into a region instead.
			more.addEventListener("click", (evt) => {
				if (this.tool !== "none") return;
				evt.stopPropagation();
				this.goInto(node.id);
			});
		}

		return sun;
	}

	private renderNodes(): void {
		this.nodesEl.empty();
		// Only this level. Everything on other levels stays in data.json and comes
		// back when the writer walks into it, so one flat store and one focused view
		// never disagree about what exists.
		for (const node of this.currentLevel()) {
			if (isZone(node)) continue;
			this.nodesEl.appendChild(this.buildNode(node));
		}
	}

	private buildNode(node: MapNode): HTMLElement {
		// 0x0 anchor placed in canvas coordinates...
		const anchor = this.nodesEl.createDiv({ cls: "wsm-node" });
		anchor.style.left = `${node.x}px`;
		anchor.style.top = `${node.y}px`;
		anchor.dataset.nodeId = node.id;

		// The ring is appended first so the pin and its label paint on top of it.
		anchor.appendChild(this.buildFan(node).layer);

		// The pin and its label each centre on the anchor themselves. They used to
		// share one flex column, but centring a column of [label, pin] puts the pin
		// half a label below the real coordinates, and the pin is the location: the
		// whole map hangs off that one point.
		//
		// Both are counter-scaled by `1/k` like everything else on the stage.
		// `data-drag="node"` on both means either one grabs the location.
		const pin = anchor.createDiv({ cls: "wsm-node__pin" });
		pin.dataset.drag = "node";
		if (node.chars.length === 0) pin.addClass("is-empty");
		pin.title = node.label ?? node.id;

		const label = anchor.createDiv({ cls: "wsm-node__label", text: node.label ?? node.id });
		label.dataset.drag = "node";

		anchor.addEventListener("pointerdown", (evt) => this.onNodePointerDown(evt, node, anchor));
		anchor.addEventListener("dblclick", (evt) => this.onFanDoubleClick(evt, node));
		return anchor;
	}

	/**
	 * The character ring: one spoke per character, drawn in a single SVG, and
	 * one avatar per slot on top of it.
	 *
	 * The SVG is created with `createElementNS` because `createEl` would produce
	 * an unknown HTML element that browsers never lay out. Its box is 0x0 with
	 * overflow visible, so the coordinates are simply offsets from the pin.
	 */
	private buildFan(node: MapNode): { layer: HTMLElement; spokes: SVGSVGElement } {
		const layer = createDiv({ cls: "wsm-fan" });
		// A 0x0 box at the pin, so every child positions itself by offset alone.
		// The ring can reach well outside the location's own footprint, so it must
		// not be clipped, and it must not eat pointer events meant for the stage.
		layer.dataset.drag = "fan";

		const spokes = this.createSpokeLayer(layer);
		const count = node.chars.length;
		if (count === 0) return { layer, spokes };

		const roster = this.plugin.pawns;
		const index = indexPawns(roster);

		for (let i = 0; i < count; i += 1) {
			const token = node.chars[i];
			const position = placedPosition(i, count, node.charOffsets?.[token]);

			// Screen px -> canvas px. The stage is scaled, and the ring is
			// authored in the units the reader actually sees, so the two have to
			// meet here or the spokes would not reach their own avatars. One
			// division, and the avatar and its line both use the result: they are
			// then in the same coordinate space by construction.
			const left = position.x / this.scale;
			const top = position.y / this.scale;

			const spoke = document.createElementNS("http://www.w3.org/2000/svg", "line");
			// The layer's own origin is its top-left corner, so the pin — the middle
			// of the box — is at the centre offset, not at 0,0.
			spoke.setAttribute("x1", String(SPOKE_VIEWPORT));
			spoke.setAttribute("y1", String(SPOKE_VIEWPORT));
			spoke.setAttribute("x2", String(SPOKE_VIEWPORT + left));
			spoke.setAttribute("y2", String(SPOKE_VIEWPORT + top));
			// Without this the elastic thread would thicken as the map scaled up
			// and fade away as it scaled down.
			spoke.setAttribute("vector-effect", "non-scaling-stroke");
			spoke.classList.add("wsp-spoke");
			spokes.appendChild(spoke);

			const avatar = this.buildAvatar(resolveToken(token, index, roster));
			avatar.dataset.drag = "char";
			avatar.dataset.token = token;
			avatar.style.left = `${left}px`;
			avatar.style.top = `${top}px`;
			if (isNudged(node.charOffsets?.[token])) avatar.addClass("is-nudged");
			layer.appendChild(avatar);
		}

		return { layer, spokes };
	}

	private createSpokeLayer(host: HTMLElement): SVGSVGElement {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("class", "wsp-spokes");
		// A real box, centred on the pin, instead of the 0x0 viewport this used to
		// be. Zero-sized meant every line depended on `overflow: visible` holding
		// on an empty viewport; when it did not, the threads simply were not there.
		// The numbers are also in styles.css, and a test keeps the two in step.
		svg.style.left = `${-SPOKE_VIEWPORT}px`;
		svg.style.top = `${-SPOKE_VIEWPORT}px`;
		svg.style.width = `${SPOKE_VIEWPORT * 2}px`;
		svg.style.height = `${SPOKE_VIEWPORT * 2}px`;
		svg.setAttribute("overflow", "visible");
		host.appendChild(svg);
		return svg;
	}

	/** One avatar. Same colours and avatar image as the roster token, but bigger. */
	private buildAvatar(resolved: { token: string; pawn: Pawn | null }): HTMLElement {
		const { pawn, token } = resolved;
		const color = pawn?.color ?? colorForToken(token);
		const initials = pawn?.initials ?? initialsFromName(token);

		const el = createDiv({ cls: "wsm-avatar" });
		if (!pawn) el.addClass("is-unknown");
		const colorClasses = textColorClasses(pawn, color);
		if (colorClasses) el.addClass(colorClasses);
		el.style.backgroundColor = color;
		el.setText(clampInitials(initials, token));
		el.title = pawn?.name ?? `${this.plugin.t("unknownPawnTitle")}: ${token}`;
		if (pawn?.avatar) this.applyAvatar(el, pawn.avatar);
		return el;
	}

	private applyAvatar(el: HTMLElement, path: string): void {
		const file = this.resolveVaultFile(path);
		if (file) el.style.backgroundImage = `url("${this.app.vault.getResourcePath(file)}")`;
	}

	/* ------------------------------------------------------------------ */
	/* Interaction: drag the pin, one avatar, or the whole fan            */
	/* ------------------------------------------------------------------ */

	/** Which part of a location the pointer grabbed, if any. */
	private dragModeAt(target: EventTarget | null): DragMode | null {
		if (!(target instanceof Element)) return null;
		const kind = target.closest("[data-drag]")?.getAttribute("data-drag");
		return kind === "node" || kind === "char" || kind === "fan" ? kind : null;
	}

	/** The character whose avatar was grabbed, if any. */
	private tokenAt(target: EventTarget | null): string | null {
		if (!(target instanceof Element)) return null;
		return target.closest<HTMLElement>("[data-token]")?.dataset.token ?? null;
	}

	private onNodePointerDown(evt: PointerEvent, node: MapNode, anchor: HTMLElement): void {
		if (evt.button !== 0) return;
		const grabbed = this.dragModeAt(evt.target);
		if (!grabbed) return;
		evt.stopPropagation();

		// Shift always means "the whole sun", whatever was grabbed. The pin is the
		// natural handle for it, but Shift+avatar has to work too — that is the
		// gesture muscle memory forms after the first time.
		const mode: DragMode = evt.shiftKey ? "fan" : grabbed;
		const token = this.tokenAt(evt.target);
		if (mode === "char" && !token) return;

		const el = this.dragHandle(anchor, mode, token);
		if (!el) return;

		this.drag = {
			mode,
			nodeId: node.id,
			el,
			startX: evt.clientX,
			startY: evt.clientY,
			originX: node.x,
			originY: node.y,
			moved: false,
			token: token ?? "",
			deltaX: 0,
			deltaY: 0,
			screenDeltaX: 0,
			screenDeltaY: 0,
			avatars: this.fanAvatars(anchor),
		};

		el.setPointerCapture(evt.pointerId);
		el.addEventListener("pointermove", this.onPointerDrag);
		el.addEventListener("pointerup", this.onPointerUp);
		el.addEventListener("pointercancel", this.onPointerCancel);
	}

	/** The element that actually follows the pointer, per mode. */
	private dragHandle(anchor: HTMLElement, mode: DragMode, token: string | null): HTMLElement | null {
		if (mode === "node") return anchor;
		const layer = anchor.querySelector<HTMLElement>(".wsm-fan");
		if (!layer) return null;
		if (mode === "fan") return layer;
		if (!token) return null;
		return this.avatarHandle(layer, token)?.el ?? null;
	}

	/**
	 * One avatar plus the elastic thread that follows it.
	 *
	 * Searched from the fan layer, never from the avatar itself: `querySelectorAll`
	 * does not match its own root, and in "char" mode the handle *is* the avatar.
	 */
	private avatarHandle(host: HTMLElement, token: string): AvatarHandle | undefined {
		return this.fanAvatars(host).find((avatar) => avatar.token === token);
	}

	/** Every avatar in a node's ring, with the position it started at. */
	private fanAvatars(host: HTMLElement): AvatarHandle[] {
		// Spokes and avatars are appended in the same loop, so the Nth spoke
		// belongs to the Nth avatar. Putting `data-token` on the spoke too would
		// only duplicate the roster key.
		const spokes = Array.from(host.querySelectorAll<SVGLineElement>(".wsp-spoke"));
		return Array.from(host.querySelectorAll<HTMLElement>('[data-drag="char"]')).map((el, index) => ({
			token: el.dataset.token ?? "",
			el,
			spoke: spokes[index] ?? null,
			startX: parseFloat(el.style.left) || 0,
			startY: parseFloat(el.style.top) || 0,
		}));
	}

	private readonly onPointerDrag = (evt: PointerEvent): void => {
		const drag = this.drag;
		if (!drag) return;

		const dx = evt.clientX - drag.startX;
		const dy = evt.clientY - drag.startY;
		if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

		if (!drag.moved) {
			// A popover anchored to something that is now moving would float free.
			this.closePopover();
			drag.moved = true;
			drag.el.addClass("is-dragging");
		}

		// Screen px -> canvas px, the same conversion the ring layout used, so a
		// hand-placed avatar lands under the cursor at any sidebar width.
		drag.screenDeltaX = dx;
		drag.screenDeltaY = dy;
		drag.deltaX = dx / this.scale;
		drag.deltaY = dy / this.scale;

		if (drag.mode === "node") {
			drag.el.style.left = `${drag.originX + drag.deltaX}px`;
			drag.el.style.top = `${drag.originY + drag.deltaY}px`;
			return;
		}

		if (drag.mode === "fan") {
			// The layer holds the spokes as well as the avatars, so translating it
			// stretches every thread for free.
			drag.el.style.transform = `translate(${drag.deltaX}px, ${drag.deltaY}px)`;
			return;
		}

		// One avatar: move it and stretch only its own thread. The lookup goes
		// through the state captured at pointer-down, not through the handle —
		// which in this mode is the avatar itself.
		const avatar = drag.avatars.find((item) => item.token === drag.token);
		if (!avatar) return;
		avatar.el.style.left = `${avatar.startX + drag.deltaX}px`;
		avatar.el.style.top = `${avatar.startY + drag.deltaY}px`;
		// The far end of the thread, in the layer's own coordinates — which start
		// at the box's corner, so the centre offset has to be added back.
		avatar.spoke?.setAttribute("x2", String(SPOKE_VIEWPORT + avatar.startX + drag.deltaX));
		avatar.spoke?.setAttribute("y2", String(SPOKE_VIEWPORT + avatar.startY + drag.deltaY));
	};

	private readonly onPointerUp = (evt: PointerEvent): void => {
		const drag = this.drag;
		if (!drag) return;
		this.endDrag(drag, evt.pointerId);

		if (!drag.moved) {
			this.togglePopover(drag.nodeId);
			return;
		}
		evt.stopPropagation();
		this.commitDrag(drag);
	};

	/**
	 * A cancelled gesture is not a click and not a placement: the browser took
	 * the pointer away — a second finger landed, the system opened a menu — so
	 * the whole drag is discarded. Repainting from storage is what makes that
	 * true, since the DOM still holds the abandoned travel.
	 */
	private readonly onPointerCancel = (evt: PointerEvent): void => {
		const drag = this.drag;
		if (!drag) return;
		this.endDrag(drag, evt.pointerId);
		if (drag.moved) this.renderNodes();
	};

	/** Release the pointer and unhook the gesture; the drag is over either way. */
	private endDrag(drag: DragState, pointerId: number): void {
		drag.el.releasePointerCapture?.(pointerId);
		drag.el.removeEventListener("pointermove", this.onPointerDrag);
		drag.el.removeEventListener("pointerup", this.onPointerUp);
		drag.el.removeEventListener("pointercancel", this.onPointerCancel);
		drag.el.removeClass("is-dragging");
		this.drag = null;
	}

	/**
	 * Only a completed pointer-up persists. Everything before it is DOM-only, so
	 * a gesture that never completes — Escape, or a pointer the system took away
	 * — leaves data.json untouched.
	 */
	private commitDrag(drag: DragState): void {
		const path = this.path;
		if (!path) return;

		// The pin is anchored in canvas px, so it commits the canvas travel; a
		// nudge is a screen-px figure, and must not be divided by the scale twice.
		const dx = Math.round(drag.screenDeltaX);
		const dy = Math.round(drag.screenDeltaY);

		if (drag.mode === "node") {
			const node = this.map.nodes.find((item) => item.id === drag.nodeId);
			if (!node) return;
			node.x = Math.round(drag.originX + drag.deltaX);
			node.y = Math.round(drag.originY + drag.deltaY);
			this.plugin.updateMap(path, (maps, p) => moveNode(maps, p, drag.nodeId, node.x, node.y));
			return;
		}

		if (drag.mode === "fan") {
			this.plugin.updateMap(path, (maps, p) => moveCharOffsets(maps, p, drag.nodeId, dx, dy));
		} else {
			// The stored offset is relative to the radial slot, so the drag delta
			// simply lands on top of whatever nudge was already there.
			const node = this.map.nodes.find((item) => item.id === drag.nodeId);
			const previous = node?.charOffsets?.[drag.token];
			const offset = {
				offsetX: Math.round((previous?.offsetX ?? 0) + dx),
				offsetY: Math.round((previous?.offsetY ?? 0) + dy),
			};
			this.plugin.updateMap(path, (maps, p) => setCharOffset(maps, p, drag.nodeId, drag.token, offset));
		}

		// Repaint from the stored values rather than from the live DOM: the offsets
		// are rounded on the way to disk, and the rounding is what the author sees.
		this.renderNodes();
	}

	/** Double-clicking an avatar drops its nudge and snaps it back into the ring. */
	private onFanDoubleClick(evt: MouseEvent, node: MapNode): void {
		const token = this.tokenAt(evt.target);
		if (!token) return;
		// A reset is a deliberate click, not a gesture: stop the stage handler
		// from also treating this as "create a location here".
		evt.stopPropagation();
		evt.preventDefault();

		const path = this.path;
		if (!path) return;
		this.plugin.updateMap(path, (maps, p) => setCharOffset(maps, p, node.id, token, null));
		this.renderNodes();
	}


	/**
	 * A click on the stage, which means three different things depending on the
	 * tool and on what is under the pointer.
	 *
	 * Order matters and is the whole design of this handler. A tool wins outright,
	 * because a writer who picked "draw a zone" and got a location instead would
	 * stop trusting the toolbar. Only with no tool active does a click mean "go
	 * in", and only then does an empty spot mean "add something here".
	 *
	 * The tool branches come first and each one returns, so the raycast and the
	 * `goInto` below are unreachable while a tool is armed — the anchor tool can
	 * place its anchor and nothing else. That guard is only half the fix, though:
	 * a click inside a zone lands on the polygon first, and that handler used to
	 * drill in and stop the event before it ever got here. Both layers are needed
	 * because both are real ways for the click to arrive.
	 */
	private onStageClick(evt: MouseEvent): void {
		const path = this.path;
		if (!path) {
			new Notice(this.plugin.t("noticeNoChapter"));
			return;
		}

		const { x, y } = this.toCanvasCoords(evt);
		const corner: ZonePoint = { x: Math.round(x), y: Math.round(y) };

		if (this.tool === "zone") {
			this.addDraftCorner(corner);
			return;
		}

		if (this.tool === "anchor") {
			this.placeAnchor(corner);
			return;
		}

		// No tool: a click inside an outline means "go in", because a zone is a place
		// before it is a shape. The raycast is over this level only, so a zone on
		// another branch can never swallow a click meant for the level in view.
		const zone = zoneAt(this.currentLevel(), { x, y });
		if (zone) this.goInto(zone.id);
	}

	/**
	 * Add a corner to the outline being drawn, or close it.
	 *
	 * Closing needs three corners because a polygon with fewer has no inside, and
	 * a zone with no inside is a shape that cannot be walked into. A click near the
	 * first corner is the close gesture rather than a fourth corner nearby it,
	 * which is the same "back to where you started" rule every drawing tool uses.
	 */
	private addDraftCorner(corner: ZonePoint): void {
		const first = this.draftCorners[0];
		const closes =
			this.draftCorners.length >= 3 &&
			first !== undefined &&
			Math.hypot(corner.x - first.x, corner.y - first.y) <= CLOSE_RADIUS / Math.max(this.scale, 0.05);

		if (closes) {
			this.commitZone();
			return;
		}
		this.draftCorners.push(corner);
		this.renderDraft();
	}

	/**
	 * Store the outline, then name it.
	 *
	 * The refusal on a self-crossing outline is the important line: a bow tie has
	 * two insides, and which half a later click lands in would be decided by a
	 * counting rule rather than by anything the writer drew. Saying no here is
	 * cheap; saving it is not.
	 *
	 * A new zone does *not* drill in. The writer drew a shape whose only name is
	 * the id they never see, and the one thing they have to type is the label;
	 * dropping them into a level with nothing in it took them away from the field
	 * they need. So the level stays where it is, the card opens on the new zone,
	 * and the name is selected and waiting.
	 */
	private commitZone(): void {
		const path = this.path;
		const corners = this.draftCorners;
		if (!path || corners.length < 3) return;

		if (zoneSelfIntersects(corners)) {
			new Notice(this.plugin.t("noticeZoneSelfCross"));
			return;
		}

		// A redraw is an update in place: the zone keeps its id, so its children,
		// colour, name and anchor all stay attached. Creating a new one and deleting
		// the old would have been simpler and would have thrown away a region.
		if (this.redrawingZoneId) {
			const id = this.redrawingZoneId;
			this.plugin.updateMap(path, (maps, p) => setZoneOutline(maps, p, id, corners));
			this.cancelTool();
			this.refresh();
			return;
		}

		const id = this.plugin.updateMap(path, (maps, p) => addZone(maps, p, "zone", corners));
		this.cancelTool();
		// `refresh` first: the popover anchors itself to the label element, and
		// the label is built by the repaint. Opening before it exists would find
		// nothing and silently do nothing.
		this.refresh();
		this.openPopover(id, true);
		this.renderHint();
	}

	/**
	 * Put a zone's anchor down, which is where its cast is drawn.
	 *
	 * Only a zone can have one, and only a click inside an outline on this level
	 * counts. A click on empty canvas is refused with a reason rather than
	 * silently ignored, because the tool gives no other feedback and the writer
	 * would assume it had worked.
	 */
	private placeAnchor(corner: ZonePoint): void {
		const path = this.path;
		if (!path) return;

		const zone = zoneAt(this.currentLevel(), corner);
		if (!zone) {
			new Notice(this.plugin.t("noticeAnchorNeedsZone"));
			return;
		}

		this.plugin.updateMap(path, (maps, p) => setNodeAnchor(maps, p, zone.id, corner.x, corner.y));
		this.cancelTool();
		this.refresh();
	}

	/**
	 * Light up the zone under the pointer.
	 *
	 * A raycast rather than a hover listener on each polygon on purpose: a pin or
	 * a sun standing inside the outline would otherwise eat the hover and the zone
	 * would go dark exactly when the writer is pointing at it to go in.
	 */
	private onStagePointerMove(evt: PointerEvent): void {
		if (this.tool !== "none") return;

		const { x, y } = this.toCanvasCoords(evt);
		const hit = zoneAt(this.currentLevel(), { x, y });
		const id = hit ? hit.id : null;
		if (id === this.hoverZoneId) return;

		this.hoverZoneId = id;
		for (const polygon of Array.from(this.zonesEl.querySelectorAll<SVGPolygonElement>("[data-zone-id]"))) {
			polygon.classList.toggle("is-hover", polygon.dataset.zoneId === id);
		}
	}

	private clearZoneHover(): void {
		if (this.hoverZoneId === null) return;
		this.hoverZoneId = null;
		for (const polygon of Array.from(this.zonesEl.querySelectorAll<SVGPolygonElement>("[data-zone-id]"))) {
			polygon.classList.remove("is-hover");
		}
	}

	/**
	 * Double-click on empty space creates a location.
	 *
	 * Inside a zone the new location is its child, so the writer never has to draw
	 * a nesting arrow: go in, double-click, done. On the world level the same
	 * gesture makes a root, which is why this is the only place that decides
	 * between the two.
	 *
	 * What counts as "empty" is asked of the target rather than compared to a
	 * fixed element. The click lands on whatever is topmost at that pixel, and on a
	 * map with pins that is the nodes layer, not the stage — a test against one
	 * specific element would read as correct and be wrong the moment a pin existed.
	 * Anything that carries a node or a zone id is interactive and owns its own
	 * clicks, so those are left alone.
	 */
	private onStageDoubleClick(evt: MouseEvent): void {
		const path = this.path;
		if (!path) {
			new Notice(this.plugin.t("noticeNoChapter"));
			return;
		}
		// A tool owns the click: closing a zone is a click on the first corner, and
		// the second half of that double-click would otherwise drop a pin on top of
		// the corner that just closed it.
		if (this.tool !== "none") return;
		// Pins, suns and zone labels have their own double-click behaviour.
		if (this.ownedTarget(evt.target)) return;

		const { x, y } = this.toCanvasCoords(evt);
		const parentId = this.nodeIds[this.nodeIds.length - 1] ?? null;
		// Creates the chapter's map entry on the spot: binding is lazy.
		const id = this.plugin.updateMap(path, (maps, p) => addNode(maps, p, "node", x, y));
		if (parentId) this.plugin.updateMap(path, (maps, p) => setNodeParent(maps, p, id, parentId));
		this.refresh();
		this.openPopover(id, true);
	}

	/**
	 * Whether this click was aimed at something that handles its own clicks.
	 *
	 * A pin drags, a zone label walks in, a sun resets an avatar — all of them
	 * stopPropagation, but the stage listener is on the ancestor and the fallback
	 * is what runs when a stopPropagation is ever missed, so the check is repeated
	 * here rather than trusted.
	 */
	private ownedTarget(target: EventTarget | null): boolean {
		if (!(target instanceof Element)) return false;
		return target.closest("[data-node-id], [data-zone-id]") !== null;
	}

	/* ------------------------------------------------------------------ */
	/* Node popover                                                         */
	/* ------------------------------------------------------------------ */

	private togglePopover(nodeId: string): void {
		if (this.popoverEl?.dataset.nodeId === nodeId) {
			this.closePopover();
			return;
		}
		this.openPopover(nodeId, false);
	}

	private openPopover(nodeId: string, focusName: boolean): void {
		const node = this.map.nodes.find((item) => item.id === nodeId);
		if (!node) return;

		this.closePopover();

		const anchor = this.nodesEl.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
		if (!anchor) return;

		const popover = createDiv({ cls: "wsm-pop" });
		popover.dataset.nodeId = nodeId;

		// A throw while building the popover used to leave a half-built element
		// and no visible error, so the node looked completely inert. Surface it.
		try {
			if (isZone(node)) this.renderZonePopover(popover, node);
			else this.renderPopoverContent(popover, node);
		} catch (error) {
			console.error("Writer's State Map: popover failed to build", error);
			new Notice(this.plugin.t("noticeViewFailed", { message: String(error) }));
			return;
		}

		this.root.appendChild(popover);
		this.popoverEl = popover;

		this.positionPopover(popover, anchor);
		if (focusName) {
			const nameField = popover.querySelector<HTMLInputElement>(".wsm-pop__name");
			nameField?.focus();
			nameField?.select();
		}

		this.registerGlobalClose();
		window.addEventListener("resize", this.closePopover);
	}

	/**
	 * A zone's own card: name, colour, and the two things that only make sense for
	 * a shape.
	 *
	 * The roster checkboxes are gone here on purpose. A region's cast is not a list
	 * of choices — it is whatever the towns under it contain, and offering to tick
	 * a character "in the region" as well as "in the town" would let the map say
	 * two contradictory things about where somebody is.
	 */
	private renderZonePopover(popover: HTMLElement, node: MapNode): void {
		const path = this.path;
		if (!path) return;

		const head = popover.createDiv({ cls: "wsm-pop__head" });
		const nameInput = head.createEl("input", { cls: "wsm-pop__name", type: "text" });
		nameInput.value = node.label ?? "";
		nameInput.placeholder = node.id;
		nameInput.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				void this.commitRename(node.id, nameInput.value);
			}
		});
		nameInput.addEventListener("blur", () => {
			if (nameInput.value !== (node.label ?? "")) void this.commitRename(node.id, nameInput.value);
		});

		// Count: what is under this zone right now, and how deep it goes.
		const kids = childrenOf(this.map.nodes, node.id);
		const list = popover.createDiv({ cls: "wsm-pop__list" });
		if (kids.length === 0) {
			list.createDiv({ cls: "wsm-pop__empty", text: this.plugin.t("popoverZoneEmpty") });
		} else {
			for (const kid of kids) {
				const row = list.createDiv({ cls: "wsm-pop__row" });
				row.createSpan({ cls: "wsm-pop__name", text: kid.label ?? kid.id });
				const count = kid.chars.length;
				if (count > 0) {
					row.createSpan({ cls: "wsm-pop__count", text: String(count) });
				}
				// A child that is not a zone has no level of its own, so the row is
				// text rather than a link: offering a "go in" that does nothing would
				// be a lie about the depth of the map.
				if (isZone(kid)) {
					const enter = row.createEl("button", { cls: "wsm-pop__link" });
					enter.setText(this.plugin.t("mapEnterZone"));
					enter.title = kid.label ?? kid.id;
					enter.addEventListener("click", (evt) => {
						evt.preventDefault();
						this.closePopover();
						// The card lists children of the zone being viewed, so a child
						// zone is always exactly one level below the current stack top.
						this.goInto(kid.id);
					});
				}
			}
		}

		// Colour for the hover fill. A plain text field, because `asColor` accepts
		// what CSS does — a hex, an rgb(), a name — and a colour picker would only
		// offer one of those three dialects.
		const colourRow = popover.createDiv({ cls: "wsm-pop__section" });
		colourRow.createDiv({ cls: "wsm-pop__section-title", text: this.plugin.t("popoverZoneFill") });
		const colourField = colourRow.createEl("input", { cls: "wsm-pop__color", type: "text" });
		colourField.value = node.fill ?? "";
		colourField.placeholder = this.plugin.t("rosterTextColorAuto");
		colourField.addEventListener("change", () => {
			this.commitZoneFill(node.id, colourField.value);
		});

		const foot = popover.createDiv({ cls: "wsm-pop__foot" });

		const redraw = foot.createEl("button", { cls: "wsm-pop__link" });
		setIcon(redraw, "pencil");
		redraw.createSpan({ text: this.plugin.t("popoverZoneRedraw") });
		redraw.addEventListener("click", () => this.startZoneRedraw(node));

		const deleteButton = foot.createEl("button", { cls: "wsm-pop__danger" });
		setIcon(deleteButton, "trash");
		deleteButton.createSpan({ text: this.plugin.t("popoverDelete") });
		deleteButton.addEventListener("click", () => this.confirmDeleteNode(node));
	}

	/**
	 * Redraw a zone's outline, keeping everything else about it.
	 *
	 * The id, the name, the colour, the children and the anchor all survive: the
	 * writer is fixing a shape, not replacing a region, and silently detaching its
	 * towns because a border moved a little would be unforgivable.
	 */
	private startZoneRedraw(node: MapNode): void {
		this.closePopover();
		this.cancelTool();
		// The first corner is the label's own position, so reopening the draft there
		// keeps the name where it was instead of teleporting it to wherever the
		// writer starts clicking.
		this.draftCorners = [{ x: node.x, y: node.y }];
		this.redrawingZoneId = node.id;
		this.tool = "zone";
		this.stageEl.addClass("is-drawing");
		this.renderToolState();
		this.renderDraft();
	}

	private commitZoneFill(nodeId: string, value: string): void {
		const path = this.path;
		if (!path) return;

		const changed = this.plugin.updateMap(path, (maps, p) =>
			setZoneFill(maps, p, nodeId, value.trim() === "" ? null : value),
		);
		// A refused value leaves the field showing something that is not stored, which
		// is worse than saying so: re-open the card and it would look saved.
		if (!changed) {
			new Notice(this.plugin.t("noticeViewFailed", { message: value }));
			this.refresh();
			return;
		}
		this.refresh();
	}

	private renderPopoverContent(popover: HTMLElement, node: MapNode): void {
		// Note: never alias `this.plugin.t` into a local. It is a method, and a
		// detached copy loses `this` and throws on `this.settings` the moment the
		// popover is built — which silently killed every popover action.
		const roster = this.plugin.pawns;
		const index = indexPawns(roster);

		// Header: inline rename.
		const head = popover.createDiv({ cls: "wsm-pop__head" });
		const nameInput = head.createEl("input", { cls: "wsm-pop__name", type: "text" });
		nameInput.value = node.label ?? "";
		nameInput.placeholder = node.id;
		nameInput.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				void this.commitRename(node.id, nameInput.value);
			}
		});
		nameInput.addEventListener("blur", () => {
			if (nameInput.value !== (node.label ?? "")) void this.commitRename(node.id, nameInput.value);
		});

		// Roster section: one checkbox per pawn.
		const list = popover.createDiv({ cls: "wsm-pop__list" });
		if (roster.length === 0) {
			list.createDiv({ cls: "wsm-pop__empty", text: this.plugin.t("popoverEmptyRoster") });
		}

		for (const pawn of roster) {
			const row = list.createEl("label", { cls: "wsm-pop__row" });
			row.appendChild(this.buildRosterToken(pawn));
			row.createSpan({ cls: "wsm-pop__name", text: pawn.name });

			const checkbox = row.createEl("input", { type: "checkbox" });
			checkbox.checked = node.chars.includes(pawn.id);
			checkbox.addEventListener("change", () => {
				this.commitPawnToggle(node.id, pawn.id, checkbox.checked);
			});

			// One click from the map to the character's own note — the same
			// `file-text` affordance the roster tab uses, so the icon means the
			// same thing in both places.
			if (pawn.notePath) row.appendChild(this.buildNoteButton(pawn));
		}

		// Unknown tokens: leftovers from deleted pawns or hand-edited data.json.
		const unknown = node.chars.filter((token) => !index.has(token) && resolveToken(token, index, roster).pawn === null);
		if (unknown.length > 0) {
			const section = popover.createDiv({ cls: "wsm-pop__section" });
			section.createDiv({ cls: "wsm-pop__section-title", text: this.plugin.t("popoverUnknown") });
			for (const token of unknown) {
				const row = section.createEl("label", { cls: "wsm-pop__row is-unknown" });
				row.appendChild(this.buildRosterToken(null, token));
				row.createSpan({ cls: "wsm-pop__name", text: token });

				const addButton = row.createEl("button", { cls: "wsm-pop__link" });
				addButton.setText(this.plugin.t("popoverAddToRoster"));
				addButton.addEventListener("click", (evt) => {
					evt.preventDefault();
					void this.adoptUnknownToken(node, token);
				});
			}
		}

		// Footer: destructive action.
		const foot = popover.createDiv({ cls: "wsm-pop__foot" });
		const deleteButton = foot.createEl("button", { cls: "wsm-pop__danger" });
		setIcon(deleteButton, "trash");
		deleteButton.createSpan({ text: this.plugin.t("popoverDelete") });
		deleteButton.addEventListener("click", () => {
			this.confirmDeleteNode(node);
		});
	}

	/**
	 * The "open this character's note" button inside a popover row.
	 *
	 * The row is a `<label>` wrapping the checkbox, so a plain click anywhere on
	 * it toggles the character. Without the three stopPropagation/preventDefault
	 * calls below, opening a note would also tick the character on the map — the
	 * exact kind of surprise that loses an author's placement.
	 */
	private buildNoteButton(pawn: Pawn): HTMLElement {
		const notePath = pawn.notePath as string;
		const button = createDiv({ cls: "wsm-pop__note" });
		setIcon(button, "file-text");
		button.title = `${this.plugin.t("rosterNoteOpen")} — ${notePath}`;
		button.setAttribute("role", "button");
		button.setAttribute("tabindex", "0");
		button.setAttribute("aria-label", button.title);

		const open = (evt: Event): void => {
			evt.preventDefault();
			evt.stopPropagation();
			this.closePopover();
			void this.app.workspace.openLinkText(notePath, "");
		};
		button.addEventListener("click", open);
		button.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") open(evt);
		});

		return button;
	}

	private buildRosterToken(pawn: Pawn | null, fallbackToken?: string): HTMLElement {
		const token = pawn?.id ?? fallbackToken ?? "";
		const color = pawn?.color ?? colorForToken(token);
		const initials = pawn?.initials ?? initialsFromName(token);

		const el = createDiv({ cls: "wsm-token wsm-token--sm" });
		if (!pawn) el.addClass("is-unknown");
		const colorClasses = textColorClasses(pawn, color);
		if (colorClasses) el.addClass(colorClasses);
		el.style.backgroundColor = color;
		el.setText(clampInitials(initials, token));
		if (pawn?.avatar) this.applyAvatar(el, pawn.avatar);
		return el;
	}

	private positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
		const anchorRect = anchor.getBoundingClientRect();
		popover.style.left = "0px";
		popover.style.top = "0px";

		const hostRect = this.root.getBoundingClientRect();
		const popRect = popover.getBoundingClientRect();

		let left = anchorRect.left - hostRect.left + anchorRect.width / 2 - popRect.width / 2;
		left = Math.max(4, Math.min(left, hostRect.width - popRect.width - 4));

		let top = anchorRect.bottom - hostRect.top + 6;
		if (top + popRect.height > hostRect.height - 4) {
			top = anchorRect.top - hostRect.top - popRect.height - 6;
		}
		top = Math.max(4, top);

		popover.style.left = `${left}px`;
		popover.style.top = `${top}px`;
	}

	private closePopover = (): void => {
		this.popoverEl?.remove();
		this.popoverEl = null;
		this.unregisterGlobalClose();
		window.removeEventListener("resize", this.closePopover);
	};

	private closeOnOutsideClick = (evt: MouseEvent): void => {
		const target = evt.target as Node | null;
		if (this.popoverEl?.contains(target)) return;
		if (target instanceof Element && target.closest(".wsm-node")) return;
		this.closePopover();
	};

	/**
	 * Escape unwinds one thing at a time, in order of how much work would be lost.
	 *
	 * The popover closes before the tool drops, because a card open on top of a
	 * half-drawn zone is the common case and the popover is the smaller thing to
	 * undo. The tool drops before the level pops, because abandoning three corners
	 * the writer just placed is a bigger loss than a level change they can redo
	 * with one click.
	 */
	private closeOnEscape = (evt: KeyboardEvent): void => {
		if (evt.key !== "Escape") return;
		if (this.popoverEl) {
			this.closePopover();
			return;
		}
		if (this.tool !== "none") this.cancelTool();
	};

	private globalListenersBound = false;

	private registerGlobalClose(): void {
		if (this.globalListenersBound) return;
		this.globalListenersBound = true;
		document.addEventListener("pointerdown", this.closeOnOutsideClick, true);
		document.addEventListener("keydown", this.closeOnEscape, true);
	}

	private unregisterGlobalClose(): void {
		if (!this.globalListenersBound) return;
		this.globalListenersBound = false;
		document.removeEventListener("pointerdown", this.closeOnOutsideClick, true);
		document.removeEventListener("keydown", this.closeOnEscape, true);
	}

	/* ------------------------------------------------------------------ */
	/* Popover actions                                                      */
	/* ------------------------------------------------------------------ */

	private commitPawnToggle(nodeId: string, token: string, present: boolean): void {
		const path = this.path;
		if (!path) return;

		this.plugin.updateMap(path, (maps, p) => setPawnOnNode(maps, p, nodeId, token, present));
		this.renderNodes();
	}

	private commitRename(nodeId: string, label: string): void {
		const path = this.path;
		if (!path) return;

		this.plugin.updateMap(path, (maps, p) => renameNode(maps, p, nodeId, label));
		this.renderNodes();
		this.renderPopoverLabel(nodeId, label.trim());
	}

	/** Keep the popover's name field in sync without rebuilding the whole popover. */
	private renderPopoverLabel(nodeId: string, value: string): void {
		if (this.popoverEl?.dataset.nodeId !== nodeId) return;
		const input = this.popoverEl.querySelector<HTMLInputElement>(".wsm-pop__name");
		if (input) input.value = value;
	}

	/** Turn an unknown token into a real roster pawn and re-link the node. */
	private async adoptUnknownToken(node: MapNode, token: string): Promise<void> {
		const path = this.path;
		if (!path) return;

		const pawn = this.plugin.addPawn(token);
		if (!pawn) return;

		this.plugin.updateMap(path, (maps, p) => replaceNodeToken(maps, p, node.id, token, pawn.id));
		this.refresh();
		this.openPopover(node.id, false);
	}

	private confirmDeleteNode(node: MapNode): void {
		const path = this.path;
		if (!path) return;

		this.closePopover();
		this.plugin.updateMap(path, (maps, p) => deleteNode(maps, p, node.id));
		this.refresh();
	}

	/* ------------------------------------------------------------------ */
	/* Empty states                                                         */
	/* ------------------------------------------------------------------ */

	private renderEmptyState(): void {
		this.emptyEl.empty();
		this.emptyEl.removeClass("is-hidden");
		this.root.toggleClass("is-no-chapter", !this.path);
		// Not a plain clear: the level decides what this line says, and a panel
		// below that replaces the line wholesale would otherwise fight it.
		this.renderHint();

		if (!this.path) {
			this.showEmpty(this.plugin.t("emptyNoFileTitle"), this.plugin.t("emptyNoFileHint"));
			return;
		}

		// A background was chosen but cannot be resolved: tell the truth instead
		// of silently showing a blank map.
		if (this.brokenBg) {
			this.showEmpty(this.plugin.t("emptyBrokenBgTitle"), this.plugin.t("emptyBrokenBgHint", { path: this.brokenBg }), [
				{
					label: this.plugin.t("mapSetBackground"),
					icon: "image",
					run: () => void this.chooseBackground(),
				},
			]);
			return;
		}

		// Nothing is stored for this chapter yet. Binding is lazy, so a stray
		// markdown note is not recorded until the writer actually starts using it.
		if (!hasMap(this.plugin.settings.maps, this.path)) {
			this.showEmpty(this.plugin.t("emptyNoMapTitle"), this.plugin.t("emptyNoMapHint"), [
				{
					label: this.plugin.t("emptyCreateMap"),
					icon: "plus",
					run: () => this.createMapEntry(),
					primary: true,
				},
				...this.inheritAction(),
			]);
			return;
		}

		// A level with nothing on it is not an empty *map*, and must not be shown as
		// one. The chapter has plenty stored one level up; the writer is simply
		// standing in a region that has no towns yet, and that deserves a line in the
		// toolbar, not a panel offering to create the map that already exists.
		if (this.map.nodes.length > 0 && this.currentLevel().length === 0) {
			this.emptyEl.addClass("is-hidden");
			this.renderHint();
			return;
		}

		// The map exists. With a background and at least one location there is
		// nothing left to explain.
		if (this.map.bg && this.map.nodes.length > 0) {
			this.emptyEl.addClass("is-hidden");
			return;
		}

		// Locations without a background: the map is usable, but the writer most
		// likely still means to pick a picture. Say so instead of leaving an
		// empty bordered strip at the bottom of the panel.
		if (this.map.nodes.length === 0) {
			this.hintEl.setText(this.plugin.t("emptyNoNodesHint"));
			this.showEmpty("", this.plugin.t("emptyNoBgHint"), [
				{
					label: this.map.bg ? this.plugin.t("mapChangeBackground") : this.plugin.t("mapSetBackground"),
					icon: "image",
					run: () => void this.chooseBackground(),
				},
				...this.inheritAction(),
			]);
			return;
		}

		this.showEmpty("", this.plugin.t("emptyNoBgHint"), [
			{
				label: this.map.bg ? this.plugin.t("mapChangeBackground") : this.plugin.t("mapSetBackground"),
				icon: "image",
				run: () => void this.chooseBackground(),
			},
		]);
	}

	/**
	 * The "take the last chapter's layout" button, or nothing.
	 *
	 * Returns an empty list when there is no chapter to take it from, or when the
	 * map is no longer empty — the copy is refused in that case, and a button
	 * that can only fail is worse than no button.
	 */
	private inheritAction(): { label: string; icon: string; run: () => void; title: string }[] {
		if (!this.path || this.map.nodes.length > 0) return [];
		const preview = previewInherit(this.plugin.settings.maps, this.path);
		if (!preview) return [];

		const label = `${this.plugin.t("mapInheritFrom")}: ${basename(preview.parent)}`;
		const title = `${this.plugin.t("mapInheritSummary", {
			nodes: preview.nodes,
			pawns: preview.pawns,
		})} — ${this.plugin.t("mapInheritTitle")}`;

		return [{ label, icon: "git-fork", run: () => this.runInherit(preview.parent), title }];
	}

	/**
	 * Copy another chapter's layout in, and say what came across.
	 *
	 * The refusal case is reported rather than swallowed: if the writer clicks
	 * this on a map they have already filled in, silence would look like a bug,
	 * and the rule that protects their work should be visible.
	 */
	private runInherit(parent: string): void {
		const path = this.path;
		if (!path) return;

		const result = this.plugin.updateMap(path, (maps, p) => inheritFrom(maps, p, parent));
		this.refresh();

		if (!result) {
			new Notice(this.plugin.t("noticeInheritRefused"));
			return;
		}
		new Notice(
			this.plugin.t("noticeInherited", { path: basename(parent), nodes: result.nodes, pawns: result.pawns }),
		);
	}

	/** Create the chapter's map entry without adding a location yet. */
	private createMapEntry(): void {
		const path = this.path;
		if (!path) return;

		this.plugin.updateMap(path, (maps, p) => ensureMap(maps, p));
		this.refresh();
		new Notice(this.plugin.t("noticeMapCreated", { path }));
	}

	/**
	 * The panel that explains why there is nothing to look at, and what can be
	 * done about it.
	 *
	 * A list rather than one button, because the empty state genuinely has two
	 * good answers here: start a map from scratch, or take the last chapter's
	 * layout as the starting point. Offering only one would make the other look
	 * unavailable.
	 */
	private showEmpty(
		title: string,
		hint: string,
		actions?: { label: string; icon: string; run: () => void; primary?: boolean; title?: string }[],
	): void {
		this.emptyEl.removeClass("is-hidden");
		if (title) this.emptyEl.createDiv({ cls: "wsm-empty__title", text: title });
		if (hint) this.emptyEl.createDiv({ cls: "wsm-empty__hint", text: hint });
		if (!actions?.length) return;

		for (const action of actions) {
			const button = this.emptyEl.createEl("button", {
				cls: action.primary ? "wsm-empty__copy mod-cta" : "wsm-empty__copy",
			});
			setIcon(button, action.icon);
			button.createSpan({ text: action.label });
			button.addEventListener("click", action.run);
			// The source chapter goes in the tooltip rather than into the label:
			// the label has to stay short enough to fit a narrow sidebar, and
			// which chapter is about to be copied is the one thing that must not
			// be truncated.
			if (action.title) button.title = action.title;
		}
	}
}
