import { moment } from "obsidian";

/**
 * 軽量な i18n。Obsidian の表示言語を見て英語 / 日本語を切り替える。
 * 言語変更には Obsidian の再起動が要るため、読み込み時に一度だけ判定すれば十分。
 *
 * 表示言語の取得元は環境で異なる（特にモバイルでは localStorage の "language" が
 * 空のことがある）ため、複数ソースを順に見る:
 *   1. localStorage "language" … ユーザーが明示設定した Obsidian の表示言語
 *   2. moment.locale()          … Obsidian が表示言語に合わせて設定する日付ロケール
 *   3. navigator.language       … 端末の言語（最後の砦）
 */
function isJa(v: string | null | undefined): boolean {
	return !!v && v.toLowerCase().startsWith("ja");
}

function detectLang(): "ja" | "en" {
	// 1. 明示設定があればそれを尊重（ja 以外なら英語扱い）
	try {
		const l = window.localStorage.getItem("language");
		if (l) return isJa(l) ? "ja" : "en";
	} catch (e) {
		/* localStorage 不可 */
	}
	// 2. 明示設定なし（英語既定 or モバイルの空）→ Obsidian のロケール
	try {
		if (isJa(moment.locale())) return "ja";
	} catch (e) {
		/* moment 不可 */
	}
	// 3. 端末の言語
	try {
		if (isJa(navigator?.language)) return "ja";
	} catch (e) {
		/* navigator 不可 */
	}
	return "en";
}

