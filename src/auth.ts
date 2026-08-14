import { Notice, Platform, requestUrl } from "obsidian";
import type { Server } from "http";
import { t } from "./i18n";
import type GdsyncPlugin from "./main";
import { applySharedSettings, pickSharedSettings, SharedSettings } from "./types";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive";
/** 認可開始からコールバック受理までの有効期限 */
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;
/**
 * デスクトップのループバック認証で使う固定ポート。
 * 固定にしておくことで、Web アプリケーション型クライアントでも
 * `http://127.0.0.1:42813` を事前登録すれば動く（Desktop 型なら登録不要）。
 */
const LOOPBACK_PORT = 42813;
const LOOPBACK_REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}`;

/** 認証切れ・未認証。ユーザー操作（再認証）が必要な状態 */
export class AuthError extends Error {}

/**
 * 端末間で認証を移すための接続コードのペイロード。
 * v1 = 認証情報のみ / v2 = 共有設定（同期対象フォルダ等）も同梱。
 * 生成は常に v2 だが、古い端末が出力した v1 も読める。
 */
interface ConnectionPayload {
	v: 1 | 2;
	clientId: string;
	clientSecret: string;
	tokens: {
		accessToken: string;
		refreshToken: string;
		expiresAt: number;
	};
	shared?: Partial<SharedSettings>;
}

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
	private loopbackServer: Server | null = null;
	private loopbackTimer: number | null = null;

	constructor(private plugin: GdsyncPlugin) {}

	get isAuthenticated(): boolean {
		return !!this.plugin.settings.tokens?.refreshToken;
	}

	/** unload 時のクリーンアップ */
	dispose(): void {
		this.stopLoopback();
	}

	/**
	 * 認証を開始する。
	 * デスクトップ: 一時ローカルサーバー（ループバック）で完結。リダイレクトページ不要。
	 * モバイル: リダイレクトURI設定があれば外部ブラウザ経由、なければ接続コードを案内。
	 */
	async beginAuth(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.clientId || !s.clientSecret) {
			new Notice(t.setCredsFirst);
			return;
		}
		if (Platform.isDesktopApp) {
			await this.beginLoopbackAuth();
			return;
		}
		if (!s.redirectUri) {
			new Notice(t.mobileNoRedirect, 12000);
			return;
		}
		await this.beginRedirectAuth();
	}

	private async createPkce(): Promise<{ verifier: string; challenge: string }> {
		const verifier = randomToken(64);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(verifier)
		);
		return { verifier, challenge: base64UrlEncode(digest) };
	}

	private buildAuthUrl(redirectUri: string, state: string, challenge: string): string {
		const params = new URLSearchParams({
			client_id: this.plugin.settings.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: SCOPE,
			access_type: "offline",
			prompt: "consent",
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		return `${AUTH_ENDPOINT}?${params.toString()}`;
	}

	// ---------------- デスクトップ: ループバックフロー ----------------

	/**
	 * 127.0.0.1 の一時 HTTP サーバーで認可コードを受ける。
	 * リダイレクトページのホスティングが不要になる。デスクトップ専用。
	 */
	private async beginLoopbackAuth(): Promise<void> {
		this.stopLoopback();
		const { verifier, challenge } = await this.createPkce();
		const state = randomToken(16);

		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { createServer } = require("http") as typeof import("http");
		const server = createServer((req, res) => {
			let code: string | null = null;
			let st: string | null = null;
			let error: string | null = null;
			try {
				const url = new URL(req.url ?? "/", LOOPBACK_REDIRECT_URI);
				code = url.searchParams.get("code");
				st = url.searchParams.get("state");
				error = url.searchParams.get("error");
			} catch (e) {
				/* 不正なURLは無視 */
			}
			if (!code && !error) {
				// ブラウザの favicon リクエスト等
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				"<!DOCTYPE html><html><body style=\"font-family:sans-serif;text-align:center;padding-top:15vh\">" +
					`<h2>GDSync</h2><p>${t.loopbackPageBody}</p></body></html>`
			);
			this.stopLoopback();
			if (error) {
				new Notice(t.authCancelled(error));
				return;
			}
			if (st !== state) {
				new Notice(t.stateMismatch);
				return;
			}
			void this.exchangeCode(code!, verifier, LOOPBACK_REDIRECT_URI);
		});

		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(LOOPBACK_PORT, "127.0.0.1", () => resolve());
			});
		} catch (e) {
			new Notice(t.portInUse(LOOPBACK_PORT), 12000);
			return;
		}
		this.loopbackServer = server;
		// 放置されたら自動で閉じる
		this.loopbackTimer = window.setTimeout(() => this.stopLoopback(), PENDING_AUTH_TTL_MS);
		window.open(this.buildAuthUrl(LOOPBACK_REDIRECT_URI, state, challenge));
	}

	private stopLoopback(): void {
		if (this.loopbackTimer !== null) {
			window.clearTimeout(this.loopbackTimer);
			this.loopbackTimer = null;
		}
		if (this.loopbackServer) {
			try {
				this.loopbackServer.close();
			} catch (e) {
				/* 既に閉じている */
			}
			this.loopbackServer = null;
		}
	}

	// ---------------- モバイル: リダイレクトページ経由フロー ----------------

	/** 認可URLを生成して外部ブラウザを開く。verifier/state は往復中の kill に備え data.json に保存 */
	private async beginRedirectAuth(): Promise<void> {
		const s = this.plugin.settings;
		const { verifier, challenge } = await this.createPkce();
		const state = randomToken(16);
		s.pendingAuth = { state, codeVerifier: verifier, createdAt: Date.now() };
		await this.plugin.saveSettings();
		window.open(this.buildAuthUrl(s.redirectUri, state, challenge));
	}

	/** obsidian://gdsync-auth コールバックの処理 */
	async handleCallback(params: Record<string, string>): Promise<void> {
		const s = this.plugin.settings;
		if (params.error) {
			new Notice(t.authCancelled(params.error));
			return;
		}
		const pending = s.pendingAuth;
		if (!pending || !params.state || params.state !== pending.state) {
			new Notice(t.stateMismatch);
			return;
		}
		if (Date.now() - pending.createdAt > PENDING_AUTH_TTL_MS) {
			s.pendingAuth = null;
			await this.plugin.saveSettings();
			new Notice(t.authExpired);
			return;
		}
		if (!params.code) {
			new Notice(t.missingCode);
			return;
		}
		await this.exchangeCode(params.code, pending.codeVerifier, s.redirectUri);
	}

	// ---------------- 共通: コード→トークン交換 ----------------

	private async exchangeCode(
		code: string,
		codeVerifier: string,
		redirectUri: string
	): Promise<void> {
		const s = this.plugin.settings;
		try {
			const body = new URLSearchParams({
				code,
				client_id: s.clientId,
				client_secret: s.clientSecret,
				redirect_uri: redirectUri,
				grant_type: "authorization_code",
				code_verifier: codeVerifier,
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
				throw new Error(t.noRefreshToken);
			}
			s.tokens = {
				accessToken: data.access_token,
				refreshToken: data.refresh_token,
				expiresAt: Date.now() + (data.expires_in - 60) * 1000,
			};
			s.pendingAuth = null;
			await this.plugin.saveSettings();
			new Notice(t.authSucceeded);
			this.plugin.onAuthenticated();
		} catch (e) {
			console.error("gdsync auth code exchange failed", e);
			new Notice(t.tokenExchangeFailed(e instanceof Error ? e.message : ""));
		}
	}

	// ---------------- 接続コード（端末間の認証移行） ----------------

	/**
	 * 認証済みのクレデンシャル+トークン+共有設定を1つの文字列にまとめる。
	 * モバイルに貼り付ければブラウザ往復なしで接続でき、同期対象フォルダ等も引き継げる。
	 * リフレッシュトークンを含むため、パスワードと同等に扱うこと。
	 */
	exportConnectionCode(): string | null {
		const s = this.plugin.settings;
		if (!s.clientId || !s.clientSecret || !s.tokens) return null;
		const payload: ConnectionPayload = {
			v: 2,
			clientId: s.clientId,
			clientSecret: s.clientSecret,
			tokens: { ...s.tokens },
			shared: pickSharedSettings(s),
		};
		const json = JSON.stringify(payload);
		return btoa(unescape(encodeURIComponent(json)));
	}

	/** 接続コードを取り込んで認証状態を復元する */
	async importConnectionCode(codeText: string): Promise<boolean> {
		let payload: ConnectionPayload;
		try {
			const json = decodeURIComponent(escape(atob(codeText.trim())));
			payload = JSON.parse(json) as ConnectionPayload;
		} catch (e) {
			new Notice(t.invalidConnectionCode);
			return false;
		}
		if (
			(payload.v !== 1 && payload.v !== 2) ||
			!payload.clientId ||
			!payload.clientSecret ||
			!payload.tokens?.refreshToken
		) {
			new Notice(t.invalidConnectionCode);
			return false;
		}
		const s = this.plugin.settings;
		s.clientId = payload.clientId;
		s.clientSecret = payload.clientSecret;
		s.tokens = {
			accessToken: payload.tokens.accessToken,
			refreshToken: payload.tokens.refreshToken,
			// アクセストークンの鮮度は不明として即リフレッシュさせる
			expiresAt: 0,
		};
		s.pendingAuth = null;
		// v1 のコードには shared が無い。その場合は既存の設定をそのまま残す
		const applied = applySharedSettings(s, payload.shared);
		await this.plugin.saveSettings();
		new Notice(applied > 0 ? t.connectedWithCodeSettings(applied) : t.connectedWithCode);
		this.plugin.onAuthenticated();
		return true;
	}

	/** 有効なアクセストークンを返す。期限切れなら先にリフレッシュ */
	async getAccessToken(): Promise<string> {
		const tok = this.plugin.settings.tokens;
		if (!tok?.refreshToken) {
			throw new AuthError(t.notAuthenticated);
		}
		if (Date.now() >= tok.expiresAt) {
			await this.refresh();
		}
		const cur = this.plugin.settings.tokens;
		if (!cur) throw new AuthError(t.reauthRequired);
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
		const tok = s.tokens;
		if (!tok?.refreshToken) throw new AuthError(t.reauthRequired);
		const body = new URLSearchParams({
			client_id: s.clientId,
			client_secret: s.clientSecret,
			refresh_token: tok.refreshToken,
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
			throw new Error(t.tokenRefreshOffline);
		}
		if (res.status >= 400) {
			const err = res.json?.error;
			if (err === "invalid_grant") {
				// リフレッシュトークン失効 → 再認証が必要
				s.tokens = null;
				await this.plugin.saveSettings();
				throw new AuthError(t.authExpiredReauth);
			}
			throw new Error(t.tokenRefreshError(res.status, res.json?.error_description || ""));
		}
		const data = res.json;
		s.tokens = {
			accessToken: data.access_token,
			refreshToken: data.refresh_token || tok.refreshToken,
			expiresAt: Date.now() + (data.expires_in - 60) * 1000,
		};
		await this.plugin.saveSettings();
	}
}
