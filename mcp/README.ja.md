# html-vault MCP server

[English](README.md) | **日本語**

MCP クライアント（Claude Code、Claude Desktop など）が、モデルの生成した HTML を
そのままセルフホストの HTML Vault に保存できるようにする、小さな [MCP](https://modelcontextprotocol.io)
サーバです。あとから任意の端末で閲覧できます。

認証はブラウザのログインではなく Vault の **API トークン**（`Authorization: Bearer`）を
使うため、ヘッドレスで動きます。

> **claude.ai やスマホアプリから使いたい場合は？** それらは Vault 内蔵の
> **リモート** MCP エンドポイント（`/mcp/<MCP_SECRET_PATH>`）に接続します。この stdio
> サーバではありません（別プロセスの起動も不要）。
> [メイン README → MCP 連携 のセクション B](../README.ja.md#mcp-連携ヘッドレスアップロード) を参照。
> この stdio サーバは Claude Code / Claude Desktop などの **ローカル** クライアント向けです。

## ツール

| ツール | 機能 |
|------|------|
| `upload_html(html, title?, tags?)` | スニペットを作成。title 未指定なら HTML の `<title>`/`<h1>` を使用。 |
| `list_snippets(limit?)` | 保存済みスニペットの一覧（title / tags / サイズ / 更新時刻）。 |

## セットアップ

1. **Vault 側でトークンを有効化。** Vault の `.env` に `API_TOKEN` を設定
   （`openssl rand -hex 32` で生成）して再起動。詳細は
   [メイン README](../README.ja.md#mcp-連携ヘッドレスアップロード) を参照。

2. **依存をインストール:**

   ```bash
   cd mcp
   npm install
   ```

3. **MCP クライアントにサーバを登録。** Claude Code の例（`.mcp.json`）:

   ```json
   {
     "mcpServers": {
       "html-vault": {
         "command": "node",
         "args": ["/absolute/path/to/mcp/server.mjs"],
         "env": {
           "VAULT_URL": "http://127.0.0.1:3000",
           "VAULT_API_TOKEN": "same value as the vault's API_TOKEN"
         }
       }
     }
   }
   ```

## 環境変数

| 変数 | 既定 | 説明 |
|------|------|------|
| `VAULT_URL` | `http://127.0.0.1:3000` | Vault のベース URL（公開済みなら公開 URL を指定）。 |
| `VAULT_API_TOKEN` | — | Vault の `API_TOKEN` と一致させる。必須。 |

## メモ

- このトークンはスニペットの作成/一覧の権限を持ちます。秘匿し、`API_TOKEN` を
  変更（と `VAULT_API_TOKEN` の更新）でローテートしてください。
- トークン認証は CSRF の対象外（ヘッダ認証はブラウザが自動付与しない＝CSRF 経路に
  ならない）。ブラウザ/Cookie 経由は従来どおり CSRF を要求します。
- `upload_html` は「保存して」と明示的に頼んだときだけ動く想定です。ツールの説明文で、
  生成のたびにアップロードしないようモデルに指示しています。
