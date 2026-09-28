/**
 * A DOM small enough to run under Node, big enough for the plugin's views.
 *
 * The view layer used to have zero test coverage, which is how a detached
 * `this.plugin.t` reference could reach the bundle and kill every popover
 * action without a single failing assertion. These fakes exist so the popover
 * and the pawn editor can be exercised for real instead.
 *
 * Implemented: Obsidian element helpers, classes, text, dataset, style,
 * dispatchable listeners, one selector form, fixed rects, focus/select.
 * Deliberately absent: layout, so getBoundingClientRect returns fixed boxes.
 */

export interface ElementInfo {
	cls?: string;
	text?: string;
	type?: string;
	value?: string;
	placeholder?: string;
}

export interface FakeEvent {
	type?: string;
	key?: string;
	target?: unknown;
	button?: number;
	clientX?: number;
	clientY?: number;
	preventDefault?: () => void;
	stopPropagation?: () => void;
}

type Listener = (event: FakeEvent) => void;

interface Style {
	[key: string]: string;
	setProperty(name: string, value: string): void;
}

function createStyle(): Style {
	const style: Style = {
		setProperty(name: string, value: string): void {
			style[name] = value;
		},
	};
	return style;
}

/**
 * A real `dataset` is a view over the `data-*` attributes, not a second store.
 * Keeping two would break the plugin in a way no assertion could explain: the
 * code reads a flag with `getAttribute("data-drag")` after writing it with
 * `dataset.drag`, and a two-store stub answers `null` for a flag that is
 * plainly set, so every drag silently stops recognising what it grabbed.
 *
 * A plain object also breaks the mapping the popover needs, hence the proxy:
 * dataset keys are camelCase, the attributes they mirror are kebab-cased, and
 * reads may arrive in either shape, so the mapping has to be idempotent.
 */
