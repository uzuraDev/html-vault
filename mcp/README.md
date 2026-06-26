# html-vault MCP server

A small [MCP](https://modelcontextprotocol.io) server that lets an MCP client
(Claude Code, Claude Desktop, etc.) save model-generated HTML straight into your
self-hosted HTML Vault — so you can view it later on any device.

It authenticates with the vault's **API token** (`Authorization: Bearer`), not the
browser login, so it works headless.

> **Using claude.ai, Claude chat, or the mobile app instead?** Those connect to the
> vault's built-in **remote** MCP endpoint (`/mcp/<MCP_SECRET_PATH>`), not this stdio
> server — no separate process to run. See
> [main README → MCP integration, Section B](../README.md#mcp-integration-headless-upload).
> This stdio server is for **local** clients like Claude Code / Claude Desktop.

## Tools

| Tool | What it does |
|------|------|
| `upload_html(html, title?, tags?)` | Create a snippet. Title defaults to the HTML `<title>`/`<h1>`. |
| `list_snippets(limit?)` | List stored snippets (title / tags / size / updated). |

## Setup

1. **Enable the token on the vault.** Set `API_TOKEN` in the vault's `.env`
   (generate one with `openssl rand -hex 32`), then restart it. See the
   [main README](../README.md#mcp-integration-headless-upload).

2. **Install deps:**

   ```bash
   cd mcp
   npm install
   ```

3. **Register the server** with your MCP client. Example for Claude Code
   (`.mcp.json`):

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

## Environment

| Variable | Default | Description |
|------|------|------|
| `VAULT_URL` | `http://127.0.0.1:3000` | Base URL of your vault (use its public URL if deployed). |
| `VAULT_API_TOKEN` | — | Must equal the vault's `API_TOKEN`. Required. |

## Notes

- The token grants snippet create/list. Keep it secret; rotate by changing
  `API_TOKEN` on the vault and updating `VAULT_API_TOKEN`.
- Token requests skip CSRF (header auth is not auto-sent by browsers, so it
  isn't a CSRF vector). The browser/cookie flow still uses CSRF.
- `upload_html` is meant to run only when you explicitly ask to save — the tool
  description tells the model not to upload on every generation.
