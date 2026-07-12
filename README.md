# GDSync — Google Drive オンデマンド同期（Obsidianプラグイン）

モバイル（iOS/Android）の Obsidian から Google Drive 上の Vault データを**オンデマンド**で読み書きするプラグインです。

- Drive のフォルダ/ファイル構造を Vault 内の `GDrive/`（変更可）に **0バイトのスタブ**として再現 → Obsidian 標準のファイルエクスプローラー/クイックスイッチャーがそのまま使える
- ファイルを**開いた時**に Drive から実体をダウンロード（ハイドレート）
- **編集すると自動アップロード**（デバウンス数秒、`modifiedTime` による競合検出 → 競合時は `(conflict …)` コピーを作成）
- 一度開いたファイルはローカルにキャッシュ。古いキャッシュは自動でスタブに戻る
- 作成 / リネーム / 削除も Drive に反映（削除は Drive のゴミ箱へ）
- PC 側は Google Drive for Desktop で同じフォルダを Vault にすれば OK（このプラグインは既定でモバイルのみ動作）

## セットアップ

### 1. Google Cloud プロジェクト（自分専用）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクト作成
2. 「APIとサービス」→「ライブラリ」→ **Google Drive API を有効化**
3. 「OAuth 同意画面」: User Type = **外部**、スコープに `https://www.googleapis.com/auth/drive` を追加
4. 公開ステータスを **「本番」に移行**（テストのままだとリフレッシュトークンが7日で失効する）。未検証アプリ警告は自分のアカウントなら「詳細」→「（安全でないページに）移動」で通過できる
5. 「認証情報」→ OAuth クライアントID作成 → 種類 = **ウェブアプリケーション**、承認済みリダイレクトURIに **手順2でデプロイするページのURL** を登録

### 2. リダイレクトページのデプロイ

`redirect-page/index.html` を Cloudflare Pages（や GitHub Pages 等の静的ホスティング）にデプロイします。認可コードを `obsidian://gdsync-auth` へ転送するだけの静的ページで、シークレットは扱いません。

デプロイしたURLを GCP のリダイレクトURIとプラグイン設定の両方に設定してください。

### 3. プラグインのインストール

#### 方法A: BRAT 経由（推奨・モバイルでも1タップ更新）

1. Obsidian のコミュニティプラグインから **BRAT** (Beta Reviewers Auto-update Tool) をインストールして有効化
2. BRAT の設定 →「Add beta plugin」→ `https://github.com/surblue-git/gdsync` を入力
3. gdsync が自動でインストールされる。以後は BRAT の「Check for updates」（自動チェックも可）で最新リリースに更新できる

すでに手動コピーで gdsync を入れている場合も、プラグインID が同じ（`gdsync`）なので同じフォルダに上書きされ、設定（`data.json`）と認証状態はそのまま引き継がれます。

#### 方法B: 手動ビルド

```
npm install
npm run build
```

生成された `main.js` と `manifest.json` を Vault の `.obsidian/plugins/gdsync/` にコピーし、Obsidian の設定でコミュニティプラグインとして有効化します。

- **Android**: Vault の `.obsidian/plugins/gdsync/` に直接コピー
- **iOS**: PC で作った Vault ごとコピーするか、ファイルAppで配置

### 4. プラグイン設定

1. クライアントID / シークレット / リダイレクトURI を入力
2. 「Google 認証を開始」→ ブラウザで許可 → Obsidian に自動で戻る
3. 「接続テスト」で確認
4. 「一覧から選択」で同期対象の Drive フォルダを選択（Drive の URL 貼り付けでも可）
5. 「フルスキャン実行」→ `GDrive/` 配下にツリーが生成される

## 日常の使い方

- ファイルを開く → その場でダウンロードされ表示（2回目以降はキャッシュ、リモート更新があれば再取得）
- 編集 → 数秒後に自動アップロード
- リボンの同期アイコン / コマンド「今すぐ同期」→ 保留分の送信 + リモート差分の取得
- アプリをフォアグラウンドに戻した時にも自動で差分同期

## 安全設計（重要）

- **空スタブで Drive を上書きしない**多層ガード（未取得ファイルの編集はアップロードされず警告）
- 削除は常に Drive の**ゴミ箱**へ（完全削除しない）
- 競合時は両方の版を保持（ローカル版は `名前 (conflict 日時).md`）
- オフライン編集は保持され、オンライン復帰時に自動送信

## 制限事項

- Google ドキュメント/スプレッドシート等のネイティブ形式、ショートカットは同期対象外
- 設定の「最大ファイルサイズ」（既定20MB）を超えるファイルはダウンロードしない
- Drive 上の同名ファイルは ` (1)` 連番で区別
- `drive.file` ではなくフル `drive` スコープが必要（Drive for Desktop が作るファイルを読むため）

## リリース手順（開発者向け）

```
npm version patch   # manifest.json / versions.json も自動更新される
git push && git push --tags
```

タグを push すると GitHub Actions がビルドし、`main.js` と `manifest.json` を添付したリリースを自動作成します。BRAT はこのリリースを見て更新します。
