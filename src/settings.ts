import {
	App,
	FuzzySuggestModal,
	Modal,
	moment,
	Notice,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { FOLDER_MIME } from "./drive-client";
import { t } from "./i18n";
import type GdsyncPlugin from "./main";
import { DriveItemMeta } from "./types";
import { validPath } from "./sync-paths";

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
		this.setPlaceholder(t.searchFolderPlaceholder);
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
		this.setTitle(t.modalEnterCodeTitle);
		contentEl.createEl("p", { text: t.modalEnterCodeDesc });
		const ta = contentEl.createEl("textarea", {
			cls: "gdsync-connection-code",
		});
		ta.rows = 6;
		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(t.btnConnect)
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

class SyncReportModal extends Modal {
	constructor(app: App, private heading: string, private lines: string[], private action?: () => Promise<void>) { super(app); }
	onOpen(): void {
		this.setTitle(this.heading);
		for (const line of this.lines) this.contentEl.createEl("p", { text: line });
		if (this.action) new Setting(this.contentEl).addButton((button) =>
			button.setButtonText(t.btnRun).setCta().onClick(async () => {
				button.setDisabled(true);
				try { await this.action!(); this.close(); }
				catch (e) { new Notice(String(e), 15000); button.setDisabled(false); }
			}));
	}
	onClose(): void { this.contentEl.empty(); }
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
		new Setting(containerEl).setName(t.headingGoogleAuth).setHeading();

		new Setting(containerEl)
			.setName(t.clientId)
			.setDesc(t.clientIdDesc)
			.addText((text) => {
				text.setValue(s.clientId).onChange(async (v) => {
					s.clientId = v.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.addClass("gdsync-wide-input");
			});

		new Setting(containerEl)
			.setName(t.clientSecret)
			.setDesc(t.clientSecretDesc)
			.addText((text) => {
				text.setValue(s.clientSecret).onChange(async (v) => {
					s.clientSecret = v.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.type = "password";
				text.inputEl.addClass("gdsync-wide-input");
			});

		new Setting(containerEl)
			.setName(t.redirectUri)
			.setDesc(t.redirectUriDesc)
			.addText((text) => {
				text.setPlaceholder(t.redirectUriPlaceholder)
					.setValue(s.redirectUri)
					.onChange(async (v) => {
						s.redirectUri = v.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass("gdsync-wide-input");
			});

		const authStatus = s.tokens
			? t.statusAuthenticated
			: s.pendingAuth
				? t.statusWaiting
				: t.statusNot;
		new Setting(containerEl)
			.setName(t.statusLabel(authStatus))
			.addButton((btn) =>
				btn
					.setButtonText(s.tokens ? t.btnReauth : t.btnAuth)
					.setCta()
					.onClick(() => void this.plugin.auth.beginAuth())
			)
			.addButton((btn) =>
				btn.setButtonText(t.btnTestConnection).onClick(async () => {
					try {
						const user = await this.plugin.drive.about();
						new Notice(t.connectedNotice(user.displayName, user.emailAddress));
					} catch (e) {
						new Notice(
							t.connTestFailed(e instanceof Error ? e.message : String(e))
						);
					}
				})
			)
			.addButton((btn) =>
				btn.setButtonText(t.btnLogout).setWarning().onClick(async () => {
					await this.plugin.auth.logout();
					this.display();
				})
			);

		const connDesc = new Setting(containerEl)
			.setName(t.connCode)
			.setDesc(t.connCodeDesc);
		if (s.tokens) {
			connDesc.addButton((btn) =>
				btn.setButtonText(t.btnCopyCode).onClick(async () => {
					const code = this.plugin.auth.exportConnectionCode();
					if (!code) {
						new Notice(t.authFirst);
						return;
					}
					await navigator.clipboard.writeText(code);
					new Notice(t.codeCopied);
				})
			);
		}
		connDesc.addButton((btn) =>
			btn.setButtonText(t.btnEnterCode).onClick(() => {
				new ConnectionCodeModal(this.app, (code) => {
					void this.plugin.auth.importConnectionCode(code).then((ok) => {
						if (ok) this.display();
					});
				}).open();
			})
		);

		// ---------- 同期対象 ----------
		new Setting(containerEl).setName(t.headingSyncTarget).setHeading();

		const folderSetting = new Setting(containerEl)
			.setName(t.driveFolder)
			.setDesc(
				s.rootFolderName
					? t.driveFolderSelected(s.rootFolderName, s.rootFolderId)
					: t.driveFolderDesc
			)
			.addText((text) => {
				text.setPlaceholder(t.driveFolderPlaceholder)
					.setValue(s.rootFolderId)
					.onChange(async (v) => {
						if (!this.plugin.engine.canChangeTarget()) { new Notice(t.targetLocked); return; }
						s.rootFolderId = extractFolderId(v);
						s.rootFolderName = "";
						this.plugin.index.reset(s.rootFolderId);
						this.plugin.index.data.mountBase = this.plugin.engine.basePath();
						await this.plugin.index.flush();
						await this.plugin.saveSettings();
					});
				// フォーカスが外れたら、手入力IDの実在を検証してフォルダ名を解決する。
				// 無効なID（余分な文字の混入など）を黙って受け入れず、その場で気付けるように。
				text.inputEl.addEventListener("blur", async () => {
					const id = s.rootFolderId;
					if (!id || s.rootFolderName) return;
					try {
						const meta = await this.plugin.drive.getMeta(
							id,
							"id,name,mimeType,trashed"
						);
						if (meta.trashed || meta.mimeType !== FOLDER_MIME) {
							new Notice(t.rootNotFolder(id), 12000);
							return;
						}
						s.rootFolderName = meta.name;
						await this.plugin.saveSettings();
						this.display();
					} catch (e) {
						new Notice(
							t.rootResolveFailed(e instanceof Error ? e.message : String(e)),
							12000
						);
					}
				});
				text.inputEl.addClass("gdsync-wide-input");
			})
			.addButton((btn) =>
				btn.setButtonText(t.btnChooseFromList).onClick(async () => {
					try {
						new Notice(t.fetchingFolders);
						const folders = await this.plugin.drive.listAllFolders();
						const choices = buildFolderChoices(folders);
						new DriveFolderSuggestModal(this.app, choices, async (c) => {
							if (!this.plugin.engine.canChangeTarget()) { new Notice(t.targetLocked); return; }
							s.rootFolderId = c.id;
							s.rootFolderName = c.path;
							this.plugin.index.reset(s.rootFolderId);
							this.plugin.index.data.mountBase = this.plugin.engine.basePath();
							await this.plugin.index.flush();
							await this.plugin.saveSettings();
							this.display();
						}).open();
					} catch (e) {
						new Notice(
							t.fetchFoldersFailed(e instanceof Error ? e.message : String(e))
						);
					}
				})
			);

		// 選択中フォルダのフルパス/IDは長いので、狭い画面でも折り返して全体が見えるように
		folderSetting.descEl.addClass("gdsync-folder-desc");

		new Setting(containerEl)
			.setName(t.mirrorBase)
			.setDesc(t.mirrorBaseDesc)
			.addText((text) =>
				text.setValue(s.baseFolder).onChange(async (v) => {
					if (!this.plugin.engine.canChangeTarget()) { new Notice(t.targetLocked); return; }
					if (!validPath(v.trim())) return;
					s.baseFolder = v.trim() || "GDrive";
					this.plugin.index.data.mountBase = s.mountMode === "vaultRoot" ? "" : s.baseFolder;
					this.plugin.index.markDirty();
					await this.plugin.index.flush();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName(t.mountMode).setDesc(t.mountModeDesc)
			.addDropdown((drop) => drop.addOption("subfolder", t.mountSubfolder)
				.addOption("vaultRoot", t.mountRoot).setValue(s.mountMode)
				.onChange(async (value) => {
					if (!this.plugin.engine.canChangeTarget()) { new Notice(t.targetLocked); drop.setValue(s.mountMode); return; }
					s.mountMode = value === "vaultRoot" ? "vaultRoot" : "subfolder";
					this.plugin.index.data.mountBase = this.plugin.engine.basePath();
					this.plugin.index.markDirty();
					await this.plugin.index.flush();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t.excludePatterns)
			.setDesc(t.excludePatternsDesc)
			.addTextArea((ta) => {
				ta.setValue(s.excludePatterns).onChange(async (v) => {
					s.excludePatterns = v;
					await this.plugin.saveSettings();
				});
				ta.inputEl.rows = 4;
			});

		new Setting(containerEl)
			.setName(t.eagerSyncPatterns)
			.setDesc(t.eagerSyncPatternsDesc)
			.addTextArea((ta) => {
				ta.setValue(s.eagerSyncPatterns).onChange(async (v) => {
					s.eagerSyncPatterns = v;
					await this.plugin.saveSettings();
					// 追加された指定を既存スタブに即反映する
					void this.plugin.engine.hydrateEagerFiles();
				});
				ta.inputEl.rows = 3;
			});

		new Setting(containerEl)
			.setName(t.buildIndex)
			.setDesc(t.buildIndexDesc)
			.addButton((btn) =>
				btn
					.setButtonText(t.btnRunFullScan)
					.setCta()
					.onClick(() => void this.plugin.engine.fullScan())
			);

		// ---------- 動作設定 ----------
		new Setting(containerEl).setName(t.headingBehavior).setHeading();

		new Setting(containerEl)
			.setName(t.maxFileSize)
			.setDesc(t.maxFileSizeDesc)
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
			.setName(t.uploadDebounce)
			.setDesc(t.uploadDebounceDesc)
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
			.setName(t.freshness)
			.setDesc(t.freshnessDesc)
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
			.setName(t.cacheRetention)
			.setDesc(t.cacheRetentionDesc)
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
			.setName(t.cacheMaxCount)
			.setDesc(t.cacheMaxCountDesc)
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
			.setName(t.enableOnDesktop)
			.setDesc(t.enableOnDesktopDesc)
			.addToggle((toggle) =>
				toggle.setValue(s.enableOnDesktop).onChange(async (v) => {
					s.enableOnDesktop = v;
					await this.plugin.saveSettings();
				})
			);

		// ---------- メンテナンス ----------
		new Setting(containerEl).setName(t.headingMaintenance).setHeading();
		new Setting(containerEl).setName(t.diagnoseLinks).addButton((button) =>
			button.setButtonText(t.btnRun).onClick(async () => {
				const issues = await this.plugin.engine.diagnoseAttachments();
				new SyncReportModal(this.app, t.diagnoseLinks, issues.length ? issues : [t.linksHealthy]).open();
			}));
		new Setting(containerEl).setName(t.migrateRoot).setDesc(t.migrateDesc).addButton((button) =>
			button.setButtonText(t.btnRun).onClick(() => {
				new SyncReportModal(this.app, t.migrateConfirm, [t.migrateConfirmDesc], async () => {
					const warnings = await this.plugin.engine.migrateToRoot();
					new SyncReportModal(this.app, t.migrationDone, warnings.length ? warnings : [t.linksHealthy]).open();
					this.display();
				}).open();
			}));

		// 前回の手動同期の結果（メモリ内のみ。詳細は最後の1〜数件を表示）
		const stat = this.plugin.status.getSnapshot();
		const lastAt = stat.lastSyncAt
			? moment(stat.lastSyncAt).format("YYYY-MM-DD HH:mm")
			: t.syncNever;
		new Setting(containerEl)
			.setName(t.syncStateLabel(lastAt))
			.setDesc(stat.lastSummary ?? t.syncNoSummary);

		new Setting(containerEl)
			.setName(t.settingsSyncNow)
			.setDesc(t.settingsSyncNowDesc)
			.addButton((btn) =>
				btn
					.setButtonText(t.btnSync)
					.onClick(() =>
						void this.plugin.engine.syncNow({ awaitUploads: true, notify: true })
					)
			);

		new Setting(containerEl)
			.setName(t.cleanCache)
			.setDesc(t.cleanCacheDesc)
			.addButton((btn) =>
				btn.setButtonText(t.btnRun).onClick(async () => {
					await this.plugin.engine.evictCache();
					new Notice(t.cacheCleanupDone);
				})
			);

		new Setting(containerEl)
			.setName(t.resetIndex)
			.setDesc(t.resetIndexDesc)
			.addButton((btn) =>
				btn.setWarning().setButtonText(t.btnReset).onClick(async () => {
					const dirty = this.plugin.index.dirtyPaths().length;
					if (dirty > 0 || this.plugin.engine.isBusy() || this.plugin.index.data.pendingOps.length || this.plugin.index.data.incoming?.length) {
						new Notice(t.unsentEdits(dirty));
						return;
					}
					// Keep stub identities and baselines; forgetting them makes a zero-byte
					// placeholder indistinguishable from a real empty local file.
					this.plugin.index.data.changesPageToken = null;
					this.plugin.index.data.lastFullScan = 0;
					this.plugin.index.markDirty();
					await this.plugin.index.flush();
					new Notice(t.indexReset);
				})
			);
	}
}
