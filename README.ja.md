# HTML Vault

[English](README.md) | **日本語**

AI が生成した HTML を、そのままブラウザで開かない。HTML Vault は HTML スニペットを保存し、隔離された `sandbox` iframe でプレビューする、パスワード認証付きの保管庫です。すべてのスニペットを「信頼しない」前提で扱います。Cloudflare Workers に数分でデプロイでき、Docker でのセルフホストも可能です。

LLM（Claude / ChatGPT のアーティファクト、AI 解説資料、ダッシュボードなど）で生成した HTML を、第三者のオンラインツールに貼り付ける代わりに、自分のインフラ上で保存・安全にプレビューしたい人向けです。個人開発の初期段階の OSS なので、フィードバックや Issue を歓迎します。

> 💡 **[ライブデモ](https://html-vault-demo.uzuradev.workers.dev)**（閲覧専用）— AI が生成した実物のスニペットを sandbox ビューアで閲覧できます。さらに [MCP 連携](#mcp-連携ヘッドレスアップロード)を使えば、Claude が会話中に生成した HTML をそのまま Vault へアップロードできます（手作業の保存・アップロード不要）。

![screenshot](docs/screenshot.png)

## ⚡ クイックスタート — Cloudflare Workers（推奨）

Workers の無料枠で動きます。管理するサーバーなし、常時稼働。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/uzuraDev/html-vault/tree/main/worker)

手動でセットアップする場合：

```bash
git clone https://github.com/uzuraDev/html-vault.git && cd html-vault/worker
npm install
npx wrangler login
npx wrangler kv namespace create VAULT   # 出力された id を wrangler.toml に貼る
npm run setpass                          # ログインパスワード（PBKDF2 ハッシュを AUTH_HASH Secret へ保存）
npx wrangler secret put SESSION_SECRET   # openssl rand -hex 32 等で生成した値
npm run deploy
```

> 初回の `setpass` / `secret put` の時点では Worker がまだ存在しないため、wrangler が新規（draft）Worker を作成するか確認してきます。yes で続行してください。

これで `https://html-vault.<あなたのサブドメイン>.workers.dev` で Vault が動きます。詳細は [worker/README.md](worker/README.md)。

### Secrets / Vars

Secret は `npx wrangler secret put <名前>`（`worker/` 内で実行）で設定します。Var は `wrangler.toml` に書きます。

