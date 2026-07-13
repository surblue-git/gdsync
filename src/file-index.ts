import { normalizePath } from "obsidian";
import type GdsyncPlugin from "./main";
import { emptyIndex, GdsyncIndex, IndexEntry } from "./types";

const SAVE_DEBOUNCE_MS = 2500;

/**
 * インデックスの保持と永続化。
 * data.json（設定+トークン）とは分けて、プラグインフォルダの index.json に保存する。
 */
export class FileIndex {
	data: GdsyncIndex = emptyIndex();
	/** fileId → path の逆引き（メモリ上のみ、load時に再構築） */
	private byId = new Map<string, string>();
	private saveTimer: number | null = null;
	private pendingSave = false;

	constructor(private plugin: GdsyncPlugin) {}

	private get filePath(): string {
		return normalizePath(`${this.plugin.manifest.dir}/index.json`);
	}

	async load(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		try {
			if (await adapter.exists(this.filePath)) {
				const raw = await adapter.read(this.filePath);
				const parsed = JSON.parse(raw) as GdsyncIndex;
				if (parsed && parsed.version === 1) {
					this.data = parsed;
				}
			}
		} catch (e) {
			console.error("gdsync: failed to load index.json; a full rescan is required", e);
			this.data = emptyIndex();
		}
		this.rebuildReverseMap();
	}

	private rebuildReverseMap(): void {
		this.byId.clear();
		for (const [path, entry] of Object.entries(this.data.files)) {
			if (entry.fileId) this.byId.set(entry.fileId, path);
		}
		for (const [path, id] of Object.entries(this.data.folders)) {
			if (id) this.byId.set(id, path);
		}
	}

	/** 変更をデバウンス保存 */
	markDirty(): void {
		this.pendingSave = true;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, SAVE_DEBOUNCE_MS);
	}

	/** 即時保存（アップロード成功などの重要遷移後・unload時） */
	async flush(): Promise<void> {
		if (!this.pendingSave) return;
		this.pendingSave = false;
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		try {
			await this.plugin.app.vault.adapter.write(
				this.filePath,
				JSON.stringify(this.data)
			);
		} catch (e) {
			console.error("gdsync: failed to save index.json", e);
			this.pendingSave = true;
		}
	}

	// ---- ファイルエントリ操作（逆引きを常に同期させる） ----

	getFile(path: string): IndexEntry | undefined {
		return this.data.files[path];
	}

	setFile(path: string, entry: IndexEntry): void {
		const old = this.data.files[path];
		if (old?.fileId && old.fileId !== entry.fileId) this.byId.delete(old.fileId);
		this.data.files[path] = entry;
		if (entry.fileId) this.byId.set(entry.fileId, path);
		this.markDirty();
	}

	deleteFile(path: string): void {
		const old = this.data.files[path];
		if (old?.fileId) this.byId.delete(old.fileId);
		delete this.data.files[path];
		this.markDirty();
	}

	renameFile(oldPath: string, newPath: string): void {
		const entry = this.data.files[oldPath];
		if (!entry) return;
		delete this.data.files[oldPath];
		this.data.files[newPath] = entry;
		if (entry.fileId) this.byId.set(entry.fileId, newPath);
		this.markDirty();
	}

	// ---- フォルダ ----

	getFolderId(path: string): string | undefined {
		return this.data.folders[path];
	}

	setFolder(path: string, id: string): void {
		const old = this.data.folders[path];
		if (old) this.byId.delete(old);
		this.data.folders[path] = id;
		if (id) this.byId.set(id, path);
		this.markDirty();
	}

	deleteFolder(path: string): void {
		const old = this.data.folders[path];
		if (old) this.byId.delete(old);
		delete this.data.folders[path];
		this.markDirty();
	}

	/** フォルダ配下（自身含む）のパス一覧 */
	pathsUnder(folderPath: string): { files: string[]; folders: string[] } {
		const prefix = folderPath + "/";
		const files = Object.keys(this.data.files).filter((p) =>
			p.startsWith(prefix)
		);
		const folders = Object.keys(this.data.folders).filter(
			(p) => p === folderPath || p.startsWith(prefix)
		);
		return { files, folders };
	}

	/** フォルダリネーム: 配下エントリのキーを一括付け替え */
	renameFolderPrefix(oldPath: string, newPath: string): void {
		const prefix = oldPath + "/";
		const remapped: Array<[string, string]> = [];
		for (const p of Object.keys(this.data.files)) {
			if (p.startsWith(prefix)) remapped.push([p, newPath + "/" + p.slice(prefix.length)]);
		}
		for (const [from, to] of remapped) {
			const e = this.data.files[from];
			delete this.data.files[from];
			this.data.files[to] = e;
			if (e.fileId) this.byId.set(e.fileId, to);
		}
		const folderRemap: Array<[string, string]> = [];
		for (const p of Object.keys(this.data.folders)) {
			if (p === oldPath) folderRemap.push([p, newPath]);
			else if (p.startsWith(prefix)) folderRemap.push([p, newPath + "/" + p.slice(prefix.length)]);
		}
		for (const [from, to] of folderRemap) {
			const id = this.data.folders[from];
			delete this.data.folders[from];
			this.data.folders[to] = id;
			if (id) this.byId.set(id, to);
		}
		this.markDirty();
	}

	/** fileId/folderId からパスを引く（changes 適用用） */
	pathById(id: string): string | undefined {
		return this.byId.get(id);
	}

	dirtyPaths(): string[] {
		return Object.entries(this.data.files)
			.filter(([, e]) => e.dirty)
			.map(([p]) => p);
	}

	hydratedCount(): number {
		return Object.values(this.data.files).filter((e) => e.hydrated).length;
	}

	reset(rootFolderId: string): void {
		this.data = emptyIndex();
		this.data.rootFolderId = rootFolderId;
		this.rebuildReverseMap();
		this.markDirty();
	}
}
