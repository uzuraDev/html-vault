# HTML Vault — Cloudflare Workers edition

Run [HTML Vault](https://github.com/uzuraDev/html-vault) as a single Cloudflare Worker with KV storage. Free tier friendly, no server to keep alive. This directory is fully self-contained.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/uzuraDev/html-vault/tree/main/worker)

Public read-only live demo: <https://html-vault-demo.uzuradev.workers.dev>

## Deploy from the CLI

```sh
git clone https://github.com/uzuraDev/html-vault.git && cd html-vault/worker
npm install
npx wrangler login
npx wrangler kv namespace create VAULT   # paste the printed id into wrangler.toml
npm run setpass                          # login password (stores a PBKDF2 hash in the AUTH_HASH secret)
npx wrangler secret put SESSION_SECRET   # any long random string, e.g. `openssl rand -hex 32`
npm run deploy
```

> On the first `setpass` / `secret put`, the Worker does not exist yet, so wrangler
> asks whether to create a new (draft) Worker — answer yes and continue.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # set SESSION_SECRET
npm run setpass:local            # writes AUTH_HASH into .dev.vars
npm run dev                      # http://localhost:8787
```

## Configuration

| Name | Type | Description |
|---|---|---|
| `SESSION_SECRET` | Secret (required) | Signs session cookies. |
| `AUTH_HASH` | Secret (required) | PBKDF2 login hash — set via `npm run setpass`. |
| `API_TOKEN` | Secret (optional) | Enables `Authorization: Bearer` access for headless clients. |
| `MCP_SECRET_PATH` | Secret (optional) | Enables the remote MCP endpoint at `/mcp/<value>`. |
| `SECURITY_CONTACT` | Secret (optional) | Served in `/.well-known/security.txt` (e.g. `mailto:you@example.com`). Unset = 404. |
| `DEMO_MODE` | Var (optional) | `"1"` = public read-only demo; all writes return 403. **All reads become public** — only enable it on a dedicated demo KV namespace, never on your real vault. |

To seed a demo instance with sample pages, see `scripts/seed-demo.mjs` (seed a dedicated, empty demo namespace only).

## Dependencies

This edition ships **no runtime dependencies**. `wrangler` is the only entry in
`devDependencies`, and it is a build/deploy tool — nothing it pulls in ends up in the
Worker bundle that Cloudflare runs.

```sh
npm run audit    # npm audit --audit-level=high, devDependencies included
```

CI runs `npm audit --omit=dev` here, which is a no-op while there are no runtime
dependencies. `npm run audit` is the local counterpart that actually looks at the
build/deploy chain (wrangler → workerd / miniflare / esbuild / sharp).

Updates arrive as weekly Dependabot PRs (see the `/worker` entry in
`.github/dependabot.yml`). `miniflare` and `workerd` back `wrangler dev`, which is what
`npm test` runs against, so check what a bump does to those two before merging it:

```sh
node -e "const p=require('./package-lock.json').packages;for(const k of ['node_modules/miniflare','node_modules/workerd'])console.log(k,p[k]?.version)"
```

A **prerelease** (`-alpha` / `-beta` / `-rc`) there can break local development and the
smoke test, and no audit finding justifies taking one. **The command above is the source
of truth — the versions named here go stale.** At the time of writing (2026-07-31,
wrangler 4.116.0) both were stable (`miniflare 4.x`, `workerd 1.x`), and wrangler 4.117.0
moved `miniflare` to a `5.x-alpha`; that is the shape of the problem, not a standing fact.
Check the tree yourself before deciding on a bump:

```sh
npm view wrangler@<version> dependencies   # what the candidate pulls in
```

Deeper in the tree `unenv` and `youch` are already pinned to prereleases by wrangler
itself — those are upstream's choice and not something to act on.

After taking a bump, run the smoke test and a build before merging:

```sh
npm test                        # spawns `wrangler dev` — exercises miniflare / workerd
npx wrangler deploy --dry-run   # bundles with esbuild, uploads nothing
```

`npm test` needs `.dev.vars` (see [Local development](#local-development)). CI runs the
same smoke test in the `worker-smoke` job — but only as a *required* check if it is
registered in the branch protection, and Dependabot PRs auto-merge on the required checks
alone.

See [CONTRIBUTING](../CONTRIBUTING.md#dependencies) for the repo-wide policy.

## Limitations

- **Snippet metadata lives in a single KV `index` key**, updated read-modify-write. Workers KV has no transactions, so two writes landing at the same moment can drop one of them. This is a deliberate trade-off for a single-user personal vault — if you need multi-writer consistency, this design (and KV itself) is the wrong fit; Durable Objects or D1 would be the way to go.
- KV is eventually consistent: a new snippet may take a few seconds to appear in the list on other edge locations.

For full documentation (features, security model, Docker edition), see the [root README](../README.md).
