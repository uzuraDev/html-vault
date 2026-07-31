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
// HTMLに埋め込む文字列のエスケープ (エラーページ等、ユーザー入力を含み得る箇所で必須)
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
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

// text の idx 位置(一致開始点)の周辺を抜き出して抜粋を作る。
// 一致位置は呼び出し側が lower.indexOf で既に求めているので、ここでは再走査しない。
function makeExcerpt(text, idx, needleLen) {
  const start = Math.max(0, idx - SEARCH_EXCERPT_RADIUS);
  const end = Math.min(text.length, idx + needleLen + SEARCH_EXCERPT_RADIUS);
  // slice は元の文字列を参照したまま (V8 の SlicedString) になり、120字程度の抜粋が
  // 本文まるごとを生かし続けてしまう。短いので作り直して親を解放する。
  let ex = text.slice(start, end).split('').join('');
  if (start > 0) ex = '…' + ex;
  if (end < text.length) ex = ex + '…';
  return ex;
}

// ---- 本文テキストのキャッシュ (アイソレート内) -----------------------------
// 検索は本文が要るスニペットぶんだけ KV を読むが、KV の read は1件ずつが往復なので
// 件数が増えるとそのまま待ち時間になる。正規化済みテキストをアイソレートに持たせて
// 2回目以降は KV 読み込みごと省く (Workers のアイソレートはリクエストを跨いで生きる)。
// KV には mtime が無いので、index のメタ (updated/bytes) を版として使う。
// PUT は必ず updated を進めるため、本文が変わったスニペットは自動で作り直される。
//
// ただし版キーだけに頼ると、KV の結果整合による窓 (最大60秒) で
// 「index は新しいのに snip: の read は旧本文を返す」瞬間に当たったとき、
// 旧本文が新しい版キーで焼き込まれて**永久に自己修復しない**。
// (dropSearchText は書き込みを処理したアイソレートのメモリしか消せない)
// そこで2つの歯止めを置く:
//   1. 読んだ本文のバイト長が meta.bytes と食い違うなら、伝播途中とみなしてキャッシュしない
//   2. エントリに読み取り時刻を持たせ、TTL を過ぎたら版キーが同じでも必ず読み直す
// 「永久に直らない」状態は無くなるが、最悪の陳腐化は無くならない点に注意:
//   - 歯止め1 は「バイト長まで同じ差し替え」(1文字の置換など) をすり抜ける
//   - TTL の起点は読んだ時刻なので、伝播窓の終盤に旧本文を読むと収束後さらに TTL ぶん続く
//     = 最悪で「伝播窓 + TTL」(およそ2分) になる。TTL 導入前は毎回読み直すので伝播窓だけだった
//   - キャッシュヒット中は KV を読まないので、本文だけが先に消えた状態 (DELETE の伝播が
//     index と分かれた場合など) にも TTL のあいだ気付けない
// TTL を延ばすとこの窓がそのまま伸びる。速度と引き換えにする値なので安易に触らないこと。
//
// なお SEARCH_CACHE_MAX_CHARS が縛るのは**リクエストを跨いで保持する量**だけ。
// 1リクエスト中に同時に生きる本文は、検索側でチャンクごとに使い捨てて有界にしている。
// text+lower 合計。実メモリで約8MB を**アイソレートに常駐させ続ける**ので、
// そのぶん全リクエストが使えるメモリ(128MB)が減る。速度と引き換えの値。
const SEARCH_CACHE_MAX_CHARS = 4 * 1024 * 1024;
const SEARCH_CACHE_TTL_MS = 60 * 1000; // 版キーが同じでもこの間隔で読み直す
const searchTextCache = new Map(); // id -> { ver, at, text, lower }
let searchCacheChars = 0;
// 本文の並行読み込みは「件数」と「バイト数」の両方で抑える。
// 逐次 await だと「件数 × 1往復」を直列に待つことになるが、件数だけで切ると
// 10MB級 (MAX_BYTES) が並んだとき1チャンクで数十MBが同時に載り、
// 1件ずつ処理していたときより悪くなる。
// 件数の上限6は Workers の「応答ヘッダ待ちの同時接続」上限に合わせたもの (超える分はキューされる)。
const KV_READ_CONCURRENCY = 6;
const KV_READ_MAX_BYTES = 4 * 1024 * 1024;

