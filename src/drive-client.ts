import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { AuthManager } from "./auth";
import { t } from "./i18n";
import { DriveChange, DriveItemMeta } from "./types";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";

const FILE_FIELDS =
	"id,name,mimeType,parents,md5Checksum,modifiedTime,size,trashed,shortcutDetails";

/** トランスポートレベルの失敗（オフライン等）。リトライ対象 */
export class NetworkError extends Error { }

/** HTTP エラー。status で分岐する */
export class ApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

export interface UploadParams {
	/** 既存ファイルの更新なら指定 (PATCH)、新規なら undefined (POST) */
	fileId?: string;
	creationId?: string;
	name?: string;
	parentId?: string;
	mimeType: string;
	data: ArrayBuffer;
}

function extractErrorMessage(res: RequestUrlResponse): string {
	try {
		const j = res.json;
		if (j?.error?.message) return j.error.message;
	} catch (e) {
		/* JSONでないレスポンス */
	}
	try {
		return (res.text || "").slice(0, 300);
	} catch (e) {
		return "";
	}
}

/** multipart/related ボディを ArrayBuffer 連結で構築（requestUrl は FormData 不可） */
function buildMultipartBody(
	metadata: Record<string, unknown>,
	data: ArrayBuffer,
	contentType: string
): { body: ArrayBuffer; contentType: string } {
	const boundary = "gdsync_" + Math.random().toString(36).slice(2);
	const enc = new TextEncoder();
	const head = enc.encode(
		`--${boundary}\r\n` +
		`Content-Type: application/json; charset=UTF-8\r\n\r\n` +
		`${JSON.stringify(metadata)}\r\n` +
		`--${boundary}\r\n` +
		`Content-Type: ${contentType}\r\n\r\n`
	);
	const tail = enc.encode(`\r\n--${boundary}--`);
	const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
	body.set(head, 0);
	body.set(new Uint8Array(data), head.byteLength);
	body.set(tail, head.byteLength + data.byteLength);
	return {
		body: body.buffer,
		contentType: `multipart/related; boundary=${boundary}`,
	};
}

export class DriveClient {
	constructor(private auth: AuthManager) { }

	/** 認証ヘッダ付与 + 401時1回だけリフレッシュ&リトライ + エラー分類 */
	private async call(
		params: Omit<RequestUrlParam, "throw">
	): Promise<RequestUrlResponse> {
		const exec = async (): Promise<RequestUrlResponse> => {
			const token = await this.auth.getAccessToken();
			const headers: Record<string, string> = {
				...(params.headers || {}),
				Authorization: `Bearer ${token}`,
			};
			try {
				return await requestUrl({ ...params, headers, throw: false });
			} catch (e) {
				throw new NetworkError(
					t.networkError(e instanceof Error ? e.message : String(e))
				);
			}
		};
		let res = await exec();
		if (res.status === 401) {
			await this.auth.forceRefresh();
			res = await exec();
		}
		if (res.status >= 400) {
			throw new ApiError(res.status, extractErrorMessage(res));
		}
		return res;
	}

	/** 接続テスト用 */
	async about(): Promise<{ displayName: string; emailAddress: string }> {
		const res = await this.call({
			url: `${API}/about?fields=${encodeURIComponent("user(displayName,emailAddress)")}`,
		});
		return res.json.user;
	}

	/** マイドライブ全体のファイル/フォルダ一覧（ページング吸収）。onPage は進捗通知用 */
	async listAll(
		onPage?: (count: number) => void
	): Promise<DriveItemMeta[]> {
		const items: DriveItemMeta[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				q: "trashed=false",
				fields: `nextPageToken,files(${FILE_FIELDS})`,
				pageSize: "1000",
				spaces: "drive",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const res = await this.call({ url: `${API}/files?${params.toString()}` });
			const data = res.json;
			for (const f of data.files || []) items.push(f as DriveItemMeta);
			pageToken = data.nextPageToken;
			if (onPage) onPage(items.length);
		} while (pageToken);
		return items;
	}

	/** フォルダ選択UI用: 全フォルダ（id, name, parents） */
	async listAllFolders(): Promise<DriveItemMeta[]> {
		const items: DriveItemMeta[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				q: `mimeType='${FOLDER_MIME}' and trashed=false`,
				fields: "nextPageToken,files(id,name,parents)",
				pageSize: "1000",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const res = await this.call({ url: `${API}/files?${params.toString()}` });
			const data = res.json;
			for (const f of data.files || []) items.push(f as DriveItemMeta);
			pageToken = data.nextPageToken;
		} while (pageToken);
		return items;
	}

