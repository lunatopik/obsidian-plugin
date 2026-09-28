import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type WriterStateMapPlugin from "../main";
import { addLink, readMap, removeLink } from "./store";
import type { ChapterLink, LinkKind, Pawn } from "./types";
import type { TranslationKey } from "./i18n";
import { colorForToken, indexPawns, textColorClasses } from "./pawns";
import { placedPosition } from "./layout";

export const VIEW_TYPE_RELATIONSHIP = "writer-state-map-relationship";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The three kinds, in the order the picker offers them. */
const KINDS: LinkKind[] = ["blood", "debt", "secret"];

/**
 * The i18n key for each kind, spelled out rather than assembled.
 *
 * A template key would be a string the compiler cannot check, and a typo in it
 * would show the writer a raw placeholder instead of a word. The map is the
 * whole list of kinds, so a new kind cannot be added without being named here.
 */
const KIND_KEYS: Record<LinkKind, TranslationKey> = {
	blood: "relKindBlood",
	debt: "relKindDebt",
	secret: "relKindSecret",
};

const KIND_ICONS: Record<LinkKind, string> = {
	blood: "droplet",
	debt: "coins",
	secret: "eye-off",
};

/** Half the drawing area. The ring lives inside this, in SVG user units. */
const EXTENT = 100;

/** One vertex of the graph. */
interface Vertex {
	token: string;
	pawn: Pawn | null;
	/** The location this character stands on, for the tooltip. */
	nodeId: string;
}

/**
 * The relationships tab: who is tied to whom in the current chapter.
 *
 * Only characters actually placed on this chapter's map get a vertex. A tie
 * between two characters who are both off the map says something real about the
 * story, and hiding it would make the tab look emptier than the data is — so
 * those ties are listed underneath instead, marked as not drawn. The graph is
 * for reading the shape of the cast at a glance; the list is the honest
 * inventory.
 *
 * Ties are undirected and there is at most one per pair. Drawing them as an
 * unordered set is what makes "Tom owes Aya" and "Aya is Tom's creditor" the
 * same fact, which is how the writer records it. The kind carries the direction
 * of obligation; the pair does not.
 */
export class RelationshipView extends ItemView {
	private root!: HTMLElement;
	private graphEl!: HTMLElement;
	private listEl!: HTMLElement;
	private hintEl!: HTMLElement;
	/** The first of the two characters picked, waiting for the second. */
	private pending: string | null = null;

	private readonly plugin: WriterStateMapPlugin;

	// Explicit field instead of a TS parameter property: the test suite runs
	// these files through Node's strip-only TypeScript, which rejects them.
	constructor(leaf: WorkspaceLeaf, plugin: WriterStateMapPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_RELATIONSHIP;
	}

	getDisplayText(): string {
		return this.plugin.t("viewRelationship");
	}

	getIcon(): string {
		return "git-fork";
	}

	async onOpen(): Promise<void> {
		// A pending first pick belongs to a DOM that is about to be thrown away.
		// Carrying it over would make the next click land on a tie the writer
		// never finished choosing.
		this.pending = null;

		this.root = this.contentEl;
		this.root.empty();
		this.root.addClass("wsm-rel");

		const head = this.root.createDiv({ cls: "wsm-rel__head" });
		head.createDiv({ cls: "wsm-rel__title", text: this.plugin.t("viewRelationship") });
		this.hintEl = head.createDiv({ cls: "wsm-rel__hint" });

		this.graphEl = this.root.createDiv({ cls: "wsm-rel__graph" });
		this.listEl = this.root.createDiv({ cls: "wsm-rel__list" });

		this.render();
	}

	async onClose(): Promise<void> {
		this.pending = null;
	}

	/** Called by the plugin when the chapter changes or the data is edited. */
	onExternalChange(): void {
		this.render();
	}

	/* ------------------------------------------------------------------ */
	/* Paint                                                                */
	/* ------------------------------------------------------------------ */

