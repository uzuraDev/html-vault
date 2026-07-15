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

For full documentation (features, security model, Docker edition), see the [root README](../README.md).
