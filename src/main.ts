import { Notice, Platform, Plugin, TFile, TFolder } from "obsidian";
import { AuthManager } from "./auth";
import { DriveClient } from "./drive-client";
import { FileIndex } from "./file-index";
import { t } from "./i18n";
import { GdsyncSettingTab } from "./settings";
import { StatusDisplay } from "./status";
import { SyncEngine } from "./sync-engine";
import { DEFAULT_SETTINGS, GdsyncSettings } from "./types";
import { recordParsedText } from "./attachment-links";
import { Suppressor, VaultOps } from "./vault-ops";

export default class GdsyncPlugin extends Plugin {
	settings: GdsyncSettings = DEFAULT_SETTINGS;
	auth!: AuthManager;
	drive!: DriveClient;
	index!: FileIndex;
	ops!: VaultOps;
	engine!: SyncEngine;
	status!: StatusDisplay;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.auth = new AuthManager(this);
		this.drive = new DriveClient(this.auth);
		this.index = new FileIndex(this);
		this.ops = new VaultOps(this.app, new Suppressor());
		this.status = new StatusDisplay(this);
		this.engine = new SyncEngine(this, this.drive, this.index, this.ops, this.status);

		this.addSettingTab(new GdsyncSettingTab(this.app, this));

		// obsidian://gdsync-auth?code=...&state=... （認証コールバック）
		this.registerObsidianProtocolHandler("gdsync-auth", (params) => {
			void this.auth.handleCallback(params as unknown as Record<string, string>);
		});

		this.addCommand({
			id: "authenticate",
			name: t.cmdAuthenticate,
			callback: () => void this.auth.beginAuth(),
		});
		this.addCommand({
			id: "full-scan",
			name: t.cmdFullScan,
			callback: () => void this.engine.fullScan(),
		});
		this.addCommand({
			id: "pause-sync",
			name: t.pauseSync,
			callback: () => void this.engine.setPaused(true).catch(e => new Notice(String(e))),
		});
		this.addCommand({
			id: "sync-now",
			name: t.cmdSyncNow,
			callback: () => void this.engine.syncNow({ awaitUploads: true, notify: true }),
		});
		this.addCommand({
			id: "evict-cache",
			name: t.cmdEvictCache,
			callback: () => void this.engine.evictCache(),
		});
		this.addCommand({
			id: "hydrate-current",
			name: t.cmdHydrateCurrent,
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const rel = this.engine.toRel(file.path);
				const entry = rel ? this.index.getFile(rel) : undefined;
				if (!entry?.fileId || (entry.dirty && entry.syncState !== "conflict") || !this.isActive()) return false;
				if (!checking) {
					entry.hydrated = false;
					entry.dirty = false;
					entry.syncState = "clean";
					entry.conflictCopy = undefined;
					this.index.markDirty();
					void this.engine.onFileOpen(file);
				}
				return true;
			},
		});
		this.addCommand({
			id: "upload-current",
			name: t.cmdUploadCurrent,
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const rel = this.engine.toRel(file.path);
				const entry = rel ? this.index.getFile(rel) : undefined;
				if (!entry || !entry.hydrated) return false;
				if (!checking) {
					// Explicit upload also resolves a blocked conflict in favor of local bytes.
					if (entry.syncState === "conflict") entry.hydratedMd5 = entry.remoteMd5 ?? undefined;
					entry.recoveryOnly = false;
					entry.dirty = true;
					entry.syncState = "localChanged";
					entry.conflictCopy = undefined;
					entry.revision = (entry.revision ?? 0) + 1;
					this.index.markDirty();
					this.engine.queue.schedule(rel!, true);
				}
				return true;
			},
		});

		this.addRibbonIcon("refresh-cw", t.ribbonSyncNow, () =>
			void this.engine.syncNow({ awaitUploads: true, notify: true })
		);

		// Vault イベントは起動時の初期スキャン（既存ファイル分の create 連発）を避けるため
		// レイアウト完了後に登録する
		this.app.workspace.onLayoutReady(() => {
			void this.startup().catch((e) => {
				this.index.ready = false;
				new Notice(String(e), 15000);
			});
		});
	}

	private async startup(): Promise<void> {
		await this.index.load();
		await this.engine.restoreMigrationState();
		if (this.index.data.mountBase === undefined) {
			this.index.data.mountBase = this.engine.basePath();
			this.index.markDirty();
			await this.index.flush();
		}

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file && this.isActive()) void this.engine.onFileOpen(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", (af) => {
				if (af instanceof TFile && this.isActive()) this.engine.onModify(af);
			})
		);
		this.registerEvent(
			this.app.vault.on("create", (af) => {
				if ((af instanceof TFile || af instanceof TFolder) && this.isActive()) {
					this.engine.onCreate(af);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (af) => {
				if ((af instanceof TFile || af instanceof TFolder) && this.isActive()) {
					this.engine.onDelete(af);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (af, oldPath) => {
				if ((af instanceof TFile || af instanceof TFolder) && this.isActive()) {
					this.engine.onRename(af, oldPath);
				}
			})
		);
		// ノート本文が（ハイドレートや編集で）解析されたら、開いているノートの
		// 埋め込み添付をハイドレートする。file-open 時点ではまだスタブで埋め込みが
		// 見えないケースをここで拾う。
		this.registerEvent(
			this.app.metadataCache.on("changed", (file, data) => {
				recordParsedText(file, data);
				if (!(file instanceof TFile) || !this.isActive()) return;
				const rel = this.engine.toRel(file.path);
				if (rel === null || rel === "") return;
				if (this.engine.isFileOpenPublic(rel)) void this.engine.hydrateEmbedsOf(file);
			})
		);

		// アプリ復帰時に差分同期（モバイルでの主要トリガー）
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.isActive()) {
				void this.engine.syncNow();
			}
		});

		if (!this.isActive() || this.settings.syncPaused) return;
		await this.ops.ensureNoMedia(this.engine.basePath());
		if (this.settings.syncOnStartup && !this.settings.syncPaused) {
			await this.engine.syncNow();
			if (this.settings.syncPaused) return;
			// eager 指定ファイルは起動時に実体を揃える（他プラグインが読む前に）
			await this.engine.hydrateEagerFiles();
			await this.engine.evictCache();
		}
	}

	/** 認証成功直後のフック */
	onAuthenticated(): void {
		if (!this.settings.rootFolderId) {
			new Notice(t.chooseFolderNext);
			return;
		}
		// 接続コードで同期対象ごと引き継いだ直後は、フォルダ選択ではなく
		// フルスキャンが次の一手になる（既にミラー済みの端末には出さない）
		if (Object.keys(this.index.data.files).length === 0) {
			new Notice(t.runFullScanNext, 10000);
		}
	}

	/** 同期機能が有効か（設定完了 + プラットフォーム条件） */
	isActive(): boolean {
		const s = this.settings;
		if (!this.index?.ready || this.engine?.migrating) return false;
		if (!s.tokens || !s.rootFolderId || (s.mountMode !== "vaultRoot" && !s.baseFolder)) return false;
		if (this.index.data.rootFolderId && this.index.data.rootFolderId !== s.rootFolderId) return false;
		if (this.index.data.mountBase !== undefined && this.index.data.mountBase !== this.engine.basePath()) return false;
		return Platform.isMobile || s.enableOnDesktop;
	}

	onunload(): void {
		this.auth.dispose();
		this.engine.queue.clear();
		void this.index.flush().catch((e) => console.error("gdsync: shutdown save failed", e));
	}

	async loadSettings(): Promise<void> {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		if (!saved) this.settings.mountMode = "vaultRoot";
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
