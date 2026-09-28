import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type WriterStateMapPlugin from "../main";
import { pickFromList, pickImage } from "./pickers";
import {
	addNode,
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
	setParentChapter,
	setPawnOnNode,
} from "./store";
import type { MapNode, Pawn } from "./types";
import { clampInitials, colorForToken, indexPawns, initialsFromName, resolveToken, textColorClasses } from "./pawns";
import { isNudged, placedPosition } from "./layout";
import { basename, inheritFrom, parentCandidates, parentIsStale, previewInherit } from "./inherit";

export const VIEW_TYPE_MAP = "writer-state-map-map";

/** Pointer travel (screen px) after which a pointer-down becomes a drag. */
const DRAG_THRESHOLD = 4;

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
	private wrapEl!: HTMLElement;
	private sizerEl!: HTMLElement;
	private stageEl!: HTMLElement;
	private bgImg!: HTMLImageElement;
	private nodesEl!: HTMLElement;
	private emptyEl!: HTMLElement;
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

		this.addAction("users", this.plugin.t("viewRoster"), () => {
			void this.plugin.openTab("roster");
		});
		this.addAction("refresh-cw", "Refresh", () => this.refresh());

		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => this.applyScale());
			this.resizeObserver.observe(this.wrapEl);
		}

		this.setChapter(this.plugin.activeChapterPath);
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.closePopover();
	}

	/* ------------------------------------------------------------------ */
	/* DOM construction                                                     */
	/* ------------------------------------------------------------------ */

	private buildToolbar(): void {
		const toolbar = this.root.createDiv({ cls: "wsm-map__toolbar" });
		this.fileLabel = toolbar.createDiv({ cls: "wsm-map__file" });
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

		this.nodesEl = this.stageEl.createDiv({ cls: "wsm-map__nodes" });

		// Double-click on empty space creates a location. `onClose` replaces the
		// whole content element, so this listener dies with the view.
		this.nodesEl.addEventListener("dblclick", (evt) => this.onStageDoubleClick(evt));
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
		this.closePopover();
		this.refresh();
	}

	/** Re-read the map from data.json and repaint. */
	refresh(): void {
		this.map = readMap(this.plugin.settings.maps, this.path, this.plugin.settings.defaultCanvas);
		this.fileLabel.setText(this.path ? basename(this.path) : "");
		// Nothing to remove means nothing to click.
		this.clearBgButton.disabled = !this.map.bg;
		this.renderBackground();
		this.renderNodes();
		this.renderEmptyState();
		this.renderProvenance();
		this.applyScale();
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
	/* Nodes                                                                */
	/* ------------------------------------------------------------------ */

	private renderNodes(): void {
		this.nodesEl.empty();
		for (const node of this.map.nodes) {
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


	private onStageDoubleClick(evt: MouseEvent): void {
		const path = this.path;
		if (!path) {
			new Notice(this.plugin.t("noticeNoChapter"));
			return;
		}
		if (evt.target !== this.nodesEl) return;

		const { x, y } = this.toCanvasCoords(evt);
		// Creates the chapter's map entry on the spot: binding is lazy.
		const id = this.plugin.updateMap(path, (maps, p) => addNode(maps, p, "node", x, y));
		this.refresh();
		this.openPopover(id, true);
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
			this.renderPopoverContent(popover, node);
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

	private closeOnEscape = (evt: KeyboardEvent): void => {
		if (evt.key === "Escape") this.closePopover();
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
		this.hintEl.setText("");

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
