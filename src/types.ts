export interface DriveTokens {
	accessToken: string;
	refreshToken: string;
	/** epoch ms。この時刻を過ぎたらリフレッシュする（発行時に60秒前倒しで記録） */
	expiresAt: number;
}

/** 外部ブラウザ往復中に Obsidian が kill されても認証を継続できるよう data.json に一時保存する */
export interface PendingAuth {
	state: string;
	codeVerifier: string;
	createdAt: number;
}

export interface GdsyncSettings {
	clientId: string;
	clientSecret: string;
	/** Cloudflare Pages 等にデプロイした静的リダイレクトページのURL */
	redirectUri: string;
	/** ミラー対象の Drive フォルダID */
	rootFolderId: string;
	rootFolderName: string;
	/** Vault 内のミラー先ベースフォルダ */
	baseFolder: string;
	mountMode: "subfolder" | "vaultRoot";
	/** これを超えるファイルはハイドレートしない (MB) */
	maxFileSizeMB: number;
	/** この日数アクセスがないキャッシュは脱ハイドレート */
	cacheMaxAgeDays: number;
	/** ハイドレート済みファイルの上限数（超過分は古い順に脱ハイドレート） */
	cacheMaxCount: number;
	/** 除外パターン（1行1パターン、パスの部分一致） */
	excludePatterns: string;
	/**
	 * 常時フル同期パターン（1行1パターン、パスの部分一致）。
	 * 一致するファイルはスタブで放置せず、スキャン/変更検出時に即座に実体化する。
	 * 他プラグインの設定ファイル等、file-open を経ずにプログラムから読むファイル向け。
	 */
	eagerSyncPatterns: string;
	/** デスクトップでも同期機能を有効にする（既定はモバイルのみ） */
	enableOnDesktop: boolean;
	uploadDebounceSec: number;
	/** ハイドレート済みファイルの鮮度再確認間隔（分） */
	freshnessTtlMin: number;
	tokens: DriveTokens | null;
	pendingAuth: PendingAuth | null;
}

export const DEFAULT_SETTINGS: GdsyncSettings = {
	clientId: "",
	clientSecret: "",
	redirectUri: "",
	rootFolderId: "",
	rootFolderName: "",
	baseFolder: "GDrive",
	mountMode: "subfolder",
	maxFileSizeMB: 20,
	cacheMaxAgeDays: 14,
	cacheMaxCount: 200,
	excludePatterns: ".obsidian\n.trash",
	eagerSyncPatterns: "",
	enableOnDesktop: false,
	uploadDebounceSec: 4,
	freshnessTtlMin: 5,
	tokens: null,
	pendingAuth: null,
};

/**
 * 端末間で共通にしてよい設定キー。接続コードに同梱して新しい端末へ引き継ぐ。
 * 意図的に含めないもの:
 * - clientId / clientSecret / tokens / pendingAuth … 接続コード本体が運ぶ
 * - enableOnDesktop … 端末の役割で決まる（母艦で勝手に有効化されると事故る）
 * - cacheMaxAgeDays / cacheMaxCount … 端末の空き容量に依存する
 * - redirectUri … モバイル単体認証用で、端末ごとに要否が違う
 * - mountMode / baseFolder … 端末固有の配置。稼働中の同期先をコードで変更しない
 */
export const SHARED_SETTING_KEYS = [
	"rootFolderId",
	"rootFolderName",
	"excludePatterns",
	"eagerSyncPatterns",
	"maxFileSizeMB",
	"uploadDebounceSec",
	"freshnessTtlMin",
] as const;

export type SharedSettings = Pick<GdsyncSettings, (typeof SHARED_SETTING_KEYS)[number]>;

/** 前後の空白が意味を持たないキー（複数行のパターン欄は trim しない） */
const TRIMMED_SHARED_KEYS: ReadonlySet<string> = new Set([
	"rootFolderId",
	"rootFolderName",
]);

export function pickSharedSettings(s: GdsyncSettings): SharedSettings {
	const out = {} as Record<string, unknown>;
	for (const key of SHARED_SETTING_KEYS) out[key] = s[key];
	return out as SharedSettings;
}