function createDataset(attributes: Record<string, string>): Record<string, string> {
	const attrName = (prop: string): string =>
		prop.startsWith("data-") ? prop : `data-${prop.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;

	return new Proxy(attributes, {
		get(target, prop: string | symbol): unknown {
			return typeof prop === "string" ? target[attrName(prop)] : undefined;
		},
		set(target, prop: string | symbol, value: unknown): boolean {
			if (typeof prop !== "string") return false;
			target[attrName(prop)] = String(value);
			return true;
		},
		has(target, prop: string | symbol): boolean {
			return typeof prop === "string" ? attrName(prop) in target : false;
		},
		deleteProperty(target, prop: string | symbol): boolean {
			if (typeof prop !== "string") return false;
			delete target[attrName(prop)];
			return true;
		},
	}) as Record<string, string>;
}

export class FakeElement {
	tag = "div";
	children: FakeElement[] = [];
	parent: FakeElement | null = null;
	/** True once the subtree has been taken out of the tree it was in. */
	detached = false;
	classes = new Set<string>();
	/**
	 * The one store for attributes *and* dataset: `data-*` lives in `attributes`,
	 * and `dataset` is a camelCase view onto it. A real DOM has no separate copy,
	 * so a stub that keeps two invents failures the plugin does not have.
	 */
	attributes: Record<string, string> = {};
	dataset: Record<string, string> = createDataset(this.attributes);
	style: Style = createStyle();
	listeners: Record<string, Listener[]> = {};
	/** Set for elements made with `createElementNS`, i.e. real SVG nodes. */
	namespaceURI: string | null = null;

	/**
	 * The SVG class list. Only the three methods the plugin actually calls, but
	 * `classList` is how SVG elements are classed: `setAttribute("class", ...)`
	 * would not update `classes`, and the selectors in the map tests read `classes`.
	 */
	readonly classList = {
		add: (...names: string[]): void => {
			for (const name of names) this.classes.add(name);
		},
		remove: (...names: string[]): void => {
			for (const name of names) this.classes.delete(name);
		},
		contains: (name: string): boolean => this.classes.has(name),
		toggle: (name: string, force?: boolean): boolean => {
			const on = force ?? !this.classes.has(name);
			if (on) this.classes.add(name);
			else this.classes.delete(name);
			return on;
		},
	};

	// State the views read and write.
	text = "";
	value = "";
	checked = false;
	title = "";
	placeholder = "";
	maxLength = -1;
	type = "";
	alt = "";
	disabled = false;
	focused = false;
	hasSelection = false;

	clientWidth = 320;
	clientHeight = 480;
	rect = { left: 0, top: 0, right: 240, bottom: 40, width: 240, height: 40 };

	constructor(tag = "div") {
		this.tag = tag;
	}

	/* ------------------------------- tree ------------------------------- */

	appendChild(child: FakeElement): FakeElement {
		if (child.parent) child.parent.removeChild(child);
		child.parent = this;
		this.children.push(child);
		child.markAttached();
		return child;
	}

	removeChild(child: FakeElement): void {
		const index = this.children.indexOf(child);
		if (index >= 0) this.children.splice(index, 1);
		child.parent = null;
		child.markDetached();
	}

	remove(): void {
		if (this.parent) this.parent.removeChild(this);
	}

	/**
	 * Mirrors the DOM closely enough for the views' self-healing paths.
	 *
	 * A subtree that leaves the tree is detached as a whole: checking only the
	 * immediate parent would report a label inside a removed editor as still
	 * connected, which is precisely the mistake a real `isConnected` does not
	 * make.
	 */
	get isConnected(): boolean {
		return !this.detached;
	}

	markDetached(): void {
		if (this.detached) return;
		this.detached = true;
		for (const child of this.children) child.markDetached();
	}

	markAttached(): void {
		if (!this.detached) return;
		this.detached = false;
		for (const child of this.children) child.markAttached();
	}

	empty(): void {
		for (const child of [...this.children]) this.removeChild(child);
	}

	/** Depth-first list of every descendant, self excluded. */
	all(): FakeElement[] {
		const out: FakeElement[] = [];
		const walk = (node: FakeElement): void => {
			for (const child of node.children) {
				out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}

	find(predicate: (el: FakeElement) => boolean): FakeElement | null {
		return this.all().find(predicate) ?? null;
	}

	findAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
		return this.all().filter(predicate);
	}

	/* ----------------------------- selectors ---------------------------- */

	/** Supports ".class", bare tag names, "[data-x]" and "[data-x='y']". */
	matches(selector: string): boolean {
		const withValue = /^\[([a-zA-Z-]+)="([^"]*)"\]$/.exec(selector);
		if (withValue) return this.dataset[withValue[1]] === withValue[2];
		// A bare attribute selector: "does this element carry the mark at all".
		const bare = /^\[([a-zA-Z-]+)\]$/.exec(selector);
		if (bare) return bare[1] in this.dataset;
		if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
		return this.tag === selector;
	}

	querySelector(selector: string): FakeElement | null {
		return this.all().find((el) => el.matches(selector)) ?? null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		return this.all().filter((el) => el.matches(selector));
	}

	closest(selector: string): FakeElement | null {
		let node: FakeElement | null = this;
		while (node) {
			if (node.matches(selector)) return node;
			node = node.parent;
		}
		return null;
	}

	/* ------------------------------ classes ----------------------------- */

	addClass(...names: string[]): void {
		for (const name of names) if (name) this.classes.add(name);
	}

	removeClass(...names: string[]): void {
		for (const name of names) this.classes.delete(name);
	}

	toggleClass(name: string, on: boolean): void {
		if (on) this.classes.add(name);
		else this.classes.delete(name);
	}

	/* ------------------------------ content ----------------------------- */

	setText(value: string): void {
		this.text = value;
	}

	setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
	}

	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null;
	}

	removeAttribute(name: string): void {
		delete this.attributes[name];
	}

	/* ----------------------------- listeners ---------------------------- */

	addEventListener(type: string, listener: Listener): void {
		(this.listeners[type] ??= []).push(listener);
	}

	removeEventListener(type: string, listener: Listener): void {
		const list = this.listeners[type];
		if (!list) return;
		const index = list.indexOf(listener);
		if (index >= 0) list.splice(index, 1);
	}

	/** Dispatch a synthetic event, the way a user interaction would. */
	fire(type: string, event: FakeEvent = {}): void {
		const payload: FakeEvent = {
			preventDefault: () => undefined,
			stopPropagation: () => undefined,
			...event,
			type,
			target: event.target ?? this,
		};
		for (const listener of [...(this.listeners[type] ?? [])]) listener(payload);
	}

	/* ------------------------------ geometry ---------------------------- */

	getBoundingClientRect(): typeof this.rect {
		return this.rect;
	}

	focus(): void {
		this.focused = true;
	}

	select(): void {
		this.hasSelection = true;
	}

	setPointerCapture(): void {
		/* no-op */
	}

	releasePointerCapture(): void {
		/* no-op */
	}

	/* ------------------- Obsidian element helper methods ------------------ */

	/** Create a child with the given info. Classes apply to the child only. */
	createEl(tag: string, info: ElementInfo = {}): FakeElement {
		const child = new FakeElement(tag);
		applyInfo(child, info);
		return this.appendChild(child);
	}

	createDiv(info: ElementInfo = {}): FakeElement {
		return this.createEl("div", info);
	}

	createSpan(info: ElementInfo = {}): FakeElement {
		return this.createEl("span", info);
	}
}

function applyInfo(el: FakeElement, info: ElementInfo): void {
	if (info.cls) for (const name of info.cls.split(/\s+/)) el.addClass(name);
	if (info.type) el.type = info.type;
	if (info.text !== undefined) el.setText(info.text);
	// `value` and `placeholder` matter: a `<option>` is identified by its value
	// and an `<input>` is read by it, so a stub that drops them makes every
	// dropdown look empty and every test over it meaningless.
	if (info.value !== undefined) el.value = info.value;
	if (info.placeholder !== undefined) el.placeholder = info.placeholder;
}

export function createElement(tag = "div", info: ElementInfo = {}): FakeElement {
	const el = new FakeElement(tag);
	applyInfo(el, info);
	return el;
}

/** The SVG namespace, the one the map's spokes are built in. */
export const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Namespaced element creation.
 *
 * `createEl` cannot make an `<svg>` or a `<line>`: browsers treat them as
 * unknown HTML elements that never lay out, which is exactly why the spoke layer
 * has to go through here. The stub records the namespace so a test can prove the
 * production code used this path and not the HTML one.
 */
export function createElementNS(namespace: string, tag: string): FakeElement {
	const el = new FakeElement(tag);
	el.namespaceURI = namespace;
	return el;
}

/** Install the globals the plugin reaches for without importing them. */
export function installDom(): void {
	const scope = globalThis as unknown as Record<string, unknown>;
	scope.createDiv = (info: ElementInfo = {}): FakeElement => createElement("div", info);
	scope.createEl = (tag: string, info: ElementInfo = {}): FakeElement => createElement(tag, info);
	scope.createSpan = (info: ElementInfo = {}): FakeElement => createElement("span", info);
	scope.CSS = { escape: (value: string): string => value };
	/**
	 * `Element` is the global the plugin narrows event targets with before
	 * calling `closest`. Without it the map's drag recogniser throws a
	 * ReferenceError on the very first gesture, so the drag paths stay untested
	 * and every avatar sits still. Here the stub *is* the element class: every
	 * node the tests touch is a `FakeElement`, and nothing else passes for one.
	 */
	scope.Element = FakeElement;
	scope.window = { addEventListener: (): void => undefined, removeEventListener: (): void => undefined };
	scope.document = {
		addEventListener: (): void => undefined,
		removeEventListener: (): void => undefined,
		createElement: (tag: string): FakeElement => createElement(tag),
		createElementNS: (namespace: string, tag: string): FakeElement => createElementNS(namespace, tag),
	};
}
