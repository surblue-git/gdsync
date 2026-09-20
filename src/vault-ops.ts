import { App, normalizePath, TAbstractFile, TFile, TFolder } from "obsidian";

/** vault.process で扱うテキスト拡張子。それ以外はバイナリとして modifyBinary */
const TEXT_EXTS = new Set([
	"md", "txt", "json", "csv", "canvas", "yaml", "yml",
	"html", "css", "js", "ts", "org", "tex", "xml",
]);

export function isTextExt(ext: string): boolean {
	return TEXT_EXTS.has(ext.toLowerCase());
}

/** 「既に存在する」系のエラーか（大文字小文字を区別しないFS対策） */
export function isAlreadyExistsError(e: unknown): boolean {
	const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
	return msg.includes("already exist") || msg.includes("exists");
}

/**
 * 自プラグインの Vault 操作が発火させるイベントを識別するための抑制セット。
 * 操作直前に add し、イベントハンドラ先頭で consume する。
 * カウント方式 + TTL（リーク保険）。
 */
export class Suppressor {
	private map = new Map<string, number[]>();
	private static TTL_MS = 10_000;
	clear(): void { this.map.clear(); }

	add(path: string): void {
		const list = this.map.get(path) || [];
		list.push(Date.now());
		this.map.set(path, list);
	}

	consume(path: string): boolean {
		const list = this.map.get(path);
		if (!list) return false;
		const now = Date.now();
		// 期限切れを除去
		while (list.length && now - list[0] > Suppressor.TTL_MS) list.shift();
		if (!list.length) {
			this.map.delete(path);
			return false;
		}
		list.shift();
		if (!list.length) this.map.delete(path);
		return true;
	}
}

/** Vault 操作ラッパー。Drive のことは知らない */
export class VaultOps {
	constructor(private app: App, public suppressor: Suppressor) { }

	getFile(path: string): TFile | null {
		const af = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return af instanceof TFile ? af : null;
	}

	getFolder(path: string): TFolder | null {
		const af = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return af instanceof TFolder ? af : null;
	}

	exists(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
	}

	/** フォルダを再帰的に作成（存在すればスキップ、イベント抑制付き） */
	async ensureFolder(path: string): Promise<void> {
		const norm = normalizePath(path);
		if (!norm || norm === "/") return;
		const parts = norm.split("/");
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(cur);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`Folder path is occupied by a file: ${cur}`);
			this.suppressor.add(cur);
			try {
				await this.app.vault.createFolder(cur);
			} catch (e) {
				// 「既に存在する」は無視する。Obsidian の索引は大文字小文字を区別する一方、
				// Android 等のファイルシステムは区別しないため、索引上は未存在でも
				// createFolder が "Folder already exists" を投げることがある。
				this.suppressor.consume(cur);
				if (this.app.vault.getAbstractFileByPath(cur) instanceof TFolder) continue;
				throw e;
			}
		}
	}

	/** 0バイトのスタブファイルを作成。既に存在すれば何もしない */
	async createStub(path: string): Promise<void> {
		const norm = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(norm);
		if (existing instanceof TFile) return;
		if (existing) throw new Error(`File path is occupied by a folder: ${norm}`);
		const parent = norm.includes("/")
			? norm.slice(0, norm.lastIndexOf("/"))
			: "";
		if (parent) await this.ensureFolder(parent);
		this.suppressor.add(norm);
		const ext = norm.slice(norm.lastIndexOf(".") + 1);
		try {
			if (isTextExt(ext)) {
				await this.app.vault.create(norm, "");
			} else {
				await this.app.vault.createBinary(norm, new ArrayBuffer(0));
			}
		} catch (e) {
			// 大文字小文字を区別しないFS 等で「既に存在する」場合はスタブ済みとみなす
			this.suppressor.consume(norm);
			if (this.app.vault.getAbstractFileByPath(norm) instanceof TFile) return;
			throw e;
		}
	}

	/** ダウンロード内容をファイルへ書き込む（エディタ表示中でも安全に） */
	async writeContent(file: TFile, data: ArrayBuffer, guard: () => boolean = () => true): Promise<boolean> {
		if (!guard()) return false;
		let written = true;
		if (isTextExt(file.extension)) {
			const text = new TextDecoder("utf-8").decode(data);
			await this.app.vault.process(file, (current) => {
				if (!guard()) { written = false; return current; }
				this.suppressor.add(file.path);
				return text;
			});
		} else {
			this.suppressor.add(file.path);
			await this.app.vault.modifyBinary(file, data);
		}
		return written;
	}

	/** キャッシュ追い出し: 内容を空に戻す */
	async truncateToStub(file: TFile, guard: () => boolean = () => true): Promise<boolean> {
		return this.writeContent(file, new ArrayBuffer(0), guard);
	}

	/** 新しいファイルを内容付きで作成（競合コピー用） */
	async createWithContent(path: string, data: ArrayBuffer): Promise<TFile> {
		const norm = normalizePath(path);
		const parent = norm.includes("/")
			? norm.slice(0, norm.lastIndexOf("/"))
			: "";
		if (parent) await this.ensureFolder(parent);
		this.suppressor.add(norm);
		return await this.app.vault.createBinary(norm, data);
	}

	/** ローカル削除（ユーザーのゴミ箱設定に従う、イベント抑制付き） */
	async deleteLocal(af: TAbstractFile): Promise<void> {
		this.suppressor.add(af.path);
		await this.app.fileManager.trashFile(af);
	}

	/** リモート由来のリネームをローカルへ反映 */
	async renameLocal(af: TAbstractFile, newPath: string): Promise<void> {
		const norm = normalizePath(newPath);
		const parent = norm.includes("/")
			? norm.slice(0, norm.lastIndexOf("/"))
			: "";
		if (parent) await this.ensureFolder(parent);
		this.suppressor.add(norm);
		await this.app.vault.rename(af, norm);
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		return await this.app.vault.readBinary(file);
	}
}

/** Drive のファイル名を Vault で使える名前に変換（禁止文字置換 + 制御文字除去） */
export function sanitizeName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/[. ]+$/, "")
		.trim() || "_";
}
