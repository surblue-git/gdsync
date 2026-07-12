import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import { AuthError } from "./auth";
import {
	ApiError,
	DriveClient,
	FOLDER_MIME,
	GOOGLE_APPS_PREFIX,
	NetworkError,
} from "./drive-client";
import { FileIndex } from "./file-index";
import { StatusDisplay } from "./status";
import { DriveChange, DriveItemMeta, IndexEntry } from "./types";
import { UploadQueue } from "./upload-queue";
import { sanitizeName, VaultOps } from "./vault-ops";
import type GdsyncPlugin from "./main";

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
	private scanning = false;
	private syncing = false;
	private flushingOps = false;

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
		return normalizePath(this.plugin.settings.baseFolder);
	}

	toVault(rel: string): string {
		return rel ? `${this.basePath()}/${rel}` : this.basePath();
	}

	/** Vault パス → ベースフォルダ相対パス。対象外なら null、ベース自身は "" */
	toRel(vaultPath: string): string | null {
		const base = this.basePath();
		if (vaultPath === base) return "";
		if (vaultPath.startsWith(base + "/")) return vaultPath.slice(base.length + 1);
		return null;
	}

	private isExcluded(rel: string): boolean {
		const patterns = this.plugin.settings.excludePatterns
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		if (patterns.some((p) => rel === p || rel.includes(p))) return true;
		// 自己増殖ガード: Drive ツリー内にミラー先と同名のフォルダが現れた場合は必ず除外する。
		// baseFolder が PC 側で Drive 同期対象と重なっていると、GDSync が作ったローカルの
		// ミラーフォルダを外部の同期クライアント(Drive for Desktop等)が拾ってDriveへ
		// アップロードしてしまい、次のスキャンでそれを再度ミラーする無限入れ子ループが起きる。
		const baseName = this.plugin.settings.baseFolder.split("/").pop()?.toLowerCase();
		if (baseName) {
			const segments = rel.toLowerCase().split("/");
			if (segments.includes(baseName)) return true;
		}
		return false;
	}

	/** per-file 直列化。ハイドレートとアップロードの競走を防ぐ */
	private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(key) || Promise.resolve();
		const run = prev.then(fn, fn);
		this.locks.set(
			key,
			run.then(
				() => undefined,
				() => undefined
			)
		);
		return run;
	}

	private isFileOpen(rel: string): boolean {
		const vaultPath = this.toVault(rel);
		let open = false;
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as unknown as { file?: { path?: string } };
			if (view?.file?.path === vaultPath) open = true;
		});
		return open;
	}

	// ---------------- 初回/フルスキャン ----------------

	/**
	 * Drive 全体を一括リストしてツリーを再構成し、スタブを生成する。
	 * 冪等: 既存スタブ・既存インデックスとの差分のみ適用。
	 */
	async fullScan(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.rootFolderId) {
			new Notice("GDSync: 対象の Drive フォルダが未設定です。");
			return;
		}
		if (this.scanning) {
			new Notice("GDSync: スキャンは既に実行中です。");
			return;
		}
		this.scanning = true;
		try {
			this.status.progress("Drive 一覧を取得中…");
			// リスト取得前にトークンを確保 → スキャン中の変更を取りこぼさない
			const startToken = await this.drive.getStartPageToken();
			const items = await this.drive.listAll((count) =>
				this.status.progress(`Drive 一覧を取得中… ${count} 件`)
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
				const kids = children.get(cur.id) || [];
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
			console.log(
				`gdsync: fullScan — Drive総アイテム=${items.length}, ` +
					`対象フォルダ=${remoteFolders.size}, 対象ファイル=${remoteFiles.size}`
			);
			if (remoteFiles.size === 0 && remoteFolders.size > 0) {
				new Notice(
					"GDSync: フォルダは見つかりましたが同期対象ファイルが0件でした。除外パターンや対象フォルダ設定を確認してください。",
					15000
				);
			}

			// --- ローカルへ反映 ---
			this.status.progress("フォルダを作成中…");
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
					const existing = this.index.getFile(rel);
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
							// 別ファイルに置き換わっていた → キャッシュ無効化
							existing.fileId = meta.id;
							if (existing.hydrated && !existing.dirty) {
								await this.ops.truncateToStub(localFile);
								existing.hydrated = false;
								existing.hydratedMd5 = undefined;
							}
						} else {
							const newMd5 = meta.md5Checksum ?? null;
							if (
								existing.hydrated &&
								!existing.dirty &&
								newMd5 !== (existing.hydratedMd5 ?? null)
							) {
								await this.ops.truncateToStub(localFile);
								existing.hydrated = false;
								existing.hydratedMd5 = undefined;
							}
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
					console.error("gdsync: スタブ作成失敗", rel, e);
				}
				if (i % 50 === 0) {
					this.status.progress(`スタブ作成中… ${i}/${remoteFiles.size}`);
					await yieldToUI();
				}
			}

			// リモートに存在しなくなったもの
			for (const rel of Object.keys(this.index.data.files)) {
				if (remoteFiles.has(rel)) continue;
				const entry = this.index.getFile(rel)!;
				if (entry.dirty || !entry.fileId) {
					// ローカル編集/新規はアップロード対象として残す（fileId をクリアして新規作成へ）
					if (entry.dirty) entry.fileId = "";
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

			this.index.data.rootFolderId = s.rootFolderId;
			this.index.data.changesPageToken = startToken;
			this.index.data.lastFullScan = Date.now();
			this.index.markDirty();
			await this.index.flush();
			this.status.endProgress();
			if (failed > 0) {
				new Notice(
					`GDSync: スキャン完了（${remoteFiles.size}ファイル中 ${created}件作成、${failed}件失敗）\n最初の失敗: ${firstError}`,
					15000
				);
			} else {
				new Notice(
					`GDSync: スキャン完了 (${remoteFiles.size} ファイル / 新規スタブ ${created})`,
					8000
				);
			}
		} catch (e) {
			this.status.endProgress();
			this.notifyError("スキャン失敗", e);
		} finally {
			this.scanning = false;
		}
	}

	// ---------------- ハイドレート ----------------

	async onFileOpen(file: TFile): Promise<void> {
		const rel = this.toRel(file.path);
		if (rel === null || rel === "") return;
		const entry = this.index.getFile(rel);
		if (!entry) return;
		entry.lastAccess = Date.now();
		this.index.markDirty();
		if (!entry.fileId) return; // ローカル新規（リモート未作成）
		await this.withLock(rel, async () => {
			if (entry.tooLarge) {
				new Notice(
					`GDSync: ${file.name} はサイズ上限(${this.plugin.settings.maxFileSizeMB}MB)を超えるため取得しません。`
				);
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
		const maxSize = this.plugin.settings.maxFileSizeMB * 1024 * 1024;
		if (entry.remoteSize > maxSize) {
			entry.tooLarge = true;
			this.index.markDirty();
			new Notice(`GDSync: ${file.name} はサイズ上限を超えるため取得しません。`);
			return false;
		}
		this.status.set(`${file.name} を取得中…`);
		try {
			const data = await this.drive.download(entry.fileId);
			await this.ops.writeContent(file, data);
			entry.hydrated = true;
			entry.hydratedMd5 = entry.remoteMd5 ?? undefined;
			entry.dirty = false;
			entry.lastAccess = Date.now();
			entry.lastFreshCheck = Date.now();
			this.index.markDirty();
			await this.index.flush();
			return true;
		} catch (e) {
			this.notifyError(`${file.name} の取得に失敗`, e);
			return false;
		} finally {
			this.status.set("");
		}
	}

	// ---------------- Vault イベント ----------------

	onModify(file: TFile): void {
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
			new Notice(
				"GDSync: このファイルの実体はまだ取得されていません。この編集はアップロードされません。オンラインでファイルを開き直してください。"
			);
			return;
		}
		entry.dirty = true;
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
				void this.tryEnsureRemoteFolders();
			}
			return;
		}
		if (this.index.getFile(rel)) return;
		this.trackNewLocalFile(rel);
	}

	private trackNewLocalFile(rel: string): void {
		this.index.setFile(rel, {
			fileId: "",
			remoteMd5: null,
			remoteModifiedTime: 0,
			remoteSize: 0,
			hydrated: true, // ローカル生まれ = ローカルが実体
			dirty: true,
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
		void this.flushPendingOps();
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
			void this.flushPendingOps();
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
			void this.flushPendingOps();
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
		void this.tryEnsureRemoteFolders();
	}

	// ---------------- アップロード ----------------

	/** UploadQueue から呼ばれる。true=完了(またはリトライ不要)、false=リトライ */
	private async performUpload(rel: string): Promise<boolean> {
		return this.withLock(rel, async () => {
			const entry = this.index.getFile(rel);
			if (!entry || !entry.dirty) return true;
			if (!entry.hydrated) return true; // ガード2: 実体なしは絶対に送らない
			const file = this.ops.getFile(this.toVault(rel));
			if (!file) return true; // 既に消えていた
			let data: ArrayBuffer;
			try {
				data = await this.ops.readBinary(file);
			} catch (e) {
				return false;
			}
			// ガード3: ローカルが空でリモートに内容がある場合は事故防止のため送らない
			if (data.byteLength === 0 && entry.remoteSize > 0) {
				new Notice(
					`GDSync: ${file.name} が空のためアップロードを中止しました（リモートには内容があります）。意図的なら一度リモート版を開いてから編集してください。`
				);
				return true;
			}
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
							entry.fileId = ""; // リモートで完全削除済み → 新規作成
						} else {
							throw e;
						}
					}
					if (remote) {
						if (remote.trashed) {
							entry.fileId = ""; // ゴミ箱行き → 新規作成で復活
						} else if (
							remote.md5Checksum &&
							entry.hydratedMd5 &&
							remote.md5Checksum !== entry.hydratedMd5
						) {
							await this.resolveConflict(rel, file, entry, data, remote);
							return true;
						}
					}
				}
				const isNew = !entry.fileId;
				const parentId = isNew
					? await this.ensureRemoteFolder(parentOf(rel))
					: undefined;
				const mtimeBeforeUpload = file.stat.mtime;
				const res = await this.drive.upload({
					fileId: entry.fileId || undefined,
					name: isNew ? file.name : undefined,
					parentId,
					mimeType: mimeFor(file.extension),
					data,
				});
				entry.fileId = res.id;
				entry.remoteMd5 = res.md5Checksum ?? null;
				entry.remoteModifiedTime = ts(res.modifiedTime);
				entry.remoteSize = num(res.size);
				entry.hydratedMd5 = res.md5Checksum;
				// アップロード中に再編集されていたら dirty を維持して再送
				const nowFile = this.ops.getFile(this.toVault(rel));
				const editedMeanwhile =
					!!nowFile && nowFile.stat.mtime !== mtimeBeforeUpload;
				entry.dirty = editedMeanwhile;
				this.index.setFile(rel, entry);
				await this.index.flush();
				if (editedMeanwhile) this.queue.schedule(rel);
				this.status.set("");
				return true;
			} catch (e) {
				if (e instanceof AuthError) {
					new Notice(`GDSync: ${e.message}`);
					return true; // 再認証されるまでリトライしない（dirty は残る）
				}
				if (e instanceof NetworkError) {
					this.status.set("オフライン（アップロード待機中）");
					return false; // バックオフでリトライ
				}
				this.notifyError(`${file.name} のアップロードに失敗`, e);
				return false;
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
		remote: DriveItemMeta
	): Promise<void> {
		const dot = file.name.lastIndexOf(".");
		const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
		const ext = dot > 0 ? file.name.slice(dot) : "";
		const conflictName = `${stem} (conflict ${conflictStamp()})${ext}`;
		const parentRel = parentOf(rel);
		const parentId = await this.ensureRemoteFolder(parentRel);

		const uploaded = await this.drive.upload({
			name: conflictName,
			parentId,
			mimeType: mimeFor(file.extension),
			data: localData,
		});
		const conflictRel = joinPath(parentRel, conflictName);
		await this.ops.createWithContent(this.toVault(conflictRel), localData);
		this.index.setFile(conflictRel, {
			fileId: uploaded.id,
			remoteMd5: uploaded.md5Checksum ?? null,
			remoteModifiedTime: ts(uploaded.modifiedTime),
			remoteSize: num(uploaded.size),
			hydrated: true,
			dirty: false,
			lastAccess: Date.now(),
			hydratedMd5: uploaded.md5Checksum,
		});

		// 元ファイルはリモート版で上書き
		entry.remoteMd5 = remote.md5Checksum ?? null;
		entry.remoteModifiedTime = ts(remote.modifiedTime);
		entry.remoteSize = num(remote.size);
		entry.dirty = false;
		await this.downloadInto(file, entry);
		new Notice(
			`GDSync: 競合を検出しました。ローカル版を「${conflictName}」として保存し、${file.name} はリモート版に更新しました。`
		);
	}

	// ---------------- リモートフォルダ解決 ----------------

	/** ベース相対フォルダパス → Drive folderId（必要なら作成） */
	async ensureRemoteFolder(rel: string): Promise<string> {
		if (rel === "") return this.plugin.settings.rootFolderId;
		const existing = this.index.getFolderId(rel);
		if (existing) return existing;
		const parentId = await this.ensureRemoteFolder(parentOf(rel));
		const id = await this.drive.createFolder(baseName(rel), parentId);
		this.index.setFolder(rel, id);
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
				break; // オフライン等 → 後で再試行
			}
		}
	}

	// ---------------- 保留中の構造変更 ----------------

	async flushPendingOps(): Promise<void> {
		if (this.flushingOps) return;
		this.flushingOps = true;
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
				} catch (e) {
					if (e instanceof ApiError && e.status === 404) {
						// 対象が既に存在しない → スキップ
						this.index.data.pendingOps.shift();
						this.index.markDirty();
						continue;
					}
					break; // オフライン等 → 残して後で再試行
				}
			}
		} finally {
			this.flushingOps = false;
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
				new Notice("GDSync: 差分トークンが失効しました。フルスキャンを実行します。");
				await this.fullScan();
				return;
			}
			throw e;
		}
		// フォルダ作成を先に適用（子→親の順序ずれ対策）
		const folderAdds = result.changes.filter(
			(c) => !c.removed && c.file && !c.file.trashed && c.file.mimeType === FOLDER_MIME
		);
		const rest = result.changes.filter((c) => !folderAdds.includes(c));
		for (const c of [...folderAdds, ...rest]) {
			try {
				await this.applyChange(c);
			} catch (e) {
				console.error("gdsync: change適用失敗", c.fileId, e);
			}
		}
		this.index.data.changesPageToken = result.newStartPageToken;
		this.index.markDirty();
		await this.index.flush();
	}

	/** 親フォルダID → ベース相対パス（ツリー外なら undefined） */
	private parentPathOf(meta: DriveItemMeta): string | undefined {
		const pid = meta.parents?.[0];
		if (!pid) return undefined;
		if (pid === this.plugin.settings.rootFolderId) return "";
		const path = this.index.pathById(pid);
		if (path === undefined) return undefined;
		// フォルダIDであることを確認
		return this.index.getFolderId(path) !== undefined ? path : undefined;
	}

	private async applyChange(c: DriveChange): Promise<void> {
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
			return;
		}
		if (!meta) return;

		if (meta.mimeType === FOLDER_MIME) {
			const parentPath = this.parentPathOf(meta);
			if (knownPath !== undefined) {
				if (parentPath === undefined) {
					// 対象ツリー外へ移動された
					await this.removeRemoteFolderLocally(knownPath);
					return;
				}
				const newRel = joinPath(parentPath, sanitizeName(meta.name));
				if (newRel !== knownPath && !this.isExcluded(newRel)) {
					const folder = this.ops.getFolder(this.toVault(knownPath));
					if (folder) await this.ops.renameLocal(folder, this.toVault(newRel));
					this.index.renameFolderPrefix(knownPath, newRel);
				}
			} else {
				if (parentPath === undefined) return; // ツリー外
				const rel = joinPath(parentPath, sanitizeName(meta.name));
				if (this.isExcluded(rel)) return;
				await this.ops.ensureFolder(this.toVault(rel));
				this.index.setFolder(rel, meta.id);
			}
			return;
		}

		// 通常ファイル
		if (meta.mimeType.startsWith(GOOGLE_APPS_PREFIX) || meta.shortcutDetails) return;
		const parentPath = this.parentPathOf(meta);

		if (knownPath !== undefined) {
			const entry = this.index.getFile(knownPath);
			if (!entry) return;
			if (parentPath === undefined) {
				await this.removeRemoteFileLocally(knownPath);
				return;
			}
			// リネーム/移動
			let rel = knownPath;
			const newRel = joinPath(parentPath, sanitizeName(meta.name));
			if (newRel !== knownPath && !this.isExcluded(newRel) && !this.index.getFile(newRel)) {
				const f = this.ops.getFile(this.toVault(knownPath));
				if (f) await this.ops.renameLocal(f, this.toVault(newRel));
				this.index.renameFile(knownPath, newRel);
				this.queue.rename(knownPath, newRel);
				rel = newRel;
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
				await this.withLock(rel, async () => {
					const f = this.ops.getFile(this.toVault(rel));
					if (!f) return;
					if (this.isFileOpen(rel)) {
						// 開いているファイルは即時更新
						await this.downloadInto(f, entry);
					} else {
						// 未オープンはスタブ化（次回オープン時に取得）
						await this.ops.truncateToStub(f);
						entry.hydrated = false;
						entry.hydratedMd5 = undefined;
						this.index.markDirty();
					}
				});
			}
		} else {
			if (parentPath === undefined) return;
			const rel = joinPath(parentPath, sanitizeName(meta.name));
			if (this.isExcluded(rel)) return;
			if (this.index.getFile(rel)) return; // パス衝突 → 次回フルスキャンで解決
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
		}
	}

	/** リモートで削除されたファイルをローカルへ反映（dirty なら残して新規化） */
	private async removeRemoteFileLocally(rel: string): Promise<void> {
		const entry = this.index.getFile(rel);
		if (!entry) return;
		if (entry.dirty) {
			// ローカル編集を保護: 次回アップロードで新規作成される
			entry.fileId = "";
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
			const folder = this.ops.getFolder(this.toVault(rel));
			if (folder) await this.ops.deleteLocal(folder);
		}
	}

	// ---------------- 同期・キャッシュ管理 ----------------

	/** 起動時/復帰時/手動: 保留分を流してから差分を取得 */
	async syncNow(): Promise<void> {
		if (this.syncing || this.scanning) return;
		this.syncing = true;
		try {
			this.status.set("同期中…");
			await this.flushPendingOps();
			await this.tryEnsureRemoteFolders();
			for (const rel of this.index.dirtyPaths()) this.queue.schedule(rel, true);
			await this.pullChanges();
			this.status.set("");
		} catch (e) {
			this.status.set("");
			if (!(e instanceof NetworkError)) this.notifyError("同期に失敗", e);
		} finally {
			this.syncing = false;
		}
	}

	/** 古い/多すぎるキャッシュを脱ハイドレート */
	async evictCache(): Promise<void> {
		const s = this.plugin.settings;
		const now = Date.now();
		const candidates: Array<{ rel: string; entry: IndexEntry }> = [];
		for (const [rel, entry] of Object.entries(this.index.data.files)) {
			if (!entry.hydrated || entry.dirty || !entry.fileId) continue;
			if (this.queue.has(rel)) continue;
			// アップロード済みでリモートと一致しているものだけ安全に破棄できる
			if ((entry.hydratedMd5 ?? null) !== (entry.remoteMd5 ?? null)) continue;
			if (this.isFileOpen(rel)) continue;
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
				await this.ops.truncateToStub(f);
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
			new Notice(`GDSync: ${prefix}（オフラインの可能性）\n${detail}`, 15000);
		} else if (e instanceof ApiError) {
			new Notice(`GDSync: ${prefix} (HTTP ${e.status})\n${e.message}`, 15000);
		} else {
			new Notice(`GDSync: ${prefix}\n${detail}`, 15000);
		}
	}
}
