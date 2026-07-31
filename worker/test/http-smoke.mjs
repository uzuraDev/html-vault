/**
 * HTTP-level integration smoke test for the Cloudflare Workers build of HTML Vault.
 *
 * Self-orchestrating: this single file owns the whole lifecycle. It backs up the
 * developer's worker/.dev.vars, then for each phase it writes a phase-specific
 * .dev.vars, spawns `wrangler dev` (isolated --persist-to so it never touches your
 * real local KV / rate-limit state), waits for /api/me, runs the phase's assertions,
 * and kills the server. The original .dev.vars is restored on normal exit and on
 * SIGINT/SIGTERM (Ctrl+C); a hard kill (SIGKILL) or power loss can still leave the
 * phase-specific .dev.vars in place — re-running the test overwrites it cleanly.
 *
 * Phases:
 *   1. normal    — SESSION_SECRET + AUTH_HASH + MCP_SECRET_PATH (no DEMO, no SECURITY_CONTACT)
 *   2. demo      — same + DEMO_MODE=1
 *   3. mcp-unset — same but MCP_SECRET_PATH removed
 *
 * Usage:   node test/http-smoke.mjs
 * Env overrides: HV_PORT (default 8799), HV_PASSWORD (default demo-test-pass-1234),
 *                HV_MCP_SECRET (default localtest)
 *
 * Requires worker/.dev.vars to already contain SESSION_SECRET and AUTH_HASH
 * (the login password must match HV_PASSWORD). Run `npm run setpass:local` first.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, '..');
const DEV_VARS = path.join(WORKER_DIR, '.dev.vars');
const PORT = parseInt(process.env.HV_PORT || '8799', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.HV_PASSWORD || 'demo-test-pass-1234';
const MCP_SECRET = process.env.HV_MCP_SECRET || 'localtest';
const PERSIST_DIR = path.join(os.tmpdir(), 'hv-qa-persist');
const IS_WIN = process.platform === 'win32';

// ---- result accumulation --------------------------------------------------
const results = [];
function record(name, pass, expected, actual) {
  results.push({ name, pass, expected: String(expected), actual: String(actual) });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}`);
  if (!pass) console.log(`        expected: ${expected}\n        actual:   ${actual}`);
}
function check(name, actual, expected) {
  record(name, actual === expected, expected, actual);
}

// ---- header helpers -------------------------------------------------------
function secHeaders(res) {
  return {
    nosniff: res.headers.get('x-content-type-options'),
    frame: res.headers.get('x-frame-options'),
    ref: res.headers.get('referrer-policy'),
    csp: res.headers.get('content-security-policy'),
  };
}
function checkSecHeaders(label, res) {
  const h = secHeaders(res);
  const ok =
    h.nosniff === 'nosniff' &&
    h.frame === 'SAMEORIGIN' &&
    h.ref === 'no-referrer';
  record(
    `sec-headers: ${label}`,
    ok,
    'nosniff / SAMEORIGIN / no-referrer',
    `nosniff=${h.nosniff} frame=${h.frame} ref=${h.ref}`
  );
}
function checkSandboxCsp(label, res) {
  const csp = res.headers.get('content-security-policy') || '';
  const ok = csp.startsWith('sandbox ') && !csp.includes("default-src 'self'");
  record(
    `sandbox-CSP: ${label}`,
    ok,
    "starts with 'sandbox ' and excludes default-src 'self'",
    csp || '(none)'
  );
}

// ---- cookie helper --------------------------------------------------------
function extractSessCookie(res) {
  const sc = res.headers.get('set-cookie') || '';
  const m = /hv_sess=([^;]*)/.exec(sc);
  return m ? m[1] : null;
}

// ---- .dev.vars orchestration ---------------------------------------------
let ORIGINAL_DEV_VARS = null;
function readBaseVars() {
  // Parse current .dev.vars, keep only the durable secrets, drop mode-controlled keys.
  const raw = fs.readFileSync(DEV_VARS, 'utf8');
  ORIGINAL_DEV_VARS = raw;
  const keep = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const key = t.split('=')[0];
    if (['DEMO_MODE', 'MCP_SECRET_PATH', 'SECURITY_CONTACT'].includes(key)) continue;
    keep.push(t);
  }
  const hasSecret = keep.some((l) => l.startsWith('SESSION_SECRET='));
  const hasAuth = keep.some((l) => l.startsWith('AUTH_HASH='));
  if (!hasSecret || !hasAuth) {
    throw new Error('.dev.vars must contain SESSION_SECRET and AUTH_HASH before running this test');
  }
  return keep.join('\n') + '\n';
}
function writeVars(base, extras) {
  fs.writeFileSync(DEV_VARS, base + extras.map((e) => e + '\n').join(''));
}
function restoreVars() {
  if (ORIGINAL_DEV_VARS != null) fs.writeFileSync(DEV_VARS, ORIGINAL_DEV_VARS);
}

// ---- wrangler process lifecycle ------------------------------------------
let child = null;
function killWrangler() {
  if (child && child.pid) {
    try {
      // Kill the whole spawned process tree by PID (this reaches the child workerd
      // too). We deliberately do NOT `taskkill /IM workerd.exe`: that would kill
      // every workerd on the machine, including other projects' dev servers.
      if (IS_WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    } catch { /* ignore */ }
  }
  child = null;
}
async function startWrangler(configFile) {
  const args = [
    'wrangler', 'dev',
    '--port', String(PORT),
    '--local',
    '--ip', '127.0.0.1',
    '--persist-to', PERSIST_DIR,
  ];
  // The Durable Object phase needs a config with the optional binding enabled.
  if (configFile) args.push('--config', configFile);
  const cmd = 'npx';
  child = spawn(cmd, args, {
    cwd: WORKER_DIR,
    stdio: 'ignore',
    detached: !IS_WIN,
    shell: IS_WIN, // Windows requires shell:true to launch npx.cmd
  });
  // wait for readiness
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const r = await fetch(`${BASE}/api/me`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return;
    } catch { /* not up yet */ }
  }
  throw new Error('wrangler dev did not become ready in time');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function restart(base, extras, configFile) {
  killWrangler();
  await sleep(1500); // let the port release
  writeVars(base, extras);
  await startWrangler(configFile);
}

