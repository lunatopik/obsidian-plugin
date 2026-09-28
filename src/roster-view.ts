import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type WriterStateMapPlugin from "../main";
import { readMap } from "./store";
import type { Pawn } from "./types";
import { clampInitials, createPawn, indexPawns, initialsFromName, resolveToken, textColorClasses } from "./pawns";
import { pickImage, pickNote } from "./pickers";

export const VIEW_TYPE_ROSTER = "writer-state-map-roster";

type EditorState = { mode: "create"; draft: Pawn } | { mode: "edit"; draft: Pawn } | null;

/**
 * The roster tab: a manual sandbox for character pawns.
 *
 * Everything the plugin knows about characters lives in data.json and is
 * edited here by hand. The plugin never reads character notes on its own —
 * a note is attached only when the writer explicitly picks it.
 */
export class RosterView extends ItemView {
	private root!: HTMLElement;
	private listEl!: HTMLElement;
	private editorEl: HTMLElement | null = null;
	private editor: EditorState = null;
	private previewToken: HTMLElement | null = null;
	/**
	 * Widgets of the note row in the *currently open* editor.
	 *
	 * They are stored as a bundle rather than as two loose fields so that a
	 * label and its "Открепить" button can never drift apart, and so that
	 * paintNote() can tell whether the row it is about to touch is still in
	 * the document.
	 */
	private noteWidgets: { label: HTMLElement; unbind: HTMLButtonElement } | null = null;
	/** True once the writer edits initials by hand; stops auto-derivation. */
	private initialsTouched = false;
	private initialsInput: HTMLInputElement | null = null;

	private readonly plugin: WriterStateMapPlugin;

	// Explicit field instead of a TS parameter property: the test suite runs
	// these files through Node's strip-only TypeScript, which rejects them.
	constructor(leaf: WorkspaceLeaf, plugin: WriterStateMapPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_ROSTER;
	}

	getDisplayText(): string {
		return this.plugin.t("viewRoster");
	}

	getIcon(): string {
		return "users";
	}

	async onOpen(): Promise<void> {
		// The root is emptied below, so any editor left over from a previous
		// onOpen() would be a phantom: its state would still be saved while its
		// DOM is gone. Dropping it keeps the two in sync.
		this.closeEditor();
		this.root = this.contentEl;
		this.root.empty();
		this.root.addClass("wsm-roster");

		const head = this.root.createDiv({ cls: "wsm-roster__head" });
		head.createDiv({ cls: "wsm-roster__title", text: this.plugin.t("viewRoster") });

		const createButton = head.createEl("button", { cls: "wsm-roster__create mod-cta" });
		setIcon(createButton, "plus");
		createButton.createSpan({ text: this.plugin.t("rosterCreate") });
		createButton.addEventListener("click", () => this.openEditor("create"));

		// Hint about where the roster is stored: it is a sandbox, not a scan.
		this.root.createDiv({ cls: "wsm-roster__privacy", text: this.plugin.t("settingsPrivacy") });

		this.listEl = this.root.createDiv({ cls: "wsm-roster__list" });
		this.render();
	}

	async onClose(): Promise<void> {
		this.editorEl?.remove();
		this.editorEl = null;
	}

	/** Called when the active chapter changes (to refresh "on map" counters). */
	onExternalChange(): void {
		if (!this.editor) this.render();
	}

	/* ------------------------------------------------------------------ */
	/* List                                                                 */
	/* ------------------------------------------------------------------ */

	private render(): void {
		this.listEl.empty();

		const pawns = this.plugin.pawns;
		if (pawns.length === 0) {
			this.listEl.createDiv({ cls: "wsm-empty__title", text: this.plugin.t("rosterEmptyTitle") });
			this.listEl.createDiv({ cls: "wsm-empty__hint", text: this.plugin.t("rosterEmptyHint") });
			return;
		}

		const usage = this.countUsages(pawns);
		for (const pawn of pawns) {
			this.listEl.appendChild(this.buildCard(pawn, usage.get(pawn.id) ?? 0));
		}
	}

	/** How many nodes of the *active* chapter reference each pawn. */
	private countUsages(pawns: Pawn[]): Map<string, number> {
		const usage = new Map<string, number>();
		const path = this.plugin.activeChapterPath;
		if (!path) return usage;

		const index = indexPawns(pawns);
		const map = readMap(this.plugin.settings.maps, path, this.plugin.settings.defaultCanvas);
		for (const node of map.nodes) {
			for (const token of node.chars) {
				const { pawn } = resolveToken(token, index, pawns);
				if (pawn) usage.set(pawn.id, (usage.get(pawn.id) ?? 0) + 1);
			}
		}
		return usage;
	}

