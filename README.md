# HTML Vault

**English** | [日本語](README.ja.md)

Self-hostable, password-protected vault to store and safely preview (sandboxed iframe) your HTML snippets. One Docker image runs on a VPS, Fly.io, Render, a home server, or a Raspberry Pi.

![screenshot](docs/screenshot.png)

It's aimed at people who generate HTML with LLMs (Claude / ChatGPT artifacts, AI explainers, dashboards) and want to store and safely preview those snippets on their own infrastructure instead of pasting them into third-party online tools. This is an early solo OSS project — feedback and issues are welcome.

> 💡 **Upload straight from your AI client.** Set up the bundled MCP server and an MCP client (e.g. Claude Code) can push generated HTML into the vault for you — no manual save/upload — then you read it on any device. See [MCP integration](#mcp-integration-headless-upload).

## Try it in 60 seconds

```bash
docker run -p 3000:3000 -e AUTH_PASSWORD=change-me ghcr.io/uzuradev/html-vault:latest
```

Open **http://localhost:3000** and log in with the `AUTH_PASSWORD` you set. No password is ever auto-generated or written to the logs. Data is in-memory for this throwaway run; to persist it, add a volume: `-v "$PWD/data:/data"`.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/uzuraDev/html-vault)

The button uses the repo's `render.yaml` blueprint. See [Deploy](#deploy) below for Fly.io, Render, and self-hosting details.

## Quick start

```bash
cp .env.example .env        # set AUTH_PASSWORD (and SESSION_SECRET)
docker compose up -d
```

Open **http://localhost:3000** and log in with `AUTH_PASSWORD`. No password is auto-generated or logged — if you didn't set `AUTH_PASSWORD`, create one with `docker compose exec html-vault node setpass.js` (also used to change it later).

## Language (build-time)

UI and server messages are baked in at build time — no runtime switcher. Set `APP_LANG` (`en`/`ja`, default `en`):

- **Docker**: set it in `.env`, then `docker compose up -d --build`
- **Node**: `APP_LANG=ja npm start`

Strings live in [`locales/`](locales). Add a language by copying a locale file and building with that `APP_LANG`.

## Environment variables

| Variable | Default | Description |
|------|------|------|
| `PORT` | `3000` | Host port (container is fixed to 3000); listen port for plain Node |
| `HOST` | `0.0.0.0` / `127.0.0.1` (Node) | Bind address |
| `SESSION_SECRET` | random each boot | Session signing key. Set a fixed value in production (`openssl rand -hex 32`) |
| `BEHIND_HTTPS` | `0` | Set `1` behind a TLS-terminating proxy (enables Secure cookies) |
| `DATA_DIR` | `/data` / `./data` (Node) | Data directory |
| `MAX_UPLOAD_MB` | `10` | Max HTML size (MB) |
| `AUTH_PASSWORD` | unset | First-login password (or run `setpass.js`). Used only until `auth.json` exists |
| `APP_LANG` | `en` | UI/message language (`en`/`ja`), applied at build time |
| `API_TOKEN` | unset (disabled) | Bearer token for headless API access (`POST`/`GET /api/snippets`). Powers the [MCP server](#mcp-integration-headless-upload). |

## Deploy

- **VPS / home / Raspberry Pi**: `docker compose up -d`. Use HTTPS when public (see Security). Details: [deploy/DEPLOY.md](deploy/DEPLOY.md). Cloudflare Tunnel: [deploy/CLOUDFLARE.md](deploy/CLOUDFLARE.md).
- **Prebuilt image**: `ghcr.io/uzuradev/html-vault:latest` (replace `build:` with `image:` in `docker-compose.yml`).
- **Fly.io**: `fly.toml` included — `fly launch --no-deploy`, create a volume, set `SESSION_SECRET`, `fly deploy`.
- **Render**: `render.yaml` Blueprint included (persistent disk needs a paid instance).

## Security

| Threat | Mitigation |
|------|------|
| Unauthorized access | Login required, bcrypt, rate limit (10 / 15 min) |
| XSS from stored HTML | Preview in `sandbox` iframe (no `allow-same-origin`); source as `text/plain` |
| Session hijacking | HttpOnly / SameSite=Strict / Secure (HTTPS) cookie |
| CSRF | Double-submit token on mutating APIs |
| Path traversal | Server-generated IDs, 32-hex only |
| Headers | CSP / X-Frame-Options via helmet |

When public: use HTTPS and a fixed `SESSION_SECRET`. Optionally add a front gate (Basic auth / Cloudflare Access).

Notes: no password is auto-generated or written to logs — set `AUTH_PASSWORD` or run `setpass.js` to create the first login. Previewed HTML can still make outbound requests (external images/scripts/forms); restrict via a CSP if you open untrusted HTML.

## MCP integration (headless upload)

Save model-generated HTML straight into the vault from an MCP client (e.g. Claude Code), then view it later on any device.

1. Set an `API_TOKEN` on the vault (`.env`, e.g. `openssl rand -hex 32`) and restart. With a token set, `POST /api/snippets` and `GET /api/snippets` also accept `Authorization: Bearer <API_TOKEN>` — no login/CSRF needed for those. Leave `API_TOKEN` unset to disable token auth (default).
2. Run the bundled MCP server in [`mcp/`](mcp) and register it with your client. See [mcp/README.md](mcp/README.md) for the `.mcp.json` example and the `upload_html` / `list_snippets` tools.

The token is a write credential — keep it secret, prefer HTTPS, and rotate it by changing `API_TOKEN`. Token requests skip CSRF (a `Bearer` header isn't auto-attached by browsers, so it isn't a CSRF vector); the cookie/session flow still enforces CSRF.

## Backups

All data is under `data/`. Archive it:

```bash
tar czf html-vault-backup-$(date +%F).tar.gz data/
```

## Roadmap

- Full-text body search (currently title/tag only)
- Persistent session store (restarts currently require re-login; data is kept)
- Snippet export/import

## Contributing / License

[CONTRIBUTING.md](CONTRIBUTING.md) ([日本語](CONTRIBUTING.ja.md)) · [MIT](LICENSE)
