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

## Dependencies

Keep them minimal (native builds break multi-arch images). `.github/dependabot.yml` tracks
five ecosystems on a weekly schedule: three npm manifests — `/` (Express edition), `/mcp`,
`/worker` (Workers edition) — plus the Dockerfile and the GitHub Actions workflows.

What `npm audit` covers, and what it deliberately does not:

| Where | Command | Notes |
|---|---|---|
| `/` | `npm audit --omit=dev --audit-level=high` | Runs in CI (`audit` job). What reaches users. |
| `/worker` | `npm run audit` | No runtime dependencies, so CI's `--omit=dev` run is a no-op. This one includes `wrangler`. |
| `/mcp` | — | **Not audited**: no `package-lock.json`, so `npm audit` cannot run there. |

The `audit` job is intentionally *not* a required status check. Its result depends on the
npm advisory DB and registry availability, not on this repository, so a new advisory
against `express` would otherwise block every open PR — including ones that have nothing
to do with it. Treat a red `audit` as a signal to triage, not as a merge gate.

Build-time dependencies (`wrangler` and its tree) are triaged separately from runtime ones:
they are not part of the Docker image or the Worker bundle, so an advisory there is not
user-facing and is usually not worth forcing a version.

When reviewing a dependency bump, weigh the risk against the payoff. A bump with **no**
security content that pulls a **prerelease** (`-alpha` / `-beta` / `-rc`) into the local dev
runtime — `miniflare` / `workerd`, which back `wrangler dev` and therefore the
`worker-smoke` test — is not worth taking. Wait for the stable release. Dependabot PRs
auto-merge once the required checks pass, so if `worker-smoke` is not registered in the
branch protection, nothing will catch that on your behalf.

When you do take a `/worker` bump, verify it locally before merging: `npm test` (spawns
`wrangler dev`) and `npx wrangler deploy --dry-run` (bundles without uploading), both in
`worker/`. See [worker/README](worker/README.md#dependencies).

## PRs

Fork → branch → test locally (login → save → preview → delete → restart) → PR explaining what and why. Match the existing style; keep dependencies minimal (native builds break multi-arch images).

## Reporting

- Bugs: include repro steps, environment, and logs (redact secrets).
- Vulnerabilities: use GitHub Security → "Report a vulnerability" (not a public issue).

Contributions are licensed under [MIT](LICENSE).
