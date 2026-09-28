import { App, FuzzySuggestModal, TFile } from "obsidian";
import { t } from "./i18n";
import type { TranslationKey } from "./i18n";
import type { Language } from "./types";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"]);

function isImage(file: TFile): boolean {
	return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
}

/**
 * Vault pickers.
 *
 * Privacy note: `getItems()` is only called once the modal is actually opened,
 * so file names are enumerated strictly on demand. The plugin never walks the
 * vault on its own.
 */
class VaultPickerModal extends FuzzySuggestModal<TFile> {
	private resolved = false;
	// Explicit fields instead of TS parameter properties: the test suite loads
	// this module through Node's strip-only TypeScript, which rejects them.
	private readonly placeholderKey: TranslationKey;
	private readonly imageOnly: boolean;
	private readonly resolve: (file: TFile | null) => void;

	constructor(
		app: App,
		lang: Language,
		placeholderKey: TranslationKey,
		imageOnly: boolean,
		resolve: (file: TFile | null) => void,
	) {
		super(app);
		this.placeholderKey = placeholderKey;
		this.imageOnly = imageOnly;
		this.resolve = resolve;
		this.setPlaceholder(t(lang, this.placeholderKey));
		this.emptyStateText = t(lang, "pickerNoResults");
		this.limit = 50;
	}

	getItems(): TFile[] {
		const files = this.app.vault.getFiles();
		return this.imageOnly ? files.filter(isImage) : files.filter((file) => file.extension === "md");
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.resolved = true;
		this.resolve(file);
	}

	onClose(): void {
		// Insurance against Obsidian calling onClose() before onChooseItem() for
		// the same pick: resolving null on the next tick lets a same-tick
		// onChooseItem() win, and a real cancel still resolves one tick later.
		if (this.resolved) return;
		setTimeout(() => {
			if (!this.resolved) this.resolve(null);
		}, 0);
	}
}

/** Quick switcher over markdown notes. Resolves with null when cancelled. */
export function pickNote(app: App, lang: Language): Promise<TFile | null> {
	return new Promise((resolve) => {
		new VaultPickerModal(app, lang, "pickerNotePlaceholder", false, resolve).open();
	});
}

/** Quick switcher over vault images. Resolves with null when cancelled. */
export function pickImage(app: App, lang: Language): Promise<TFile | null> {
	return new Promise((resolve) => {
		new VaultPickerModal(app, lang, "pickerImagePlaceholder", true, resolve).open();
	});
}

/**
 * Quick switcher over a plain list of strings (e.g. orphaned map keys).
 * The list is passed in already built, so nothing about the vault is scanned.
 */
class ListSuggestModal extends FuzzySuggestModal<string> {
	private resolved = false;
	private readonly items: string[];
	private readonly resolve: (value: string | null) => void;

	constructor(
		app: App,
		lang: Language,
		items: string[],
		placeholderKey: TranslationKey,
		resolve: (value: string | null) => void,
	) {
		super(app);
		this.items = items;
		this.resolve = resolve;
		this.setPlaceholder(t(lang, placeholderKey));
		this.emptyStateText = t(lang, "pickerNoResults");
		this.limit = 50;
	}

	getItems(): string[] {
		return this.items;
	}

	getItemText(value: string): string {
		return value;
	}

	onChooseItem(value: string): void {
		this.resolved = true;
		this.resolve(value);
	}

	onClose(): void {
		// Same insurance as in VaultPickerModal: a same-tick onChooseItem()
		// after this close still wins.
		if (this.resolved) return;
		setTimeout(() => {
			if (!this.resolved) this.resolve(null);
		}, 0);
	}
}

export function pickFromList(
	app: App,
	lang: Language,
	items: string[],
	placeholderKey: TranslationKey,
): Promise<string | null> {
	return new Promise((resolve) => {
		new ListSuggestModal(app, lang, items, placeholderKey, resolve).open();
	});
}