const en = {
	indexRecovered: "GDSync: Recovered the sync index from a saved checkpoint. Local files will be reconciled before syncing.",
	indexRecoveryFailed: "GDSync: The sync index could not be recovered. Sync is stopped to protect local files.",

	migrationResume: "GDSync: An unfinished migration was found. Sync is paused; resume migration in settings.",
	migrationPendingOps: "Sync pending structure changes and incoming changes before migrating.",
	uncheckedStub: "Not checked (content not downloaded)",
	linkMissing: "Target not found",
	linkOutside: "Outside sync scope",
	linkPending: "Upload pending",
	linksHealthy: "No attachment issues found in downloaded notes.",
	migrateConfirm: "Migrate local files to vault root",
	migrateConfirmDesc: "All non-excluded files in this vault will become sync targets, including files outside the old mirror. Use a dedicated vault. Local content is backed up in the plugin folder. Unresolved links are reported after migration. Close other editing sessions first.",

	syncNotReady: "GDSync: Sync is inactive, not initialized, or migration is in progress.",
	targetChanged: "GDSync: The sync target changed. Restore the previous target or use migration.",
	syncPending: (n: number, ops: number, incoming: number) => `Drive sync pending: ${n} file(s), ${ops} structure operation(s), ${incoming} incoming change(s).`,
	syncIncomplete: "Drive sync incomplete. Check pending changes and errors.",
	mountMode: "Sync location",
	mountModeDesc: "Vault root gives every device the same paths. Existing mirrors must use migration.",
	mountRoot: "Vault root (dedicated vault)",
	mountSubfolder: "Subfolder (existing layout)",
	migrateRoot: "Migrate to vault root / resume migration",
	migrateDesc: "Checks collisions, backs up local contents, and repairs resolved Markdown links. Keep other devices closed during migration.",
	migrationDone: "Local migration finished. Sync to send repaired notes to Drive.",
	diagnoseLinks: "Check attachment links",
	targetLocked: "This target already contains indexed files. Use migration or a new dedicated vault.",

	// ---- auth ----
	setCredsFirst: "GDSync: Set the client ID and client secret first.",
	mobileNoRedirect:
		"GDSync: On mobile, either paste a connection code created on desktop (settings → Connection code), or set a redirect URI for browser sign-in.",
	authCancelled: (error: string) =>
		`GDSync: Authentication was cancelled or failed (${error}).`,
	stateMismatch:
		"GDSync: Authentication state mismatch. Please start authentication again.",
	portInUse: (port: number) =>
		`GDSync: Could not open local port ${port} for sign-in (is another app using it?). Close the conflicting app, or use the redirect-page sign-in instead.`,
	authExpired: "GDSync: The authentication request has expired. Please start again.",
	missingCode: "GDSync: Missing authorization code.",
	noRefreshToken:
		"No refresh_token was returned. Check that prompt=consent is effective on the Google Cloud side.",
	authSucceeded: "GDSync: Google authentication succeeded.",
	tokenExchangeFailed: (msg: string) => `GDSync: Token exchange failed. ${msg}`,
	invalidConnectionCode: "GDSync: Invalid connection code.",
	connectedWithCode: "GDSync: Connected with the connection code.",
	connectedWithCodeSettings: (n: number) =>
		`GDSync: Connected with the connection code (${n} shared settings imported).`,
	notAuthenticated:
		"Not authenticated with Google. Authenticate from the GDSync settings.",
	reauthRequired: "Re-authentication required.",
	tokenRefreshOffline: "GDSync: Token refresh failed (offline?).",
	authExpiredReauth:
		"Google authentication has expired. Re-authenticate from the settings.",
	tokenRefreshError: (status: number, desc: string) =>
		`GDSync: Token refresh error ${status}: ${desc}`,
	loopbackPageBody: "You can close this tab and return to Obsidian.",

	// ---- drive-client ----
	networkError: (msg: string) => `Network error: ${msg}`,

	// ---- commands / main ----
	cmdAuthenticate: "Authenticate with Google",
	cmdFullScan: "Full scan (build or update index)",
	cmdSyncNow: "Sync now",
	cmdEvictCache: "Clean up cache (release old content)",
	cmdHydrateCurrent: "Re-download current file",
	cmdUploadCurrent: "Upload current file now",
	ribbonSyncNow: "GDSync: Sync now",
	chooseFolderNext:
		"GDSync: Next, choose the Google Drive folder to sync in the settings tab.",
	runFullScanNext:
		"GDSync: The sync target was carried over. Run a full scan to build the mirror.",

	// ---- sync-engine ----
	noFolderSelected: "GDSync: No Google Drive folder has been selected.",
	rootNotFound: (id: string) =>
		`GDSync: The Drive folder ID "${id}" does not exist. Check the ID (a stray character can break it) and re-select the folder.`,
	rootNotFolder: (id: string) =>
		`GDSync: "${id}" is not a valid Drive folder (it may be a file or trashed). Re-select the folder.`,
	rootResolveFailed: (detail: string) =>
		`GDSync: Could not verify the Drive folder. ${detail}`,
	scanAlreadyRunning: "GDSync: A scan is already running.",
	listingDriveFiles: "Listing Drive files…",
	listingDriveFilesCount: (n: number) => `Listing Drive files… ${n}`,
	foldersNoFiles:
		"GDSync: Folders were found but no files matched. Check the exclude patterns and the selected Drive folder.",
	creatingFolders: "Creating folders…",
	creatingStubs: (i: number, total: number) => `Creating stubs… ${i}/${total}`,
	scanFinishedWithFailures: (
		created: number,
		total: number,
		failed: number,
		firstError: string
	) =>
		`GDSync: Scan finished (${created} of ${total} files created, ${failed} failed)\nFirst failure: ${firstError}`,
	scanFinished: (total: number, created: number) =>
		`GDSync: Scan finished (${total} files / ${created} new stubs)`,
	scanFailed: "Scan failed",
	tooLargeOnOpen: (name: string, mb: number) =>
		`GDSync: ${name} exceeds the size limit (${mb} MB) and will not be downloaded.`,
	tooLarge: (name: string) =>
		`GDSync: ${name} exceeds the size limit and will not be downloaded.`,
	downloading: (name: string) => `Downloading ${name}…`,
	downloadFailed: (name: string) => `Failed to download ${name}`,
	stubEditWarning:
		"GDSync: This file was edited before its content was downloaded. Your edit is preserved; sync will keep a conflict copy.",
	emptyUploadCancelled: (name: string) =>
		`GDSync: Upload of ${name} was cancelled because it is empty while the remote copy has content. If this is intentional, open the remote version once and then edit it.`,
	offlineUploadPending: "Offline (upload pending)",
	uploadFailed: (name: string) => `Failed to upload ${name}`,
	conflictDetected: (conflictName: string, name: string) =>
		`GDSync: Conflict detected. The local version was saved as "${conflictName}" and ${name} was updated to the remote version.`,
	changeTokenExpired: "GDSync: The change token has expired. Running a full scan.",
	syncing: "Syncing…",
	syncFailed: "Sync failed",
	possiblyOffline: "possibly offline",
	syncAlreadyRunning: "GDSync: Sync is already running.",
	syncNoChanges: "Sync finished (no changes).",
	uploadingStatus: (name: string) => `Uploading ${name}…`,
	uploadingStatusN: (n: number, name: string) =>
		`Uploading ${n} files (e.g. ${name})…`,
	syncClientUploads: (n: number, fail: number) =>
		`uploaded ${n}${fail > 0 ? ` (${fail} failed)` : ""}`,
	syncClientDownloads: (n: number) => `downloaded ${n}`,
	syncClientRemote: (add: number, upd: number, del: number) =>
		`remote +${add} / ~${upd} / −${del}`,
	syncClientOps: (n: number) => `structure ops ${n}`,
	syncFinished: (parts: string) => `Drive sync finished (${parts})`,

	// ---- settings ----
	modalEnterCodeTitle: "Enter connection code",
	modalEnterCodeDesc:
		"Paste the connection code copied from your other device. It contains your credentials — delete it from wherever you sent it after connecting.",
	btnConnect: "Connect",
	searchFolderPlaceholder: "Search for the Drive folder to sync…",
	headingGoogleAuth: "Google authentication",
	clientId: "Client ID",
	clientIdDesc:
		"OAuth client ID from your own Google Cloud project (Desktop app type recommended).",
	clientSecret: "Client secret",
	clientSecretDesc:
		"Stored unencrypted in this vault's plugin data. Use a dedicated Google Cloud project.",
	redirectUri: "Redirect URI (optional)",
	redirectUriDesc:
		"Only needed for browser sign-in directly on mobile. Leave empty if you sign in on desktop and connect this device with a connection code. If used, deploy the redirect page and register its URL in Google Cloud.",
	redirectUriPlaceholder: "https://example.github.io/gdsync/",
	statusAuthenticated: "authenticated",
	statusWaiting: "waiting for browser…",
	statusNot: "not authenticated",
	statusLabel: (status: string) => `Status: ${status}`,
	btnReauth: "Re-authenticate",
	btnAuth: "Authenticate with Google",
	btnTestConnection: "Test connection",
	connectedNotice: (name: string, email: string) =>
		`GDSync: Connected — ${name} (${email})`,
	connTestFailed: (msg: string) => `GDSync: Connection test failed — ${msg}`,
	btnLogout: "Log out",
	connCode: "Connection code",
	connCodeDesc:
		"Moves this authentication and the shared settings (Drive folder, mirror base folder, exclude / always-sync patterns, file size, debounce, freshness) to another device — e.g. sign in on desktop, then paste the code on your phone. Device-specific settings (cache limits, desktop toggle) are not carried over. The code contains your credentials and tokens — treat it like a password and delete it after use.",
	btnCopyCode: "Copy code",
	authFirst: "GDSync: Authenticate first.",
	codeCopied: "GDSync: Connection code copied. Treat it like a password.",
	btnEnterCode: "Enter code",
	headingSyncTarget: "Sync target",
	driveFolder: "Drive folder",
	driveFolderSelected: (name: string, id: string) => `Selected: ${name} (${id})`,
	driveFolderDesc:
		"The Google Drive folder to treat as the vault mirror. You can also paste a Drive URL.",
	driveFolderPlaceholder: "Folder ID or Drive URL",
	btnChooseFromList: "Choose from list",
	fetchingFolders: "GDSync: Fetching folder list…",
	fetchFoldersFailed: (msg: string) =>
		`GDSync: Failed to fetch folder list — ${msg}`,
	mirrorBase: "Mirror base folder",
	mirrorBaseDesc:
		"The Drive folder structure is recreated under this folder in your vault.",
	excludePatterns: "Exclude patterns",
	excludePatternsDesc:
		"One pattern per line. Paths containing a pattern are not synced.",
	eagerSyncPatterns: "Always-hydrate patterns",
	eagerSyncPatternsDesc:
		"One pattern per line. Matching files are kept fully downloaded (never stubs), so plugins can read them without opening the file. Use for small config/state files, not large content.",
	buildIndex: "Build or update index (full scan)",
	buildIndexDesc:
		"Lists your Drive files and creates the folder structure and stub files.",
	btnRunFullScan: "Run full scan",
	headingBehavior: "Behavior",
	maxFileSize: "Maximum file size (MB)",
	maxFileSizeDesc: "Files larger than this are not downloaded.",
	uploadDebounce: "Upload debounce (seconds)",
	uploadDebounceDesc: "How long to wait after you stop editing before uploading.",
	freshness: "Freshness check interval (minutes)",
	freshnessDesc: "How often to check for remote updates when opening a cached file.",
	cacheRetention: "Cache retention (days)",
	cacheRetentionDesc:
		"Files not opened for this many days are released back to stubs.",
	cacheMaxCount: "Cache maximum count",
	cacheMaxCountDesc:
		"Maximum number of files kept with content (oldest are released first).",
	enableOnDesktop: "Enable on desktop",
	enableOnDesktopDesc:
		"Usually unnecessary — on desktop, use a Google Drive for Desktop synced folder as the vault instead.",
	headingMaintenance: "Maintenance",
	settingsSyncNow: "Sync now",
	settingsSyncNowDesc:
		"Sends pending uploads and structure changes, then fetches remote changes.",
	btnSync: "Sync",
	cleanCache: "Clean up cache",
	cleanCacheDesc: "Releases old cached content back to stub files.",
	btnRun: "Run",
	cacheCleanupDone: "GDSync: Cache cleanup finished.",
	resetIndex: "Reset index",
	resetIndexDesc:
		"Sync first if you have unsent edits. After resetting, run a full scan to rebuild.",
	btnReset: "Reset",
	unsentEdits: (n: number) =>
		`GDSync: ${n} edit(s) have not been uploaded yet. Run "Sync now" first.`,
	indexReset: "GDSync: Index has been reset. Run a full scan to rebuild it.",
	syncNever: "never",
	syncNoSummary: "No sync has been run yet.",
	syncStateLabel: (last: string) => `Sync status: last attempt ${last}`,
};

