/**
 * HTML Vault — Cloudflare Workers 版
 *
 * 設計:
 *  - HTML本体/メタは KV (binding: VAULT) に保存
 *  - パスワードは PBKDF2(WebCrypto) 検証 (平文保存しない)
 *  - セッションは HMAC 署名 Cookie (ステートレス。サーバ側保存なし)
 *  - 変更系API は CSRF トークン必須 (セッションnonce由来のHMAC)
 *  - プレビューは sandbox CSP 付きで返し、直接アクセスでも本体オリジンと分離
 *  - 生ソースは text/plain。ファイルIDはサーバ採番 + 16進32文字検証 (パストラバーサル不可)
 *  - 必要に応じて前段に Cloudflare Access 等の追加ゲートを置ける (本アプリ単体でも完結する)
 *  - DEMO_MODE="1" で閲覧専用の公開デモとして動作 (書き込み系は全て 403)
 *
 * API仕様は Docker/Express 版と互換 (public/index.html は同系のUI)。
 */

import INDEX_HTML from '../public/index.html';

const MAX_BYTES = 10 * 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8時間
const DEMO_ERROR_MSG =
  'Read-only demo. Deploy your own vault: https://github.com/uzuraDev/html-vault';
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- base64url ----
function b64uEncode(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- crypto ----
async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64uEncode(sig);
}
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function pbkdf2(password, salt, iterations) {
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, km, 256
  );
  return new Uint8Array(bits);
}
async function verifyPassword(password, stored) {
  try {
    const salt = b64uDecode(stored.salt);
    const want = b64uDecode(stored.hash);
    const got = await pbkdf2(password, salt, stored.iter);
    if (got.length !== want.length) return false;
    let r = 0;
    for (let i = 0; i < got.length; i++) r |= got[i] ^ want[i];
    return r === 0;
  } catch { return false; }
}

// ---- session (signed cookie) ----
async function makeSession(secret) {
  const nonce = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = b64uEncode(enc.encode(JSON.stringify({ a: 1, n: nonce, exp })));
  const sig = await hmacSign(secret, payload);
  return { token: payload + '.' + sig, nonce };
}
async function readSession(secret, token) {
  if (!secret) return null;
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expect = await hmacSign(secret, payload);
  if (!timingSafeEqualStr(sig, expect)) return null;
  let obj;
  try { obj = JSON.parse(dec.decode(b64uDecode(payload))); } catch { return null; }
  if (!obj || obj.a !== 1 || !obj.exp || obj.exp < Date.now()) return null;
  return obj;
}
async function csrfFor(secret, nonce) { return hmacSign(secret, 'csrf:' + nonce); }

