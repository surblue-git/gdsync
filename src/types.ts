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
	/** これを超えるファイルはハイドレートしない (MB) */
	maxFileSizeMB: number;
	/** この日数アクセスがないキャッシュは脱ハイドレート */
	cacheMaxAgeDays: number;
	/** ハイドレート済みファイルの上限数（超過分は古い順に脱ハイドレート） */
	cacheMaxCount: number;
	/** 除外パターン（1行1パターン、パスの部分一致） */
	excludePatterns: string;
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
	maxFileSizeMB: 20,
	cacheMaxAgeDays: 14,
	cacheMaxCount: 200,
	excludePatterns: ".obsidian\n.trash",
	enableOnDesktop: false,
	uploadDebounceSec: 4,
	freshnessTtlMin: 5,
	tokens: null,
	pendingAuth: null,
};

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
	/** キャッシュ追い出し判定用 */
	lastAccess: number;
	/** ハイドレートした時点のリモートmd5 */
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
	version: 1;
	rootFolderId: string;
	changesPageToken: string | null;
	lastFullScan: number;
	/** key = ベースフォルダ相対の normalizePath 済みパス */
	files: Record<string, IndexEntry>;
	/** path → Drive folderId（'' はローカルのみでまだ Drive に未作成） */
	folders: Record<string, string>;
	/** オフライン時に積まれた構造変更（rename/trash）。アップロードは dirty フラグから導出 */
	pendingOps: PendingOp[];
}

export function emptyIndex(): GdsyncIndex {
	return {
		version: 1,
		rootFolderId: "",
		changesPageToken: null,
		lastFullScan: 0,
		files: {},
		folders: {},
		pendingOps: [],
	};
}

export interface DriveItemMeta {
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
