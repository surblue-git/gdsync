import {
	App,
	FuzzySuggestModal,
	Modal,
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
		this.setPlaceholder("Search for the Drive folder to sync…");
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

/** 接続コード貼り付け用モーダル */
class ConnectionCodeModal extends Modal {
	constructor(app: App, private onSubmit: (code: string) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Enter connection code");
		contentEl.createEl("p", {
			text: "Paste the connection code copied from your other device. It contains your credentials — delete it from wherever you sent it after connecting.",
		});
		const ta = contentEl.createEl("textarea", {
			cls: "gdsync-connection-code",
		});
		ta.rows = 6;
		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Connect")
				.setCta()
				.onClick(() => {
					const v = ta.value.trim();
					if (!v) return;
					this.close();
					this.onSubmit(v);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
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
		containerEl.createEl("p", {
			text: `GDSync v${this.plugin.manifest.version}`,
			cls: "gdsync-version",
		});

		// ---------- Google 認証 ----------
		new Setting(containerEl).setName("Google authentication").setHeading();

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("OAuth client ID from your own Google Cloud project (Desktop app type recommended).")
			.addText((text) => {
				text.setValue(s.clientId).onChange(async (v) => {
					s.clientId = v.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.addClass("gdsync-wide-input");
			});

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Stored unencrypted in this vault's plugin data. Use a dedicated Google Cloud project.")
			.addText((text) => {
				text.setValue(s.clientSecret).onChange(async (v) => {
					s.clientSecret = v.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.type = "password";
				text.inputEl.addClass("gdsync-wide-input");
			});

		new Setting(containerEl)
			.setName("Redirect URI (optional)")
			.setDesc("Only needed for browser sign-in directly on mobile. Leave empty if you sign in on desktop and connect this device with a connection code. If used, deploy the redirect page and register its URL in Google Cloud.")
			.addText((text) => {
				text.setPlaceholder("https://example.github.io/gdsync/")
					.setValue(s.redirectUri)
					.onChange(async (v) => {
						s.redirectUri = v.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass("gdsync-wide-input");
			});

		const authStatus = s.tokens
			? "authenticated"
			: s.pendingAuth
				? "waiting for browser…"
				: "not authenticated";
		new Setting(containerEl)
			.setName(`Status: ${authStatus}`)
			.addButton((btn) =>
				btn
					.setButtonText(s.tokens ? "Re-authenticate" : "Authenticate with Google")
					.setCta()
					.onClick(() => void this.plugin.auth.beginAuth())
			)
			.addButton((btn) =>
				btn.setButtonText("Test connection").onClick(async () => {
					try {
						const user = await this.plugin.drive.about();
						new Notice(
							`GDSync: Connected — ${user.displayName} (${user.emailAddress})`
						);
					} catch (e) {
						new Notice(
							`GDSync: Connection test failed — ${e instanceof Error ? e.message : String(e)}`
						);
					}
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Log out").setWarning().onClick(async () => {
					await this.plugin.auth.logout();
					this.display();
				})
			);

		const connDesc = new Setting(containerEl)
			.setName("Connection code")
			.setDesc(
				"Moves this authentication to another device (e.g. sign in on desktop, then paste the code on your phone). The code contains your credentials and tokens — treat it like a password and delete it after use."
			);
		if (s.tokens) {
			connDesc.addButton((btn) =>
				btn.setButtonText("Copy code").onClick(async () => {
					const code = this.plugin.auth.exportConnectionCode();
					if (!code) {
						new Notice("GDSync: Authenticate first.");
						return;
					}
					await navigator.clipboard.writeText(code);
					new Notice(
						"GDSync: Connection code copied. Treat it like a password."
					);
				})
			);
		}
		connDesc.addButton((btn) =>
			btn.setButtonText("Enter code").onClick(() => {
				new ConnectionCodeModal(this.app, (code) => {
					void this.plugin.auth.importConnectionCode(code).then((ok) => {
						if (ok) this.display();
					});
				}).open();
			})
		);

		// ---------- 同期対象 ----------
		new Setting(containerEl).setName("Sync target").setHeading();

		new Setting(containerEl)
			.setName("Drive folder")
			.setDesc(
				s.rootFolderName
					? `Selected: ${s.rootFolderName} (${s.rootFolderId})`
					: "The Google Drive folder to treat as the vault mirror. You can also paste a Drive URL."
			)
			.addText((text) => {
				text.setPlaceholder("Folder ID or Drive URL")
					.setValue(s.rootFolderId)
					.onChange(async (v) => {
						s.rootFolderId = extractFolderId(v);
						s.rootFolderName = "";
						await this.plugin.saveSettings();
					});
			})
			.addButton((btn) =>
				btn.setButtonText("Choose from list").onClick(async () => {
					try {
						new Notice("GDSync: Fetching folder list…");
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
							`GDSync: Failed to fetch folder list — ${e instanceof Error ? e.message : String(e)}`
						);
					}
				})
			);

		new Setting(containerEl)
			.setName("Mirror base folder")
			.setDesc("The Drive folder structure is recreated under this folder in your vault.")
			.addText((text) =>
				text.setValue(s.baseFolder).onChange(async (v) => {
					s.baseFolder = v.trim() || "GDrive";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Exclude patterns")
			.setDesc("One pattern per line. Paths containing a pattern are not synced.")
			.addTextArea((ta) => {
				ta.setValue(s.excludePatterns).onChange(async (v) => {
					s.excludePatterns = v;
					await this.plugin.saveSettings();
				});
				ta.inputEl.rows = 4;
			});

		new Setting(containerEl)
			.setName("Build or update index (full scan)")
			.setDesc("Lists your Drive files and creates the folder structure and stub files.")
			.addButton((btn) =>
				btn
					.setButtonText("Run full scan")
					.setCta()
					.onClick(() => void this.plugin.engine.fullScan())
			);

		// ---------- 動作設定 ----------
		new Setting(containerEl).setName("Behavior").setHeading();

		new Setting(containerEl)
			.setName("Maximum file size (MB)")
			.setDesc("Files larger than this are not downloaded.")
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
			.setName("Upload debounce (seconds)")
			.setDesc("How long to wait after you stop editing before uploading.")
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
			.setName("Freshness check interval (minutes)")
			.setDesc("How often to check for remote updates when opening a cached file.")
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
			.setName("Cache retention (days)")
			.setDesc("Files not opened for this many days are released back to stubs.")
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
			.setName("Cache maximum count")
			.setDesc("Maximum number of files kept with content (oldest are released first).")
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
			.setName("Enable on desktop")
			.setDesc("Usually unnecessary — on desktop, use a Google Drive for Desktop synced folder as the vault instead.")
			.addToggle((toggle) =>
				toggle.setValue(s.enableOnDesktop).onChange(async (v) => {
					s.enableOnDesktop = v;
					await this.plugin.saveSettings();
				})
			);

		// ---------- メンテナンス ----------
		new Setting(containerEl).setName("Maintenance").setHeading();

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Sends pending uploads and structure changes, then fetches remote changes.")
			.addButton((btn) =>
				btn.setButtonText("Sync").onClick(() => void this.plugin.engine.syncNow())
			);

		new Setting(containerEl)
			.setName("Clean up cache")
			.setDesc("Releases old cached content back to stub files.")
			.addButton((btn) =>
				btn.setButtonText("Run").onClick(async () => {
					await this.plugin.engine.evictCache();
					new Notice("GDSync: Cache cleanup finished.");
				})
			);

		new Setting(containerEl)
			.setName("Reset index")
			.setDesc(
				"Sync first if you have unsent edits. After resetting, run a full scan to rebuild."
			)
			.addButton((btn) =>
				btn.setWarning().setButtonText("Reset").onClick(async () => {
					const dirty = this.plugin.index.dirtyPaths().length;
					if (dirty > 0) {
						new Notice(
							`GDSync: ${dirty} edit(s) have not been uploaded yet. Run "Sync now" first.`
						);
						return;
					}
					this.plugin.index.reset(s.rootFolderId);
					await this.plugin.index.flush();
					new Notice(
						"GDSync: Index has been reset. Run a full scan to rebuild it."
					);
				})
			);
	}
}
