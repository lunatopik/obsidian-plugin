import { Notice, normalizePath } from "obsidian";
import type WriterStateMapPlugin from "../main";
import { mergeMaps, mergePawns, normalizeMaps, normalizePawns } from "./store";
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from "./types";
import type { Language, WriterStateMapSettings } from "./types";

/**
 * Byte-level persistence for data.json.
 *
 * This is the only module in the plugin that touches the disk. Chapter maps and
 * the roster live in the plugin's own data.json — the author's notes are never
 * read or written here.
 *
 * Three layers of safety, because data.json is now the single source of truth
 * for every chapter:
 *   1. debounced, serialized writes  — rapid edits can never interleave or race
 *   2. data.json.bak                — the last known-good file, rate-limited
 *   3. export/import to the vault   — a copy your git or sync setup can see
 */

/** How long to wait for a quiet moment before writing. */
const SAVE_DEBOUNCE_MS = 400;
/** Minimum gap between two backups, so a long editing session is not disk-bound. */
const BACKUP_INTERVAL_MS = 60_000;

export type ImportMode = "replace" | "merge";

/**
 * Every registered tab the plugin can be the one to open.
 *
 * Spelled out as a list rather than tested against "roster" and defaulting to
 * "map": a check written that way silently rewrites every new view to the map,
 * so a data.json that asked for the roster tab would come back showing the map
 * instead, with nothing to indicate why.
 *
 * The chapter note and the relationship graph are not in the list because they
 * are not tabs. A file that names either falls back to the map, which is the
 * honest answer: there is no such tab to open.
 */
const DEFAULT_VIEWS = ["map", "roster"] as const;

function asDefaultView(value: unknown): WriterStateMapSettings["defaultView"] {
	return DEFAULT_VIEWS.includes(value as (typeof DEFAULT_VIEWS)[number])
		? (value as WriterStateMapSettings["defaultView"])
		: DEFAULT_SETTINGS.defaultView;
}

export interface ImportResult {
	maps: number;
	pawns: number;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Vault path of the folder containing a path ("a/b/c.json" -> "a/b"). */
function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "" : path.slice(0, index);
}

function isLanguage(value: unknown): value is Language {
	return value === "en" || value === "ru";
}

/**
 * Turn whatever is on disk into a valid settings object.
 *
 * data.json is hand-editable and imports come from outside, so nothing here may
 * throw: a broken file degrades to defaults instead of disabling the plugin.
 * Normalizing the map is also how older layouts are migrated, so the version is
 * stamped after the fact rather than trusted.
 */
export function parseSettings(raw: unknown): WriterStateMapSettings {
	const data = asRecord(raw);
	const canvas = asRecord(data.defaultCanvas);
	const exportPath = typeof data.exportPath === "string" ? data.exportPath.trim() : "";

	return {
		schemaVersion: SCHEMA_VERSION,
		language: isLanguage(data.language) ? data.language : DEFAULT_SETTINGS.language,
			defaultView: asDefaultView(data.defaultView),
		defaultCanvas: {
			width: positive(canvas.width, DEFAULT_SETTINGS.defaultCanvas.width),
			height: positive(canvas.height, DEFAULT_SETTINGS.defaultCanvas.height),
		},
		exportPath: exportPath || DEFAULT_SETTINGS.exportPath,
		pawns: normalizePawns(data.pawns),
		maps: normalizeMaps(data.maps),
	};
}

function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

export class DataStorage {
	private readonly plugin: WriterStateMapPlugin;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	/** Serializes writes: each one waits for the previous to settle. */
	private chain: Promise<void> = Promise.resolve();
	private lastBackupAt = 0;

	constructor(plugin: WriterStateMapPlugin) {
		this.plugin = plugin;
	}

	/* ------------------------------------------------------------------ */
	/* Paths                                                                 */
	/* ------------------------------------------------------------------ */

	/** Resolved from the manifest so a renamed plugin folder still works. */
	private get pluginDir(): string {
		const dir = this.plugin.manifest.dir;
		return normalizePath(dir || `.obsidian/plugins/${this.plugin.manifest.id}`);
	}

	private get dataPath(): string {
		return `${this.pluginDir}/data.json`;
	}

	private get backupPath(): string {
		return `${this.pluginDir}/data.json.bak`;
	}

