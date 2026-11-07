import { Platform, TFile, TFolder } from "obsidian";
import type GdsyncPlugin from "./main";
import { contentHash } from "./mount-migration";
import { protectedPath, validPath } from "./sync-paths";

interface RebuildJournal {
	version: 1;
	rootId: string;
	directory: string;
	phase: "archiving" | "complete";
	files: string[];
	folders: string[];
}

/** Explicitly discard this device's sync state; never perform a Drive write. */
export class RootRebuild {
	constructor(private plugin: GdsyncPlugin) {}
	private get path(): string { return `${this.plugin.manifest.dir}/root-rebuild.json`; }
	private async load(): Promise<RebuildJournal | null> {
		const a = this.plugin.app.vault.adapter;
		if (!await a.exists(this.path)) return null;
		const j = JSON.parse(await a.read(this.path)) as RebuildJournal;
		if (j.version !== 1 || !Array.isArray(j.files) || !Array.isArray(j.folders) ||
			!["archiving", "complete"].includes(j.phase) ||
			!j.directory.startsWith(`${this.plugin.manifest.dir}/root-rebuild-backup-`) || !validPath(j.directory)) {
			throw new Error("Invalid root rebuild checkpoint");
		}
		return j;
	}
	async pending(): Promise<boolean> { return (await this.load())?.phase === "archiving"; }

	async run(): Promise<string> {
		const { app, settings, index } = this.plugin;
		const a = app.vault.adapter;
		let j = await this.load();
		if (j?.phase === "complete") return j.directory;
		if (!j) {
			const directory = `${this.plugin.manifest.dir}/root-rebuild-backup-${Date.now()}`;
			await a.mkdir(directory);
			// Keep configuration and all old checkpoints for manual recovery, including
			// pending remote deletes/renames that must never run after this reset.
			await a.write(`${directory}/index-before.json`, JSON.stringify(index.data));
			for (const name of ["data.json", "index.json", "index.json.tmp", "index.json.bak", "mount-migration.json", "mount-migration.json.tmp"]) {
				const source = `${this.plugin.manifest.dir}/${name}`;
				if (await a.exists(source)) await a.write(`${directory}/${name}`, await a.read(source));
			}
			const files = app.vault.getFiles().map(f => f.path).filter(p => !protectedPath(p, app.vault.configDir));
			const folders = app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder && validPath(f.path) && !protectedPath(f.path, app.vault.configDir))
				.map(f => f.path).sort((x, y) => y.length - x.length);
			j = { version: 1, rootId: settings.rootFolderId, directory, phase: "archiving", files, folders };
			await a.write(`${directory}/paths.json`, JSON.stringify(j));
			await a.write(this.path, JSON.stringify(j));
		}
		if (j.rootId !== settings.rootFolderId) throw new Error("Root rebuild target mismatch");
		for (let n = 0; n < j.files.length; n++) {
			const path = j.files[n];
			this.plugin.status.progress(`端末データを退避中 ${n + 1}/${j.files.length}: ${path}`);
			if (!validPath(path) || protectedPath(path, app.vault.configDir)) throw new Error("Invalid rebuild path");
			const backup = `${j.directory}/${n}.bin`;
			const file = app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const data = await app.vault.readBinary(file);
				await a.writeBinary(backup, data);
				const hash = await contentHash(data);
				if (await contentHash(await a.readBinary(backup)) !== hash || await contentHash(await app.vault.readBinary(file)) !== hash) {
					throw new Error(`退避の検証に失敗しました。再実行してください: ${path}`);
				}
				await app.vault.delete(file);
			} else if (!await a.exists(backup)) throw new Error(`Missing rebuild backup: ${path}`);
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		// Include files created while archiving rather than letting them become uploads.
		const added = app.vault.getFiles().map(f => f.path).filter(p => !protectedPath(p, app.vault.configDir) && !j!.files.includes(p));
		if (added.length) {
			j.files.push(...added);
			await a.write(`${j.directory}/paths.json`, JSON.stringify(j));
			await a.write(this.path, JSON.stringify(j));
		}
		if (app.vault.getFiles().some(f => !protectedPath(f.path, app.vault.configDir))) {
			throw new Error("復旧中にファイルが作成されました。編集を止めて再実行してください。");
		}
		for (const path of j.folders) {
			// Older checkpoints can include the vault root ("/") and paths that
			// cannot be cleaned up. Removing empty folders is optional.
			if (typeof path !== "string" || !validPath(path) || protectedPath(path, app.vault.configDir)) continue;
			const folder = this.plugin.ops.getFolder(path);
			if (folder?.children.length === 0) {
				const children = await a.list(path);
				if (!children.files.length && !children.folders.length) await app.vault.delete(folder);
			}
		}
		// Supersede even an interrupted conventional migration; its original is backed up.
		const complete = JSON.stringify({ version: 1, rootId: j.rootId, phase: "complete", files: [], folders: [], warnings: [] });
		await a.write(`${this.plugin.manifest.dir}/mount-migration.json`, complete);
		await a.write(`${this.plugin.manifest.dir}/mount-migration.json.tmp`, complete);
		index.reset(j.rootId);
		index.data.mountBase = "";
		await index.flush();
		settings.mountMode = "vaultRoot";
		settings.syncPaused = true;
		settings.syncOnStartup = false;
		await this.plugin.saveSettings();
		if (Platform.isAndroidApp && !await a.exists(".nomedia")) await a.write(".nomedia", "");
		j.phase = "complete";
		await a.write(this.path, JSON.stringify(j));
		return j.directory;
	}
}
