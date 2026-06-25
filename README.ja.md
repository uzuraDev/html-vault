# HTML Vault

[English](README.md) | **日本語**

生成済み HTML スニペットを保存し、安全に（sandbox iframe で）プレビューできる、パスワード認証付きのセルフホスト Web アプリ。同じ Docker イメージが VPS / Fly.io / Render / 自宅サーバー・Raspberry Pi で動きます。

LLM（Claude / ChatGPT のアーティファクト、AI 解説資料、ダッシュボードなど）で生成した HTML を、第三者のオンラインツールに貼り付ける代わりに、自分のインフラ上で保存・安全にプレビューしたい人向けです。個人開発の初期段階の OSS なので、その前提でフィードバックを歓迎します。

> 💡 **AI クライアントから直接アップロード。** 同梱の MCP サーバを設定すれば、MCP クライアント（例: Claude Code）が生成した HTML を手作業なしで Vault に保存してくれます。あとはスマホなど任意の端末で読むだけ。詳細は [MCP 連携](#mcp-連携ヘッドレスアップロード)。

![screenshot](docs/screenshot.png)

## 60秒で試す

ビルド済みイメージを 1 コマンドで起動できます：

```bash
docker run -p 3000:3000 -e AUTH_PASSWORD=change-me ghcr.io/uzuradev/html-vault:latest
```

**http://localhost:3000** を開き、設定した `AUTH_PASSWORD` でログイン。パスワードの自動生成・ログ出力は一切しません。データを永続化したい場合は任意で `-v $(pwd)/data:/data` を付けます（最小構成では不要）。

Render にワンクリックでデプロイ（リポジトリの `render.yaml` Blueprint を使用）：

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/uzuraDev/html-vault)

## クイックスタート

```bash
cp .env.example .env        # AUTH_PASSWORD（と SESSION_SECRET）を設定
docker compose up -d
```

**http://localhost:3000** を開き、`AUTH_PASSWORD` でログイン。パスワードの自動生成・ログ出力はしません。未設定なら `docker compose exec html-vault node setpass.js` で作成（変更も同様）。

## 表示言語（ビルド時）

UI とサーバメッセージはビルド時に焼き込まれます（ランタイム切替なし）。`APP_LANG`（`en`/`ja`、既定 `en`）で選択：

- **Docker**: `.env` に設定して `docker compose up -d --build`
- **Node**: `APP_LANG=ja npm start`

文言は [`locales/`](locales) にあります。ロケールファイルをコピーして翻訳すれば言語を追加できます。

## 環境変数

| 変数 | 既定 | 説明 |
|------|------|------|
| `PORT` | `3000` | ホスト公開ポート（コンテナ内は 3000 固定）。素の Node では待受ポート |
| `HOST` | `0.0.0.0` / `127.0.0.1`（Node） | 待受アドレス |
| `SESSION_SECRET` | 毎回ランダム | セッション署名鍵。本番は固定値推奨（`openssl rand -hex 32`） |
| `BEHIND_HTTPS` | `0` | TLS 終端プロキシ背後なら `1`（Secure Cookie 有効化） |
| `DATA_DIR` | `/data` / `./data`（Node） | データ保存先 |
| `MAX_UPLOAD_MB` | `10` | HTML 最大サイズ(MB) |
| `AUTH_PASSWORD` | 未設定 | 初回ログインのパスワード（または `setpass.js`）。`auth.json` 生成までのみ使用 |
| `APP_LANG` | `en` | UI/メッセージ言語（`en`/`ja`）。ビルド時に適用 |
| `API_TOKEN` | 未設定（無効） | ヘッドレスAPI用の Bearer トークン（`POST`/`GET /api/snippets`）。[MCPサーバ](#mcp-連携ヘッドレスアップロード)を有効化 |

## デプロイ

- **VPS / 自宅 / Raspberry Pi**: `docker compose up -d`。公開時は HTTPS 必須（セキュリティ参照）。詳細: [deploy/DEPLOY.ja.md](deploy/DEPLOY.ja.md)。Cloudflare Tunnel: [deploy/CLOUDFLARE.ja.md](deploy/CLOUDFLARE.ja.md)。
- **公開イメージ**: `ghcr.io/uzuradev/html-vault:latest`（`docker-compose.yml` の `build:` を `image:` に置換）。
- **Fly.io**: `fly.toml` 同梱 — `fly launch --no-deploy`、ボリューム作成、`SESSION_SECRET` 設定、`fly deploy`。
- **Render**: `render.yaml` 同梱（永続ディスクは有料インスタンスが必要）。

## セキュリティ

| 脅威 | 対策 |
|------|------|
| 他人のアクセス | ログイン必須・bcrypt・レート制限（15分10回） |
| 保存HTMLのXSS | `sandbox` iframe（`allow-same-origin` なし）で隔離。ソースは `text/plain` |
| セッション奪取 | HttpOnly / SameSite=Strict /（HTTPS時）Secure Cookie |
| CSRF | 変更系APIにダブルサブミットトークン |
| パストラバーサル | サーバー採番・16進32文字のみ |
| ヘッダ | helmet の CSP / X-Frame-Options |

公開時は HTTPS と固定 `SESSION_SECRET` を。必要なら前段に Basic 認証 / Cloudflare Access を追加。

注意: パスワードの自動生成・ログ出力はしません。`AUTH_PASSWORD` 設定か `setpass.js` で初回ログインを作成してください。プレビュー先からの外向き通信（外部画像/スクリプト/フォーム）は可能なので、信頼できない HTML を開くなら CSP で制限を。

## MCP 連携（ヘッドレスアップロード）

MCP クライアント（例: Claude Code）から、生成した HTML を直接 Vault に保存し、あとで任意の端末で閲覧できます。

1. Vault の `.env` に `API_TOKEN` を設定（例: `openssl rand -hex 32`）して再起動。トークンを設定すると、`POST /api/snippets` と `GET /api/snippets` が `Authorization: Bearer <API_TOKEN>` でも通ります（この2つはログイン/CSRF 不要）。未設定ならトークン認証は無効（既定）。
2. 同梱の MCP サーバ [`mcp/`](mcp) を起動し、クライアントに登録する。`.mcp.json` の例と `upload_html` / `list_snippets` ツールは [mcp/README.md](mcp/README.md) を参照。

トークンは書き込み権限です。秘匿し、公開時は HTTPS を使い、`API_TOKEN` を変えればローテートできます。トークン認証は CSRF の対象外（`Bearer` ヘッダはブラウザが自動付与しない＝CSRF経路にならない）。Cookie/セッション経由は従来どおり CSRF を要求します。

## バックアップ

データはすべて `data/`。アーカイブするだけ：

```bash
tar czf html-vault-backup-$(date +%F).tar.gz data/
```

## Roadmap

- 本文の全文検索（現在はタイトル/タグのみ）
- セッション永続化（現在は再起動で再ログイン。データは保持）
- スニペットのエクスポート/インポート

## コントリビュート / ライセンス

[CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)（[English](CONTRIBUTING.md)）· [MIT](LICENSE)
