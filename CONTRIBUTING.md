# Contributing

**English** | [日本語](CONTRIBUTING.ja.md)

Bug reports, feature ideas, docs, and PRs are welcome. For non-trivial changes, please open an issue first.

## Setup

```bash
docker compose up -d        # or: npm install && npm start
```

## Scope

- **In**: storing and safely previewing existing HTML; easy self-hosting.
- **Out**: HTML generation; multi-user/sharing.

## Keep intact

Don't break the existing security: CSRF token, `sandbox` preview (no `allow-same-origin`), login rate limit, helmet/CSP headers, server-generated file IDs. Never commit `.env` / `data/`.

## i18n

User-facing strings live in [`locales/en.json`](locales/en.json) / [`locales/ja.json`](locales/ja.json) and are baked at build time (`APP_LANG`). Add a key to **both** files; HTML uses `{{key}}` in `public/index.template.html`, JS uses `T.key`. Run `npm run build:i18n` and confirm no `{{placeholder}}` remains.

## PRs

Fork → branch → test locally (login → save → preview → delete → restart) → PR explaining what and why. Match the existing style; keep dependencies minimal (native builds break multi-arch images).

## Reporting

- Bugs: include repro steps, environment, and logs (redact secrets).
- Vulnerabilities: use GitHub Security → "Report a vulnerability" (not a public issue).

Contributions are licensed under [MIT](LICENSE).
