#!/usr/bin/env node
/**
 * html-vault MCP server — save generated HTML into a self-hosted HTML Vault.
 *
 * Exposes two tools over stdio (Model Context Protocol), so an MCP client
 * (Claude Code, Claude Desktop, etc.) can store HTML the model just produced:
 *   - upload_html(html, title?, tags?)  create a snippet
 *   - list_snippets(limit?)             list stored snippets
 *
 * Auth uses the vault's API token (no browser/CSRF flow):
 *   Authorization: Bearer <VAULT_API_TOKEN>
 * Set API_TOKEN on the vault (see ../README.md) and pass the same value here.
 *
 * Env:
 *   VAULT_URL        base URL of the vault (default http://127.0.0.1:3000)
 *   VAULT_API_TOKEN  must equal the vault's API_TOKEN (required)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VAULT_URL = (process.env.VAULT_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const VAULT_API_TOKEN = process.env.VAULT_API_TOKEN || "";

/** Guess a display title from the HTML (<title> -> <h1> -> "Untitled"). */
function guessTitle(html) {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t && t[1].trim()) return t[1].trim().slice(0, 120);
  const h = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h) {
    const text = h[1].replace(/<[^>]+>/g, "").trim();
    if (text) return text.slice(0, 120);
  }
  return "Untitled";
}

/** Call the vault API with the bearer token. */
async function vaultFetch(pathname, init = {}) {
  if (!VAULT_API_TOKEN) {
    throw new Error(
      "VAULT_API_TOKEN is not set. Set API_TOKEN on the vault and pass the same value as VAULT_API_TOKEN here."
    );
  }
  const res = await fetch(`${VAULT_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${VAULT_API_TOKEN}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Vault API error (${res.status}): ${(body && body.error) || `HTTP ${res.status}`}`);
  }
  return body;
}

const server = new McpServer({ name: "html-vault", version: "1.0.0" });

server.registerTool(
  "upload_html",
  {
    title: "Upload HTML to the vault",
    description:
      "Save a generated HTML snippet to the self-hosted HTML Vault. " +
      "Call this ONLY when the user explicitly asks to save/upload (e.g. \"save it to the vault\", \"upload this\"). " +
      "Do not upload on every HTML generation. After saving, the snippet is viewable from any device by logging into the vault.",
    inputSchema: {
      html: z.string().describe("The full HTML document to store (a complete, self-contained file)."),
      title: z.string().optional().describe("List display name. Defaults to the HTML <title>/<h1> if omitted."),
      tags: z.string().optional().describe("Comma-separated tags (optional)."),
    },
  },
  async ({ html, title, tags }) => {
    if (!html || !html.trim()) {
      return { isError: true, content: [{ type: "text", text: "html is empty." }] };
    }
    const resolvedTitle = (title && title.trim()) || guessTitle(html);
    try {
      const body = await vaultFetch("/api/snippets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, title: resolvedTitle, tags: tags || "" }),
      });
      const snip = body.snippet || {};
      return {
        content: [
          {
            type: "text",
            text:
              `Saved "${snip.title}" (${snip.bytes} bytes). Open ${VAULT_URL} and it appears at the top of the list.\n` +
              JSON.stringify({
                ok: true,
                id: snip.id,
                title: snip.title,
                bytes: snip.bytes,
                viewUrl: VAULT_URL,
                previewUrl: snip.id ? `${VAULT_URL}/api/snippets/${snip.id}/preview` : undefined,
              }),
          },
        ],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
    }
  }
);

server.registerTool(
  "list_snippets",
  {
    title: "List vault snippets",
    description: "List snippets stored in the HTML Vault (title / tags / size / updated time).",
    inputSchema: {
      limit: z.number().int().positive().max(100).optional().describe("Max items (default 20)."),
    },
  },
  async ({ limit }) => {
    try {
      const body = await vaultFetch("/api/snippets", { method: "GET" });
      const list = (body.snippets || []).slice(0, limit || 20).map((s) => ({
        id: s.id,
        title: s.title,
        tags: s.tags,
        bytes: s.bytes,
        updated: new Date(s.updated).toISOString(),
      }));
      return { content: [{ type: "text", text: `${list.length} item(s)\n` + JSON.stringify(list, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
