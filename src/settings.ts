import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type WriterStateMapPlugin from "../main";
import type { Language } from "./types";

/**
 * Plugin-level options only.
 *
 * The roster deliberately lives in its own tab next to the map, so that adding
 * a character never requires a trip to the settings dialog.
 */
export class WriterStateMapSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: WriterStateMapPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(this.plugin.t("settingsLanguage"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("en", "English")
					.addOption("ru", "Русский")
					.setValue(this.plugin.settings.language)
					.onChange((value) => {
						this.plugin.setLanguage(value as Language);
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settingsDefaultView"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("map", this.plugin.t("settingsDefaultViewMap"))
					.addOption("note", this.plugin.t("settingsDefaultViewNote"))
		.addOption("roster", this.plugin.t("settingsDefaultViewRoster"))
			.addOption("relationship", this.plugin.t("settingsDefaultViewRelationship"))
			.setValue(this.plugin.settings.defaultView)
				.onChange(async (value) => {
					this.plugin.settings.defaultView = value as "map" | "note" | "roster" | "relationship";
					this.plugin.requestSave();
				}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settingsDefaultCanvas"))
			.setDesc(this.plugin.t("settingsDefaultCanvasHint"))
			.addText((text) =>
				text
					.setPlaceholder("1024x768")
					.setValue(`${this.plugin.settings.defaultCanvas.width}x${this.plugin.settings.defaultCanvas.height}`)
					.onChange(async (raw) => {
						const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(raw.trim());
						if (!match) return;
						const width = Number.parseInt(match[1], 10);
						const height = Number.parseInt(match[2], 10);
						if (width <= 0 || height <= 0) return;
						this.plugin.settings.defaultCanvas = { width, height };
						this.plugin.requestSave();
					}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settingsOpenRoster"))
			.setDesc(this.plugin.t("settingsOpenRosterDesc"))
			.addButton((button) =>
				button
					.setButtonText(this.plugin.t("viewRoster"))
					.setCta()
					.onClick(() => {
						void this.plugin.openTab("roster");
					}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settingsExportNotes"))
			.setDesc(this.plugin.t("settingsExportNotesDesc"))
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settingsExportNotesButton")).onClick(() => {
					void this.plugin.exportNotes();
				}),
			);

		this.displayDataSection(containerEl);
	}

	/* ------------------------------------------------------------------ */
	/* Data safety                                                          */
	/* ------------------------------------------------------------------ */

	private displayDataSection(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: this.plugin.t("settingsDataHeading") });

		new Setting(containerEl)
			.setName(this.plugin.t("settingsExportPath"))
			.setDesc(this.plugin.t("settingsExportPathHint"))
			.addText((text) =>
				text.setPlaceholder("Writer Maps/wsm-data.json").setValue(this.plugin.settings.exportPath).onChange((raw) => {
					const value = raw.trim();
					if (!value) return;
					this.plugin.settings.exportPath = value;
					this.plugin.requestSave();
				}),
			)
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settingsExport")).onClick(() => {
					void this.plugin.exportData();
				}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("commandImportData"))
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settingsImport")).onClick(() => {
					void this.plugin.importData("merge");
				}),
			)
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settingsImportReplace")).onClick(() => {
					if (!window.confirm(this.plugin.t("confirmReplaceImport"))) return;
					void this.plugin.importData("replace");
				}),
			);

		// Hand-editing data.json is supported, but the plugin saves on its own
		// schedule — without this button such edits would be overwritten.
		new Setting(containerEl)
			.setName(this.plugin.t("commandReloadData"))
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settingsReload")).onClick(async () => {
					if (!window.confirm(this.plugin.t("confirmReload"))) return;
					await this.plugin.reloadData();
					this.display();
				}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settingsRestoreBackup"))
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settingsRestoreBackup")).onClick(async () => {
					if (!(await this.plugin.storage.hasBackup())) {
						new Notice(this.plugin.t("noticeNoBackup"));
						return;
					}
					if (!window.confirm(this.plugin.t("confirmRestoreBackup"))) return;
					await this.plugin.restoreBackup();
					this.display();
				}),
			);

		const orphans = this.plugin.orphanMapKeys();
		new Setting(containerEl)
			.setName(this.plugin.t("settingsCleanupOrphans"))
			.setDesc(orphans.length > 0 ? orphans.join(", ") : this.plugin.t("noticeNoOrphans"))
			.addButton((button) =>
				button
					.setButtonText(this.plugin.t("commandCleanupOrphans"))
					.setDisabled(orphans.length === 0)
					.onClick(() => {
						void this.plugin.cleanupOrphanMaps();
						this.display();
					}),
			);

		containerEl.createEl("p", {
			cls: "setting-item-description wsm-privacy",
			text: this.plugin.t("settingsPrivacy"),
		});
	}
}