	private render(): void {
		this.graphEl.empty();
		this.listEl.empty();

		const path = this.plugin.activeChapterPath;
		const map = readMap(this.plugin.settings.maps, path, this.plugin.settings.defaultCanvas);
		const index = indexPawns(this.plugin.pawns);
		const vertices = this.collectVertices(map.nodes, index);

		// A half-finished pair no longer means anything once the chapter under it
		// is gone.
		if (this.pending && !vertices.some((vertex) => vertex.token === this.pending)) this.pending = null;

		if (vertices.length === 0) {
			this.hintEl.setText("");
			this.graphEl.addClass("is-hidden");
			this.listEl.createDiv({ cls: "wsm-empty__hint", text: this.plugin.t("relNoCast") });
			return;
		}

		this.graphEl.removeClass("is-hidden");
		this.renderGraph(vertices, map.links);
		this.renderList(map.links, vertices, index);
	}

	/**
	 * Every character standing on a location in this chapter, once each.
	 *
	 * A character placed on two locations is one vertex, not two: the graph is
	 * about the cast, and drawing the same person twice would make a tie look
	 * like it belonged to one of the two places in particular.
	 */
	private collectVertices(nodes: { id: string; chars: string[] }[], index: Map<string, Pawn>): Vertex[] {
		const seen = new Map<string, Vertex>();
		for (const node of nodes) {
			for (const token of node.chars) {
				if (seen.has(token)) continue;
				seen.set(token, { token, pawn: index.get(token) ?? null, nodeId: node.id });
			}
		}
		return [...seen.values()];
	}

	private renderGraph(vertices: Vertex[], links: ChapterLink[]): void {
		this.hintEl.setText(this.pending ? this.plugin.t("relPickSecond") : this.plugin.t("relPickFirst"));

		const svg = svgEl("svg");
		svg.setAttribute("viewBox", `${-EXTENT} ${-EXTENT} ${EXTENT * 2} ${EXTENT * 2}`);
		svg.setAttribute("class", "wsm-rel__canvas");

		// Vertices first, in ring order, so a later tie can never be hidden
		// behind an avatar.
		const slots = new Map<string, { x: number; y: number }>();
		vertices.forEach((vertex, indexInRing) => {
			slots.set(vertex.token, placedPosition(indexInRing, vertices.length, undefined));
		});

		for (const link of links) {
			const from = slots.get(link.a);
			const to = slots.get(link.b);
			// One of the two is not on this map. The tie is still listed below.
			if (!from || !to) continue;

			const line = svgEl("line");
			line.setAttribute("x1", String(from.x));
			line.setAttribute("y1", String(from.y));
			line.setAttribute("x2", String(to.x));
			line.setAttribute("y2", String(to.y));
			// The kind is the only thing the line has to say, so it is carried by
			// one class that CSS turns into a colour and a dash pattern.
			line.setAttribute("class", `wsm-rel__line is-${link.kind}`);
			svg.appendChild(line);
		}

		for (const vertex of vertices) {
			const slot = slots.get(vertex.token) as { x: number; y: number };
			const group = svgEl("g");
			group.setAttribute("class", this.pending === vertex.token ? "wsm-rel__node is-picked" : "wsm-rel__node");
			group.setAttribute("transform", `translate(${slot.x} ${slot.y})`);
			group.appendChild(this.avatar(vertex));
			group.addEventListener("click", () => this.pick(vertex.token));
			svg.appendChild(group);
		}

		this.graphEl.appendChild(svg);
	}

	/** The circle for one character, in their own colour. */
	private avatar(vertex: Vertex): SVGElement {
		const pawn = vertex.pawn;
		const circle = svgEl("circle");
		circle.setAttribute("r", "9");
		circle.setAttribute("fill", pawn?.color ?? colorForToken(vertex.token));
		// A token with no pawn behind it is a name the writer typed into a note
		// and never made a character. It gets the same grey as the map's unknown
		// avatars rather than a colour of its own, so the eye skips it.
		if (!pawn) circle.setAttribute("class", "is-unknown");
		else {
			const classes = textColorClasses(pawn, pawn.color);
			if (classes) circle.setAttribute("class", classes);
		}

		const title = document.createElementNS(SVG_NS, "title");
		title.textContent = pawn?.name ?? vertex.token;
		circle.appendChild(title);
		return circle;
	}

	/* ------------------------------------------------------------------ */
	/* The list underneath                                                  */
	/* ------------------------------------------------------------------ */