	private buildCard(pawn: Pawn, onMap: number): HTMLElement {
		const card = this.listEl.createDiv({ cls: "wsm-card" });
		card.appendChild(this.buildToken(pawn));

		const info = card.createDiv({ cls: "wsm-card__info" });
		info.createDiv({ cls: "wsm-card__name", text: pawn.name });
		info.createDiv({ cls: "wsm-card__id", text: pawn.id });
		info.createDiv({
			cls: "wsm-card__meta",
			text: `${this.plugin.t("rosterOnMap")}: ${onMap}`,
		});

		const actions = card.createDiv({ cls: "wsm-card__actions" });

		const openButton = actions.createEl("button", { cls: "wsm-card__action" });
		setIcon(openButton, "pencil");
		openButton.title = this.plugin.t("rosterEdit");
		openButton.addEventListener("click", () => this.openEditor("edit", pawn));

		if (pawn.notePath) {
			const notePath = pawn.notePath;
			const noteButton = actions.createEl("button", { cls: "wsm-card__action" });
			setIcon(noteButton, "file-text");
			// The full path as a tooltip: the sidebar is too narrow to show it.
			noteButton.title = `${this.plugin.t("rosterNoteOpen")} — ${notePath}`;
			noteButton.addEventListener("click", () => {
				void this.app.workspace.openLinkText(notePath, "");
			});
		}

		const deleteButton = actions.createEl("button", { cls: "wsm-card__action is-danger" });
		setIcon(deleteButton, "trash");
		deleteButton.title = this.plugin.t("rosterDelete");
		deleteButton.addEventListener("click", () => this.confirmDelete(pawn));

		return card;
	}

	private async confirmDelete(pawn: Pawn): Promise<void> {
		if (!window.confirm(this.plugin.t("rosterDeleteConfirm", { name: pawn.name }))) return;
		this.plugin.removePawn(pawn.id);
		this.render();
	}

	/* ------------------------------------------------------------------ */
	/* Editor                                                               */
	/* ------------------------------------------------------------------ */

	private openEditor(mode: "create" | "edit", existing?: Pawn): void {
		const draft = mode === "create" ? createPawn("", this.plugin.pawns) : { ...(existing as Pawn) };
		this.closeEditor();
		// An untouched draft must keep following the name, otherwise typing a name
		// leaves the token frozen on the "?" placeholder and the pawn is saved with
		// a literal question mark.
		this.initialsTouched = mode === "edit" && draft.initials !== initialsFromName(draft.name);
		this.editor = { mode, draft };
		this.buildEditor();
	}

	private closeEditor(): void {
		this.editor = null;
		this.editorEl?.remove();
		this.editorEl = null;
		this.previewToken = null;
		this.noteWidgets = null;
		this.initialsInput = null;
	}

	/**
	 * Rebuild the editor DOM while keeping the current draft.
	 *
	 * Used by paintNote() when the note row it holds is no longer in the
	 * document — the writer's binding must never be saved while the sidebar
	 * still claims the file is "not bound".
	 */
	private repaintEditor(): void {
		if (!this.editor) return;
		this.editorEl?.remove();
		this.editorEl = null;
		this.previewToken = null;
		this.noteWidgets = null;
		this.initialsInput = null;
		this.buildEditor();
	}

	/**
	 * Show the draft's note binding in the open editor.
	 *
	 * Single source of truth for the label text and the "Открепить" state, so
	 * they can never disagree. When the widgets are stale (the view was
	 * re-rendered underneath us) the editor is rebuilt first — a rebuild paints
	 * the row directly and never comes back through here, so healing cannot
	 * recurse.
	 */
	private paintNote(): void {
		const draft = this.editor?.draft;
		if (!draft) return;

		let widgets = this.noteWidgets;
		if (!widgets || !widgets.label.isConnected) {
			this.repaintEditor();
			widgets = this.noteWidgets;
		}
		if (widgets) this.paintNoteWidgets(widgets, draft);
	}

	private paintNoteWidgets(widgets: { label: HTMLElement; unbind: HTMLButtonElement }, draft: Pawn): void {
		widgets.label.setText(draft.notePath ?? this.plugin.t("rosterNoNote"));
		widgets.label.title = draft.notePath ?? "";
		widgets.unbind.disabled = !draft.notePath;
	}