	private get adapter() {
		return this.plugin.app.vault.adapter;
	}

	/* ------------------------------------------------------------------ */
	/* Writing                                                               */
	/* ------------------------------------------------------------------ */

	/** Coalesce bursts of edits into a single write. */
	requestSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, SAVE_DEBOUNCE_MS);
	}

	/** Write now, after any pending debounce and any in-flight write. */
	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.chain = this.chain.then(() => this.writeNow());
		return this.chain;
	}

	private async writeNow(): Promise<void> {
		try {
			await this.backup();
			await this.plugin.saveData(this.plugin.settings);
		} catch (error) {
			// The in-memory state stays correct, so a failed write is recoverable
			// by the next save rather than something the UI must roll back.
			new Notice(this.plugin.t("noticeSaveFailed", { message: String(error) }));
		}
	}

	/**
	 * Copy the current file to data.json.bak before it is overwritten.
	 * Best-effort: a missing, unreadable or corrupt file is simply skipped, so
	 * a bad read can never destroy the last good backup.
	 */
	private async backup(): Promise<void> {
		const now = Date.now();
		if (now - this.lastBackupAt < BACKUP_INTERVAL_MS) return;
		this.lastBackupAt = now;

		try {
			if (!(await this.adapter.exists(this.dataPath))) return;
			const raw = await this.adapter.read(this.dataPath);
			JSON.parse(raw);
			await this.adapter.write(this.backupPath, raw);
		} catch {
			/* backup is an optimization, never a blocker */
		}
	}

	/** True when a backup file is available to restore. */
	async hasBackup(): Promise<boolean> {
		try {
			return await this.adapter.exists(this.backupPath);
		} catch {
			return false;
		}
	}

	async restoreBackup(): Promise<boolean> {
		const raw = await this.adapter.read(this.backupPath);
		this.plugin.settings = parseSettings(JSON.parse(raw));
		await this.plugin.saveData(this.plugin.settings);
		this.plugin.refreshAllViews();
		return true;
	}

	/**
	 * Re-read data.json from disk, discarding anything held in memory.
	 * The escape hatch for people who edit the file by hand: without this, the
	 * next automatic save would silently overwrite their edits.
	 */
	async reloadFromDisk(): Promise<void> {
		this.plugin.settings = parseSettings(await this.plugin.loadData());
		this.plugin.refreshAllViews();
	}

	/* ------------------------------------------------------------------ */
	/* Portable copy in the vault                                            */
	/* ------------------------------------------------------------------ */

	async exportTo(path: string): Promise<string> {
		const target = normalizePath(path.trim() || this.plugin.settings.exportPath);
		// The export is plugin data, never a note. Without this a user-supplied
		// path could point the writer at a chapter file.
		if (!target.toLowerCase().endsWith(".json")) {
			throw new Error("export path must end with .json");
		}
		const dir = parentOf(target);
		if (dir && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);

		const payload = {
			schemaVersion: SCHEMA_VERSION,
			exportedAt: new Date().toISOString(),
			pawns: this.plugin.settings.pawns,
			maps: this.plugin.settings.maps,
		};
		await this.adapter.write(target, `${JSON.stringify(payload, null, 2)}\n`);
		return target;
	}

	async importFrom(path: string, mode: ImportMode): Promise<ImportResult> {
		const source = normalizePath(path.trim() || this.plugin.settings.exportPath);
		const data = asRecord(JSON.parse(await this.adapter.read(source)));

		const incomingMaps = normalizeMaps(data.maps);
		const incomingPawns = normalizePawns(data.pawns);
		const settings = this.plugin.settings;

		if (mode === "replace") {
			settings.maps = incomingMaps;
			settings.pawns = incomingPawns;
		} else {
			settings.maps = mergeMaps(settings.maps, incomingMaps).maps;
			settings.pawns = mergePawns(settings.pawns, incomingPawns).pawns;
		}

		await this.plugin.saveData(settings);
		this.plugin.refreshAllViews();
		return { maps: Object.keys(incomingMaps).length, pawns: incomingPawns.length };
	}

	/** Flush anything pending; called when the plugin unloads. */
	async dispose(): Promise<void> {
		if (!this.saveTimer) return;
		await this.flush();
	}
}