	private renderList(links: ChapterLink[], vertices: Vertex[], index: Map<string, Pawn>): void {
		this.listEl.createDiv({ cls: "wsm-rel__list-title", text: this.plugin.t("relListTitle") });

		if (links.length === 0) {
			this.listEl.createDiv({ cls: "wsm-rel__empty", text: this.plugin.t("relNoLinks") });
			return;
		}

		for (const link of links) {
			const row = this.listEl.createDiv({ cls: `wsm-rel__row is-${link.kind}` });

			const names = row.createDiv({ cls: "wsm-rel__pair" });
			names.createSpan({ cls: "wsm-rel__who", text: this.who(link.a, index) });
			names.createSpan({
				cls: "wsm-rel__arrow",
				// The kind is spelled out rather than left to the line colour:
				// a colour alone cannot be read by everyone, and this row is
				// where the writer checks what they actually recorded.
				text: this.plugin.t("relKindLabel", { kind: this.plugin.t(KIND_KEYS[link.kind]) }),
			});
			names.createSpan({ cls: "wsm-rel__who", text: this.who(link.b, index) });

			// A tie with someone who is not on this map cannot be drawn. Saying so
			// is better than a graph that is quietly missing an edge.
			const off = !vertices.some((vertex) => vertex.token === link.a) ||
				!vertices.some((vertex) => vertex.token === link.b);
			if (off) {
				row.createDiv({ cls: "wsm-rel__off", text: this.plugin.t("relOffMap") });
			}

			const remove = row.createEl("button", { cls: "wsm-map__from-btn wsm-rel__remove" });
			setIcon(remove, "trash-2");
			remove.title = this.plugin.t("relRemove");
			remove.addEventListener("click", () => this.drop(link));
		}
	}

	private who(token: string, index: Map<string, Pawn>): string {
		return index.get(token)?.name ?? token;
	}

	/* ------------------------------------------------------------------ */
	/* Actions                                                              */
	/* ------------------------------------------------------------------ */

	/**
	 * Two clicks make a tie, the third decision is the kind.
	 *
	 * Picking the same character twice cancels instead of making a tie to
	 * itself, which is the mistake a two-click gesture invites.
	 */
	private pick(token: string): void {
		if (!this.pending) {
			this.pending = token;
			this.render();
			return;
		}
		if (this.pending === token) {
			this.pending = null;
			this.render();
			return;
		}
		this.chooseKind(token);
	}

	/** The three kinds, offered once the pair is known. */
	private chooseKind(second: string): void {
		const first = this.pending as string;
		const path = this.plugin.activeChapterPath;
		if (!path) return;

		this.pending = null;
		this.graphEl.empty();
		const picker = this.graphEl.createDiv({ cls: "wsm-rel__kinds" });
		picker.createDiv({
			cls: "wsm-rel__kinds-title",
			text: this.plugin.t("relKindTitle", { a: first, b: second }),
		});

		for (const kind of KINDS) {
			const button = picker.createEl("button", { cls: `wsm-rel__kind is-${kind}` });
			setIcon(button, KIND_ICONS[kind]);
			button.createSpan({ text: this.plugin.t(KIND_KEYS[kind]) });
			button.addEventListener("click", () => this.commit(first, second, kind));
		}

		const cancel = picker.createEl("button", { cls: "wsm-rel__kinds-cancel" });
		cancel.setText(this.plugin.t("relCancel"));
		cancel.addEventListener("click", () => this.render());
	}

	private commit(first: string, second: string, kind: LinkKind): void {
		const path = this.plugin.activeChapterPath;
		if (!path) return;

		const changed = this.plugin.updateMap(path, (maps, p) => addLink(maps, p, first, second, kind));
		this.render();
		new Notice(
			changed
				? this.plugin.t("noticeLinkAdded", {
						kind: this.plugin.t(KIND_KEYS[kind]),
						a: first,
						b: second,
					})
				: this.plugin.t("noticeLinkKept"),
		);
	}

	private drop(link: ChapterLink): void {
		const path = this.plugin.activeChapterPath;
		if (!path) return;

		this.plugin.updateMap(path, (maps, p) => removeLink(maps, p, link.a, link.b));
		this.render();
	}
}

function svgEl(tag: string): SVGElement {
	return document.createElementNS(SVG_NS, tag) as SVGElement;
}
