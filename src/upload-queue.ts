interface QueueItem {
	timer: number; failCount: number; done: Promise<void>; settle: () => void;
}
/** Drains follow attempt objects, never historical completion of a path. */
export class UploadQueue {
	private items = new Map<string, QueueItem>();
	private active = new Set<Promise<void>>();
	private paused = false;
	private stopped = false;
	private activePaths = new Set<string>();
	private ready = new Map<string, QueueItem>();
	constructor(private run: (path: string) => Promise<boolean>, private baseDelayMs: () => number) { }
	schedule(path: string, immediate = false): void {
		if (this.stopped) return;
		const previous = this.items.get(path);
		if (previous) window.clearTimeout(previous.timer);
		let settle!: () => void;
		const done = new Promise<void>((resolve) => { settle = resolve; });
		const item: QueueItem = { timer: 0, failCount: previous?.failCount ?? 0, done, settle };
		if (previous) void done.then(previous.settle);
		this.items.set(path, item);
		if (!this.paused) this.arm(path, item, immediate ? 0 : this.delay(item.failCount));
	}
	private delay(n: number): number { return Math.min(300000, this.baseDelayMs() * Math.pow(2, n)); }
	private arm(path: string, item: QueueItem, delay: number): void {
		item.timer = window.setTimeout(() => {
			if (this.items.get(path) !== item) return;
			this.ready.set(path, item);
			this.pump();
		}, delay);
	}
	private pump(): void {
		if (this.paused || this.stopped) return;
		for (const [path, item] of this.ready) {
			if (this.active.size >= 3) break;
			if (this.activePaths.has(path)) continue;
			this.ready.delete(path);
			if (this.items.get(path) !== item) continue;
			this.activePaths.add(path);
			const task = this.execute(path, item);
			this.active.add(task);
			void task.finally(() => { this.active.delete(task); this.activePaths.delete(path); this.pump(); });
		}
	}
	async pause(): Promise<void> {
		this.paused = true;
		this.ready.clear();
		for (const item of this.items.values()) window.clearTimeout(item.timer);
		await Promise.all(Array.from(this.active));
	}
	resume(): void {
		if (this.stopped || !this.paused) return;
		this.paused = false;
		for (const [path, item] of this.items) this.arm(path, item, this.delay(item.failCount));
	}
	rename(oldPath: string, newPath: string): void {
		if (!this.items.has(oldPath)) return;
		this.cancel(oldPath); this.schedule(newPath);
	}
	cancel(path: string): void {
		const item = this.items.get(path);
		if (!item) return;
		window.clearTimeout(item.timer); this.items.delete(path); item.settle();
		this.ready.delete(path);
	}
	has(path: string): boolean { return this.items.has(path); }
	flushAll(): void { for (const path of this.items.keys()) this.schedule(path, true); }
	clear(): void { this.stopped = true; for (const path of this.items.keys()) this.cancel(path); }
	async drainPending(): Promise<void> {
		await Promise.all([...Array.from(this.items.values(), (i) => i.done), ...this.active]);
	}
	async runNow(paths: string[]): Promise<void> {
		for (const path of paths) this.schedule(path, true);
		await Promise.all(paths.map((path) => this.items.get(path)?.done));
	}
	private async execute(path: string, item: QueueItem): Promise<void> {
		if (this.paused || this.stopped || this.items.get(path) !== item) return;
		let ok = false;
		try { ok = await this.run(path); } catch (e) { console.error('gdsync: upload failed', path, e); }
		if (this.items.get(path) === item) {
			this.items.delete(path);
			if (!ok && !this.stopped) {
				this.schedule(path);
				const retry = this.items.get(path)!;
				retry.failCount = item.failCount + 1;
				window.clearTimeout(retry.timer);
				if (!this.paused) this.arm(path, retry, this.delay(retry.failCount));
			}
		}
		item.settle();
	}
}
