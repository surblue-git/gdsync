import { Notice, requestUrl } from "obsidian";
import type GdsyncPlugin from "./main";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive";

/** 認証切れ・未認証。ユーザー操作（再認証）が必要な状態 */
export class AuthError extends Error {}

function base64UrlEncode(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes.buffer);
}

export class AuthManager {
	private refreshing: Promise<void> | null = null;

	constructor(private plugin: GdsyncPlugin) {}

	get isAuthenticated(): boolean {
		return !!this.plugin.settings.tokens?.refreshToken;
	}

	/** 認可URLを生成して外部ブラウザを開く。verifier/state は往復中の kill に備え data.json に保存 */
	async beginAuth(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.clientId || !s.clientSecret || !s.redirectUri) {
			new Notice("GDSync: クライアントID・シークレット・リダイレクトURIを先に設定してください。");
			return;
		}
		const codeVerifier = randomToken(64);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(codeVerifier)
		);
		const state = randomToken(16);
		s.pendingAuth = { state, codeVerifier, createdAt: Date.now() };
		await this.plugin.saveSettings();

		const params = new URLSearchParams({
			client_id: s.clientId,
			redirect_uri: s.redirectUri,
			response_type: "code",
			scope: SCOPE,
			access_type: "offline",
			prompt: "consent",
			state,
			code_challenge: base64UrlEncode(digest),
			code_challenge_method: "S256",
		});
		window.open(`${AUTH_ENDPOINT}?${params.toString()}`);
	}

	/** obsidian://gdsync-auth コールバックの処理 */
	async handleCallback(params: Record<string, string>): Promise<void> {
		const s = this.plugin.settings;
		if (params.error) {
			new Notice(`GDSync: 認証がキャンセル/失敗しました (${params.error})`);
			return;
		}
		const pending = s.pendingAuth;
		if (!pending || !params.state || params.state !== pending.state) {
			new Notice("GDSync: 認証状態が一致しません。もう一度認証を開始してください。");
			return;
		}
		if (!params.code) {
			new Notice("GDSync: 認可コードがありません。");
			return;
		}
		try {
			const body = new URLSearchParams({
				code: params.code,
				client_id: s.clientId,
				client_secret: s.clientSecret,
				redirect_uri: s.redirectUri,
				grant_type: "authorization_code",
				code_verifier: pending.codeVerifier,
			});
			const res = await requestUrl({
				url: TOKEN_ENDPOINT,
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				body: body.toString(),
				throw: false,
			});
			if (res.status >= 400) {
				const detail = res.json?.error_description || res.json?.error || res.text;
				throw new Error(`${res.status}: ${detail}`);
			}
			const data = res.json;
			if (!data.refresh_token) {
				throw new Error("refresh_token が返されませんでした。GCP側で prompt=consent が効いているか確認してください。");
			}
			s.tokens = {
				accessToken: data.access_token,
				refreshToken: data.refresh_token,
				expiresAt: Date.now() + (data.expires_in - 60) * 1000,
			};
			s.pendingAuth = null;
			await this.plugin.saveSettings();
			new Notice("GDSync: Google 認証に成功しました。");
			this.plugin.onAuthenticated();
		} catch (e) {
			console.error("gdsync auth callback failed", e);
			new Notice(`GDSync: トークン交換に失敗しました。${e instanceof Error ? e.message : ""}`);
		}
	}

	/** 有効なアクセストークンを返す。期限切れなら先にリフレッシュ */
	async getAccessToken(): Promise<string> {
		const t = this.plugin.settings.tokens;
		if (!t?.refreshToken) {
			throw new AuthError("Google 未認証です。GDSync 設定から認証してください。");
		}
		if (Date.now() >= t.expiresAt) {
			await this.refresh();
		}
		const cur = this.plugin.settings.tokens;
		if (!cur) throw new AuthError("再認証が必要です。");
		return cur.accessToken;
	}

	/** API側で401を受けた場合の強制リフレッシュ */
	async forceRefresh(): Promise<void> {
		await this.refresh();
	}

	async logout(): Promise<void> {
		this.plugin.settings.tokens = null;
		this.plugin.settings.pendingAuth = null;
		await this.plugin.saveSettings();
	}

	private refresh(): Promise<void> {
		// 同時リフレッシュ防止: in-flight の Promise を共有
		if (!this.refreshing) {
			this.refreshing = this.doRefresh().finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
	}

	private async doRefresh(): Promise<void> {
		const s = this.plugin.settings;
		const t = s.tokens;
		if (!t?.refreshToken) throw new AuthError("再認証が必要です。");
		const body = new URLSearchParams({
			client_id: s.clientId,
			client_secret: s.clientSecret,
			refresh_token: t.refreshToken,
			grant_type: "refresh_token",
		});
		let res;
		try {
			res = await requestUrl({
				url: TOKEN_ENDPOINT,
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				body: body.toString(),
				throw: false,
			});
		} catch (e) {
			// ネットワーク断はトークンを破棄しない
			throw new Error("GDSync: トークン更新に失敗しました（オフライン？）");
		}
		if (res.status >= 400) {
			const err = res.json?.error;
			if (err === "invalid_grant") {
				// リフレッシュトークン失効 → 再認証が必要
				s.tokens = null;
				await this.plugin.saveSettings();
				throw new AuthError("Google の認証が失効しました。設定から再認証してください。");
			}
			throw new Error(`GDSync: トークン更新エラー ${res.status}: ${res.json?.error_description || ""}`);
		}
		const data = res.json;
		s.tokens = {
			accessToken: data.access_token,
			refreshToken: data.refresh_token || t.refreshToken,
			expiresAt: Date.now() + (data.expires_in - 60) * 1000,
		};
		await this.plugin.saveSettings();
	}
}
