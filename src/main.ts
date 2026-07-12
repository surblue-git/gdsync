import { Notice, Platform, Plugin, TFile, TFolder } from "obsidian";
import { AuthManager } from "./auth";
import { DriveClient } from "./drive-client";
import { FileIndex } from "./file-index";
import { GdsyncSettingTab } from "./settings";
import { StatusDisplay } from "./status";
import { SyncEngine } from "./sync-engine";
import { DEFAULT_SETTINGS, GdsyncSettings } from "./types";
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
		console.log(`gdsync: loading v${this.manifest.version}`);
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
			name: "Google 認証を開始",
			callback: () => void this.auth.beginAuth(),
		});
		this.addCommand({
			id: "full-scan",
			name: "フルスキャン（インデックス構築/更新）",
			callback: () => void this.engine.fullScan(),
		});
		this.addCommand({
			id: "sync-now",
			name: "今すぐ同期",
			callback: () => void this.engine.syncNow(),
		});
		this.addCommand({
			id: "evict-cache",
			name: "キャッシュ整理（古い実体を解放）",
			callback: () => void this.engine.evictCache(),
		});
		this.addCommand({
			id: "hydrate-current",
			name: "現在のファイルを再ダウンロード",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const rel = this.engine.toRel(file.path);
				const entry = rel ? this.index.getFile(rel) : undefined;
				if (!entry?.fileId) return false;
				if (!checking) {
					entry.hydrated = false;
					entry.hydratedMd5 = undefined;
					entry.dirty = false;
					this.index.markDirty();
					void this.engine.onFileOpen(file);
				}
				return true;
			},
		});
		this.addCommand({
			id: "upload-current",
			name: "現在のファイルを今すぐアップロード",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const rel = this.engine.toRel(file.path);
				const entry = rel ? this.index.getFile(rel) : undefined;
				if (!entry || !entry.hydrated) return false;
				if (!checking) {
					entry.dirty = true;
					this.index.markDirty();
					this.engine.queue.schedule(rel!, true);
				}
				return true;
			},
		});

		this.addRibbonIcon("refresh-cw", "GDSync: 今すぐ同期", () =>
			void this.engine.syncNow()
		);

		// Vault イベントは起動時の初期スキャン（既存ファイル分の create 連発）を避けるため
		// レイアウト完了後に登録する
		this.app.workspace.onLayoutReady(() => {
			void this.startup();
		});
	}

	private async startup(): Promise<void> {
		await this.index.load();

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

		// アプリ復帰時に差分同期（モバイルでの主要トリガー）
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.isActive()) {
				void this.engine.syncNow();
			}
		});

		if (this.isActive()) {
			// ミラー生成でフォルダが作られる前に置く（MediaStore が索引する前に除外させる）
			await this.ensureNoMedia();
			await this.engine.syncNow();
			await this.engine.evictCache();
		}
	}

	/**
	 * Android のメディアスキャナ(MediaStore)からミラーを隠す。
	 * ミラールート直下に空の `.nomedia` を置くと、そのフォルダと全サブフォルダが
	 * ギャラリー/Lightroom/Google フォト等の索引対象から外れる。
	 * `.nomedia` はドット始まりなので Obsidian の Vault レイヤーからは不可視で、
	 * gdsync 自身の同期対象にも拾われない。Android 以外では no-op。
	 */
	private async ensureNoMedia(): Promise<void> {
		if (!Platform.isAndroidApp) return;
		const adapter = this.app.vault.adapter;
		const base = this.engine.basePath();
		if (!base || base === "/") return;
		const marker = `${base}/.nomedia`;
		try {
			if (await adapter.exists(marker)) return;
			if (!(await adapter.exists(base))) await adapter.mkdir(base);
			await adapter.write(marker, "");
			console.log(`gdsync: created ${marker} (MediaStore から除外)`);
		} catch (e) {
			console.warn("gdsync: .nomedia の作成に失敗", e);
		}
	}

	/** 認証成功直後のフック */
	onAuthenticated(): void {
		if (!this.settings.rootFolderId) {
			new Notice("GDSync: 次に設定画面で同期対象の Drive フォルダを選択してください。");
		}
	}

	/** 同期機能が有効か（設定完了 + プラットフォーム条件） */
	isActive(): boolean {
		const s = this.settings;
		if (!s.tokens || !s.rootFolderId || !s.baseFolder) return false;
		return Platform.isMobile || s.enableOnDesktop;
	}

	onunload(): void {
		this.engine.queue.clear();
		void this.index.flush();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