	async getMeta(fileId: string, fields = FILE_FIELDS): Promise<DriveItemMeta> {
		const res = await this.call({
			url: `${API}/files/${fileId}?fields=${encodeURIComponent(fields)}`,
		});
		return res.json as DriveItemMeta;
	}

	async download(fileId: string): Promise<ArrayBuffer> {
		const res = await this.call({
			url: `${API}/files/${fileId}?alt=media`,
		});
		return res.arrayBuffer;
	}

	async upload(p: UploadParams): Promise<DriveItemMeta> {
		const metadata: Record<string, unknown> = {};
		if (!p.fileId && p.creationId) metadata.id = p.creationId;
		if (p.name) metadata.name = p.name;
		if (!p.fileId) {
			metadata.mimeType = p.mimeType;
			if (p.parentId) metadata.parents = [p.parentId];
		}
		const { body, contentType } = buildMultipartBody(metadata, p.data, p.mimeType);
		const fields = encodeURIComponent("id,name,md5Checksum,modifiedTime,size");
		const url = p.fileId
			? `${UPLOAD_API}/files/${p.fileId}?uploadType=multipart&fields=${fields}`
			: `${UPLOAD_API}/files?uploadType=multipart&fields=${fields}`;
		let res: RequestUrlResponse;
		try {
			res = await this.call({
				url,
				method: p.fileId ? "PATCH" : "POST",
				contentType,
				body,
			});
		} catch (e) {
			if (e instanceof ApiError && e.status === 409 && p.creationId && !p.fileId) {
				// Recover the successful creation; the engine compares the actual bytes before ACK.
				return { ...await this.getMeta(p.creationId), gdsyncRecovered: true };
			}
			throw e;
		}
		return res.json as DriveItemMeta;
	}

	async generateId(): Promise<string> {
		const res = await this.call({ url: `${API}/files/generateIds?count=1&space=drive&type=files` });
		return res.json.ids[0];
	}

	async createFolder(name: string, parentId: string, creationId?: string): Promise<string> {
		try {
			const res = await this.call({
				url: `${API}/files?fields=id`,
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({
					id: creationId,
					name,
					mimeType: FOLDER_MIME,
					parents: [parentId],
				}),
			});
			return res.json.id as string;
		} catch (e) {
			if (e instanceof ApiError && e.status === 409 && creationId) return creationId;
			throw e;
		}
	}

	/** rename / move / trash 等のメタデータ更新 */
	async patchMeta(
		fileId: string,
		body: Record<string, unknown>,
		query?: Record<string, string>
	): Promise<DriveItemMeta> {
		const params = new URLSearchParams({ fields: FILE_FIELDS, ...(query || {}) });
		const res = await this.call({
			url: `${API}/files/${fileId}?${params.toString()}`,
			method: "PATCH",
			contentType: "application/json",
			body: JSON.stringify(body),
		});
		return res.json as DriveItemMeta;
	}

	async trash(fileId: string): Promise<void> {
		await this.patchMeta(fileId, { trashed: true });
	}

	async getStartPageToken(): Promise<string> {
		const res = await this.call({
			url: `${API}/changes/startPageToken`,
		});
		return res.json.startPageToken as string;
	}

	/**
	 * changes.list をページング吸収して差分一覧を返す。
	 * pageToken 失効（400/404/410）は ApiError のまま投げる → 呼び出し側でフル再スキャン
	 */
	async listChanges(
		pageToken: string
	): Promise<{ changes: DriveChange[]; newStartPageToken: string }> {
		const changes: DriveChange[] = [];
		let token = pageToken;
		let newStart = "";
		for (; ;) {
			const params = new URLSearchParams({
				pageToken: token,
				fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
				pageSize: "1000",
				restrictToMyDrive: "true",
				spaces: "drive",
			});
			const res = await this.call({ url: `${API}/changes?${params.toString()}` });
			const data = res.json;
			for (const c of data.changes || []) changes.push(c as DriveChange);
			if (data.newStartPageToken) {
				newStart = data.newStartPageToken;
				break;
			}
			token = data.nextPageToken;
		}
		return { changes, newStartPageToken: newStart };
	}
}
