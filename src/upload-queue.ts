interface QueueItem {
	timer: number;
	failCount: number;
}

const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * per-file デバウンス付きアップロードキュー。
 * 失敗（オフライン等）は指数バックオフで再スケジュールする。
 * 永続化はしない — dirty フラグがインデックスに残るため、
 * 再起動時は dirty エントリから再投入される。
 */
export class UploadQueue {
	private items = new Map<string, QueueItem>();

	constructor(
		private run: (path: string) => Promise<boolean>,
		private baseDelayMs: () => number
	) {}

	/** 編集のたびに呼ぶ。既存タイマーはリセット（デバウンス） */
	schedule(path: string, immediate = false): void {
		const existing = this.items.get(path);
		if (existing) window.clearTimeout(existing.timer);
		const failCount = existing?.failCount ?? 0;
		const delay = immediate ? 0 : this.delayFor(failCount);
		const timer = window.setTimeout(() => void this.execute(path), delay);
		this.items.set(path, { timer, failCount });
	}

	/** rename でキー変更 */
	rename(oldPath: string, newPath: string): void {
		const item = this.items.get(oldPath);
		if (!item) return;
		this.items.delete(oldPath);
		window.clearTimeout(item.timer);
		this.schedule(newPath);
	}

	cancel(path: string): void {
		const item = this.items.get(path);
		if (item) {
			window.clearTimeout(item.timer);
			this.items.delete(path);
		}
	}

	has(path: string): boolean {
		return this.items.has(path);
	}

	/** 手動同期: 待機中のものを全部すぐ実行 */
	flushAll(): void {
		for (const path of Array.from(this.items.keys())) {
			this.schedule(path, true);
		}
	}

	clear(): void {
		for (const item of this.items.values()) window.clearTimeout(item.timer);
		this.items.clear();
	}

	private delayFor(failCount: number): number {
		const base = this.baseDelayMs();
		if (failCount === 0) return base;
		return Math.min(MAX_BACKOFF_MS, base * Math.pow(2, failCount));
	}

	private async execute(path: string): Promise<void> {
		const item = this.items.get(path);
		if (!item) return;
		let ok = false;
		try {
			ok = await this.run(path);
		} catch (e) {
			console.error("gdsync: upload failed", path, e);
			ok = false;
		}
		const cur = this.items.get(path);
		// 実行中に再スケジュールされていたら触らない
		if (cur !== item) return;
		if (ok) {
			this.items.delete(path);
		} else {
			// リトライ（バックオフ）
			const failCount = item.failCount + 1;
			const timer = window.setTimeout(
				() => void this.execute(path),
				this.delayFor(failCount)
			);
			this.items.set(path, { timer, failCount });
		}
	}
}