// ---- cookies ----
function parseCookies(req) {
  const h = req.headers.get('Cookie') || '';
  const out = {};
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
// SameSite は Lax にする。/p/ ページ(sandbox CSP = opaque origin)からの相対リンク遷移は
// 「クロスサイト扱いのトップレベルGET遷移」になり、Strict だと Cookie が送られず 401 になるため。
// 変更系は全て CSRF トークンヘッダ必須なので Lax でも CSRF 耐性は落ちない。
function sessionCookie(token, maxAgeSec, secure) {
  const parts = [`hv_sess=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join('; ');
}

// ---- responses ----
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
};
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...(extra || {}) },
  });
}

// ---- utils ----
function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function validId(id) { return /^[a-f0-9]{32}$/.test(id); }
// 制御文字(0x00-0x1f, 0x7f)を除去。ソースに制御文字を含めないようコードポイントで判定。
function sanitizeText(s, max = 200) {
  const str = String(s == null ? '' : s);
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) continue;
    out += ch;
  }
  return out.slice(0, max).trim();
}
function byteLen(s) { return enc.encode(s).length; }
// ダウンロード用ファイル名 (タイトル由来。OS禁止文字を置換し .html を付ける)
function downloadName(title) {
  const s = sanitizeText(title, 100).replace(/[\\/:*?"<>|]/g, '_').trim();
  return (s || 'snippet') + '.html';
}
function isDemo(env) { return env.DEMO_MODE === '1'; }

// ---- 全文検索ユーティリティ ----------------------------------------------
const SEARCH_EXCERPT_RADIUS = 60; // マッチ前後に確保する文字数 (合計 ~120字)

// HTMLからプレーンテキストを作る。script/style除去 → タグ除去 → 主要エンティティ復元 → 空白圧縮。
function htmlToText(html) {
  return String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// text 内の最初の needle(小文字化済み) 周辺を抜き出して抜粋を作る。
function makeExcerpt(text, lowerNeedle) {
  const idx = text.toLowerCase().indexOf(lowerNeedle);
  if (idx === -1) return '';
  const start = Math.max(0, idx - SEARCH_EXCERPT_RADIUS);
  const end = Math.min(text.length, idx + lowerNeedle.length + SEARCH_EXCERPT_RADIUS);
  let ex = text.slice(start, end);
  if (start > 0) ex = '…' + ex;
  if (end < text.length) ex = ex + '…';
  return ex;
}

// プレビューに注入するスクロール位置の記憶/復元スクリプト。
// sandbox(allow-same-origin なし)の opaque origin で動くため、親とは postMessage のみで連携する。
// スニペットIDは親が把握しているので、フレーム側は位置 {y} だけを通知し、親が currentId に紐付けて保存する。
//  - 親へ: スクロール時(throttle)/離脱時/定期チェックで現在位置 {y} を通知。ready で準備完了を通知。
//  - 親から: 保存済み位置 {y} を受け取り、その位置へ復元(レイアウト確定を待ち複数回試行)。
// ※ 一部環境では scroll イベントが発火しないため、位置変化のポーリングを保険として併用する。
const SCROLL_SCRIPT =
  '\n<script>(function(){' +
  'function pos(){return window.scrollY||document.documentElement.scrollTop||document.body.scrollTop||0;}' +
  'var lastSent=-1;' +
  'function post(){var y=pos();lastSent=y;try{parent.postMessage({__hv:1,y:y},"*");}catch(e){}}' +
  'var t=null;' +
  'addEventListener("scroll",function(){if(t)return;t=setTimeout(function(){t=null;post();},200);},{passive:true});' +
  'setInterval(function(){if(Math.abs(pos()-lastSent)>1)post();},600);' +
  'addEventListener("pagehide",post);' +
  'addEventListener("message",function(e){' +
  'var d=e.data;if(!d||d.__hv_to!=="frame")return;' +
  'if(typeof d.y==="number"&&d.y>0){var go=function(){window.scrollTo(0,d.y);};go();setTimeout(go,60);setTimeout(go,250);}' +
  '});' +
  // スニペット間の相対リンク (<a href="other.html">) を親へ通知して、親側でプレビューを切り替える。
  // sandbox iframe 内からの直接遷移は Cookie が付かず 401 になるため、遷移は親に委譲する。
  // 対象は「スキームなし・ルート相対でない・.html(+#fragment) で終わる」href のみ。それ以外は素通し。
  'addEventListener("click",function(ev){' +
  'var a=ev.target&&ev.target.closest?ev.target.closest("a[href]"):null;' +
  'if(!a)return;' +
  'var h=a.getAttribute("href")||"";' +
  'if(!h||/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)||h.charAt(0)==="#"||h.charAt(0)==="/")return;' +
  'if(!/\\.html?([#?].*)?$/i.test(h))return;' +
  'ev.preventDefault();' +
  'try{parent.postMessage({__hv:1,nav:h},"*");}catch(e){}' +
  '},true);' +
  'try{parent.postMessage({__hv:1,ready:true},"*");}catch(e){}' +
  '})();</scr' + 'ipt>\n';
function injectScrollScript(html) {
  const i = html.toLowerCase().lastIndexOf('</body>');
  if (i >= 0) return html.slice(0, i) + SCROLL_SCRIPT + html.slice(i);
  return html + SCROLL_SCRIPT;
}
// index は「読んで・直して・全体を書き戻す」方式。Workers KV にトランザクションは
// ないため、同時書き込みが重なると後勝ちでメタデータが失われ得る。本アプリは
// 単一ユーザーのパーソナルツールという前提でこの割り切りを採る (厳密な整合性が
// 必要なら Durable Objects / D1 への置き換えが本筋)。README の Limitations も参照。
async function loadIndex(env) {
  const v = await env.VAULT.get('index');
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
}
async function saveIndex(env, list) { await env.VAULT.put('index', JSON.stringify(list)); }

// HTMLから推測タイトルを得る (<title> → <h1> → 'Untitled')。MCPのupload_htmlでtitle未指定時に使う。
function guessTitle(html) {
  const s = String(html == null ? '' : html);
  const mt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  if (mt && mt[1].replace(/<[^>]+>/g, '').trim()) return mt[1].replace(/<[^>]+>/g, '').trim();
  const mh = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(s);
  if (mh) { const t = mh[1].replace(/<[^>]+>/g, '').trim(); if (t) return t; }
  return 'Untitled';
}

// スニペット作成の共通処理。/api/snippets(POST) と /mcp(upload_html) の両方から呼ぶ。
// 成功で { meta } を、入力不正で { error, status } を返す。
// DEMO_MODE ガードもここに置く (HTTP ルート側のガードと合わせた多重防御。MCP経由も塞ぐ)。
async function createSnippet(env, { html, title, tags }) {
  if (isDemo(env)) return { error: DEMO_ERROR_MSG, status: 403 };
  const body = typeof html === 'string' ? html : '';
  if (!body.trim()) return { error: 'Content is empty.', status: 400 };
  if (byteLen(body) > MAX_BYTES) return { error: 'Exceeds the 10MB size limit.', status: 413 };
  const id = newId();
  await env.VAULT.put('snip:' + id, body);
  const now = Date.now();
  const meta = {
    id,
    title: sanitizeText(title) || 'Untitled',
    tags: sanitizeText(tags, 120),
    created: now,
    updated: now,
    bytes: byteLen(body),
  };
  const list = await loadIndex(env);
  list.push(meta);
  await saveIndex(env, list);
  return { meta };
}

async function requireAuth(req, env) {
  const c = parseCookies(req);
  return readSession(env.SESSION_SECRET, c.hv_sess);
}
async function csrfOk(req, sess, env) {
  const token = req.headers.get('x-csrf-token');
  if (!token) return false;
  return timingSafeEqualStr(token, await csrfFor(env.SESSION_SECRET, sess.n));
}
// 任意: ヘッドレス用の API トークン認証 (Authorization: Bearer <API_TOKEN>)。
// env.API_TOKEN 未設定なら無効 (= 従来どおりセッション認証のみ)。
// ヘッダ認証なので CSRF の対象外 (ブラウザが自動付与しない = CSRF経路にならない)。
function apiTokenOk(req, env) {
  if (!env.API_TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
  return !!m && timingSafeEqualStr(m[1], env.API_TOKEN);
}

// ===========================================================================
//  リモートMCP (Streamable HTTP / ステートレス / 手書きJSON-RPC)
//  claude.ai 等のカスタムコネクター(リモートMCP)から呼ぶ。
//  authless + 秘匿パス /mcp/<MCP_SECRET_PATH> で保護 (ガードは fetch 側)。
//  ローカルCLI向けの stdio 版 MCP サーバーとは別系統 (こちらは Worker 単体で完結)。
//  仕様: Streamable HTTP は単一エンドへ POST。request には JSON で1応答、
//        notification/response のみなら 202、GET(SSE)は未提供で 405。
// ===========================================================================
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_TOOLS = [
  {
    name: 'upload_html',
    description: 'Save generated HTML to the vault and return its view URL.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Full HTML document to store' },
        title: { type: 'string', description: 'Optional. Guessed from <title>/<h1> when omitted' },
        tags: { type: 'string', description: 'Optional. Comma-separated tags' },
      },
      required: ['html'],
    },
  },
  {
    name: 'list_snippets',
    description: 'List snippets in the vault, newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20' } },
    },
  },
];
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function mcpUploadHtml(env, args, origin) {
  const a = args || {};
  const title = (a.title && String(a.title).trim()) || guessTitle(a.html);
  const r = await createSnippet(env, { html: a.html, title, tags: a.tags });
  if (r.error) throw new Error(r.error);
  return JSON.stringify(
    {
      ok: true,
      id: r.meta.id,
      title: r.meta.title,
      bytes: r.meta.bytes,
      viewUrl: origin + '/',
      previewUrl: origin + '/api/snippets/' + r.meta.id + '/preview',
      pageUrl: origin + '/p/' + encodeURIComponent(r.meta.title) + '.html',
    },
    null,
    2
  );
}

async function mcpListSnippets(env, args) {
  const n = parseInt((args && args.limit) || 20, 10);
  const limit = Math.min(Math.max(Number.isFinite(n) ? n : 20, 1), 100);
  const list = (await loadIndex(env)).sort((a, b) => b.updated - a.updated).slice(0, limit);
  const out = list.map((s) => ({
    id: s.id, title: s.title, tags: s.tags, bytes: s.bytes,
    updated: new Date(s.updated).toISOString(),
  }));
  return JSON.stringify(out, null, 2);
}

// DEMO_MODE で塞ぐ書き込み系 MCP ツール。createSnippet 内のガードと合わせた多重防御
// (/api/ ルートの「グローバルガード + createSnippet」と同じ二層構成にする)。
const MCP_WRITE_TOOLS = new Set(['upload_html']);

async function mcpDispatch(msg, env, origin) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion:
          params && typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'html-vault', version: '1.0.0' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      // DEMO_MODE: 書き込みツールはここでも即拒否 (createSnippet が唯一の砦にならないように)
      if (isDemo(env) && MCP_WRITE_TOOLS.has(name)) {
        return rpcResult(id, {
          content: [{ type: 'text', text: 'Error: ' + DEMO_ERROR_MSG }],
          isError: true,
        });
      }
      try {
        let text;
        if (name === 'upload_html') text = await mcpUploadHtml(env, args, origin);
        else if (name === 'list_snippets') text = await mcpListSnippets(env, args);
        else return rpcError(id, -32602, 'Unknown tool: ' + name);
        return rpcResult(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        // ツール実行時の失敗は JSON-RPC エラーではなく isError:true の結果で返す (MCP流儀)
        return rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + ((e && e.message) || e) }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, 'Method not found: ' + method);
  }
}

async function handleMcp(req, env, origin) {
  if (req.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: SEC_HEADERS });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: SEC_HEADERS });

  let body;
  try { body = await req.json(); } catch { return json(rpcError(null, -32700, 'Parse error')); }
  const batch = Array.isArray(body);
  const msgs = batch ? body : [body];

  // request(id付き)が1つも無い (= notification/response のみ) → 202 Accepted
  const hasRequest = msgs.some((m) => m && m.id !== undefined && m.id !== null && typeof m.method === 'string');
  if (!hasRequest) return new Response(null, { status: 202, headers: SEC_HEADERS });

  const out = [];
  for (const m of msgs) {
    if (!m || m.id === undefined || m.id === null) continue; // notification は応答不要
    out.push(await mcpDispatch(m, env, origin));
  }
  return json(batch ? out : out[0]);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const secure = url.protocol === 'https:';
    const demo = isDemo(env);

    // DEMO_MODE (閲覧専用) はセッションを発行しないので SESSION_SECRET 無しでも動く
    if (!env.SESSION_SECRET && !demo) {
      return json({ error: 'SESSION_SECRET is not set. Run: wrangler secret put SESSION_SECRET' }, 500);
    }

    try {
      // ---- リモートMCP (authless + 秘匿パス /mcp/<MCP_SECRET_PATH>) ----
      // 秘匿文字列が一致したときだけ到達。未設定/不一致は 404 で存在自体を秘匿する。
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        const secret = env.MCP_SECRET_PATH || '';
        const given = path.startsWith('/mcp/') ? path.slice(5) : '';
        if (!secret || !timingSafeEqualStr(given, secret)) return json({ error: 'Not found' }, 404);
        return handleMcp(req, env, url.origin);
      }

      // ---- DEMO_MODE: 書き込み系エンドポイントを一括で 403 にする ----
      // /api/login も含めて塞ぐことで、レート制限カウンタ等の KV 書き込みも発生させない。
      // (createSnippet 側と MCP の tools/call 側にも同じガードがあり、多重防御になっている)
      // HEAD は GET と同じ読み取り扱いで通す。書き込みルートは POST/PUT/DELETE にしか
      // マッチしないので、HEAD を通しても書き込みには到達しない。
      if (demo && path.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') {
        return json({ error: DEMO_ERROR_MSG }, 403);
      }

      // ---- security.txt (RFC 9116) ----
      // SECURITY_CONTACT Secret (例: "mailto:you@example.com") が設定されているときだけ配信する。
      if (path === '/.well-known/security.txt' || path === '/security.txt') {
        if (!env.SECURITY_CONTACT) return json({ error: 'Not found' }, 404);
        const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        const body =
          [
            'Contact: ' + env.SECURITY_CONTACT,
            'Expires: ' + expires,
            'Canonical: ' + url.origin + '/.well-known/security.txt',
          ].join('\n') + '\n';
        return new Response(body, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_HEADERS },
        });
      }

      // ---- 静的フロント ----
      if (path === '/' || path === '/index.html') {
        // DEMO_MODE のとき、UI 内のマーカー行を書き換えてフラグを伝達する
        const html = demo
          ? INDEX_HTML.replace('window.__HV_DEMO__ = false;', 'window.__HV_DEMO__ = true;')
          : INDEX_HTML;
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS },
        });
      }

      // ---- 認証 ----
      if (path === '/api/me' && method === 'GET') {
        if (demo) return json({ authed: false, csrf: null, demo: true });
        const sess = await requireAuth(req, env);
        if (!sess) return json({ authed: false, csrf: null });
        return json({ authed: true, csrf: await csrfFor(env.SESSION_SECRET, sess.n) });
      }

      if (path === '/api/login' && method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        const rlKey = 'rl:' + ip;
        const cnt = parseInt((await env.VAULT.get(rlKey)) || '0', 10);
        if (cnt >= 10) return json({ error: 'Too many login attempts. Try again later.' }, 429);

        // 認証ハッシュは Secret(env.AUTH_HASH) に保存(強整合・即時反映。KVの遅延を回避)
        let auth = null;
        try { auth = env.AUTH_HASH ? JSON.parse(env.AUTH_HASH) : null; } catch { auth = null; }
        if (!auth) return json({ error: 'Password is not set. Run: npm run setpass' }, 500);

        let body;
        try { body = await req.json(); } catch { body = {}; }
        const ok = await verifyPassword(String((body && body.password) || ''), auth);
        if (!ok) {
          await env.VAULT.put(rlKey, String(cnt + 1), { expirationTtl: 15 * 60 });
          return json({ error: 'Wrong password.' }, 401);
        }
        const s = await makeSession(env.SESSION_SECRET);
        return json(
          { ok: true, csrf: await csrfFor(env.SESSION_SECRET, s.nonce) },
          200,
          { 'Set-Cookie': sessionCookie(s.token, Math.floor(SESSION_TTL_MS / 1000), secure) }
        );
      }

      if (path === '/api/logout' && method === 'POST') {
        const sess = await requireAuth(req, env);
        if (!sess) return json({ error: 'Unauthorized.' }, 401);
        // 状態変更(Cookie失効)なので他の変更系APIと同じくCSRFトークンを要求する
        if (!(await csrfOk(req, sess, env))) return json({ error: 'Invalid CSRF token.' }, 403);
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0, secure) });
      }

      // ---- 一覧 ----
      if (path === '/api/snippets' && method === 'GET') {
        let csrf = null;
        if (!demo) {
          const tokenOk = apiTokenOk(req, env);
          const sess = tokenOk ? null : await requireAuth(req, env);
          if (!tokenOk && !sess) return json({ error: 'Unauthorized.' }, 401);
          if (sess) csrf = await csrfFor(env.SESSION_SECRET, sess.n);
        }
        const list = (await loadIndex(env)).sort((a, b) => b.updated - a.updated);
        return json({ snippets: list, csrf });
      }

      // ---- 全文検索 (タイトル/タグ/本文。本文はKVから読みプレーン化して走査) ----
      if (path === '/api/search' && method === 'GET') {
        let csrf = null;
        if (!demo) {
          const tokenOk = apiTokenOk(req, env);
          const sess = tokenOk ? null : await requireAuth(req, env);
          if (!tokenOk && !sess) return json({ error: 'Unauthorized.' }, 401);
          if (sess) csrf = await csrfFor(env.SESSION_SECRET, sess.n);
        }
        const q = String(url.searchParams.get('q') || '').trim();
        if (q.length < 2) {
          // 2文字未満は検索しない (空。UI側は全件表示にフォールバック)
          return json({ results: [], q, csrf });
        }
        const needle = q.toLowerCase();
        const list = (await loadIndex(env)).sort((a, b) => b.updated - a.updated);
        const results = [];
        for (const meta of list) {
          const inTitle = (meta.title || '').toLowerCase().includes(needle);
          const inTags = (meta.tags || '').toLowerCase().includes(needle);
          // 本文の取得(KV読み + HTML→テキスト変換)はタイトル/タグ不一致のときだけ行う
          let bodyText = null;
          let inBody = false;
          if (!inTitle && !inTags && validId(meta.id)) {
            const raw = await env.VAULT.get('snip:' + meta.id);
            if (raw != null) {
              bodyText = htmlToText(raw);
              inBody = bodyText.toLowerCase().includes(needle);
            }
          }
          if (!inTitle && !inTags && !inBody) continue;
          results.push({
            id: meta.id,
            title: meta.title,
            tags: meta.tags,
            created: meta.created,
            updated: meta.updated,
            bytes: meta.bytes,
            field: inTitle ? 'title' : inTags ? 'tags' : 'body',
            excerpt: inBody ? makeExcerpt(bodyText, needle) : '',
          });
        }
        return json({ results, q, csrf });
      }

      // ---- 作成 (貼り付け or アップロード) ----
      if (path === '/api/snippets' && method === 'POST') {
        // Bearer トークン or (セッション + CSRF)。トークン時は CSRF 免除。
        if (!apiTokenOk(req, env)) {
          const sess = await requireAuth(req, env);
          if (!sess) return json({ error: 'Unauthorized.' }, 401);
          if (!(await csrfOk(req, sess, env))) return json({ error: 'Invalid CSRF token.' }, 403);
        }

        let html = '', title = '', tags = '', fileName = '';
        const ct = req.headers.get('content-type') || '';
        if (ct.includes('multipart/form-data')) {
          const form = await req.formData();
          const file = form.get('file');
          if (file && typeof file.text === 'function') {
            html = await file.text();
            fileName = file.name || '';
          } else if (typeof form.get('html') === 'string') {
            html = form.get('html');
          }
          title = form.get('title') || '';
          tags = form.get('tags') || '';
        } else {
          const b = await req.json().catch(() => ({}));
          html = typeof b.html === 'string' ? b.html : '';
          title = b.title || '';
          tags = b.tags || '';
        }
        // タイトル未入力なら、アップロードされたファイル名(拡張子除く)をタイトルに使う
        if (!sanitizeText(title) && fileName) {
          title = fileName.replace(/\.html?$/i, '');
        }

        const r = await createSnippet(env, { html, title, tags });
        if (r.error) return json({ error: r.error }, r.status);
        return json({ ok: true, snippet: r.meta });
      }

      // ---- 生ソース ----
      const mRaw = path.match(/^\/api\/snippets\/([^/]+)\/raw$/);
      if (mRaw && method === 'GET') {
        if (!demo) {
          const sess = await requireAuth(req, env);
          if (!sess) return json({ error: 'Unauthorized.' }, 401);
        }
        if (!validId(mRaw[1])) return json({ error: 'Invalid ID.' }, 400);
        const html = await env.VAULT.get('snip:' + mRaw[1]);
        if (html == null) return json({ error: 'Not found.' }, 404);
        return new Response(html, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_HEADERS },
        });
      }

      // ---- ダウンロード (Content-Disposition: attachment で1ファイルずつ保存) ----
      const mDl = path.match(/^\/api\/snippets\/([^/]+)\/download$/);
      if (mDl && method === 'GET') {
        if (!demo) {
          const sess = await requireAuth(req, env);
          if (!sess) return new Response('Unauthorized.', { status: 401, headers: SEC_HEADERS });
        }
        if (!validId(mDl[1])) return new Response('Invalid ID.', { status: 400, headers: SEC_HEADERS });
        const html = await env.VAULT.get('snip:' + mDl[1]);
        if (html == null) return new Response('Not found.', { status: 404, headers: SEC_HEADERS });
        const list = await loadIndex(env);
        const meta = list.find((s) => s.id === mDl[1]);
        const name = downloadName(meta && meta.title);
        const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
        return new Response(html, {
          headers: {
            ...SEC_HEADERS,
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          },
        });
      }

      // ---- ページ配信 (/p/<タイトル>.html) ----
      // スニペット同士の相対リンクを機能させるための同一階層ルート。
      // タイトル(=アップロード時のファイル名ステム)で最新のスニペットを引いて返す。
      // sandbox CSP で本体オリジンから隔離しつつ allow-top-navigation-by-user-activation +
      // SameSite=Lax Cookie でページ間のトップレベル遷移(ユーザー操作起点)を成立させる。
      // 認証はセッション or APIトークン (DEMO_MODE では公開)。
      if (path.startsWith('/p/') && method === 'GET') {
        const htmlErr = (msg, status) =>
          new Response(
            '<!doctype html><html lang="en"><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;color:#333">' +
              '<p>' + msg + '</p><p><a href="/">Open HTML Vault</a></p></body></html>',
            { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS } }
          );
        if (!demo && !apiTokenOk(req, env)) {
          const sess = await requireAuth(req, env);
          if (!sess) return htmlErr('Unauthorized. Please log in and try again.', 401);
        }
        let slug = path.slice(3);
        try { slug = decodeURIComponent(slug); } catch { /* 不正な%エンコードはそのまま扱う */ }
        slug = slug.replace(/\.html?$/i, '').trim().toLowerCase();
        if (!slug) return htmlErr('No page name specified.', 404);
        const list = await loadIndex(env);
        const meta = list
          .filter((s) => (s.title || '').trim().toLowerCase() === slug)
          .sort((a, b) => b.updated - a.updated)[0];
        const html = meta && validId(meta.id) ? await env.VAULT.get('snip:' + meta.id) : null;
        if (html == null) return htmlErr('"' + sanitizeText(slug, 100) + '" was not found in the vault.', 404);
        // 注: SEC_HEADERS のアプリ用CSP(default-src 'self')は付けない。保存HTMLの
        // 外部リソース読込を壊すため、隔離は sandbox CSP に任せる。
        // allow-top-navigation-by-user-activation: リンククリック等の明示操作による
        // ページ間遷移は許可しつつ、スクリプトによる自動リダイレクトは遮断する。
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy':
              'sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock allow-top-navigation-by-user-activation',
          },
        });
      }

      // ---- プレビュー (sandbox CSP で隔離) ----
      const mPrev = path.match(/^\/api\/snippets\/([^/]+)\/preview$/);
      if (mPrev && method === 'GET') {
        if (!demo) {
          const sess = await requireAuth(req, env);
          if (!sess) return new Response('Unauthorized.', { status: 401, headers: SEC_HEADERS });
        }
        if (!validId(mPrev[1])) return new Response('Invalid ID.', { status: 400, headers: SEC_HEADERS });
        const html = await env.VAULT.get('snip:' + mPrev[1]);
        if (html == null) return new Response('Not found.', { status: 404, headers: SEC_HEADERS });
        // 注: /p/ と同じく SEC_HEADERS のアプリ用CSPは付けず、sandbox CSP で隔離する。
        return new Response(injectScrollScript(html), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy':
              'sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock',
          },
        });
      }

      // ---- 更新 / 削除 ----
      const mId = path.match(/^\/api\/snippets\/([^/]+)$/);
      if (mId && method === 'PUT') {
        const sess = await requireAuth(req, env);
        if (!sess) return json({ error: 'Unauthorized.' }, 401);
        if (!(await csrfOk(req, sess, env))) return json({ error: 'Invalid CSRF token.' }, 403);
        const id = mId[1];
        if (!validId(id)) return json({ error: 'Invalid ID.' }, 400);
        const list = await loadIndex(env);
        const meta = list.find((s) => s.id === id);
        if (!meta) return json({ error: 'Not found.' }, 404);
        const b = await req.json().catch(() => ({}));
        if (typeof b.html === 'string') {
          if (byteLen(b.html) > MAX_BYTES) return json({ error: 'Exceeds the 10MB size limit.' }, 413);
          await env.VAULT.put('snip:' + id, b.html);
          meta.bytes = byteLen(b.html);
        }
        if (typeof b.title === 'string') meta.title = sanitizeText(b.title) || 'Untitled';
        if (typeof b.tags === 'string') meta.tags = sanitizeText(b.tags, 120);
        meta.updated = Date.now();
        await saveIndex(env, list);
        return json({ ok: true, snippet: meta });
      }

      if (mId && method === 'DELETE') {
        const sess = await requireAuth(req, env);
        if (!sess) return json({ error: 'Unauthorized.' }, 401);
        if (!(await csrfOk(req, sess, env))) return json({ error: 'Invalid CSRF token.' }, 403);
        const id = mId[1];
        if (!validId(id)) return json({ error: 'Invalid ID.' }, 400);
        const list = await loadIndex(env);
        const idx = list.findIndex((s) => s.id === id);
        if (idx === -1) return json({ error: 'Not found.' }, 404);
        await env.VAULT.delete('snip:' + id);
        list.splice(idx, 1);
        await saveIndex(env, list);
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Internal error' }, 500);
    }
  },
};