	/**
	 * Keep initials derived from the name until the writer types their own.
	 * A new draft starts with the "?" placeholder, which would otherwise be
	 * saved verbatim.
	 */
	private syncAutoInitials(draft: Pawn): void {
		if (this.initialsTouched) return;
		draft.initials = initialsFromName(draft.name);
		if (this.initialsInput) this.initialsInput.value = draft.initials;
	}

	private buildEditor(): void {
		const state = this.editor;
		if (!state) return;

		const editor = this.root.createDiv({ cls: "wsm-editor" });
		this.editorEl = editor;
		const draft = state.draft;

		// Live preview of the token.
		const previewHolder = editor.createDiv({ cls: "wsm-editor__preview" });
		this.previewToken = this.buildToken(draft);
		previewHolder.appendChild(this.previewToken);

		// Name.
		const nameRow = editor.createDiv({ cls: "wsm-editor__row" });
		nameRow.createDiv({ cls: "wsm-editor__label", text: this.plugin.t("rosterName") });
		const nameInput = nameRow.createEl("input", { type: "text", cls: "wsm-editor__input" });
		nameInput.value = draft.name;
		nameInput.placeholder = this.plugin.t("rosterNamePlaceholder");
		nameInput.addEventListener("input", () => {
			draft.name = nameInput.value;
			this.syncAutoInitials(draft);
			this.refreshPreview();
		});

		// Initials (auto-generated, always overridable).
		const initialsRow = editor.createDiv({ cls: "wsm-editor__row" });
		initialsRow.createDiv({ cls: "wsm-editor__label", text: this.plugin.t("rosterInitials") });
		const initialsInput = initialsRow.createEl("input", {
			type: "text",
			cls: "wsm-editor__input wsm-editor__input--initials",
		});
		initialsInput.value = draft.initials;
		initialsInput.maxLength = 3;
		this.initialsInput = initialsInput;
		initialsInput.addEventListener("input", () => {
			draft.initials = initialsInput.value;
			this.initialsTouched = true;
			this.refreshPreview();
		});

		const autoButton = initialsRow.createEl("button", { cls: "wsm-editor__mini" });
		autoButton.setText(this.plugin.t("rosterInitialsReset"));
		autoButton.title = this.plugin.t("rosterInitialsHint");
		autoButton.addEventListener("click", () => {
			this.initialsTouched = false;
			draft.initials = initialsFromName(draft.name);
			initialsInput.value = draft.initials;
			this.refreshPreview();
		});

		// Color.
		const colorRow = editor.createDiv({ cls: "wsm-editor__row" });
		colorRow.createDiv({ cls: "wsm-editor__label", text: this.plugin.t("rosterColor") });
		const colorInput = colorRow.createEl("input", { type: "color", cls: "wsm-editor__color" });
		colorInput.value = draft.color;
		colorInput.addEventListener("input", () => {
			draft.color = colorInput.value;
			this.refreshPreview();
		});

		// Initials colour. The automatic choice reads the solid colour, which is
		// all it can do — it has no idea what an avatar image looks like — so an
		// explicit override is the only way to fix a token the test got wrong.
		const textRow = editor.createDiv({ cls: "wsm-editor__row" });
		textRow.createDiv({ cls: "wsm-editor__label", text: this.plugin.t("rosterTextColor") });
		const textSelect = textRow.createEl("select", { cls: "wsm-editor__input wsm-editor__select" });
		// "auto" is not a stored colour but the absence of one, which is what a
		// pawn written before this field existed has.
		for (const [value, label] of [
			["", this.plugin.t("rosterTextColorAuto")],
			["white", this.plugin.t("rosterTextColorWhite")],
			["black", this.plugin.t("rosterTextColorBlack")],
			["red", this.plugin.t("rosterTextColorRed")],
		] as const) {
			const option = textSelect.createEl("option", { value });
			option.setText(label);
		}
		textSelect.value = draft.textColor ?? "";
		textSelect.addEventListener("change", () => {
			draft.textColor = (textSelect.value || undefined) as Pawn["textColor"];
			this.refreshPreview();
		});

		// Avatar (optional, chosen by hand).
		const avatarRow = editor.createDiv({ cls: "wsm-editor__row" });
		avatarRow.createDiv({ cls: "wsm-editor__label", text: this.plugin.t("rosterAvatar") });
		const avatarActions = avatarRow.createDiv({ cls: "wsm-editor__actions" });
		const pickAvatarButton = avatarActions.createEl("button", { cls: "wsm-editor__mini" });
		pickAvatarButton.setText(this.plugin.t("rosterAvatarPick"));
		pickAvatarButton.addEventListener("click", () => {
			void pickImage(this.app, this.plugin.settings.language).then((file: TFile | null) => {
				if (!file || !this.editor) return;
				draft.avatar = file.path;
				clearButton.disabled = false;
				this.refreshPreview();
			});
		});
		const clearButton = avatarActions.createEl("button", { cls: "wsm-editor__mini" });
		clearButton.setText(this.plugin.t("rosterAvatarClear"));
		clearButton.disabled = !draft.avatar;
		clearButton.addEventListener("click", () => {
			draft.avatar = undefined;
			clearButton.disabled = true;
			this.refreshPreview();
		});

		// Character note (optional, attached by hand).
		const noteRow = editor.createDiv({ cls: "wsm-editor__row" });
		noteRow.createDiv({ cls: "wsm-editor__label", text: this.plugin.t("rosterNote") });
		const noteActions = noteRow.createDiv({ cls: "wsm-editor__actions" });
		const noteLabel = noteActions.createDiv({ cls: "wsm-editor__note" });
		const bindButton = noteActions.createEl("button", { cls: "wsm-editor__mini" });
		bindButton.setText(this.plugin.t("rosterNoteBind"));
		const unbindButton = noteActions.createEl("button", { cls: "wsm-editor__mini" });
		unbindButton.setText(this.plugin.t("rosterNoteClear"));
		this.noteWidgets = { label: noteLabel, unbind: unbindButton };
		// Painted directly rather than through paintNote(): during the initial
		// build there is nothing to heal, and going through the healing path here
		// would rebuild the editor forever.
		this.paintNoteWidgets(this.noteWidgets, draft);

		bindButton.addEventListener("click", () => {
			void pickNote(this.app, this.plugin.settings.language).then((file: TFile | null) => {
				if (!file) return;
				// The state goes to the draft that asked for it, not to whatever
				// editor happens to be open when the picker closes.
				draft.notePath = file.path;
				if (this.editor?.draft === draft) this.paintNote();
			});
		});
		unbindButton.addEventListener("click", () => {
			draft.notePath = undefined;
			this.paintNote();
		});

		// Footer.
		const foot = editor.createDiv({ cls: "wsm-editor__foot" });
		const cancelButton = foot.createEl("button", { cls: "wsm-editor__cancel" });
		cancelButton.setText(this.plugin.t("rosterCancel"));
		cancelButton.addEventListener("click", () => this.closeEditor());

		const saveButton = foot.createEl("button", { cls: "wsm-editor__save mod-cta" });
		saveButton.setText(state.mode === "create" ? this.plugin.t("rosterCreateAction") : this.plugin.t("rosterSave"));
		saveButton.addEventListener("click", () => this.save());

		if (state.mode === "edit") {
			editor.createDiv({ cls: "wsm-editor__id", text: `id: ${draft.id}` });
		}
	}

