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

## PR

Fork → ブランチ → ローカルで確認（ログイン → 保存 → プレビュー → 削除 → 再起動）→ 何を・なぜ変えたか説明。既存スタイルに合わせ、依存は最小限に（ネイティブビルドはマルチアーキを壊す）。

## 報告

- バグ: 再現手順・環境・ログ（秘密は伏せる）を添えて。
- 脆弱性: 公開 Issue ではなく GitHub Security → "Report a vulnerability" から。

貢献は [MIT](LICENSE) の下で公開されます。
