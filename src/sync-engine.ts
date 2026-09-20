import { FileView, Notice, TFile, TFolder } from "obsidian";
import { AuthError } from "./auth";
import {
	ApiError,
	DriveClient,
	FOLDER_MIME,
	GOOGLE_APPS_PREFIX,
	NetworkError,
} from "./drive-client";
import { FileIndex } from "./file-index";
import { t } from "./i18n";
import { StatusDisplay } from "./status";
import { DriveChange, DriveItemMeta, IndexEntry } from "./types";
import { UploadQueue } from "./upload-queue";
import { sanitizeName, VaultOps } from "./vault-ops";
import type GdsyncPlugin from "./main";
import { mountBase, relativePath, vaultPath, protectedPath } from "./sync-paths";
import { attachmentReferences, freshLinkCache, invalidateLinkCache } from "./attachment-links";
import { MountMigration } from "./mount-migration";

const MIME_BY_EXT: Record<string, string> = {
	md: "text/markdown",
	txt: "text/plain",
	json: "application/json",
	canvas: "application/json",
	csv: "text/csv",
	html: "text/html",
	css: "text/css",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	mp4: "video/mp4",
	mov: "video/quicktime",
};

function mimeFor(ext: string): string {
	return MIME_BY_EXT[ext.toLowerCase()] || "application/octet-stream";
}

function ts(s?: string): number {
	return s ? new Date(s).getTime() : 0;
}

function num(s?: string): number {
	return s ? parseInt(s, 10) || 0 : 0;
}

function parentOf(rel: string): string {
	const i = rel.lastIndexOf("/");
	return i < 0 ? "" : rel.slice(0, i);
}

function joinPath(parent: string, name: string): string {
	return parent ? `${parent}/${name}` : name;
}

function baseName(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? p : p.slice(i + 1);
}

function conflictStamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function yieldToUI(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export class SyncEngine {
	queue: UploadQueue;
	private locks = new Map<string, Promise<void>>();
	private lockKeys = new WeakMap<IndexEntry, string>();
	private nextLock = 0;
	private scanning = false;
	private syncing = false;
	private folderTasks = new Map<string, Promise<string>>();
	private opsTask: Promise<void> | null = null;
	migrating = false;
	private pendingIssues = new Set<string>();
	private openAttachments = new Set<string>();
	private migrationRunning = false;

	constructor(
		private plugin: GdsyncPlugin,
		private drive: DriveClient,
		private index: FileIndex,
		private ops: VaultOps,
		private status: StatusDisplay
	) {
		this.queue = new UploadQueue(
			(path) => this.performUpload(path),
			() => this.plugin.settings.uploadDebounceSec * 1000
		);
	}

	// ---------------- パスヘルパー ----------------

	basePath(): string {
		return mountBase(this.plugin.settings.mountMode, this.plugin.settings.baseFolder);
	}

	toVault(rel: string): string {
		return vaultPath(this.basePath(), rel);
	}

	/** Vault パス → ベースフォルダ相対パス。対象外なら null、ベース自身は "" */
	toRel(vaultPath: string): string | null {
		return relativePath(this.basePath(), vaultPath);
	}

	private assertTarget(): void {
		if (!this.index.ready || this.migrating) throw new Error(t.syncNotReady);
		const d = this.index.data;
		if ((d.rootFolderId && d.rootFolderId !== this.plugin.settings.rootFolderId) ||
			(d.mountBase !== undefined && d.mountBase !== this.basePath())) throw new Error(t.targetChanged);
		if (!this.plugin.isActive()) throw new Error(t.syncNotReady);
	}

	canChangeTarget(): boolean {
		return this.index.ready && !this.isBusy() && !this.index.data.incoming?.length &&
			Object.keys(this.index.data.files).length === 0 &&
			Object.keys(this.index.data.folders).length === 0 && !this.index.data.pendingOps.length;
	}

	isBusy(): boolean {
		return this.scanning || this.syncing || this.migrating || this.migrationRunning || !!this.opsTask || this.locks.size > 0 || this.folderTasks.size > 0;
	}

	private rememberLocal(file: TFile, entry: IndexEntry): void {
		entry.localMtime = file.stat.mtime;
		entry.localSize = file.stat.size;
	}

	async restoreMigrationState(): Promise<void> {
		this.migrating = await new MountMigration(this.plugin).pending();
		if (this.migrating) new Notice(t.migrationResume, 15000);
	}

	async migrateToRoot(): Promise<string[]> {
		if (this.syncing || this.scanning || this.migrationRunning) throw new Error(t.syncAlreadyRunning);
		this.migrationRunning = true;
		const migration = new MountMigration(this.plugin);
		try {
			const pending = await migration.pending();
			if (!pending) this.assertTarget();
			if (this.index.data.pendingOps.length || this.index.data.incoming?.length) throw new Error(t.migrationPendingOps);
			this.migrating = true;
			try {
				await this.queue.pause();
				await Promise.all(Array.from(this.locks.values()));
				if (this.opsTask) await this.opsTask;
				if (!pending) {
					for (const [rel, entry] of Object.entries(this.index.data.files)) {
						if (!/\.(md|canvas)$/i.test(rel) || entry.hydrated) continue;
						this.status.progress(`${t.migrateRoot}: ${rel}`);
						await this.hydrateStubRel(rel);
						if (!entry.hydrated) throw new Error(`${t.uncheckedStub}: ${rel}`);
					}
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				const warnings = await migration.run();
				this.migrating = false;
				this.ops.suppressor.clear();
				return warnings;
			} finally {
				this.migrating = await migration.pending();
				this.status.endProgress();
				if (!this.migrating) this.queue.resume();
			}
		} finally { this.migrationRunning = false; }
	}

	/** Detect edits made while the app was closed; unknown files are always real data. */
	private async reconcileLocal(): Promise<void> {
		for (const file of this.plugin.app.vault.getFiles()) {
			const rel = this.toRel(file.path);
			if (!rel || this.isExcluded(rel)) continue;
			const e = this.index.getFile(rel);
			if (!e) this.trackNewLocalFile(rel);
			else if ((e.hydrated && e.localMtime === undefined) || (e.localMtime !== undefined &&
				(e.localMtime !== file.stat.mtime || e.localSize !== file.stat.size)) ||
				(!e.hydrated && file.stat.size > 0)) {
				e.hydrated = true;
				e.dirty = true;
				e.revision = (e.revision ?? 0) + 1;
				this.rememberLocal(file, e);
				this.index.markDirty();
			}
		}
		await this.index.flush();
	}

	private isExcluded(rel: string): boolean {
		if (protectedPath(rel, this.plugin.app.vault.configDir) ||
			protectedPath(this.toVault(rel), this.plugin.app.vault.configDir)) return true;
		const patterns = this.plugin.settings.excludePatterns
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		if (patterns.some((p) => rel === p || rel.includes(p))) return true;
		// 自己増殖ガード: Drive ツリー内にミラー先と同名のフォルダが現れた場合は必ず除外する。
		// baseFolder が PC 側で Drive 同期対象と重なっていると、GDSync が作ったローカルの
		// ミラーフォルダを外部の同期クライアント(Drive for Desktop等)が拾ってDriveへ
		// アップロードしてしまい、次のスキャンでそれを再度ミラーする無限入れ子ループが起きる。
		const baseName = this.basePath().split("/").pop()?.toLowerCase();
		if (baseName) {
			const segments = rel.toLowerCase().split("/");
			if (segments.includes(baseName)) return true;
		}
		return false;
	}

	/** 常時フル同期パターンに一致するか（スタブにせず実体を保つ対象） */
	private isEager(rel: string): boolean {
		const patterns = this.plugin.settings.eagerSyncPatterns
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		if (patterns.length === 0) return false;
		return patterns.some((p) => rel === p || rel.includes(p));
	}

	/**
	 * まだ実体を持たない1ファイル（スタブ）を即時ハイドレートする。
	 * 呼び出し側で当該 rel のロックを取得していないこと（内部で withLock を取る）。
	 */
	private async hydrateStubRel(rel: string): Promise<void> {
		const file = this.ops.getFile(this.toVault(rel));
		if (!file) return;
		await this.withLock(rel, async () => {
			// 別経路で状態が変わっている場合に備えロック取得後に再判定
			const e = this.index.getFile(rel);
			if (!e || !e.fileId || e.hydrated || e.dirty || e.tooLarge) return;
			await this.downloadInto(file, e);
		});
	}

	/** eager 指定に一致するスタブを一括で実体化する（フルスキャン後・起動時・設定変更時） */
	async hydrateEagerFiles(): Promise<void> {
		if (!this.plugin.settings.eagerSyncPatterns.trim()) return;
		for (const rel of Object.keys(this.index.data.files)) {
			if (this.isEager(rel)) await this.hydrateStubRel(rel);
		}
	}

	/**
	 * 開いたノートが埋め込む/リンクする添付（画像等）をハイドレートする。
	 * 埋め込み画像は Obsidian のレンダラが直接読むだけで file-open が発火しないため、
	 * スタブのままだと表示されない。ノートを開いた時にその添付だけを取得する
	 * （オンデマンドの利点を保ったまま、見ているノートの画像は自動で揃う）。
	 */
	async hydrateEmbedsOf(file: TFile): Promise<void> {
		if (this.migrating || this.scanning) return;
		if (file.extension !== "md") return;
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		if (!cache) return;
		const refs = [...(cache.embeds ?? []), ...(cache.links ?? [])];
		if (refs.length === 0) return;
		const seen = new Set<string>();
		for (const ref of refs) {
			const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(
				ref.link,
				file.path
			);
			if (!dest || dest.path === file.path) continue;
			const rel = this.toRel(dest.path);
			if (rel === null || rel === "" || this.isExcluded(rel)) continue;
			if (seen.has(rel)) continue;
			seen.add(rel);
			const entry = this.index.getFile(rel);
			if (!entry || !entry.fileId || entry.dirty || entry.tooLarge) {
				continue;
			}
			this.openAttachments.add(rel);
			entry.lastAccess = Date.now();
			if (dest.extension === "md") await this.hydrateStubRel(rel);
			else await this.onFileOpen(dest);
		}
	}

	async diagnoseAttachments(): Promise<string[]> {
		const issues: string[] = [];
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const rel = this.toRel(file.path);
			if (!rel || this.isExcluded(rel)) continue;
			const entry = this.index.getFile(rel);
			if (entry && !entry.hydrated) { issues.push(`${file.path}: ${t.uncheckedStub}`); continue; }
			for (const ref of attachmentReferences(this.plugin.app, file)) {
				const target = ref.file ? this.toRel(ref.file.path) : null;
				const reason = !ref.file ? t.linkMissing : !target || this.isExcluded(target) ? t.linkOutside
					: this.index.getFile(target)?.dirty ? t.linkPending : null;
				if (reason) issues.push(`${file.path} → ${ref.link}: ${reason}`);
			}
		}
		return issues;
	}

	private async uploadAttachments(file: TFile, text: string): Promise<boolean> {
		if (file.extension !== "md") return true;
		if (!freshLinkCache(this.plugin.app, file, text)) return false;
		for (const ref of attachmentReferences(this.plugin.app, file)) {
			const rel = ref.file ? this.toRel(ref.file.path) : null;
			if (!ref.file || !rel || this.isExcluded(rel)) { this.pendingIssues.add(file.path); return false; }
			if (!this.index.getFile(rel)) this.trackNewLocalFile(rel);
			if (this.index.getFile(rel)?.dirty) await this.performUpload(rel);
			if (this.index.getFile(rel)?.dirty || !this.index.getFile(rel)?.fileId) return false;
		}
		return true;
	}

	/** per-file 直列化。ハイドレートとアップロードの競走を防ぐ */
	private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const entry = this.index.getFile(key);
		if (entry) {
			let stableKey = this.lockKeys.get(entry);
			if (!stableKey) { stableKey = `file:${++this.nextLock}`; this.lockKeys.set(entry, stableKey); }
			key = stableKey;
		}
		const prev = this.locks.get(key) || Promise.resolve();
		const run = prev.then(fn, fn);
		const settled = run.then(() => undefined, () => undefined);
		this.locks.set(key, settled);
		void settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key); });
		return run;
	}

	private isFileOpen(rel: string): boolean {
		const vaultPath = this.toVault(rel);
		let open = false;
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof FileView && leaf.view.file?.path === vaultPath) {
				open = true;
			}
		});
		return open;
	}

	/** rel のファイルがいずれかのリーフで開かれているか（外部イベントからの利用可）。 */
	isFileOpenPublic(rel: string): boolean {
		return this.isFileOpen(rel);
	}

	// ---------------- 初回/フルスキャン ----------------

	/**
	 * Drive 全体を一括リストしてツリーを再構成し、スタブを生成する。
	 * 冪等: 既存スタブ・既存インデックスとの差分のみ適用。
	 */
	async fullScan(internal = false): Promise<void> {
		try { this.assertTarget(); } catch (e) { this.notifyError(t.scanFailed, e); return; }
		const s = this.plugin.settings;
		if (!s.rootFolderId) {
			new Notice(t.noFolderSelected);
			return;
		}
		if (this.scanning || this.migrationRunning || (this.syncing && !internal)) {
			new Notice(t.scanAlreadyRunning);
			return;
		}
		this.scanning = true;
		try {
			await this.queue.pause();
			await Promise.all(Array.from(this.locks.values()));
			if (this.opsTask) await this.opsTask;
			await this.reconcileLocal();
			// ルートフォルダの実在＆種別を検証。無効なIDだと BFS が空振りして
			// 「既存は見えるが新規だけ永遠に同期されない」紛らわしい失敗になるため、
			// リスト取得の前に弾いて明確に通知する。
			try {
				const rootMeta = await this.drive.getMeta(
					s.rootFolderId,
					"id,mimeType,trashed"
				);
				if (rootMeta.trashed || rootMeta.mimeType !== FOLDER_MIME) {
					new Notice(t.rootNotFolder(s.rootFolderId), 15000);
					return;
				}
			} catch (e) {
				if (e instanceof ApiError && e.status === 404) {
					new Notice(t.rootNotFound(s.rootFolderId), 15000);
				} else if (e instanceof NetworkError) {
					new Notice(`GDSync: ${t.possiblyOffline}`, 12000);
				} else {
					this.pendingIssues.add("scan");
					this.notifyError(t.scanFailed, e);
				}
				return;
			}
			this.status.progress(t.listingDriveFiles);
			// リスト取得前にトークンを確保 → スキャン中の変更を取りこぼさない
			const startToken = await this.drive.getStartPageToken();
			const items = await this.drive.listAll((count) =>
				this.status.progress(t.listingDriveFilesCount(count))
			);

			// parents ポインタからツリー再構成（BFS）
			const children = new Map<string, DriveItemMeta[]>();
			for (const it of items) {
				const p = it.parents?.[0];
				if (!p) continue;
				let list = children.get(p);
				if (!list) {
					list = [];
					children.set(p, list);
				}
				list.push(it);
			}

			const remoteFiles = new Map<string, DriveItemMeta>(); // rel → meta
			const remoteFolders = new Map<string, string>(); // rel → id
			const queue: Array<{ id: string; rel: string }> = [
				{ id: s.rootFolderId, rel: "" },
			];
			while (queue.length) {
				const cur = queue.shift()!;
				const kids = (children.get(cur.id) || []).sort((a, b) => a.id.localeCompare(b.id));
				const usedNames = new Set<string>();
				for (const kid of kids) {
					if (kid.trashed) continue;
					const isFolder = kid.mimeType === FOLDER_MIME;
					if (!isFolder) {
						if (kid.mimeType.startsWith(GOOGLE_APPS_PREFIX)) continue;
						if (kid.shortcutDetails) continue;
					}
					let name = sanitizeName(kid.name);
					// Drive は同名兄弟を許すので Vault 側は連番で一意化
					if (usedNames.has(name.toLowerCase())) {
						const dot = name.lastIndexOf(".");
						const stem = dot > 0 ? name.slice(0, dot) : name;
						const ext = dot > 0 ? name.slice(dot) : "";
						let n = 1;
						while (usedNames.has(`${stem} (${n})${ext}`.toLowerCase())) n++;
						name = `${stem} (${n})${ext}`;
					}
					usedNames.add(name.toLowerCase());
					const rel = joinPath(cur.rel, name);
					if (this.isExcluded(rel)) continue;
					if (isFolder) {
						remoteFolders.set(rel, kid.id);
						queue.push({ id: kid.id, rel });
					} else {
						remoteFiles.set(rel, kid);
					}
				}
			}

			// 診断ログ（開発者コンソール用）
			console.debug(
				`gdsync: fullScan — total items=${items.length}, ` +
				`folders=${remoteFolders.size}, files=${remoteFiles.size}`
			);
			if (remoteFiles.size === 0 && remoteFolders.size > 0) {
				new Notice(t.foldersNoFiles, 15000);
			}

			// --- ローカルへ反映 ---
			this.status.progress(t.creatingFolders);
			await this.ops.ensureFolder(this.basePath());
			const sortedFolders = Array.from(remoteFolders.keys()).sort(
				(a, b) => a.split("/").length - b.split("/").length
			);
			for (const rel of sortedFolders) {
				await this.ops.ensureFolder(this.toVault(rel));
				this.index.setFolder(rel, remoteFolders.get(rel)!);
			}

			const maxSize = s.maxFileSizeMB * 1024 * 1024;
			let created = 0;
			let failed = 0;
			let firstError: string | null = null;
			let i = 0;
			for (const [rel, meta] of remoteFiles) {
				i++;
				try {
					let existing = this.index.getFile(rel);
					if (!existing && this.ops.getFile(this.toVault(rel))) {
						this.trackNewLocalFile(rel);
						existing = this.index.getFile(rel);
					}
					if (!existing) {
						await this.ops.createStub(this.toVault(rel));
						this.index.setFile(rel, {
							fileId: meta.id,
							remoteMd5: meta.md5Checksum ?? null,
							remoteModifiedTime: ts(meta.modifiedTime),
							remoteSize: num(meta.size),
							hydrated: false,
							dirty: false,
							lastAccess: 0,
							tooLarge: num(meta.size) > maxSize,
						});
						created++;
					} else {
						const localFile = this.ops.getFile(this.toVault(rel));
						if (!localFile) {
							if (existing.dirty) throw new Error("Missing unsent local file: " + rel);
							// インデックスには記録があるが実体が存在しない
							// （手動削除・アプリ外操作・古いrootFolderIdからの切替等で
							// パスが偶然一致した場合を含む）→ スタブを作り直して自己修復する
							await this.ops.createStub(this.toVault(rel));
							existing.fileId = meta.id;
							existing.hydrated = false;
							existing.hydratedMd5 = undefined;
							existing.dirty = false;
							created++;
						} else if (existing.fileId !== meta.id) {
							existing.fileId = meta.id;
							// Preserve cached bytes. A later guarded download compares the new remote hash.
							existing.hydratedMd5 = undefined;
						}
						existing.remoteMd5 = meta.md5Checksum ?? null;
						existing.remoteModifiedTime = ts(meta.modifiedTime);
						existing.remoteSize = num(meta.size);
						existing.tooLarge = num(meta.size) > maxSize;
						this.index.setFile(rel, existing);
					}
				} catch (e) {
					// 1ファイルの失敗で全体を止めない。詳細は集計して最後に通知する
					failed++;
					if (!firstError) {
						firstError = `${rel}: ${e instanceof Error ? e.message : String(e)}`;
					}
					console.error("gdsync: failed to create stub", rel, e);
					this.pendingIssues.add(rel);
					const incoming = this.index.data.incoming ?? (this.index.data.incoming = []);
					if (!incoming.some((change) => change.fileId === meta.id)) incoming.push({ fileId: meta.id, file: meta, removed: false });
				}
				if (i % 50 === 0) {
					this.status.progress(t.creatingStubs(i, remoteFiles.size));
					await yieldToUI();
				}
			}

			// リモートに存在しなくなったもの
			for (const rel of Object.keys(this.index.data.files)) {
				if (this.isExcluded(rel)) continue;
				if (remoteFiles.has(rel)) continue;
				const entry = this.index.getFile(rel)!;
				if (entry.dirty || !entry.fileId) {
					// ローカル編集/新規はアップロード対象として残す（fileId をクリアして新規作成へ）
					if (entry.dirty) { entry.fileId = ""; entry.creationId = undefined; }
					this.index.setFile(rel, entry);
					continue;
				}
				const f = this.ops.getFile(this.toVault(rel));
				if (f) await this.ops.deleteLocal(f);
				this.index.deleteFile(rel);
			}
			for (const rel of Object.keys(this.index.data.folders)) {
				if (remoteFolders.has(rel) || rel === "") continue;
				const id = this.index.getFolderId(rel);
				if (!id) continue; // ローカル新規フォルダは残す
				const { files } = this.index.pathsUnder(rel);
				if (files.length > 0) continue; // まだ中身がある（dirty残り等）
				const folder = this.ops.getFolder(this.toVault(rel));
				if (folder && folder.children.length === 0) {
					await this.ops.deleteLocal(folder);
				}
				this.index.deleteFolder(rel);
			}

			// eager 指定ファイルはスタブのままにせず実体化しておく
			await this.hydrateEagerFiles();

			this.index.data.rootFolderId = s.rootFolderId;
			this.index.data.mountBase = this.basePath();
			this.index.data.changesPageToken = startToken;
			this.index.data.lastFullScan = Date.now();
			this.index.markDirty();
			await this.index.flush();
			this.status.endProgress();
			if (failed > 0) {
				new Notice(
					t.scanFinishedWithFailures(created, remoteFiles.size, failed, firstError ?? ""),
					15000
				);
			} else {
				new Notice(t.scanFinished(remoteFiles.size, created), 8000);
			}
		} catch (e) {
			this.status.endProgress();
			this.pendingIssues.add("scan");
			this.notifyError(t.scanFailed, e);
		} finally {
			this.scanning = false;
			if (!internal) this.queue.resume();
		}
	}

	// ---------------- ハイドレート ----------------

	async onFileOpen(file: TFile): Promise<void> {
		if (this.scanning || this.migrating) return;
		this.assertTarget();
		const rel = this.toRel(file.path);
		if (rel === null || rel === "") return;
		const entry = this.index.getFile(rel);
		if (!entry) return;
		entry.lastAccess = Date.now();
		this.index.markDirty();
		if (!entry.fileId) return; // ローカル新規（リモート未作成）
		// 開いたノートの埋め込み添付（画像等）も取得する。ノート本文がまだ
		// スタブなら metadataCache に埋め込みが無いので、ダウンロード後に
		// 発火する metadataCache "changed" 側でも拾う（main.ts で登録）。
		if (file.extension === "md") void this.hydrateEmbedsOf(file);
		await this.withLock(rel, async () => {
			if (entry.tooLarge) {
				new Notice(t.tooLargeOnOpen(file.name, this.plugin.settings.maxFileSizeMB));
				return;
			}
			if (!entry.hydrated) {
				await this.downloadInto(file, entry);
				return;
			}
			if (entry.dirty) return; // ローカル編集を優先。競合はアップロード側で処理
			const ttlMs = this.plugin.settings.freshnessTtlMin * 60 * 1000;
			if (Date.now() - (entry.lastFreshCheck ?? 0) < ttlMs) return;
			try {
				const meta = await this.drive.getMeta(
					entry.fileId,
					"md5Checksum,modifiedTime,size,trashed"
				);
				entry.lastFreshCheck = Date.now();
				if (meta.trashed) return; // 削除反映は changes に任せる
				entry.remoteMd5 = meta.md5Checksum ?? null;
				entry.remoteModifiedTime = ts(meta.modifiedTime);
				entry.remoteSize = num(meta.size);
				this.index.markDirty();
				if (entry.remoteMd5 && entry.remoteMd5 !== entry.hydratedMd5) {
					await this.downloadInto(file, entry);
				}
			} catch (e) {
				// オフライン等 → キャッシュのまま表示
			}
		});
	}

	/** 実体をダウンロードしてファイルへ書き込む。呼び出し側でロック取得済みであること */
	private async downloadInto(file: TFile, entry: IndexEntry): Promise<boolean> {
		const revision = entry.revision ?? 0;
		const expectedMtime = file.stat.mtime;
		const expectedPath = file.path;
		const remoteMd5 = entry.remoteMd5;
		const maxSize = this.plugin.settings.maxFileSizeMB * 1024 * 1024;
		if (entry.remoteSize > maxSize) {
			entry.tooLarge = true;
			this.index.markDirty();
			new Notice(t.tooLarge(file.name));
			return false;
		}
		const transfer = this.status.downloadStarting(file.path);
		let ok = false;
		try {
			const data = await this.drive.download(entry.fileId);
			const unchanged = () => (entry.revision ?? 0) === revision &&
				file.path === expectedPath && file.stat.mtime === expectedMtime && !entry.dirty;
			if (!await this.ops.writeContent(file, data, unchanged)) return false;
			entry.hydrated = true;
			entry.hydratedMd5 = remoteMd5 ?? undefined;
			entry.dirty = false;
			entry.lastAccess = Date.now();
			entry.lastFreshCheck = Date.now();
			this.rememberLocal(file, entry);
			this.index.markDirty();
			await this.index.flush();
			ok = true;
			return true;
		} catch (e) {
			this.pendingIssues.add(expectedPath);
			this.notifyError(t.downloadFailed(file.name), e);
			return false;
		} finally {
			this.status.downloadFinished(transfer, ok);
		}
	}

	// ---------------- Vault イベント ----------------

	onModify(file: TFile): void {
		invalidateLinkCache(file);
		if (this.ops.suppressor.consume(file.path)) return;
		const rel = this.toRel(file.path);
		if (rel === null || rel === "") return;
		if (this.isExcluded(rel)) return;
		const entry = this.index.getFile(rel);
		if (!entry) {
			this.trackNewLocalFile(rel);
			return;
		}
		if (!entry.hydrated && entry.fileId) {
			// ガード1: 未ハイドレートのスタブ編集はアップロードさせない
			new Notice(t.stubEditWarning);
			// Preserve the edit. With no baseline, upload creates a conflict copy.
			entry.hydrated = true;
			entry.hydratedMd5 = undefined;
		}
		entry.dirty = true;
		entry.revision = (entry.revision ?? 0) + 1;
		this.rememberLocal(file, entry);
		this.index.markDirty();
		this.queue.schedule(rel);
	}

	onCreate(af: TFile | TFolder): void {
		if (this.ops.suppressor.consume(af.path)) return;
		const rel = this.toRel(af.path);
		if (rel === null || rel === "") return;
		if (this.isExcluded(rel)) return;
		if (af instanceof TFolder) {
			if (this.index.getFolderId(rel) === undefined) {
				this.index.setFolder(rel, "");
				if (!this.scanning && !this.syncing) void this.tryEnsureRemoteFolders().catch((e) => this.notifyError(t.syncFailed, e));
			}
			return;
		}
		if (this.index.getFile(rel)) return;
		this.trackNewLocalFile(rel);
	}

	private trackNewLocalFile(rel: string): void {
		const file = this.ops.getFile(this.toVault(rel));
		this.index.setFile(rel, {
			fileId: "",
			remoteMd5: null,
			remoteModifiedTime: 0,
			remoteSize: 0,
			hydrated: true, // ローカル生まれ = ローカルが実体
			dirty: true,
			revision: 1,
			localMtime: file?.stat.mtime,
			localSize: file?.stat.size,
			lastAccess: Date.now(),
		});
		this.queue.schedule(rel);
	}

	onDelete(af: TFile | TFolder): void {
		if (this.ops.suppressor.consume(af.path)) return;
		const rel = this.toRel(af.path);
		if (rel === null || rel === "") return;
		if (af instanceof TFolder || this.index.getFolderId(rel) !== undefined) {
			this.dropLocalFolderTree(rel, true);
		} else {
			const entry = this.index.getFile(rel);
			if (!entry) return;
			this.queue.cancel(rel);
			if (entry.fileId) {
				this.index.data.pendingOps.push({
					kind: "trashRemote",
					fileId: entry.fileId,
				});
			}
			this.index.deleteFile(rel);
		}
		this.index.markDirty();
		if (!this.scanning && !this.syncing) void this.flushPendingOps().catch((e) => this.notifyError(t.syncFailed, e));
	}

	/** ローカルで消えたフォルダ配下のインデックスを整理。trashRemote=true ならリモートもゴミ箱へ */
	private dropLocalFolderTree(rel: string, trashRemote: boolean): void {
		const folderId = this.index.getFolderId(rel);
		const { files, folders } = this.index.pathsUnder(rel);
		for (const f of files) {
			this.queue.cancel(f);
			this.index.deleteFile(f);
		}
		for (const fo of folders) this.index.deleteFolder(fo);
		if (trashRemote && folderId) {
			// フォルダごとゴミ箱へ（配下は Drive 側でまとめて trash される）
			this.index.data.pendingOps.push({ kind: "trashRemote", fileId: folderId });
		}
	}

	onRename(af: TFile | TFolder, oldPath: string): void {
		// 自分の rename は新パスに、自分の trash（.trash への移動が rename として
		// 発火する場合）は旧パスに抑制が積まれているため両方を確認する
		if (
			this.ops.suppressor.consume(af.path) ||
			this.ops.suppressor.consume(oldPath)
		) {
			return;
		}
		// ベースフォルダ自体のリネームは設定へ追従
		if (oldPath === this.basePath() && af instanceof TFolder) {
			this.plugin.settings.baseFolder = af.path;
			this.index.data.mountBase = af.path;
			this.index.markDirty();
			void this.plugin.saveSettings();
			return;
		}
		const oldRel = this.toRel(oldPath);
		const newRel = this.toRel(af.path);

		if (oldRel !== null && oldRel !== "" && newRel !== null && newRel !== "") {
			// ベース内での移動/リネーム
			if (af instanceof TFolder) {
				const id = this.index.getFolderId(oldRel);
				this.index.renameFolderPrefix(oldRel, newRel);
				if (id) {
					this.index.data.pendingOps.push({
						kind: "renameRemote",
						fileId: id,
						newName: baseName(af.path),
						newParentPath: parentOf(newRel),
					});
				}
				// キュー内の dirty ファイルを新キーで再スケジュール
				for (const p of this.index.pathsUnder(newRel).files) {
					if (this.index.getFile(p)?.dirty) this.queue.schedule(p);
				}
			} else {
				const entry = this.index.getFile(oldRel);
				if (!entry) {
					this.trackNewLocalFile(newRel);
					return;
				}
				this.index.renameFile(oldRel, newRel);
				this.queue.rename(oldRel, newRel);
				if (entry.fileId) {
					this.index.data.pendingOps.push({
						kind: "renameRemote",
						fileId: entry.fileId,
						newName: baseName(af.path),
						newParentPath: parentOf(newRel),
					});
				}
			}
			this.index.markDirty();
			if (!this.scanning && !this.syncing) void this.flushPendingOps().catch((e) => this.notifyError(t.syncFailed, e));
		} else if (oldRel !== null && oldRel !== "" && newRel === null) {
			// ベース外へ移動 → Drive 上はゴミ箱へ（復元可能な保険）
			if (af instanceof TFolder) {
				this.dropLocalFolderTree(oldRel, true);
			} else {
				const entry = this.index.getFile(oldRel);
				if (entry) {
					this.queue.cancel(oldRel);
					if (entry.fileId) {
						this.index.data.pendingOps.push({
							kind: "trashRemote",
							fileId: entry.fileId,
						});
					}
					this.index.deleteFile(oldRel);
				}
			}
			this.index.markDirty();
			if (!this.scanning && !this.syncing) void this.flushPendingOps().catch((e) => this.notifyError(t.syncFailed, e));
		} else if (oldRel === null && newRel !== null && newRel !== "") {
			// ベース外から移入 → 新規としてアップロード対象に
			if (af instanceof TFolder) {
				this.registerMovedInFolder(af);
			} else if (af instanceof TFile) {
				this.trackNewLocalFile(newRel);
			}
			this.index.markDirty();
		}
	}

	/** ベース外から移入されたフォルダを再帰登録 */
	private registerMovedInFolder(folder: TFolder): void {
		const rel = this.toRel(folder.path);
		if (rel === null || rel === "" || this.isExcluded(rel)) return;
		if (this.index.getFolderId(rel) === undefined) this.index.setFolder(rel, "");
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				this.registerMovedInFolder(child);
			} else if (child instanceof TFile) {
				const childRel = this.toRel(child.path);
				if (childRel && !this.isExcluded(childRel) && !this.index.getFile(childRel)) {
					this.trackNewLocalFile(childRel);
				}
			}
		}
		if (!this.scanning && !this.syncing) void this.tryEnsureRemoteFolders().catch((e) => this.notifyError(t.syncFailed, e));
	}

	// ---------------- アップロード ----------------

	/** UploadQueue から呼ばれる。true=完了(またはリトライ不要)、false=リトライ */
	private async performUpload(rel: string): Promise<boolean> {
		return this.withLock(rel, async () => {
			this.assertTarget();
			if (this.isExcluded(rel)) return true;
			const entry = this.index.getFile(rel);
			if (!entry || !entry.dirty) return true;
			if (!entry.hydrated) return true; // ガード2: 実体なしは絶対に送らない
			const file = this.ops.getFile(this.toVault(rel));
			if (!file) return true; // 既に消えていた
			const revision = entry.revision ?? 0;
			const mtimeBeforeUpload = file.stat.mtime;
			let data: ArrayBuffer;
			try {
				data = await this.ops.readBinary(file);
			} catch (e) {
				return false;
			}
			if (file.extension === "md" && !await this.uploadAttachments(file, new TextDecoder().decode(data))) return false;
			if ((entry.revision ?? 0) !== revision || file.stat.mtime !== mtimeBeforeUpload) return false;
			// ガード3: ローカルが空でリモートに内容がある場合は事故防止のため送らない
			if (data.byteLength === 0 && entry.remoteSize > 0 && !entry.hydratedMd5) {
				new Notice(t.emptyUploadCancelled(file.name));
				return true;
			}
			const transfer = this.status.uploadStarting(file.path);
			let ok = false;
			try {
				if (entry.fileId) {
					// 競合チェック（他端末の更新を上書きしない）
					let remote: DriveItemMeta | null = null;
					try {
						remote = await this.drive.getMeta(
							entry.fileId,
							"md5Checksum,modifiedTime,size,trashed"
						);
					} catch (e) {
						if (e instanceof ApiError && e.status === 404) {
							entry.creationId = undefined;
							entry.fileId = ""; // リモートで完全削除済み → 新規作成
						} else {
							throw e;
						}
					}
					if (remote) {
						if (remote.trashed) {
							entry.creationId = undefined;
							entry.fileId = ""; // ゴミ箱行き → 新規作成で復活
						} else if (
							remote.md5Checksum &&
							remote.md5Checksum !== entry.hydratedMd5
						) {
							await this.resolveConflict(rel, file, entry, data, remote, revision);
							ok = true;
							return true;
						}
					}
				}
				const isNew = !entry.fileId;
				const parentId = isNew
					? await this.ensureRemoteFolder(parentOf(rel))
					: undefined;
				if (isNew && !entry.creationId) {
					entry.creationId = await this.drive.generateId();
					this.index.markDirty();
					await this.index.flush();
				}
				const res = await this.drive.upload({
					creationId: entry.creationId,
					fileId: entry.fileId || undefined,
					name: isNew ? file.name : undefined,
					parentId,
					mimeType: mimeFor(file.extension),
					data,
				});
				// A user may rename/delete the file while the request is in flight.
				const currentRel = this.toRel(file.path);
				if (!currentRel || this.index.getFile(currentRel) !== entry) {
					this.index.data.pendingOps.push({ kind: "trashRemote", fileId: res.id });
					this.index.markDirty();
					await this.index.flush();
					return true;
				}
				if (currentRel !== rel) {
					this.index.data.pendingOps.push({
						kind: "renameRemote", fileId: res.id,
						newName: file.name, newParentPath: parentOf(currentRel)
					});
				}
				entry.fileId = res.id;
				entry.remoteMd5 = res.md5Checksum ?? null;
				entry.remoteModifiedTime = ts(res.modifiedTime);
				entry.remoteSize = num(res.size);
				if (!res.gdsyncRecovered) entry.hydratedMd5 = res.md5Checksum;
				// アップロード中に再編集されていたら dirty を維持して再送
				const nowFile = this.ops.getFile(this.toVault(currentRel));
				const editedMeanwhile =
					!!res.gdsyncRecovered ||
					(entry.revision ?? 0) !== revision ||
					!!nowFile && nowFile.stat.mtime !== mtimeBeforeUpload;
				entry.dirty = editedMeanwhile;
				if (nowFile && !editedMeanwhile) this.rememberLocal(nowFile, entry);
				this.index.setFile(currentRel, entry);
				await this.index.flush();
				if (editedMeanwhile) this.queue.schedule(currentRel);
				ok = true;
				return true;
			} catch (e) {
				if (e instanceof AuthError) {
					new Notice(`GDSync: ${e.message}`);
					ok = false; // 未送信（要再認証）: 再認証されるまでリトライしない
					return true;
				}
				if (e instanceof NetworkError) {
					this.status.setOffline();
					ok = false; // バックオフでリトライ
					return false;
				}
				this.notifyError(t.uploadFailed(file.name), e);
				ok = false;
				return false;
			} finally {
				this.status.uploadFinished(transfer, ok);
			}
		});
	}

	/**
	 * 競合: ローカル版を「(conflict …)」として Drive とローカル両方に保存し、
	 * 元ファイルはリモート版で復元する。
	 */
	private async resolveConflict(
		rel: string,
		file: TFile,
		entry: IndexEntry,
		localData: ArrayBuffer,
		remote: DriveItemMeta,
		revision: number
	): Promise<void> {
		if (!entry.conflictCopy || entry.conflictCopy.revision !== revision) {
			const dot = file.name.lastIndexOf('.');
			const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
			const ext = dot > 0 ? file.name.slice(dot) : '';
			const creationId = await this.drive.generateId();
			const name = stem + ' (conflict ' + conflictStamp() + '-' + Date.now() + ')' + ext;
			entry.conflictCopy = { rel: joinPath(parentOf(rel), name), creationId, revision };
			this.index.markDirty();
			await this.index.flush();
		}
		const copy = entry.conflictCopy;
		const conflictName = baseName(copy.rel);
		let localCopy = this.ops.getFile(this.toVault(copy.rel));
		if (!localCopy) localCopy = await this.ops.createWithContent(this.toVault(copy.rel), localData);
		let copyEntry = this.index.getFile(copy.rel);
		if (!copyEntry) {
			copyEntry = {
				fileId: '', creationId: copy.creationId, hydrated: true, dirty: true,
				remoteMd5: null, remoteSize: 0, remoteModifiedTime: 0, lastAccess: Date.now(), revision: 1
			};
			this.rememberLocal(localCopy, copyEntry);
			this.index.setFile(copy.rel, copyEntry);
			await this.index.flush();
		}
		if (!copyEntry.fileId) {
			const stamp = localCopy.stat.mtime;
			const parentId = await this.ensureRemoteFolder(parentOf(copy.rel));
			const uploaded = await this.drive.upload({
				creationId: copy.creationId, name: conflictName,
				parentId, mimeType: mimeFor(file.extension), data: localData
			});
			copyEntry.fileId = uploaded.id;
			copyEntry.remoteMd5 = uploaded.md5Checksum ?? null;
			copyEntry.hydratedMd5 = uploaded.md5Checksum;
			copyEntry.remoteSize = num(uploaded.size);
			copyEntry.dirty = localCopy.stat.mtime !== stamp;
			this.index.setFile(copy.rel, copyEntry);
			await this.index.flush();
		}

		// 元ファイルはリモート版で上書き
		entry.remoteMd5 = remote.md5Checksum ?? null;
		entry.remoteModifiedTime = ts(remote.modifiedTime);
		entry.remoteSize = num(remote.size);
		if ((entry.revision ?? 0) === revision) {
			entry.dirty = false;
			if (!await this.downloadInto(file, entry)) entry.dirty = true;
		}
		this.index.markDirty();
		await this.index.flush();
		new Notice(t.conflictDetected(conflictName, file.name));
	}

	// ---------------- リモートフォルダ解決 ----------------

	/** ベース相対フォルダパス → Drive folderId（必要なら作成） */
	async ensureRemoteFolder(rel: string): Promise<string> {
		if (rel === "") return this.plugin.settings.rootFolderId;
		const running = this.folderTasks.get(rel);
		if (running) return running;
		const task = this.createRemoteFolder(rel);
		this.folderTasks.set(rel, task);
		try { return await task; } finally { this.folderTasks.delete(rel); }
	}

	private async createRemoteFolder(rel: string): Promise<string> {
		this.assertTarget();
		if (this.isExcluded(rel)) throw new Error(t.targetChanged);
		const existing = this.index.getFolderId(rel);
		if (existing) return existing;
		const parentId = await this.ensureRemoteFolder(parentOf(rel));
		const ids = this.index.data.folderCreationIds ?? (this.index.data.folderCreationIds = {});
		if (!ids[rel]) {
			ids[rel] = await this.drive.generateId();
			this.index.markDirty();
			await this.index.flush();
		}
		const id = await this.drive.createFolder(baseName(rel), parentId, ids[rel]);
		this.index.setFolder(rel, id);
		await this.index.flush();
		this.status.opFlushed();
		return id;
	}

	/** ローカルで作成された未同期フォルダ（id=''）をリモートに作成 */
	async tryEnsureRemoteFolders(): Promise<void> {
		const pending = Object.entries(this.index.data.folders)
			.filter(([, id]) => !id)
			.map(([p]) => p)
			.sort((a, b) => a.split("/").length - b.split("/").length);
		for (const rel of pending) {
			try {
				await this.ensureRemoteFolder(rel);
			} catch (e) {
				throw e;
			}
		}
	}

	// ---------------- 保留中の構造変更 ----------------

	async flushPendingOps(): Promise<void> {
		if (this.opsTask) return this.opsTask;
		const task = this.performPendingOps();
		this.opsTask = task;
		try { await task; } finally { this.opsTask = null; }
	}
	private async performPendingOps(): Promise<void> {
		this.assertTarget();
		await this.index.flush();
		await Promise.all(Array.from(this.locks.values()));
		try {
			while (this.index.data.pendingOps.length > 0) {
				const op = this.index.data.pendingOps[0];
				try {
					if (op.kind === "trashRemote") {
						await this.drive.trash(op.fileId);
					} else {
						const parentId = await this.ensureRemoteFolder(op.newParentPath);
						const meta = await this.drive.getMeta(op.fileId, "parents");
						const oldParent = meta.parents?.[0];
						const query: Record<string, string> = {};
						if (oldParent && oldParent !== parentId) {
							query.addParents = parentId;
							query.removeParents = oldParent;
						}
						await this.drive.patchMeta(op.fileId, { name: op.newName }, query);
					}
					this.index.data.pendingOps.shift();
					this.index.markDirty();
					this.status.opFlushed();
				} catch (e) {
					if (e instanceof ApiError && e.status === 404) {
						// 対象が既に存在しない → スキップ
						this.index.data.pendingOps.shift();
						this.index.markDirty();
						this.status.opFlushed();
						continue;
					}
					throw e;
				}
			}
		} finally {
			await this.index.flush();
		}
	}

	// ---------------- リモート差分（changes API） ----------------

	async pullChanges(): Promise<void> {
		const token = this.index.data.changesPageToken;
		if (!token) return; // フルスキャン前
		let result;
		try {
			result = await this.drive.listChanges(token);
		} catch (e) {
			if (e instanceof ApiError && [400, 404, 410].includes(e.status)) {
				new Notice(t.changeTokenExpired);
				await this.fullScan(true);
				return;
			}
			throw e;
		}
		const latest = new Map<string, DriveChange>();
		for (const c of [...(this.index.data.incoming ?? []), ...result.changes]) latest.set(c.fileId, c);
		this.index.data.incoming = Array.from(latest.values());
		this.index.data.changesPageToken = result.newStartPageToken;
		this.index.markDirty();
		await this.index.flush(); // Durable receipt BEFORE advancing through application.
		const changes = [...this.index.data.incoming].sort((a, b) =>
			Number(b.file?.mimeType === FOLDER_MIME) - Number(a.file?.mimeType === FOLDER_MIME));
		for (const c of changes) {
			try {
				await this.applyChange(c);
				this.index.data.incoming = this.index.data.incoming!.filter((item) => item !== c);
			} catch (e) { console.error('gdsync: incoming change retained', c.fileId, e); }
		}
		this.index.markDirty();
		await this.index.flush();
	}

	/** 親フォルダID → ベース相対パス（ツリー外なら undefined） */
	private async parentPathOf(meta: DriveItemMeta, visited = new Set<string>()): Promise<string | undefined> {
		const pid = meta.parents?.[0];
		if (!pid) return undefined;
		if (pid === this.plugin.settings.rootFolderId) return '';
		const known = this.index.pathById(pid);
		if (known !== undefined && this.index.getFolderId(known) !== undefined) return known;
		if (visited.has(pid)) throw new Error('Cyclic Drive ancestry');
		visited.add(pid);
		const parent = await this.drive.getMeta(pid);
		const ancestor = await this.parentPathOf(parent, visited);
		if (ancestor === undefined) return undefined;
		const rel = joinPath(ancestor, sanitizeName(parent.name));
		if (this.isExcluded(rel)) throw new Error('Excluded ancestor');
		const occupied = this.index.getFolderId(rel);
		if (occupied && occupied !== pid) throw new Error('Folder path collision: ' + rel);
		await this.ops.ensureFolder(this.toVault(rel));
		this.index.setFolder(rel, pid);
		return rel;
	}

	private async applyChange(c: DriveChange): Promise<void> {
		if (this.index.data.pendingOps.some((op) => op.fileId === c.fileId)) throw new Error("Local structure change is pending");
		const knownPath = this.index.pathById(c.fileId);
		const meta = c.file;

		// ルートフォルダ自体の削除は無視（誤爆防止）
		if (c.fileId === this.plugin.settings.rootFolderId) return;

		if (c.removed || meta?.trashed) {
			if (knownPath === undefined) return;
			if (this.index.getFolderId(knownPath) !== undefined) {
				await this.removeRemoteFolderLocally(knownPath);
			} else {
				await this.removeRemoteFileLocally(knownPath);
			}
			this.status.remoteChange("removed");
			return;
		}
		if (!meta) return;

		if (meta.mimeType === FOLDER_MIME) {
			const parentPath = await this.parentPathOf(meta);
			if (knownPath !== undefined) {
				if (parentPath === undefined) {
					// 対象ツリー外へ移動された
					await this.removeRemoteFolderLocally(knownPath);
					this.status.remoteChange("removed");
					return;
				}
				const newRel = joinPath(parentPath, sanitizeName(meta.name));
				if (newRel !== knownPath && !this.isExcluded(newRel)) {
					const folder = this.ops.getFolder(this.toVault(knownPath));
					if (folder) await this.ops.renameLocal(folder, this.toVault(newRel));
					this.index.renameFolderPrefix(knownPath, newRel);
					this.status.remoteChange("updated");
				}
			} else {
				if (parentPath === undefined) return; // ツリー外
				const rel = joinPath(parentPath, sanitizeName(meta.name));
				if (this.isExcluded(rel)) return;
				await this.ops.ensureFolder(this.toVault(rel));
				this.index.setFolder(rel, meta.id);
				this.status.remoteChange("added");
			}
			return;
		}

		// 通常ファイル
		if (meta.mimeType.startsWith(GOOGLE_APPS_PREFIX) || meta.shortcutDetails) return;
		const parentPath = await this.parentPathOf(meta);

		if (knownPath !== undefined) {
			const entry = this.index.getFile(knownPath);
			if (!entry) return;
			if (parentPath === undefined) {
				await this.removeRemoteFileLocally(knownPath);
				this.status.remoteChange("removed");
				return;
			}
			// リネーム/移動
			let rel = knownPath;
			let changed = false;
			const newRel = joinPath(parentPath, sanitizeName(meta.name));
			if (newRel !== knownPath && !this.isExcluded(newRel) && !this.index.getFile(newRel)) {
				const f = this.ops.getFile(this.toVault(knownPath));
				if (f) await this.ops.renameLocal(f, this.toVault(newRel));
				this.index.renameFile(knownPath, newRel);
				this.queue.rename(knownPath, newRel);
				rel = newRel;
				changed = true;
			}
			// 内容更新
			entry.remoteMd5 = meta.md5Checksum ?? null;
			entry.remoteModifiedTime = ts(meta.modifiedTime);
			entry.remoteSize = num(meta.size);
			entry.tooLarge =
				num(meta.size) > this.plugin.settings.maxFileSizeMB * 1024 * 1024;
			this.index.markDirty();
			if (
				entry.hydrated &&
				!entry.dirty &&
				(entry.remoteMd5 ?? null) !== (entry.hydratedMd5 ?? null)
			) {
				changed = true;
				await this.withLock(rel, async () => {
					const f = this.ops.getFile(this.toVault(rel));
					if (!f || entry.dirty) return;
					if (this.isFileOpen(rel) || this.isEager(rel)) {
						// 開いているファイル・eager 指定は即時更新して実体を保つ
						if (!await this.downloadInto(f, entry)) throw new Error(`Download deferred: ${rel}`);
					}
				});
			}
			if (changed) this.status.remoteChange("updated");
		} else {
			if (parentPath === undefined) return;
			const rel = joinPath(parentPath, sanitizeName(meta.name));
			if (this.isExcluded(rel)) return;
			if (this.index.getFile(rel)) throw new Error('File path collision: ' + rel);
			if (this.ops.exists(this.toVault(rel))) throw new Error('Untracked local file: ' + rel);
			await this.ops.createStub(this.toVault(rel));
			this.index.setFile(rel, {
				fileId: meta.id,
				remoteMd5: meta.md5Checksum ?? null,
				remoteModifiedTime: ts(meta.modifiedTime),
				remoteSize: num(meta.size),
				hydrated: false,
				dirty: false,
				lastAccess: 0,
				tooLarge:
					num(meta.size) > this.plugin.settings.maxFileSizeMB * 1024 * 1024,
			});
			this.status.remoteChange("added");
			// eager 指定なら新規スタブをその場で実体化
			if (this.isEager(rel)) await this.hydrateStubRel(rel);
		}
	}

	/** リモートで削除されたファイルをローカルへ反映（dirty なら残して新規化） */
	private async removeRemoteFileLocally(rel: string): Promise<void> {
		const entry = this.index.getFile(rel);
		if (!entry) return;
		if (entry.dirty) {
			// ローカル編集を保護: 次回アップロードで新規作成される
			entry.fileId = "";
			entry.creationId = undefined;
			this.index.setFile(rel, entry);
			return;
		}
		const f = this.ops.getFile(this.toVault(rel));
		if (f) await this.ops.deleteLocal(f);
		this.index.deleteFile(rel);
	}

	/** リモートで削除されたフォルダをローカルへ反映（dirty ファイルは保護） */
	private async removeRemoteFolderLocally(rel: string): Promise<void> {
		const { files, folders } = this.index.pathsUnder(rel);
		const keptFiles: string[] = [];
		for (const f of files) {
			const e = this.index.getFile(f)!;
			if (e.dirty) {
				e.fileId = "";
				e.creationId = undefined;
				this.index.setFile(f, e);
				keptFiles.push(f);
			} else {
				const file = this.ops.getFile(this.toVault(f));
				if (file) await this.ops.deleteLocal(file);
				this.index.deleteFile(f);
			}
		}
		// dirty ファイルの祖先フォルダは「未作成」として残し、それ以外は除去
		const needed = new Set<string>();
		for (const f of keptFiles) {
			let p = parentOf(f);
			while (p && (p === rel || p.startsWith(rel + "/"))) {
				needed.add(p);
				p = parentOf(p);
			}
		}
		for (const fo of folders) {
			if (needed.has(fo)) this.index.setFolder(fo, "");
			else this.index.deleteFolder(fo);
		}
		if (keptFiles.length === 0) {
			for (const path of folders.sort((a, b) => b.length - a.length)) {
				const folder = this.ops.getFolder(this.toVault(path));
				if (folder && folder.children.length === 0) await this.ops.deleteLocal(folder);
			}
		}
	}

	// ---------------- 同期・キャッシュ管理 ----------------

	/**
	 * Each cycle attempts its current work once; failed retries continue in the queue.
	 * Automatic cycles stay quiet; manual cycles show the same pending/success result.
	 */
	async syncNow(opts?: { awaitUploads?: boolean; notify?: boolean }): Promise<void> {
		if (this.scanning || this.syncing || this.migrating || this.migrationRunning) {
			if (opts?.notify) new Notice(t.syncAlreadyRunning);
			return;
		}
		this.syncing = true;
		this.pendingIssues.clear();
		this.status.beginSync();
		let failed = false;
		try {
			this.assertTarget();
			await this.queue.pause();
			await Promise.all(Array.from(this.locks.values()));
			if (this.opsTask) await this.opsTask;
			if (!this.index.data.changesPageToken) await this.fullScan(true);
			if (!this.index.data.changesPageToken) throw new Error(t.syncNotReady);
			await this.reconcileLocal();
			await this.flushPendingOps();
			await this.tryEnsureRemoteFolders();
			await this.pullChanges();
			this.openAttachments.clear();
			const openNotes: TFile[] = [];
			this.plugin.app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.view instanceof FileView && leaf.view.file?.extension === "md") openNotes.push(leaf.view.file);
			});
			for (const file of openNotes) await this.hydrateEmbedsOf(file);
			this.queue.resume();
			// Attachments first. A second phase reads current notes only after that attempt.
			await this.queue.runNow(this.index.dirtyPaths().filter((rel) => !rel.endsWith(".md")));
			await this.queue.runNow(this.index.dirtyPaths().filter((rel) => rel.endsWith(".md")));
			await this.flushPendingOps();
			await this.index.flush();
		} catch (e) {
			failed = true;
			if (e instanceof NetworkError) this.status.setOffline();
			else this.notifyError(t.syncFailed, e);
		} finally {
			this.queue.resume();
			const pending = this.index.dirtyPaths().length;
			const ops = this.index.data.pendingOps.length + Object.values(this.index.data.folders).filter(id => !id).length;
			const incoming = this.index.data.incoming?.length ?? 0;
			const summary = this.status.endSync({ pending, ops, incoming, failed: failed || this.pendingIssues.size > 0 });
			this.syncing = false;
			if (opts?.notify) new Notice('GDSync: ' + (summary ?? t.syncNoChanges), 6000);
		}
	}

	/** 古い/多すぎるキャッシュを脱ハイドレート */
	async evictCache(): Promise<void> {
		if (this.migrating || this.scanning || this.syncing) return;
		const s = this.plugin.settings;
		const now = Date.now();
		const candidates: Array<{ rel: string; entry: IndexEntry }> = [];
		for (const [rel, entry] of Object.entries(this.index.data.files)) {
			if (this.openAttachments.has(rel)) continue;
			if (!entry.hydrated || entry.dirty || !entry.fileId) continue;
			if (this.queue.has(rel)) continue;
			// アップロード済みでリモートと一致しているものだけ安全に破棄できる
			if ((entry.hydratedMd5 ?? null) !== (entry.remoteMd5 ?? null)) continue;
			if (this.isFileOpen(rel)) continue;
			if (this.isEager(rel)) continue; // eager 指定は常に実体を保つ
			candidates.push({ rel, entry });
		}
		const maxAgeMs = s.cacheMaxAgeDays * 24 * 60 * 60 * 1000;
		const evictSet = new Set(
			candidates.filter((c) => now - c.entry.lastAccess > maxAgeMs)
		);
		const excess = this.index.hydratedCount() - s.cacheMaxCount;
		if (excess > 0) {
			const sorted = [...candidates].sort(
				(a, b) => a.entry.lastAccess - b.entry.lastAccess
			);
			for (const c of sorted.slice(0, excess)) evictSet.add(c);
		}
		let evicted = 0;
		for (const { rel, entry } of evictSet) {
			await this.withLock(rel, async () => {
				if (!entry.hydrated || entry.dirty) return;
				const f = this.ops.getFile(this.toVault(rel));
				if (!f) return;
				const revision = entry.revision ?? 0;
				if (!await this.ops.truncateToStub(f, () => !entry.dirty && (entry.revision ?? 0) === revision)) return;
				this.rememberLocal(f, entry);
				entry.hydrated = false;
				entry.hydratedMd5 = undefined;
				this.index.markDirty();
				evicted++;
			});
		}
		if (evicted > 0) await this.index.flush();
	}

	private notifyError(prefix: string, e: unknown): void {
		console.error(`gdsync: ${prefix}`, e);
		const detail = e instanceof Error ? e.message : String(e);
		// モバイルでも読めるよう詳細を必ず表示し、15秒表示する
		if (e instanceof AuthError) {
			new Notice(`GDSync: ${e.message}`, 15000);
		} else if (e instanceof NetworkError) {
			new Notice(`GDSync: ${prefix} (${t.possiblyOffline})\n${detail}`, 15000);
		} else if (e instanceof ApiError) {
			new Notice(`GDSync: ${prefix} (HTTP ${e.status})\n${e.message}`, 15000);
		} else {
			new Notice(`GDSync: ${prefix}\n${detail}`, 15000);
		}
	}
}