	/** Repaint only the preview token so typing never loses focus. */
	private refreshPreview(): void {
		if (!this.editor || !this.previewToken) return;
		this.previewToken.remove();
		this.previewToken = this.buildToken(this.editor.draft);
		const holder = this.editorEl?.querySelector(".wsm-editor__preview");
		holder?.appendChild(this.previewToken);
	}

	private save(): void {
		if (!this.editor) return;
		const { mode, draft } = this.editor;
		draft.name = draft.name.trim();
		draft.initials = clampInitials(draft.initials, draft.name);

		if (!draft.name) {
			new Notice(this.plugin.t("noticePawnNameRequired"));
			return;
		}

		if (mode === "create") {
			// The id is assigned by the plugin (slugified, collision-free).
			const created = this.plugin.addPawn(draft.name, draft);
			if (!created) return;
			new Notice(this.plugin.t("noticePawnCreated", { name: created.name }));
		} else {
			this.plugin.updatePawn(draft);
		}

		this.closeEditor();
		this.render();
	}

	/* ------------------------------------------------------------------ */
	/* Token rendering (shared visual language with the map)                */
	/* ------------------------------------------------------------------ */

	private buildToken(pawn: Pawn): HTMLElement {
		const el = createDiv({ cls: "wsm-token wsm-token--lg" });
		el.style.backgroundColor = pawn.color;
		el.setText(clampInitials(pawn.initials, pawn.name));
		const colorClasses = textColorClasses(pawn, pawn.color);
		if (colorClasses) el.addClass(colorClasses);

		if (pawn.avatar) {
			const file = this.app.vault.getAbstractFileByPath(pawn.avatar);
			if (file instanceof TFile) {
				el.style.backgroundImage = `url("${this.app.vault.getResourcePath(file)}")`;
			} else {
				el.addClass("is-broken-avatar");
			}
		}
		return el;
	}
}