// ---- optional Durable Object config --------------------------------------
// wrangler.toml ships with the SESSION_REVOCATIONS binding commented out (KV is
// the default). To exercise the DO path we generate a sibling config with the
// binding switched on, run one phase against it, and delete it afterwards.
// The file has to live next to wrangler.toml — wrangler resolves `main` and the
// text-module globs relative to the config's own directory, so a temp dir will not
// do. That means it can collide with a file the developer already keeps there, so
// it is backed up and restored exactly like .dev.vars is.
const DO_CONFIG = path.join(WORKER_DIR, 'wrangler.do-test.toml');
let ORIGINAL_DO_CONFIG = null; // string = existed with this content, null = did not exist
function writeDoConfig() {
  try {
    ORIGINAL_DO_CONFIG = fs.readFileSync(DO_CONFIG, 'utf8');
  } catch {
    ORIGINAL_DO_CONFIG = null;
  }
  const base = fs.readFileSync(path.join(WORKER_DIR, 'wrangler.toml'), 'utf8');
  const extra = [
    '',
    '[[durable_objects.bindings]]',
    'name = "SESSION_REVOCATIONS"',
    'class_name = "SessionRevocations"',
    '',
    '[[migrations]]',
    'tag = "v1"',
    'new_sqlite_classes = ["SessionRevocations"]',
    '',
  ].join('\n');
  fs.writeFileSync(DO_CONFIG, base + extra);
}
function removeDoConfig() {
  if (ORIGINAL_DO_CONFIG != null) {
    // Put the developer's own file back rather than deleting it.
    try { fs.writeFileSync(DO_CONFIG, ORIGINAL_DO_CONFIG); } catch { /* ignore */ }
    return;
  }
  try { fs.unlinkSync(DO_CONFIG); } catch { /* already gone */ }
}

