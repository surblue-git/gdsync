import { Notice, Platform, Plugin } from "obsidian";
import { t } from "./i18n";

export type SyncPhase = "idle" | "syncing" | "uploading" | "downloading";

export interface SyncSnapshot {
	phase: SyncPhase;
	/** 現在処理中のファイル名（natがあれば最後に触ったもの）。なければ null */
	currentFile: string | null;
	uploaded: number;
	uploadedFailed: number;
	downloaded: number;
	remoteAdded: number;
	remoteUpdated: number;
	remoteRemoved: number;
	opsFlushed: number;
	lastSyncAt: number;
	lastSuccessAt?: number;
	lastSummary: string | null;
}

/**
 * ステータス表示 + 軽量な活動モニタ。
 * デスクトップはステータスバーに「いま何を同期しているか」（ファイル名付き）を
 * 表示し、モバイルは長時間処理のみ Notice で進捗を更新する。
 * 手動同期の開始〜完了は beginSync()/endSync() で計測し、完了サマリーを組み立てる。
 */
export class StatusDisplay {
	private el: HTMLElement | null = null;
	private progressNotice: Notice | null = null;
	private snap: SyncSnapshot = {
		phase: "idle",
		currentFile: null,
		uploaded: 0,
		uploadedFailed: 0,
		downloaded: 0,
		remoteAdded: 0,
		remoteUpdated: 0,
		remoteRemoved: 0,
		opsFlushed: 0,
		lastSyncAt: 0,
		lastSummary: null,
	};
	/** アップロード実行中のファイル名（並列アップロード対応） */
	private uploading = new Map<string, string>();
	private downloading = new Map<string, string>();
	private nextTransfer = 0;
	private pendingText: string | null = null;
	private get activeDownload(): string | null { return this.downloading.values().next().value ?? null; }
	/** beginSync()〜endSync() の間に集計する（自動同期は集計しない） */
	private cycleRunning = false;
	private offline = false;

	constructor(plugin: Plugin) {
		if (!Platform.isMobile) {
			this.el = plugin.addStatusBarItem();
			this.set("");
		}
	}

	// ---- 外部参照用（設定タブの状態表示など） ----

	getSnapshot(): SyncSnapshot {
		this.snap.currentFile =
			this.activeDownload ?? (this.uploading.size > 0 ? this.uploading.values().next().value! : null);
		this.snap.phase =
			this.uploading.size > 0
				? "uploading"
				: this.activeDownload
					? "downloading"
					: this.cycleRunning
						? "syncing"
						: "idle";
		return { ...this.snap };
	}

	// ---- 同期サイクル（手動同期の開始〜完了を集計） ----

	beginSync(): void {
		this.offline = false;
		this.pendingText = null;

		this.cycleRunning = true;
		this.snap = {
			phase: "syncing",
			currentFile: null,
			uploaded: 0,
			uploadedFailed: 0,
			downloaded: 0,
			remoteAdded: 0,
			remoteUpdated: 0,
			remoteRemoved: 0,
			opsFlushed: 0,
			lastSyncAt: this.snap.lastSyncAt,
			lastSuccessAt: this.snap.lastSuccessAt,
			lastSummary: this.snap.lastSummary,
		};
		this.render();
	}

	/** サイクル終了。人間可読の要約（1件もなければ null）を返す。戻り値は呼び出し側で Notice に使う */
	endSync(result?: { pending: number; ops: number; incoming: number; failed: boolean }): string | null {
		this.cycleRunning = false;

		this.snap.lastSyncAt = Date.now();
		this.snap.currentFile = null;
		this.snap.phase = "idle";
		const parts: string[] = [];
		const s = this.snap;
		if (s.uploaded || s.uploadedFailed) {
			parts.push(t.syncClientUploads(s.uploaded, s.uploadedFailed));
		}
		if (s.downloaded) parts.push(t.syncClientDownloads(s.downloaded));
		if (s.remoteAdded || s.remoteUpdated || s.remoteRemoved) {
			parts.push(t.syncClientRemote(s.remoteAdded, s.remoteUpdated, s.remoteRemoved));
		}
		if (s.opsFlushed) parts.push(t.syncClientOps(s.opsFlushed));
		const complete = !result || !(result.pending || result.ops || result.incoming || result.failed);
		if (complete) this.snap.lastSuccessAt = Date.now();
		const summary = !complete && result
			? ((result.pending || result.ops || result.incoming) ? t.syncPending(result.pending, result.ops, result.incoming) : t.syncIncomplete)
			: parts.length > 0 ? t.syncFinished(parts.join(" / ")) : null;
		this.snap.lastSummary = summary ? `GDSync: ${summary}` : null;
		this.pendingText = complete ? null : summary;
		this.render();
		return summary;
	}

	// ---- 活動報告（表示と集計を兼ねる） ----

	uploadStarting(fileName: string): string {
		const id = String(++this.nextTransfer);
		this.uploading.set(id, fileName);
		this.render();
		return id;
	}

	uploadFinished(id: string, ok: boolean): void {
		this.uploading.delete(id);
		if (ok) this.offline = false;
		if (this.cycleRunning) {
			if (ok) this.snap.uploaded++;
			else this.snap.uploadedFailed++;
		}
		this.render();
	}

	downloadStarting(fileName: string): string {
		const id = String(++this.nextTransfer);
		this.downloading.set(id, fileName);
		this.render();
		return id;
	}

	downloadFinished(id: string, ok: boolean): void {
		this.downloading.delete(id);
		if (ok) this.offline = false;
		if (this.cycleRunning && ok) this.snap.downloaded++;
		this.render();
	}

	/** リモート差分1件の種別（changes API の適用結果） */
	remoteChange(kind: "added" | "updated" | "removed"): void {
		if (!this.cycleRunning) return;
		if (kind === "added") this.snap.remoteAdded++;
		else if (kind === "updated") this.snap.remoteUpdated++;
		else this.snap.remoteRemoved++;
	}

	/** 構造変更（rename/trash/フォルダ作成）1件 */
	opFlushed(): void {
		if (this.cycleRunning) this.snap.opsFlushed++;
	}

	setOffline(): void {
		this.offline = true;
		this.render();
	}

	// ---- 従来の表示API（フルスキャン等が使用） ----

	set(text: string): void {
		if (this.el) this.el.setText(text ? `GDSync: ${text}` : "");
	}

	/** 長時間処理の進捗。モバイルでは Notice を使い回して更新 */
	progress(text: string): void {
		this.set(text);
		if (Platform.isMobile) {
			if (!this.progressNotice) {
				this.progressNotice = new Notice(`GDSync: ${text}`, 0);
			} else {
				this.progressNotice.setMessage(`GDSync: ${text}`);
			}
		}
	}

	endProgress(finalText?: string): void {
		this.set("");
		if (this.progressNotice) {
			this.progressNotice.hide();
			this.progressNotice = null;
		}
		if (finalText) new Notice(`GDSync: ${finalText}`);
	}

	// ---- 表示合成 ----

	private render(): void {
		if (this.uploading.size > 0) {
			if (this.uploading.size === 1) {
				this.set(t.uploadingStatus(this.uploading.values().next().value!));
			} else {
				this.set(t.uploadingStatusN(this.uploading.size, this.uploading.values().next().value!));
			}
			return;
		}
		if (this.activeDownload) {
			this.set(t.downloading(this.activeDownload));
			return;
		}
		if (this.cycleRunning) {
			this.set(t.syncing);
			return;
		}
		this.set(this.pendingText ?? (this.offline ? t.offlineUploadPending : ""));
	}
}
