import { normalizePath, Notice } from "obsidian";
import { t } from "./i18n";
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
	private saving: Promise<void> = Promise.resolve();
	ready = false;

	constructor(private plugin: GdsyncPlugin) { }

	private get filePath(): string {
		return normalizePath(`${this.plugin.manifest.dir}/index.json`);
	}

	async load(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const parse = (raw: string): GdsyncIndex => {
			const parsed = JSON.parse(raw) as Omit<GdsyncIndex, "version"> & { version: number };
			if (!parsed || ![1, 2].includes(parsed.version) || !parsed.files || !parsed.folders || !Array.isArray(parsed.pendingOps)) throw new Error("Invalid index");
			// Version 2 adds content fingerprints. Individual files remain unverified until
			// SyncEngine.reconcileLocal hashes their bytes, so an interrupted upgrade is safe.
			if (parsed.version === 1) this.pendingSave = true;
			parsed.version = 2;
			return parsed as GdsyncIndex;
		};
		try {
			if (await adapter.exists(this.filePath)) {
				const raw = await adapter.read(this.filePath);
				this.data = parse(raw);
			} else if (await adapter.exists(this.filePath + ".tmp") || await adapter.exists(this.filePath + ".bak")) {
				throw new Error("Missing checkpoint");
			}
		} catch (e) {
			let restored = false;
			for (const suffix of [".tmp", ".bak"]) {
				try {
					if (!await adapter.exists(this.filePath + suffix)) continue;
					const raw = await adapter.read(this.filePath + suffix);
					const parsed = parse(raw);
					if (await adapter.exists(this.filePath)) await adapter.write(this.filePath + ".corrupt", await adapter.read(this.filePath));
					await adapter.write(this.filePath, raw);
					this.data = parsed;
					restored = true;
					new Notice(t.indexRecovered, 15000);
					break;
				} catch (recoveryError) { console.error("gdsync: checkpoint recovery failed", suffix, recoveryError); }
			}
			if (!restored) throw new Error(t.indexRecoveryFailed);
		}
		this.rebuildReverseMap();
		this.ready = true;
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
			void this.flush().catch((e) => console.error("gdsync: index save failed", e));
		}, SAVE_DEBOUNCE_MS);
	}

	/** 即時保存（アップロード成功などの重要遷移後・unload時） */
	async flush(): Promise<void> {
		if (!this.pendingSave) return this.saving;
		this.pendingSave = false;
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		const snapshot = JSON.stringify(this.data);
		const write = this.saving.catch(() => undefined).then(async () => {
			const adapter = this.plugin.app.vault.adapter;
			// The old checkpoint survives a failed or interrupted replacement.
			if (await adapter.exists(this.filePath)) {
				const previous = await adapter.read(this.filePath);
				JSON.parse(previous);
				await adapter.write(this.filePath + ".bak", previous);
			}
			await adapter.write(this.filePath + ".tmp", snapshot);
			await adapter.write(this.filePath, snapshot);
		});
		this.saving = write;
		try { await write; }
		catch (e) { this.pendingSave = true; throw e; }
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
		if (this.data.folderCreationIds) delete this.data.folderCreationIds[path];
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
		for (const op of this.data.pendingOps) {
			if (op.kind === "renameRemote" && (op.newParentPath === oldPath || op.newParentPath.startsWith(prefix))) {
				op.newParentPath = newPath + op.newParentPath.slice(oldPath.length);
			}
		}
		for (const [path, id] of Object.entries(this.data.folderCreationIds ?? {})) {
			if (path === oldPath || path.startsWith(prefix)) {
				delete this.data.folderCreationIds![path];
				this.data.folderCreationIds![newPath + path.slice(oldPath.length)] = id;
			}
		}
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