// ---- fetch helper ---------------------------------------------------------
function req(pathname, opts = {}) {
  return fetch(BASE + pathname, opts);
}

// ===========================================================================
//  PHASE 1: NORMAL MODE
// ===========================================================================
const shared = {}; // carries ids/titles/cookies across phases

async function phaseNormal() {
  console.log('\n=== PHASE: normal ===');

  // --- login success ---
  const loginRes = await req('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  const cookie = extractSessCookie(loginRes);
  const csrf = loginBody.csrf;
  record(
    'login: correct password -> 200 + cookie + csrf',
    loginRes.status === 200 && !!cookie && !!csrf,
    '200 with hv_sess cookie and csrf',
    `status=${loginRes.status} cookie=${!!cookie} csrf=${!!csrf}`
  );
  shared.cookie = cookie;
  shared.csrf = csrf;
  const authH = { Cookie: `hv_sess=${cookie}` };
  const authCsrf = { Cookie: `hv_sess=${cookie}`, 'x-csrf-token': csrf };

  // --- wrong password -> 401 ---
  {
    const r = await req('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'definitely-wrong-pass' }),
    });
    check('login: wrong password -> 401', r.status, 401);
  }

  // --- request body size cap on the unauthenticated login route ---
  {
    // /api/login only ever carries a password, so it is capped well below MAX_BYTES.
    // Without the cap the worker would read (and PBKDF2-compare) the whole body and
    // answer 401 instead, so this case fails if the cap is removed. Rejection happens
    // before the rate-limit KV read, so it does not burn a login attempt.
    const r = await req('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a'.repeat(128 * 1024) }),
    });
    await r.text();
    check('body-limit: unauth POST /api/login 128KB -> 413', r.status, 413);
  }

  // --- create a snippet (also validates create-response security headers) ---
  const createRes = await req('/api/snippets', {
    method: 'POST',
    headers: { ...authCsrf, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'UniqueTitleZQX123',
      tags: 'qa,smoke',
      html: '<!doctype html><title>UniqueTitleZQX123</title><h1>hello</h1><p>ordinary content</p>',
    }),
  });
  const createBody = await createRes.json().catch(() => ({}));
  check('create: authed + csrf -> 200', createRes.status, 200);
  checkSecHeaders('POST /api/snippets (create response)', createRes);
  shared.id = createBody.snippet && createBody.snippet.id;
  shared.title = createBody.snippet && createBody.snippet.title;

  // second snippet: body-only search target (needle not in title/tags)
  const create2 = await req('/api/snippets', {
    method: 'POST',
    headers: { ...authCsrf, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'PlainDoc',
      tags: '',
      html: '<!doctype html><title>PlainDoc</title><body><p>the marker is BODYNEEDLEWORD42 inside text</p></body>',
    }),
  });
  await create2.json().catch(() => ({}));

  // --- CSRF required on change endpoints (authed, no csrf header) ---
  {
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authH, 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>x</p>', title: 't' }),
    });
    check('csrf: POST without token -> 403', r.status, 403);
  }
  {
    const r = await req(`/api/snippets/${shared.id}`, {
      method: 'PUT',
      headers: { ...authH, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'nope' }),
    });
    check('csrf: PUT without token -> 403', r.status, 403);
  }
  {
    const r = await req(`/api/snippets/${shared.id}`, { method: 'DELETE', headers: authH });
    check('csrf: DELETE without token -> 403', r.status, 403);
  }

  // --- unauthenticated change endpoints -> 401 ---
  {
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>x</p>' }),
    });
    check('unauth: POST /api/snippets -> 401', r.status, 401);
  }
  {
    const r = await req(`/api/snippets/${shared.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    check('unauth: PUT /api/snippets/:id -> 401', r.status, 401);
  }
  {
    const r = await req(`/api/snippets/${shared.id}`, { method: 'DELETE' });
    check('unauth: DELETE /api/snippets/:id -> 401', r.status, 401);
  }
  {
    const r = await req('/api/logout', { method: 'POST' });
    check('unauth: POST /api/logout -> 401', r.status, 401);
  }

  // NOTE: logout now revokes the session server-side, so the logout assertions
  // live at the very end of this phase — everything below still needs authH.

  // --- security headers across representative responses ---
  checkSecHeaders('GET / (index)', await req('/'));
  checkSecHeaders('GET /api/me', await req('/api/me'));
  checkSecHeaders('GET /api/snippets (list)', await req('/api/snippets', { headers: authH }));
  checkSecHeaders(`GET /api/snippets/:id/raw`, await req(`/api/snippets/${shared.id}/raw`, { headers: authH }));
  checkSecHeaders('GET /api/snippets/:id/download', await req(`/api/snippets/${shared.id}/download`, { headers: authH }));

  const prevRes = await req(`/api/snippets/${shared.id}/preview`, { headers: authH });
  checkSecHeaders('GET /api/snippets/:id/preview', prevRes);
  checkSandboxCsp('GET /api/snippets/:id/preview', prevRes);

  const pRes = await req(`/p/${encodeURIComponent(shared.title)}.html`, { headers: authH });
  checkSecHeaders('GET /p/<title>', pRes);
  checkSandboxCsp('GET /p/<title>', pRes);

  // MCP 405 + 202
  const mcp405 = await req(`/mcp/${MCP_SECRET}`, { method: 'GET' });
  check('mcp: GET -> 405', mcp405.status, 405);
  checkSecHeaders('MCP 405 (GET /mcp)', mcp405);

  const mcp202 = await req(`/mcp/${MCP_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), // no id -> 202
  });
  check('mcp: notification-only POST -> 202', mcp202.status, 202);
  checkSecHeaders('MCP 202 (notification POST)', mcp202);

  // security.txt unset -> 404
  const sec = await req('/security.txt');
  check('security.txt: unset -> 404', sec.status, 404);
  checkSecHeaders('security.txt (404)', sec);

  // --- XSS: /p/<payload> 404 must be HTML-escaped ---
  {
    const payload = '<img src=x onerror=alert(1)>';
    const r = await req(`/p/${encodeURIComponent(payload)}`, { headers: authH });
    const text = await r.text();
    // Security-meaningful checks: the tag delimiters must be entity-escaped so
    // no live <img> element is created. The literal string "onerror=" may still
    // appear, but it is inert text once < and > are escaped (&lt;img ... &gt;).
    const escaped =
      text.includes('&lt;img') && text.includes('&gt;') && !text.includes('<img');
    record(
      'xss: /p/<img onerror> reflected-escape',
      r.status === 404 && escaped,
      '404 with &lt;img ... &gt; and no raw <img',
      `status=${r.status} has&lt;img=${text.includes('&lt;img')} has&gt;=${text.includes('&gt;')} hasRaw<img=${text.includes('<img')}`
    );
  }

  // --- search short-circuit ---
  {
    const r = await req('/api/search?q=uniquetitlezqx', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const first = (b.results || [])[0] || {};
    record(
      'search: title match -> field "title"',
      r.status === 200 && first.field === 'title',
      'field=title',
      `status=${r.status} field=${first.field} results=${(b.results || []).length}`
    );
  }
  {
    const r = await req('/api/search?q=bodyneedleword42', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const first = (b.results || [])[0] || {};
    record(
      'search: body-only match -> field "body" + excerpt',
      r.status === 200 && first.field === 'body' && !!first.excerpt,
      'field=body with non-empty excerpt',
      `status=${r.status} field=${first.field} excerpt="${first.excerpt || ''}"`
    );
  }

  // --- ID validation ---
  {
    const r = await req('/api/snippets/zzz/raw', { headers: authH });
    check('id-validation: /api/snippets/zzz/raw -> 400', r.status, 400);
  }

  // --- MCP tools/list works ---
  {
    const r = await req(`/mcp/${MCP_SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const b = await r.json().catch(() => ({}));
    const tools = (b.result && b.result.tools) || [];
    record(
      'mcp: tools/list returns tools',
      r.status === 200 && tools.length === 2 && tools.some((t) => t.name === 'upload_html'),
      '200 with 2 tools incl upload_html',
      `status=${r.status} tools=${tools.map((t) => t.name).join(',')}`
    );
  }

  // --- pin / reorder ---
  // Pinning only changes ordering, so `updated` must stay put (otherwise pinning
  // would silently reshuffle the unpinned group, which is sorted by -updated).
  const listIds = async () => {
    const r = await req('/api/snippets', { headers: authH });
    const b = await r.json().catch(() => ({}));
    return b.snippets || [];
  };
  {
    const before = await listIds();
    const last = before[before.length - 1] || {};
    const r = await req(`/api/snippets/${last.id}`, {
      method: 'PUT',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    const b = await r.json().catch(() => ({}));
    const after = await listIds();
    record(
      'pin: PUT {pinned:true} -> pinned first, updated untouched',
      r.status === 200 && after[0] && after[0].id === last.id &&
        b.snippet && b.snippet.updated === last.updated,
      `first=${last.id} with same updated`,
      `status=${r.status} first=${after[0] && after[0].id} updated ${last.updated}->${b.snippet && b.snippet.updated}`
    );

    const un = await req(`/api/snippets/${last.id}`, {
      method: 'PUT',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    });
    const restored = await listIds();
    record(
      'pin: PUT {pinned:false} -> back to its previous slot',
      un.status === 200 && restored[restored.length - 1] &&
        restored[restored.length - 1].id === last.id,
      `last=${last.id}`,
      `status=${un.status} last=${restored[restored.length - 1] && restored[restored.length - 1].id}`
    );
  }
  {
    const before = await listIds();
    const reversed = before.map((s) => s.id).reverse();
    const r = await req('/api/snippets/order', {
      method: 'PUT',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: reversed }),
    });
    const after = await listIds();
    record(
      'order: PUT {ids} -> list follows the given order',
      r.status === 200 && after.map((s) => s.id).join(',') === reversed.join(','),
      reversed.join(','),
      `status=${r.status} got=${after.map((s) => s.id).join(',')}`
    );
  }
  {
    const r = await req('/api/snippets/order', {
      method: 'PUT',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['not-a-valid-id'] }),
    });
    check('order: invalid ids -> 400', r.status, 400);
  }
  {
    // /api/snippets/order is matched before the /:id route, so it needs its own CSRF check.
    const r = await req('/api/snippets/order', {
      method: 'PUT',
      headers: { ...authH, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    check('order: without csrf -> 403', r.status, 403);
  }

  // --- request body size cap on the snippet route ---
  {
    // The snippet route carries HTML, so it keeps the large cap: a body well past the
    // login cap must still be accepted (guards against applying the small cap globally).
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'BigButAllowed', html: '<p>' + 'b'.repeat(256 * 1024) + '</p>' }),
    });
    const b = await r.json().catch(() => ({}));
    check('body-limit: 256KB snippet create -> 200', r.status, 200);
    if (b.snippet && b.snippet.id) {
      await req(`/api/snippets/${b.snippet.id}`, { method: 'DELETE', headers: authCsrf });
    }
  }
  {
    // Past MAX_BYTES the HTML cannot be stored. 'x' does not get escaped, so this one
    // clears the JSON envelope and is rejected by the handler's byte-length check.
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'TooBigToStore', html: 'x'.repeat(11 * 1024 * 1024) }),
    });
    await r.text();
    check('body-limit: 11MB snippet create -> 413', r.status, 413);
  }
  {
    // Past the JSON envelope (MAX_BYTES*2 + headroom) it is rejected on Content-Length,
    // before a single byte of the body is read.
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'WayTooBig', html: 'x'.repeat(21 * 1024 * 1024) }),
    });
    await r.text();
    check('body-limit: 21MB snippet create -> 413 (before parsing)', r.status, 413);
  }
  {
    // Regression: JSON escapes the body, so the request is larger than the HTML it
    // carries. An all-quotes HTML doubles exactly (6MiB -> over 12MiB) while the stored
    // HTML stays within the 10MiB cap. An envelope of MAX_BYTES + headroom turns this
    // legitimate upload into a 413 (reported on PR #55).
    const quoted = '"'.repeat(6 * 1024 * 1024);
    const body = JSON.stringify({ title: 'QuoteHeavy', html: quoted });
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body,
    });
    const b = await r.json().catch(() => ({}));
    record(
      'body-limit: 6MiB of HTML that doubles under JSON escaping is accepted',
      r.status === 200 && bodyBytes > 10 * 1024 * 1024 + 256 * 1024,
      `200 and request body > 10MiB+256KiB (actual ${bodyBytes} bytes)`,
      `status=${r.status} bodyBytes=${bodyBytes}`
    );
    if (b.snippet && b.snippet.id) {
      await req(`/api/snippets/${b.snippet.id}`, { method: 'DELETE', headers: authCsrf });
    }
  }
  {
    // The stored-HTML contract: C0 control characters other than Tab/LF/CR are refused.
    // This is not cosmetic — it is what makes the 2x JSON envelope sound.
    const NUL = String.fromCharCode(0);
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'CtrlChars', html: '<p>' + NUL + '</p>' }),
    });
    await r.text();
    check('contract: control characters in the body -> 400', r.status, 400);
  }
  {
    // Control characters expand to a 6-byte escape in JSON, so 4MiB of them becomes a
    // 25MB request. The contract forbids that body anyway, so rejecting it at the
    // envelope is fine: no storable body is ever refused by the envelope.
    const NUL = String.fromCharCode(0);
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'NullHeavy', html: NUL.repeat(4 * 1024 * 1024) }),
    });
    await r.text();
    check('contract: 4MiB of control characters -> 413 (envelope)', r.status, 413);
  }
  {
    // The update path carries the same contract (guarding create alone is pointless).
    const NUL = String.fromCharCode(0);
    const c = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'CtrlUpdateTarget', html: '<p>ok</p>' }),
    });
    const cb = await c.json().catch(() => ({}));
    const id = cb.snippet && cb.snippet.id;
    const r = await req('/api/snippets/' + id, {
      method: 'PUT',
      headers: { ...authCsrf, 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>' + NUL + '</p>' }),
    });
    await r.text();
    check('contract: control characters on update -> 400', r.status, 400);
    if (id) await req('/api/snippets/' + id, { method: 'DELETE', headers: authCsrf });
  }
  {
    // The rejected creates must not have been stored.
    const r = await req('/api/snippets', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const titles = (b.snippets || []).map((s) => s.title);
    record(
      'body-limit: the 413 creates are not stored',
      !titles.includes('TooBigToStore') && !titles.includes('WayTooBig') && !titles.includes('QuoteHeavy') &&
        !titles.includes('CtrlChars') && !titles.includes('NullHeavy') && !titles.includes('CtrlUpdateTarget'),
      'list contains none of the rejected or cleaned-up titles',
      titles.join(',') || '(empty)'
    );
  }

  // --- logout: must revoke server-side, not just clear the client cookie ---
  // Kept last in this phase because it kills the session every assertion above uses.
  {
    const r = await req('/api/logout', { method: 'POST', headers: authH });
    check('logout: authed without csrf -> 403', r.status, 403);
  }
  {
    const r = await req('/api/logout', { method: 'POST', headers: authCsrf });
    check('logout: authed with csrf -> 200', r.status, 200);
  }
  {
    // The signed cookie is still intact and unexpired; only the server-side
    // revocation list can stop it. Replaying it must fail.
    const r = await req('/api/snippets', { headers: authH });
    check('logout: replaying the logged-out cookie -> 401', r.status, 401);
  }
  {
    const r = await req('/api/me', { headers: authH });
    const b = await r.json().catch(() => ({}));
    record(
      'logout: /api/me with the logged-out cookie -> authed:false',
      r.status === 200 && b.authed === false && b.csrf === null,
      '200 authed=false csrf=null',
      `status=${r.status} authed=${b.authed} csrf=${b.csrf}`
    );
  }
  {
    // A write path too. Uses a well-formed but non-existent id so a regression
    // here fails loudly (401 expected) instead of deleting a snippet the later
    // phases rely on.
    const r = await req(`/api/snippets/${'a'.repeat(32)}`, { method: 'DELETE', headers: authCsrf });
    check('logout: write with the logged-out cookie -> 401', r.status, 401);
  }
}

// ===========================================================================
//  PHASE 2: DEMO MODE
// ===========================================================================
async function phaseDemo() {
  console.log('\n=== PHASE: demo ===');

  check('demo: GET /api/snippets (list) -> 200 no-auth', (await req('/api/snippets')).status, 200);
  check(
    'demo: GET /preview -> 200 no-auth',
    (await req(`/api/snippets/${shared.id}/preview`)).status,
    200
  );
  check(
    'demo: GET /p/<title> -> 200 no-auth',
    (await req(`/p/${encodeURIComponent(shared.title)}.html`)).status,
    200
  );

  {
    const r = await req('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    check('demo: POST /api/login -> 403', r.status, 403);
  }
  check('demo: POST /api/logout -> 403', (await req('/api/logout', { method: 'POST' })).status, 403);
  {
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>x</p>' }),
    });
    check('demo: POST /api/snippets -> 403', r.status, 403);
  }
  {
    const r = await req(`/api/snippets/${shared.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    check('demo: PUT /api/snippets/:id -> 403', r.status, 403);
  }
  {
    const r = await req('/api/snippets/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [shared.id] }),
    });
    check('demo: PUT /api/snippets/order -> 403', r.status, 403);
  }
  check(
    'demo: DELETE /api/snippets/:id -> 403',
    (await req(`/api/snippets/${shared.id}`, { method: 'DELETE' })).status,
    403
  );

  // MCP upload_html blocked in demo (expressed as JSON-RPC isError, not HTTP 403)
  {
    const r = await req(`/mcp/${MCP_SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'upload_html', arguments: { html: '<p>demo</p>' } },
      }),
    });
    const b = await r.json().catch(() => ({}));
    const isErr = b.result && b.result.isError === true;
    const txt = (b.result && b.result.content && b.result.content[0] && b.result.content[0].text) || '';
    record(
      'demo: MCP upload_html blocked (isError + demo msg)',
      r.status === 200 && isErr && /demo/i.test(txt),
      'isError:true with read-only demo message',
      `status=${r.status} isError=${isErr} text="${txt}"`
    );
  }
}

// ===========================================================================
//  PHASE 4: DURABLE OBJECT REVOCATION (optional binding)
// ===========================================================================
// Same guarantees as the KV path, but backed by a Durable Object. Locally both
// are strongly consistent, so this phase cannot prove the multi-PoP difference
// (that needs a real deployment). What it does prove: the binding, the class
// and the migration are wired correctly, wrangler dev boots with them, and
// logout still revokes the session when the DO path is the one being used.
async function phaseDurableObject() {
  console.log('\n=== PHASE: durable-object ===');

  record(
    'do: generated config carries the SESSION_REVOCATIONS binding',
    fs.readFileSync(DO_CONFIG, 'utf8').includes('name = "SESSION_REVOCATIONS"'),
    'binding present in wrangler.do-test.toml',
    'missing'
  );

  const loginRes = await req('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  const cookie = extractSessCookie(loginRes);
  const csrf = loginBody.csrf;
  record(
    'do: login -> 200 + cookie + csrf',
    loginRes.status === 200 && !!cookie && !!csrf,
    '200 with hv_sess cookie and csrf',
    `status=${loginRes.status} cookie=${!!cookie} csrf=${!!csrf}`
  );
  const authH = { Cookie: `hv_sess=${cookie}` };
  const authCsrf = { Cookie: `hv_sess=${cookie}`, 'x-csrf-token': csrf };

  {
    const r = await req('/api/snippets', { headers: authH });
    check('do: the session works before logout -> 200', r.status, 200);
  }
  {
    const r = await req('/api/logout', { method: 'POST', headers: authCsrf });
    check('do: logout -> 200 (the DO write succeeded)', r.status, 200);
  }
  {
    // The signed cookie is untouched and unexpired. Only the DO revocation list
    // can stop it.
    const r = await req('/api/snippets', { headers: authH });
    check('do: replaying the logged-out cookie -> 401', r.status, 401);
  }
  {
    const r = await req('/api/me', { headers: authH });
    const b = await r.json().catch(() => ({}));
    record(
      'do: /api/me with the logged-out cookie -> authed:false',
      r.status === 200 && b.authed === false && b.csrf === null,
      '200 authed=false csrf=null',
      `status=${r.status} authed=${b.authed} csrf=${b.csrf}`
    );
  }
  {
    const r = await req(`/api/snippets/${'a'.repeat(32)}`, { method: 'DELETE', headers: authCsrf });
    check('do: write with the logged-out cookie -> 401', r.status, 401);
  }
  {
    // A fresh login must not inherit the previous session's revocation.
    const r2 = await req('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const c2 = extractSessCookie(r2);
    const r3 = await req('/api/snippets', { headers: { Cookie: `hv_sess=${c2}` } });
    check('do: logging in again works after a revocation -> 200', r3.status, 200);
  }
}

// ===========================================================================
//  PHASE 3: MCP UNSET
// ===========================================================================
async function phaseMcpUnset() {
  console.log('\n=== PHASE: mcp-unset ===');
  const r = await req('/mcp/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  check('mcp-unset: POST /mcp/x -> 404', r.status, 404);
  const r2 = await req('/mcp/x', { method: 'GET' });
  check('mcp-unset: GET /mcp/x -> 404', r2.status, 404);
}

// ===========================================================================
//  MAIN
// ===========================================================================
async function main() {
  const base = readBaseVars();
  // clean isolated KV/rate-limit state
  try { fs.rmSync(PERSIST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

  try {
    await restart(base, [`MCP_SECRET_PATH=${MCP_SECRET}`]);
    await phaseNormal();

    await restart(base, [`MCP_SECRET_PATH=${MCP_SECRET}`, 'DEMO_MODE=1']);
    await phaseDemo();

    await restart(base, []); // MCP secret removed
    await phaseMcpUnset();

    // Optional Durable Object revocation backend.
    writeDoConfig();
    await restart(base, [`MCP_SECRET_PATH=${MCP_SECRET}`], DO_CONFIG);
    await phaseDurableObject();
  } finally {
    killWrangler();
    restoreVars();
    removeDoConfig();
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n========================================');
  console.log(`TOTAL ${results.length}  PASSED ${passed}  FAILED ${failed}`);
  console.log('========================================');
  if (failed > 0) {
    console.log('\nFAILURES:');
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  - ${r.name}\n      expected: ${r.expected}\n      actual:   ${r.actual}`);
    }
  }
  // machine-readable summary line
  console.log('\nRESULT_JSON ' + JSON.stringify({
    total: results.length, passed, failed,
    failures: results.filter((x) => !x.pass).map((x) => ({ name: x.name, expected: x.expected, actual: x.actual })),
  }));
  process.exit(failed > 0 ? 1 : 0);
}

// Restore .dev.vars and kill the dev server on Ctrl+C / termination signals,
// not just on normal exit, so an interrupted run doesn't leave a phase-specific
// .dev.vars behind.
let cleanedUp = false;
function cleanupOnSignal(signal) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { killWrangler(); } catch { /* ignore */ }
  try { restoreVars(); } catch { /* ignore */ }
  try { removeDoConfig(); } catch { /* ignore */ }
  console.log(`\nInterrupted by ${signal}; .dev.vars restored.`);
  process.exit(130);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => cleanupOnSignal(sig));
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  try { killWrangler(); } catch { /* ignore */ }
  try { restoreVars(); } catch { /* ignore */ }
  try { removeDoConfig(); } catch { /* ignore */ }
  process.exit(2);
});