type Strings = typeof en;

const ja: Strings = {
	indexRecovered: "GDSync: 保存済みの同期記録から復旧しました。ローカルファイルを照合してから同期します。",
	indexRecoveryFailed: "GDSync: 同期記録を復旧できませんでした。ローカルファイル保護のため同期を停止しています。",

	migrationResume: "GDSync: 未完了の移行があります。同期を停止しています。設定から移行を再開してください。",
	migrationPendingOps: "保留中の構造変更・受信差分を同期してから移行してください。",
	uncheckedStub: "未検査（本文未取得）",
	linkMissing: "参照先が見つかりません",
	linkOutside: "同期範囲外",
	linkPending: "送信待ち",
	linksHealthy: "取得済みノートに添付の問題は見つかりませんでした。",
	migrateConfirm: "ローカルファイルをVault直下へ移行",
	migrateConfirmDesc: "旧ミラー外のファイルを含め、除外対象以外のVault内ファイルが同期対象になります。専用Vaultで使用してください。元の内容はプラグインフォルダへ退避します。未解決リンクは移行後に表示します。他の端末やウィンドウでの編集を止めてから実行してください。",

	syncNotReady: "GDSync: 同期が無効・初期化前、または移行中です。",
	targetChanged: "GDSync: 同期先が変更されています。元の設定に戻すか移行機能を使用してください。",
	syncPending: (n: number, ops: number, incoming: number) => `Driveとの同期は未完了: 未送信${n}件・構造変更${ops}件・未適用差分${incoming}件。`,
	syncIncomplete: "Driveとの同期は未完了です。保留中の変更・エラーを確認してください。",
	mountMode: "同期先の配置",
	mountModeDesc: "Vault直下にすると各端末のパスが一致します。既存ミラーには移行機能を使用してください。",
	mountRoot: "Vault直下（専用Vault）",
	mountSubfolder: "サブフォルダ（従来方式）",
	migrateRoot: "Vault直下へ移行／移行を再開",
	migrateDesc: "衝突を検査し、ローカル内容を退避して解決済みMarkdownリンクを修復します。移行中は他端末での編集を止めてください。",
	migrationDone: "ローカルの移行が完了しました。同期して修復したノートをDriveに送信してください。",
	diagnoseLinks: "添付リンクを診断",
	targetLocked: "既に同期対象が登録されています。移行機能または新しい専用Vaultを使用してください。",

	// ---- auth ----
	setCredsFirst: "GDSync: 先にクライアントIDとクライアントシークレットを設定してください。",
	mobileNoRedirect:
		"GDSync: モバイルでは、デスクトップで作成した接続コードを貼り付けるか（設定 →「接続コード」）、ブラウザ認証用のリダイレクトURIを設定してください。",
	authCancelled: (error: string) =>
		`GDSync: 認証がキャンセルされたか失敗しました（${error}）。`,
	stateMismatch:
		"GDSync: 認証状態が一致しません。もう一度認証を開始してください。",
	portInUse: (port: number) =>
		`GDSync: サインイン用のローカルポート ${port} を開けませんでした（他のアプリが使用中かもしれません）。競合するアプリを閉じるか、リダイレクトページ方式で認証してください。`,
	authExpired: "GDSync: 認証リクエストの有効期限が切れました。もう一度開始してください。",
	missingCode: "GDSync: 認可コードがありません。",
	noRefreshToken:
		"refresh_token が返されませんでした。Google Cloud 側で prompt=consent が有効か確認してください。",
	authSucceeded: "GDSync: Google 認証に成功しました。",
	tokenExchangeFailed: (msg: string) => `GDSync: トークン交換に失敗しました。${msg}`,
	invalidConnectionCode: "GDSync: 接続コードが無効です。",
	connectedWithCode: "GDSync: 接続コードで接続しました。",
	connectedWithCodeSettings: (n: number) =>
		`GDSync: 接続コードで接続しました（共有設定 ${n} 件を取り込み）。`,
	notAuthenticated:
		"Google に未認証です。GDSync の設定から認証してください。",
	reauthRequired: "再認証が必要です。",
	tokenRefreshOffline: "GDSync: トークンの更新に失敗しました（オフライン？）。",
	authExpiredReauth:
		"Google の認証が失効しました。設定から再認証してください。",
	tokenRefreshError: (status: number, desc: string) =>
		`GDSync: トークン更新エラー ${status}: ${desc}`,
	loopbackPageBody: "このタブを閉じて Obsidian に戻ってください。",

	// ---- drive-client ----
	networkError: (msg: string) => `ネットワークエラー: ${msg}`,

	// ---- commands / main ----
	cmdAuthenticate: "Google 認証を開始",
	cmdFullScan: "フルスキャン（インデックス構築・更新）",
	cmdSyncNow: "今すぐ同期",
	cmdEvictCache: "キャッシュ整理（古い実体を解放）",
	cmdHydrateCurrent: "現在のファイルを再ダウンロード",
	cmdUploadCurrent: "現在のファイルを今すぐアップロード",
	ribbonSyncNow: "GDSync: 今すぐ同期",
	chooseFolderNext:
		"GDSync: 次に、設定タブで同期対象の Google Drive フォルダを選択してください。",
	runFullScanNext:
		"GDSync: 同期対象の設定を引き継ぎました。フルスキャンを実行してミラーを作成してください。",

	// ---- sync-engine ----
	noFolderSelected: "GDSync: 同期対象の Google Drive フォルダが未選択です。",
	rootNotFound: (id: string) =>
		`GDSync: Drive フォルダID「${id}」が存在しません。IDに余分な文字が混入していないか確認し、フォルダを選び直してください。`,
	rootNotFolder: (id: string) =>
		`GDSync:「${id}」は有効な Drive フォルダではありません（ファイル、またはゴミ箱内の可能性）。フォルダを選び直してください。`,
	rootResolveFailed: (detail: string) =>
		`GDSync: Drive フォルダを確認できませんでした。${detail}`,
	scanAlreadyRunning: "GDSync: スキャンは既に実行中です。",
	listingDriveFiles: "Drive の一覧を取得中…",
	listingDriveFilesCount: (n: number) => `Drive の一覧を取得中… ${n}`,
	foldersNoFiles:
		"GDSync: フォルダは見つかりましたが対象ファイルがありませんでした。除外パターンと選択中の Drive フォルダを確認してください。",
	creatingFolders: "フォルダを作成中…",
	creatingStubs: (i: number, total: number) => `スタブを作成中… ${i}/${total}`,
	scanFinishedWithFailures: (
		created: number,
		total: number,
		failed: number,
		firstError: string
	) =>
		`GDSync: スキャン完了（${total} 件中 ${created} 件作成、${failed} 件失敗）\n最初の失敗: ${firstError}`,
	scanFinished: (total: number, created: number) =>
		`GDSync: スキャン完了（${total} ファイル / 新規スタブ ${created} 件）`,
	scanFailed: "スキャンに失敗しました",
	tooLargeOnOpen: (name: string, mb: number) =>
		`GDSync: ${name} はサイズ上限（${mb} MB）を超えるためダウンロードしません。`,
	tooLarge: (name: string) =>
		`GDSync: ${name} はサイズ上限を超えるためダウンロードしません。`,
	downloading: (name: string) => `${name} をダウンロード中…`,
	downloadFailed: (name: string) => `${name} のダウンロードに失敗`,
	stubEditWarning:
		"GDSync: 未取得のファイルが編集されました。編集内容を保持し、同期時に競合コピーとして保護します。",
	emptyUploadCancelled: (name: string) =>
		`GDSync: ${name} は空でリモート側に内容があるため、アップロードを中止しました。意図的な場合は、一度リモート版を開いてから編集してください。`,
	offlineUploadPending: "オフライン（アップロード保留中）",
	uploadFailed: (name: string) => `${name} のアップロードに失敗`,
	conflictDetected: (conflictName: string, name: string) =>
		`GDSync: 競合を検出しました。ローカル版を「${conflictName}」として保存し、${name} はリモート版に更新しました。`,
	changeTokenExpired: "GDSync: 差分トークンが失効しました。フルスキャンを実行します。",
	syncing: "同期中…",
	syncFailed: "同期に失敗しました",
	possiblyOffline: "オフラインの可能性",
	syncAlreadyRunning: "GDSync: 同期は既に実行中です。",
	syncNoChanges: "同期完了（変更なし）。",
	uploadingStatus: (name: string) => `${name} をアップロード中…`,
	uploadingStatusN: (n: number, name: string) =>
		`アップロード中… ${n}件（${name} ほか）`,
	syncClientUploads: (n: number, fail: number) =>
		`アップロード ${n}件${fail > 0 ? `（失敗 ${fail}）` : ""}`,
	syncClientDownloads: (n: number) => `ダウンロード ${n}件`,
	syncClientRemote: (add: number, upd: number, del: number) =>
		`差分 追加 ${add} / 更新 ${upd} / 削除 ${del}`,
	syncClientOps: (n: number) => `構造変更 ${n}件`,
	syncFinished: (parts: string) => `Driveとの同期完了（${parts}）`,

	// ---- settings ----
	modalEnterCodeTitle: "接続コードを入力",
	modalEnterCodeDesc:
		"別の端末でコピーした接続コードを貼り付けてください。認証情報を含むため、接続後は転送に使ったメッセージ等を削除してください。",
	btnConnect: "接続",
	searchFolderPlaceholder: "同期対象の Drive フォルダを検索…",
	headingGoogleAuth: "Google 認証",
	clientId: "クライアントID",
	clientIdDesc:
		"自分の Google Cloud プロジェクトの OAuth クライアントID（デスクトップアプリ型を推奨）。",
	clientSecret: "クライアントシークレット",
	clientSecretDesc:
		"この Vault のプラグインデータに平文で保存されます。専用の Google Cloud プロジェクトを使用してください。",
	redirectUri: "リダイレクトURI（任意）",
	redirectUriDesc:
		"モバイル単体でブラウザ認証する場合のみ必要です。デスクトップで認証し接続コードでこの端末を接続する場合は空欄で構いません。使用する場合はリダイレクトページをデプロイし、そのURLを Google Cloud に登録してください。",
	redirectUriPlaceholder: "https://example.github.io/gdsync/",
	statusAuthenticated: "認証済み",
	statusWaiting: "ブラウザ待機中…",
	statusNot: "未認証",
	statusLabel: (status: string) => `状態: ${status}`,
	btnReauth: "再認証",
	btnAuth: "Google 認証を開始",
	btnTestConnection: "接続テスト",
	connectedNotice: (name: string, email: string) =>
		`GDSync: 接続成功 — ${name}（${email}）`,
	connTestFailed: (msg: string) => `GDSync: 接続テストに失敗 — ${msg}`,
	btnLogout: "ログアウト",
	connCode: "接続コード",
	connCodeDesc:
		"この認証と共有設定（Drive フォルダ・ミラー先ベースフォルダ・除外/常時フル同期パターン・最大サイズ・アップロード待ち時間・鮮度確認間隔）を別の端末へ移します（例: デスクトップで認証し、コードをスマホに貼り付け）。端末固有の設定（キャッシュ上限・デスクトップ有効化）は引き継ぎません。コードは認証情報とトークンを含みます — パスワードと同等に扱い、使用後は削除してください。",
	btnCopyCode: "コードをコピー",
	authFirst: "GDSync: 先に認証してください。",
	codeCopied: "GDSync: 接続コードをコピーしました。パスワードと同等に扱ってください。",
	btnEnterCode: "コードを入力",
	headingSyncTarget: "同期対象",
	driveFolder: "Drive フォルダ",
	driveFolderSelected: (name: string, id: string) => `選択中: ${name}（${id}）`,
	driveFolderDesc:
		"Vault のミラー元として扱う Google Drive フォルダ。Drive の URL を貼り付けても構いません。",
	driveFolderPlaceholder: "フォルダID または Drive の URL",
	btnChooseFromList: "一覧から選択",
	fetchingFolders: "GDSync: フォルダ一覧を取得中…",
	fetchFoldersFailed: (msg: string) =>
		`GDSync: フォルダ一覧の取得に失敗 — ${msg}`,
	mirrorBase: "ミラー先ベースフォルダ",
	mirrorBaseDesc:
		"Vault 内のこのフォルダ配下に Drive のフォルダ構造を再現します。",
	excludePatterns: "除外パターン",
	excludePatternsDesc:
		"1行に1パターン。パターンを含むパスは同期されません。",
	eagerSyncPatterns: "常時フル同期パターン",
	eagerSyncPatternsDesc:
		"1行に1パターン。一致するファイルは常に実体をダウンロードした状態（スタブにしない）に保つため、他プラグインがファイルを開かずに読み込めます。大きな本文ではなく小さな設定・状態ファイル向けです。",
	buildIndex: "インデックス構築・更新（フルスキャン）",
	buildIndexDesc:
		"Drive のファイルを一覧し、フォルダ構造とスタブファイルを作成します。",
	btnRunFullScan: "フルスキャンを実行",
	headingBehavior: "動作設定",
	maxFileSize: "最大ファイルサイズ（MB）",
	maxFileSizeDesc: "これより大きいファイルはダウンロードしません。",
	uploadDebounce: "アップロードのデバウンス（秒）",
	uploadDebounceDesc: "編集を止めてからアップロードするまでの待ち時間。",
	freshness: "鮮度確認の間隔（分）",
	freshnessDesc: "キャッシュ済みファイルを開いたときにリモート更新を確認する間隔。",
	cacheRetention: "キャッシュ保持日数",
	cacheRetentionDesc:
		"この日数開かれていないファイルはスタブに戻されます。",
	cacheMaxCount: "キャッシュ最大件数",
	cacheMaxCountDesc:
		"内容を保持するファイル数の上限（古いものから解放）。",
	enableOnDesktop: "デスクトップで有効化",
	enableOnDesktopDesc:
		"通常は不要 — デスクトップでは Google Drive for Desktop の同期フォルダを Vault として使ってください。",
	headingMaintenance: "メンテナンス",
	settingsSyncNow: "今すぐ同期",
	settingsSyncNowDesc:
		"保留中のアップロードと構造変更を送信し、リモートの差分を取得します。",
	btnSync: "同期",
	cleanCache: "キャッシュ整理",
	cleanCacheDesc: "古いキャッシュ内容をスタブファイルに戻します。",
	btnRun: "実行",
	cacheCleanupDone: "GDSync: キャッシュ整理が完了しました。",
	resetIndex: "インデックスをリセット",
	resetIndexDesc:
		"未送信の編集がある場合は先に同期してください。リセット後はフルスキャンで再構築します。",
	btnReset: "リセット",
	unsentEdits: (n: number) =>
		`GDSync: ${n} 件の編集がまだアップロードされていません。先に「今すぐ同期」を実行してください。`,
	indexReset: "GDSync: インデックスをリセットしました。フルスキャンで再構築してください。",
	syncNever: "なし",
	syncNoSummary: "まだ同期を実行していません。",
	syncStateLabel: (last: string) => `同期状態: 最終試行 ${last}`,
};

export const t: Strings = detectLang() === "ja" ? ja : en;