// list を上の2条件でチャンクに割る。1件だけで上限を超える場合はその1件でチャンクを作る
// (「1件ずつ」に縮退するので、巨大スニペットでもメモリは悪化しない)。
// bytesOf は要素からバイト数を取り出す関数 (呼び出し側が meta を包んでいることがある)。
function chunkForRead(list, bytesOf = (m) => m.bytes) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const item of list) {
    // bytes が無い/0 の壊れたメタは最悪サイズとみなす。0 扱いにすると予算が効かなくなり、
    // 件数上限だけで巨大な本文が並んでしまう (安全側に倒して1件ずつに縮退させる)。
    const raw = Number(bytesOf(item));
    const b = raw > 0 ? raw : MAX_BYTES;
    if (cur.length && (cur.length >= KV_READ_CONCURRENCY || bytes + b > KV_READ_MAX_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(item);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

function dropSearchText(id) {
  const e = searchTextCache.get(id);
  if (!e) return;
  searchCacheChars -= e.text.length + e.lower.length;
  searchTextCache.delete(id);
}

// meta の本文を正規化済みで返す { text, lower }。KV に無ければ null。
async function getSearchText(env, meta) {
  const ver = meta.updated + ':' + meta.bytes;
  const now = Date.now();
  const hit = searchTextCache.get(meta.id);
  if (hit && hit.ver === ver && now - hit.at < SEARCH_CACHE_TTL_MS) return hit;
  const raw = await env.VAULT.get('snip:' + meta.id);
  if (raw == null) {
    dropSearchText(meta.id);
    return null;
  }
  const text = htmlToText(raw);
  const entry = { ver, at: now, text, lower: text.toLowerCase() };
  dropSearchText(meta.id); // 古い版が居たら先に外して枠を空ける
  // 読んだ本文と index が食い違う = KV がまだ収束していない。今回の結果には使うが残さない。
  const consistent = byteLen(raw) === meta.bytes;
  const cost = entry.text.length + entry.lower.length;
  if (consistent && searchCacheChars + cost <= SEARCH_CACHE_MAX_CHARS) {
    searchTextCache.set(meta.id, entry);
    searchCacheChars += cost;
  }
  return entry; // 上限で入らなくても今回の検索には使う
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
// 一覧の共通ソート: ピン留めを先頭に、各グループ内は表示順キーの昇順。
// 表示順キーは手動並べ替え済みなら order (0,1,2,...)、未設定なら -updated。
// -updated は大きな負値になるため、並べ替え後に作られた新規スニペットは
// 自動的にグループ先頭 (新しい順) に浮き、ドラッグされた時点で order が確定する。
function displayKey(m) {
  return m.order != null ? m.order : -(m.updated || 0);
}
function byDisplayOrder(a, b) {
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || displayKey(a) - displayKey(b);
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
    pinned: false,
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
  const list = (await loadIndex(env)).sort(byDisplayOrder).slice(0, limit);
  const out = list.map((s) => ({
    id: s.id, title: s.title, tags: s.tags, bytes: s.bytes,
    pinned: !!s.pinned,
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
        // DEMO_MODE / UI_HIDE_NEW のとき、UI 内のマーカー行を書き換えてフラグを伝達する。
        // 置換は文字列の完全一致。worker/public/index.html のマーカー行は整形しないこと。
        let html = INDEX_HTML;
        if (demo) html = html.replace('window.__HV_DEMO__ = false;', 'window.__HV_DEMO__ = true;');
        if (env.UI_HIDE_NEW === '1')
          html = html.replace('window.__HV_HIDE_NEW__ = false;', 'window.__HV_HIDE_NEW__ = true;');
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
        // ベストエフォートのログイン試行スロットリング。KV の read-modify-write は非アトミック
        // かつ結果整合のため、並行リクエストや複数 PoP 経由ではカウンタが過小計上され、10 回
        // 上限を厳密には保証できない(TOCTOU)。パーソナルツール前提かつ実パスワード + PBKDF2
        // (verifyPassword)で総当たり自体が高コストのため、ここでは軽い抑止に留める。厳密な保護が
        // 必要なら Durable Object でカウンタをアトミック化するか、前段に Cloudflare Rate Limiting
        // Rules を置くこと。
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
        const list = (await loadIndex(env)).sort(byDisplayOrder);
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
        const list = (await loadIndex(env)).sort(byDisplayOrder);
        // index から消えた id のキャッシュを**読み込みより先に**解放する。
        // (削除・再インポート等で残り続けると上限を占めて、以後どれもキャッシュに入らなくなる。
        //  後回しにすると、差し替え直後の検索だけ枠が空かず余分にコールドになる)
        const seen = new Set(list.map((m) => m.id));
        for (const id of searchTextCache.keys()) {
          if (!seen.has(id)) dropSearchText(id);
        }
        // まずメタだけで判定し、本文の取得(KV読み + HTML→テキスト変換)が要るものを集める。
        const rows = list.map((meta) => ({
          meta,
          inTitle: (meta.title || '').toLowerCase().includes(needle),
          inTags: (meta.tags || '').toLowerCase().includes(needle),
          inBody: false,
          excerpt: '',
        }));
        const needBody = rows.filter((r) => !r.inTitle && !r.inTags && validId(r.meta.id));
        // 本文はまとめて並行取得する。1件ずつ await すると件数分の往復を直列に待つことになる。
        // (KV への read 回数は従来と同じ = サブリクエスト上限への影響は変わらない)
        // 判定と抜粋の生成はチャンクの中で終わらせ、本文への参照はチャンクを抜ける前に捨てる。
        // 対象ぶんを同時に生かすと、件数に比例してアイソレートのメモリ(128MB)を食い潰す。
        for (const chunk of chunkForRead(needBody, (r) => r.meta.bytes)) {
          await Promise.all(
            chunk.map(async (r) => {
              const body = await getSearchText(env, r.meta);
              if (!body) return;
              const idx = body.lower.indexOf(needle);
              if (idx === -1) return;
              r.inBody = true;
              r.excerpt = makeExcerpt(body.text, idx, needle.length);
            })
          );
        }
        const results = [];
        for (const r of rows) {
          if (!r.inTitle && !r.inTags && !r.inBody) continue;
          results.push({
            id: r.meta.id,
            title: r.meta.title,
            tags: r.meta.tags,
            created: r.meta.created,
            updated: r.meta.updated,
            bytes: r.meta.bytes,
            pinned: !!r.meta.pinned,
            field: r.inTitle ? 'title' : r.inTags ? 'tags' : 'body',
            excerpt: r.excerpt,
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
            // viewport が無いと iOS Safari は既定の980pxレイアウトで描画し、縮小表示になる
            '<!doctype html><html lang="en"><meta charset="utf-8">' +
              '<meta name="viewport" content="width=device-width, initial-scale=1">' +
              '<body style="font-family:sans-serif;padding:40px;color:#333">' +
              // msg はデコード済みスラッグ等のユーザー入力を含み得るので必ずエスケープする
              '<p>' + escapeHtml(msg) + '</p><p><a href="/">Open HTML Vault</a></p></body></html>',
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

      // ---- 並べ替え (ドラッグ&ドロップの表示順を保存) ----
      // ※ 下の /api/snippets/:id (PUT) の正規表現にもマッチするパスなので、必ず先に処理する。
      // body.ids は「現在の表示順そのままの完全なID列」。各スニペットの order に列内の位置を保存する。
      // ピン留め/非ピンのグループ分けはソート側 (byDisplayOrder) が pinned を優先するため、
      // order はグループを跨いだ通し番号で問題ない (グループ内の相対順だけが効く)。
      if (path === '/api/snippets/order' && method === 'PUT') {
        const sess = await requireAuth(req, env);
        if (!sess) return json({ error: 'Unauthorized.' }, 401);
        if (!(await csrfOk(req, sess, env))) return json({ error: 'Invalid CSRF token.' }, 403);
        const b = await req.json().catch(() => ({}));
        if (!Array.isArray(b.ids) || !b.ids.every((v) => typeof v === 'string' && validId(v))) {
          return json({ error: 'Invalid request.' }, 400);
        }
        const pos = new Map(b.ids.map((id, i) => [id, i]));
        const list = await loadIndex(env);
        // ids に無いスニペット (並べ替え操作の後に別端末で作られた等) は order を付けず、
        // 未設定フォールバック (-updated) でグループ先頭に浮かせる。
        for (const meta of list) {
          if (pos.has(meta.id)) meta.order = pos.get(meta.id);
        }
        await saveIndex(env, list);
        return json({ ok: true });
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
        let contentChanged = false;
        if (typeof b.html === 'string') {
          if (byteLen(b.html) > MAX_BYTES) return json({ error: 'Exceeds the 10MB size limit.' }, 413);
          await env.VAULT.put('snip:' + id, b.html);
          // 本文が変わったので検索用テキストのキャッシュを捨てる。
          // (版キーの updated/bytes でも大抵は検知できるが、同一ミリ秒・同一バイト長の
          //  上書きをすり抜けるため、書き込み側でも必ず落とす)
          dropSearchText(id);
          meta.bytes = byteLen(b.html);
          contentChanged = true;
        }
        if (typeof b.title === 'string') { meta.title = sanitizeText(b.title) || 'Untitled'; contentChanged = true; }
        if (typeof b.tags === 'string') { meta.tags = sanitizeText(b.tags, 120); contentChanged = true; }
        // ピン留めの付け外し (幾つでも可)。並び順だけの変更なので updated は動かさない。
        if (typeof b.pinned === 'boolean') meta.pinned = b.pinned;
        if (contentChanged) meta.updated = Date.now();
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
        dropSearchText(id); // 削除済みが検索にヒットし続けないように
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