/**
 * 受け取った共有設定を検証しつつ適用する。
 * 型が合わない値・範囲外の値は黙って捨て、既存の設定を維持する
 * （壊れたコードで同期が止まるより、その項目だけ引き継がれない方が安全）。
 * @returns 実際に適用したキー数
 */
export function applySharedSettings(target: GdsyncSettings, incoming: unknown): number {
	if (!incoming || typeof incoming !== "object") return 0;
	const src = incoming as Record<string, unknown>;
	const patch: Record<string, unknown> = {};
	for (const key of SHARED_SETTING_KEYS) {
		if ((key === "rootFolderId" || key === "rootFolderName") && target.rootFolderId) continue;
		let v = src[key];
		if (typeof v !== typeof DEFAULT_SETTINGS[key]) continue;
		if (typeof v === "number") {
			// UI 側の入力検証と同じ範囲。freshnessTtlMin だけ 0（毎回確認）を許す
			const min = key === "freshnessTtlMin" ? 0 : 1;
			if (!Number.isFinite(v) || v < min) continue;
		}
		if (typeof v === "string" && TRIMMED_SHARED_KEYS.has(key)) v = v.trim();
		patch[key] = v;
	}
	Object.assign(target, patch);
	return Object.keys(patch).length;
}

export interface IndexEntry {
	/** '' はローカルで新規作成され、まだ Drive に存在しないファイル */
	fileId: string;
	remoteMd5: string | null;
	/** epoch ms */
	remoteModifiedTime: number;
	remoteSize: number;
	/** 実体コンテンツを保持しているか（false = 0バイトスタブ） */
	hydrated: boolean;
	/** ローカル編集がまだアップロードされていない */
	dirty: boolean;
	/** Incremented on local edits; an upload only acknowledges its captured revision. */
	revision?: number;
	localMtime?: number;
	localSize?: number;
	/** MD5 of the local bytes at the last completed reconciliation. */
	localMd5?: string;
	/** Explicit state prevents an unresolved conflict from being uploaded automatically. */
	syncState?: "clean" | "localChanged" | "conflict" | "unknown";
	/** A local recovery artifact that must never be uploaded automatically. */
	recoveryOnly?: boolean;
	/** Persisted before creating a remote file, for idempotent retry. */
	creationId?: string;
	conflictCopy?: { rel: string; creationId: string; revision: number; remoteRel?: string };
	/** キャッシュ追い出し判定用 */
	lastAccess: number;
	/** Last MD5 known to be common to both local bytes and the Drive file. */
	hydratedMd5?: string;
	/** 最後に鮮度確認した時刻 */
	lastFreshCheck?: number;
	/** サイズ上限超過でハイドレート対象外 */
	tooLarge?: boolean;
}

export type PendingOp =
	| {
		kind: "renameRemote";
		fileId: string;
		newName: string;
		/** ベースフォルダ相対の移動先親フォルダパス（'' はルート） */
		newParentPath: string;
	}
	| { kind: "trashRemote"; fileId: string };

export interface GdsyncIndex {
	version: 2;
	rootFolderId: string;
	changesPageToken: string | null;
	lastFullScan: number;
	mountBase?: string;
	/** Durable changes received but not yet applied. */
	incoming?: DriveChange[];
	folderCreationIds?: Record<string, string>;
	/** key = ベースフォルダ相対の normalizePath 済みパス */
	files: Record<string, IndexEntry>;
	/** path → Drive folderId（'' はローカルのみでまだ Drive に未作成） */
	folders: Record<string, string>;
	/** オフライン時に積まれた構造変更（rename/trash）。アップロードは dirty フラグから導出 */
	pendingOps: PendingOp[];
}

export function emptyIndex(): GdsyncIndex {
	return {
		version: 2,
		rootFolderId: "",
		changesPageToken: null,
		lastFullScan: 0,
		files: {},
		folders: {},
		pendingOps: [],
	};
}

export interface DriveItemMeta {
	gdsyncRecovered?: boolean;
	id: string;
	name: string;
	mimeType: string;
	parents?: string[];
	md5Checksum?: string;
	modifiedTime?: string;
	size?: string;
	trashed?: boolean;
	shortcutDetails?: unknown;
}

export interface DriveChange {
	fileId: string;
	removed: boolean;
	file?: DriveItemMeta;
}