| 名前 | 種別 | 必須 | 説明 |
|------|------|------|------|
| `AUTH_HASH` | Secret | 必須 | ログインパスワードの PBKDF2 ハッシュ。`npm run setpass` で設定 |
| `SESSION_SECRET` | Secret | 必須 | セッション Cookie の HMAC 鍵（`openssl rand -hex 32`） |
| `API_TOKEN` | Secret | 任意 | ヘッドレス API 用の Bearer トークン。[stdio MCP サーバ](#mcp-連携ヘッドレスアップロード)を有効化 |
| `MCP_SECRET_PATH` | Secret | 任意 | リモート MCP エンドポイント `/mcp/<MCP_SECRET_PATH>` を有効化（未設定なら 404）。生成例: `openssl rand -hex 24` |
| `SECURITY_CONTACT` | Secret | 任意 | `/.well-known/security.txt` で配信する連絡先（未設定なら 404） |
| `DEMO_MODE` | Var | 任意 | `"1"` でデプロイを公開・読み取り専用デモにする |

カスタムドメインは任意です。Cloudflare ダッシュボード（対象 Worker → Domains & Routes）から追加できます。既定の `*.workers.dev` URL のままでも動きます。

読み取り専用の公開デモを自分で立てたい場合は `DEMO_MODE = "1"` を設定してください。閲覧は公開になり、書き込みはすべて 403 を返します。**必ずデモ専用の KV ネームスペース**（[`worker/scripts/seed-demo.mjs`](worker/scripts/seed-demo.mjs) で投入）に対してのみ有効化してください。DEMO_MODE はバインドされたネームスペース内の全スニペットをログインなしで公開するため、本番 Vault のネームスペースには絶対に設定しないでください。

## MCP 連携（ヘッドレスアップロード）

生成した HTML を、会話中に直接 Vault へ保存できます。接続元によって 2 つの経路があります。多くの人におすすめの B（内蔵リモート MCP）を意図的に先に、A（ローカルクライアント向け stdio）を後に載せています。

### B. claude.ai / スマホアプリ — リモート MCP（内蔵・推奨）

claude.ai の「カスタムコネクター」に登録すると、Claude（Web 版・**スマホアプリ**）が会話中に生成した HTML を `upload_html` ツールで Vault に保存できます。別途 MCP サーバを動かす必要はなく、本体が `/mcp/<MCP_SECRET_PATH>` を提供します。

- **トランスポート**: Streamable HTTP / ステートレス（JSON 応答。追加依存なし）
- **ツール**: `upload_html`（書き込み）/ `list_snippets`（読み取り）
- **認証**: authless + 秘匿パス。`MCP_SECRET_PATH` 未設定なら `/mcp` は常に 404（無効）

セットアップ:

1. **公開 HTTPS で到達可能にする**（必須。claude.ai は Anthropic のクラウドから接続するため、`localhost` / LAN 内 / VPN 内のサーバには繋がりません）。**Workers 版なら最初から満たしています**：`*.workers.dev` の URL がそのまま公開 HTTPS です。Docker 版はリバースプロキシ + ドメイン + TLS、または Cloudflare Tunnel 等で公開してください（[deploy/](deploy) 参照）。
2. 秘匿文字列を生成（`openssl rand -hex 24`）して `MCP_SECRET_PATH` に設定 — Workers 版: `npx wrangler secret put MCP_SECRET_PATH`。Docker 版: `.env` に設定して再起動。
3. claude.ai → Customize > Connectors → **Add custom connector** に URL を貼る：
   ```
   https://<あなたのWorker>.<あなたのサブドメイン>.workers.dev/mcp/<MCP_SECRET_PATH>
   ```
   （Docker 版は自分のドメインに読み替え。）authless なので OAuth 欄は不要。Web / デスクトップで登録すればスマホアプリにも同期されます。
4. 会話で「この HTML を vault に上げて」と頼む。`upload_html` を「常に許可」にすると以降ほぼ自動。

動作確認:
```bash
curl -s -X POST https://<あなたのWorker>.<あなたのサブドメイン>.workers.dev/mcp/<MCP_SECRET_PATH> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
（Docker 版は URL を `http://localhost:3000/mcp/<MCP_SECRET_PATH>` か自分のドメインに読み替えてください。）

> ⚠️ **秘匿 URL は認証ではありません。** URL が漏れると誰でも書き込めます。共有・スクリーンショット・ログ流出に注意し、不要になったら `MCP_SECRET_PATH` を変更してローテートしてください。より強固にするなら前段の OAuth / Cloudflare Access 等の併用を検討。

### A. ローカル MCP クライアント（Claude Code など）— stdio MCP

1. Vault に `API_TOKEN` を設定（例: `openssl rand -hex 32`）— Workers 版: `npx wrangler secret put API_TOKEN`。Docker 版: `.env` に設定して再起動。トークンを設定すると、`POST /api/snippets` と `GET /api/snippets` が `Authorization: Bearer <API_TOKEN>` でも通ります（この2つはログイン/CSRF 不要）。未設定ならトークン認証は無効（既定）。
2. 同梱の MCP サーバ [`mcp/`](mcp) を起動し、クライアントに登録する。`.mcp.json` の例と `upload_html` / `list_snippets` ツールは [mcp/README.ja.md](mcp/README.ja.md) を参照。

トークンは書き込み権限です。秘匿し、公開時は HTTPS を使い、`API_TOKEN` を変えればローテートできます。トークン認証は CSRF の対象外（`Bearer` ヘッダはブラウザが自動付与しない＝CSRF経路にならない）。Cookie/セッション経由は従来どおり CSRF を要求します。

## セキュリティ

コアの防御は両実装（Workers / Docker）で共通です：

| 脅威 | 対策（両実装共通） |
|------|------|
| 保存HTMLのXSS | `sandbox` iframe（`allow-same-origin` なし）で隔離。生 HTML への直接アクセスにも `Content-Security-Policy: sandbox` ヘッダを付与。ソースは `text/plain` で配信 |
| 他人のアクセス | ログイン必須・ログインレート制限（15分10回） |
| CSRF | 変更系APIにダブルサブミットトークン |
| パストラバーサル | サーバー採番・16進32文字のみ |

実装ごとの違い：

- **Docker 版**: bcrypt によるパスワードハッシュ、helmet によるセキュリティヘッダ、サーバー側セッション + HttpOnly / `SameSite=Strict` /（HTTPS時）Secure Cookie
- **Workers 版**: PBKDF2-SHA256 によるパスワードハッシュ、手書きのセキュリティヘッダ、ステートレスな HMAC 署名 Cookie（HttpOnly / `SameSite=Lax` / Secure）+ timing-safe 比較

セルフホストで公開する場合は HTTPS と固定 `SESSION_SECRET` を。必要なら前段に Basic 認証 / Cloudflare Access を追加。

注意: パスワードの自動生成・ログ出力はしません。setpass（Workers 版: `npm run setpass`、Docker 版: `setpass.js` か `AUTH_PASSWORD`）で初回ログインを作成してください。プレビュー先からの外向き通信（外部画像/スクリプト/フォーム）は可能なので、信頼できない HTML を開くなら CSP で制限を。

## 🐳 Docker / セルフホスト（上級者向け）

完全オフラインで動かしたい、データを自分のディスクに置きたい、深くカスタマイズしたい人向け。同じアプリが 1 つの Docker イメージとして、VPS / Fly.io / Render / 自宅サーバー・Raspberry Pi で動きます。

### 60秒で試す

```bash
docker run -p 3000:3000 -e AUTH_PASSWORD=change-me ghcr.io/uzuradev/html-vault:latest
```

**http://localhost:3000** を開き、設定した `AUTH_PASSWORD` でログイン。この使い捨て実行ではデータはメモリ上のみです。永続化するにはボリュームを追加: `-v "$PWD/data:/data"`。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/uzuraDev/html-vault)

ボタンはリポジトリの `render.yaml` Blueprint を使います。Fly.io / Render / セルフホストの詳細は下の[デプロイ](#デプロイ)を参照。

### クイックスタート（compose）

```bash
cp .env.example .env        # AUTH_PASSWORD（と SESSION_SECRET）を設定
docker compose up -d
```

**http://localhost:3000** を開き、`AUTH_PASSWORD` でログイン。パスワードの自動生成・ログ出力はしません。未設定なら `docker compose exec html-vault node setpass.js` で作成（変更も同様）。

### 表示言語（ビルド時）

UI とサーバメッセージはビルド時に焼き込まれます（ランタイム切替なし）。`APP_LANG`（`en`/`ja`、既定 `en`）で選択：

- **Docker**: `.env` に設定して `docker compose up -d --build`
- **Node**: `APP_LANG=ja npm start`

文言は [`locales/`](locales) にあります。ロケールファイルをコピーして翻訳すれば言語を追加できます。

（Workers 版はランタイム切替です。ヘッダーの EN/日本語 トグルで切り替わり、再ビルドは不要。）

### 環境変数

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
| `API_TOKEN` | 未設定（無効） | ヘッドレスAPI用の Bearer トークン（`POST`/`GET /api/snippets`）。[stdio MCPサーバ](#mcp-連携ヘッドレスアップロード)を有効化 |
| `MCP_SECRET_PATH` | 未設定（無効） | claude.ai 等のリモート MCP コネクター用。`/mcp/<MCP_SECRET_PATH>` を有効化（未設定なら 404）。生成例: `openssl rand -hex 24` |

### デプロイ

- **VPS / 自宅 / Raspberry Pi**: `docker compose up -d`。公開時は HTTPS 必須（セキュリティ参照）。詳細: [deploy/DEPLOY.ja.md](deploy/DEPLOY.ja.md)。Cloudflare Tunnel: [deploy/CLOUDFLARE.ja.md](deploy/CLOUDFLARE.ja.md)。
- **公開イメージ**: `ghcr.io/uzuradev/html-vault:latest`（`docker-compose.yml` の `build:` を `image:` に置換）。
- **Fly.io**: `fly.toml` 同梱 — `fly launch --no-deploy`、ボリューム作成、`SESSION_SECRET` 設定、`fly deploy`。
- **Render**: `render.yaml` 同梱（永続ディスクは有料インスタンスが必要）。

### バックアップ

データはすべて `data/`。アーカイブするだけ：

```bash
tar czf html-vault-backup-$(date +%F).tar.gz data/
```

（Workers 版のデータは KV ネームスペース `VAULT` にあります。コピーが欲しい場合は `npx wrangler kv key list` / `get` でエクスポートできます。）

## コントリビュート / ライセンス

[CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)（[English](CONTRIBUTING.md)）· [MIT](LICENSE)
