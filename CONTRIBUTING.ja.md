# コントリビュート

[English](CONTRIBUTING.md) | **日本語**

バグ報告・機能提案・ドキュメント・PR を歓迎します。大きめの変更はまず Issue で相談してください。

## セットアップ

```bash
docker compose up -d        # または: npm install && npm start
```

## スコープ

- **やる**: 生成済み HTML の保存と安全なプレビュー、セルフホストのしやすさ。
- **やらない**: HTML の生成、マルチユーザー/共有。

## 壊さないこと

既存のセキュリティを壊さないでください: CSRF トークン、`sandbox` プレビュー（`allow-same-origin` なし）、ログインレート制限、helmet/CSP、サーバー採番のファイル ID。`.env` / `data/` は決してコミットしない。

## i18n

文言は [`locales/en.json`](locales/en.json) / [`locales/ja.json`](locales/ja.json) にあり、ビルド時（`APP_LANG`）に焼き込まれます。**両方**のファイルにキーを追加し、HTML は `public/index.template.html` の `{{key}}`、JS は `T.key` を使用。`npm run build:i18n` 実行後 `{{placeholder}}` が残らないこと。

## 依存関係

依存は最小限に（ネイティブビルドはマルチアーキを壊す）。`.github/dependabot.yml` が週次で
追跡しているのは5系統です: npm のマニフェスト3つ（`/`（Express 版）・`/mcp`・
`/worker`（Workers 版））と、Dockerfile・GitHub Actions のワークフロー。

`npm audit` が見ているもの／意図的に見ていないもの:

| 場所 | コマンド | 補足 |
|---|---|---|
| `/` | `npm audit --omit=dev --audit-level=high` | CI の `audit` ジョブで実行。利用者に届く依存。 |
| `/worker` | `npm run audit` | 本番依存が無いので CI の `--omit=dev` は空振りする。こちらは `wrangler` も見る。 |
| `/mcp` | — | **監査対象外**。`package-lock.json` が無く `npm audit` を実行できない。 |

`audit` ジョブは意図的に必須チェックに入れていません。結果を決めるのはリポジトリの中身ではなく
npm advisory DB とレジストリの可用性なので、必須にすると `express` に新しい勧告が出た瞬間、
それと無関係な PR まで含めて全部マージできなくなります。赤い `audit` は「マージを止める合図」
ではなく「調べる合図」として扱ってください。

ビルド時の依存（`wrangler` とその依存木）は本番依存とは分けて判断します。Docker イメージにも
Workers バンドルにも載らないため、そこに勧告が出ても利用者には届かず、無理にバージョンを
動かす価値は通常ありません。

依存の更新を判断するときは、リスクと見返りを比べてください。ローカル実行環境（`wrangler dev`
を支える `miniflare` / `workerd`、すなわち `worker-smoke` テストの土台）に**プレリリース**
（`-alpha` / `-beta` / `-rc`）を持ち込む更新は、まずスモークテストと dry-run ビルドを通し、
どちらも緑なら取る、という順序で判断します。プレリリースが利用者に届くことはありません
（これらは devDependencies で、デプロイされた Worker は Cloudflare 自身のランタイムで動きます）。
Dependabot の PR は必須チェックが緑になり次第自動マージされるので、`worker-smoke` がブランチ
保護に登録されていなければ、壊れた開発環境を止めてくれる仕組みは存在しません。

`/worker` の更新を取り込むときは、マージ前に `worker/` で `npm test`（`wrangler dev` を
起動する）と `npx wrangler deploy --dry-run`（アップロードせずバンドルするだけ）を実行して
確認してください。詳細は [worker/README](worker/README.md#dependencies)。

## PR

Fork → ブランチ → ローカルで確認（ログイン → 保存 → プレビュー → 削除 → 再起動）→ 何を・なぜ変えたか説明。既存スタイルに合わせ、依存は最小限に（ネイティブビルドはマルチアーキを壊す）。

## 報告

- バグ: 再現手順・環境・ログ（秘密は伏せる）を添えて。
- 脆弱性: 公開 Issue ではなく GitHub Security → "Report a vulnerability" から。

貢献は [MIT](LICENSE) の下で公開されます。
