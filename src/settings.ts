import {
	App,
	FuzzySuggestModal,
	Notice,
	PluginSettingTab,
	Setting,
} from "obsidian";
import type GdsyncPlugin from "./main";
import { DriveItemMeta } from "./types";

interface FolderChoice {
	id: string;
	path: string;
}

/** Drive フォルダをファジー検索で選ぶモーダル */
class DriveFolderSuggestModal extends FuzzySuggestModal<FolderChoice> {
	constructor(
		app: App,
		private choices: FolderChoice[],
		private onChoose: (c: FolderChoice) => void
	) {
		super(app);
		this.setPlaceholder("同期対象の Drive フォルダを検索…");
	}

	getItems(): FolderChoice[] {
		return this.choices;
	}

	getItemText(item: FolderChoice): string {
		return item.path;
	}

	onChooseItem(item: FolderChoice): void {
		this.onChoose(item);
	}
}

/** parents から "親/子/孫" 形式のパス表示を組み立てる */
function buildFolderChoices(folders: DriveItemMeta[]): FolderChoice[] {
	const byId = new Map(folders.map((f) => [f.id, f]));
	const pathOf = (f: DriveItemMeta, depth = 0): string => {
		const pid = f.parents?.[0];
		const parent = pid ? byId.get(pid) : undefined;
		if (!parent || depth > 20) return f.name;
		return `${pathOf(parent, depth + 1)}/${f.name}`;
	};
	return folders
		.map((f) => ({ id: f.id, path: pathOf(f) }))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Drive フォルダURL・ID入力の正規化（URL貼り付け対応） */
function extractFolderId(input: string): string {
	const m = input.match(/folders\/([A-Za-z0-9_-]+)/);
	if (m) return m[1];
	return input.trim();
}

export class GdsyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: GdsyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// バージョン表示（新しいビルドが読み込まれているか確認用）
		const ver = containerEl.createEl("p", {
			text: `GDSync v${this.plugin.manifest.version}`,
		});
		ver.style.opacity = "0.6";
		ver.style.fontSize = "0.85em";
		ver.style.margin = "0 0 8px";

		// ---------- Google 認証 ----------
		new Setting(containerEl).setName("Google 認証").setHeading();

		new Setting(containerEl)
			.setName("クライアントID")
			.setDesc("自分の Google Cloud プロジェクトの OAuth クライアントID（Webアプリケーション型）")
			.addText((text) => {
				text.setValue(s.clientId).onChange(async (v) => {
					s.clientId = v.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.style.width = "100%";
			});

		new Setting(containerEl)
			.setName("クライアントシークレット")
			.addText((text) => {
				text.setValue(s.clientSecret).onChange(async (v) => {
					s.clientSecret = v.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
			});

		new Setting(containerEl)
			.setName("リダイレクトURI")
			.setDesc("Cloudflare Pages 等にデプロイした redirect-page のURL。GCP側のリダイレクトURIにも同じ値を登録すること")
			.addText((text) => {
				text.setPlaceholder("https://gdsync-auth.pages.dev/")
					.setValue(s.redirectUri)
					.onChange(async (v) => {
						s.redirectUri = v.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.style.width = "100%";
			});

		const authStatus = s.tokens
			? "認証済み"
			: s.pendingAuth
				? "ブラウザでの認証待ち…"
				: "未認証";
		new Setting(containerEl)
			.setName(`認証状態: ${authStatus}`)
			.addButton((btn) =>
				btn
					.setButtonText(s.tokens ? "再認証" : "Google 認証を開始")
					.setCta()
					.onClick(() => void this.plugin.auth.beginAuth())
			)
			.addButton((btn) =>
				btn.setButtonText("接続テスト").onClick(async () => {
					try {
						const user = await this.plugin.drive.about();
						new Notice(
							`GDSync: 接続OK — ${user.displayName} (${user.emailAddress})`
						);
					} catch (e) {
						new Notice(
							`GDSync: 接続テスト失敗 — ${e instanceof Error ? e.message : String(e)}`
						);
					}
				})
			)
			.addButton((btn) =>
				btn.setButtonText("ログアウト").setWarning().onClick(async () => {
					await this.plugin.auth.logout();
					this.display();
				})
			);

		// ---------- 同期対象 ----------
		new Setting(containerEl).setName("同期対象").setHeading();

		new Setting(containerEl)
			.setName("Drive フォルダ")
			.setDesc(
				s.rootFolderName
					? `選択中: ${s.rootFolderName} (${s.rootFolderId})`
					: "Vault として扱う Drive 上のフォルダ。URL 貼り付けでも可"
			)
			.addText((text) => {
				text.setPlaceholder("フォルダID または DriveのURL")
					.setValue(s.rootFolderId)
					.onChange(async (v) => {
						s.rootFolderId = extractFolderId(v);
						s.rootFolderName = "";
						await this.plugin.saveSettings();
					});
			})
			.addButton((btn) =>
				btn.setButtonText("一覧から選択").onClick(async () => {
					try {
						new Notice("GDSync: フォルダ一覧を取得中…");
						const folders = await this.plugin.drive.listAllFolders();
						const choices = buildFolderChoices(folders);
						new DriveFolderSuggestModal(this.app, choices, async (c) => {
							s.rootFolderId = c.id;
							s.rootFolderName = c.path;
							await this.plugin.saveSettings();
							this.display();
						}).open();
					} catch (e) {
						new Notice(
							`GDSync: フォルダ一覧の取得に失敗 — ${e instanceof Error ? e.message : String(e)}`
						);
					}
				})
			);

		new Setting(containerEl)
			.setName("ミラー先ベースフォルダ")
			.setDesc("Vault 内でこのフォルダ配下に Drive の構造を再現します")
			.addText((text) =>
				text.setValue(s.baseFolder).onChange(async (v) => {
					s.baseFolder = v.trim() || "GDrive";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("除外パターン")
			.setDesc("1行1パターン。パスに部分一致したものは同期しません")
			.addTextArea((ta) => {
				ta.setValue(s.excludePatterns).onChange(async (v) => {
					s.excludePatterns = v;
					await this.plugin.saveSettings();
				});
				ta.inputEl.rows = 4;
			});

		new Setting(containerEl)
			.setName("インデックス構築 / 更新（フルスキャン）")
			.setDesc("Drive の一覧を取得し、フォルダ構造とスタブを作成します")
			.addButton((btn) =>
				btn
					.setButtonText("フルスキャン実行")
					.setCta()
					.onClick(() => void this.plugin.engine.fullScan())
			);

		// ---------- 動作設定 ----------
		new Setting(containerEl).setName("動作設定").setHeading();

		new Setting(containerEl)
			.setName("最大ファイルサイズ (MB)")
			.setDesc("これを超えるファイルはダウンロードしません")
			.addText((text) =>
				text.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						s.maxFileSizeMB = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("アップロードまでの待ち時間 (秒)")
			.setDesc("編集が止まってからアップロードするまでのデバウンス")
			.addText((text) =>
				text.setValue(String(s.uploadDebounceSec)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						s.uploadDebounceSec = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("鮮度確認の間隔 (分)")
			.setDesc("キャッシュ済みファイルを開いたときにリモート更新を確認する間隔")
			.addText((text) =>
				text.setValue(String(s.freshnessTtlMin)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 0) {
						s.freshnessTtlMin = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("キャッシュ保持日数")
			.setDesc("この日数開いていないファイルの実体を解放（スタブに戻す）")
			.addText((text) =>
				text.setValue(String(s.cacheMaxAgeDays)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						s.cacheMaxAgeDays = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("キャッシュ最大件数")
			.setDesc("実体を保持するファイル数の上限（超過分は古い順に解放）")
			.addText((text) =>
				text.setValue(String(s.cacheMaxCount)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						s.cacheMaxCount = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("デスクトップでも有効にする")
			.setDesc("通常は不要（PCは Google Drive for Desktop の同期フォルダを使う想定）")
			.addToggle((toggle) =>
				toggle.setValue(s.enableOnDesktop).onChange(async (v) => {
					s.enableOnDesktop = v;
					await this.plugin.saveSettings();
				})
			);

		// ---------- メンテナンス ----------
		new Setting(containerEl).setName("メンテナンス").setHeading();

		new Setting(containerEl)
			.setName("今すぐ同期")
			.setDesc("保留中のアップロード・構造変更を送信し、リモート差分を取得します")
			.addButton((btn) =>
				btn.setButtonText("同期").onClick(() => void this.plugin.engine.syncNow())
			);

		new Setting(containerEl)
			.setName("キャッシュ整理")
			.setDesc("古いキャッシュ（実体）を解放してスタブに戻します")
			.addButton((btn) =>
				btn.setButtonText("実行").onClick(async () => {
					await this.plugin.engine.evictCache();
					new Notice("GDSync: キャッシュ整理が完了しました。");
				})
			);

		new Setting(containerEl)
			.setName("インデックスをリセット")
			.setDesc(
				"未アップロードの編集がある場合は先に同期してください。実行後は「フルスキャン実行」で作り直してください。"
			)
			.addButton((btn) =>
				btn.setWarning().setButtonText("リセット").onClick(async () => {
					const dirty = this.plugin.index.dirtyPaths().length;
					if (dirty > 0) {
						new Notice(
							`GDSync: 未アップロードの編集が${dirty}件あります。先に「今すぐ同期」を実行してください。`
						);
						return;
					}
					this.plugin.index.reset(s.rootFolderId);
					await this.plugin.index.flush();
					new Notice(
						"GDSync: インデックスをリセットしました。「フルスキャン実行」で作り直してください。"
					);
				})
			);
	}
}
