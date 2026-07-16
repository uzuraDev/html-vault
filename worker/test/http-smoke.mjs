/**
 * HTTP-level integration smoke test for the Cloudflare Workers build of HTML Vault.
 *
 * Self-orchestrating: this single file owns the whole lifecycle. It backs up the
 * developer's worker/.dev.vars, then for each phase it writes a phase-specific
 * .dev.vars, spawns `wrangler dev` (isolated --persist-to so it never touches your
 * real local KV / rate-limit state), waits for /api/me, runs the phase's assertions,
 * and kills the server. On exit the original .dev.vars is always restored.
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
      if (IS_WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    } catch { /* ignore */ }
  }
  child = null;
  // Belt-and-suspenders: kill any lingering local runtime holding the port.
  if (IS_WIN) spawnSync('taskkill', ['/F', '/IM', 'workerd.exe'], { stdio: 'ignore' });
}
async function startWrangler() {
  const args = [
    'wrangler', 'dev',
    '--port', String(PORT),
    '--local',
    '--ip', '127.0.0.1',
    '--persist-to', PERSIST_DIR,
  ];
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

async function restart(base, extras) {
  killWrangler();
  await sleep(1500); // let the port release
  writeVars(base, extras);
  await startWrangler();
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

  // --- logout without csrf -> 403, with csrf -> 200 ---
  {
    const r = await req('/api/logout', { method: 'POST', headers: authH });
    check('logout: authed without csrf -> 403', r.status, 403);
  }
  {
    const r = await req('/api/logout', { method: 'POST', headers: authCsrf });
    check('logout: authed with csrf -> 200', r.status, 200);
  }
  // NOTE: sessions are stateless HMAC cookies; logout only clears the client
  // cookie, so shared.cookie remains valid for the rest of this phase.

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
  } finally {
    killWrangler();
    restoreVars();
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

main().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  try { killWrangler(); } catch { /* ignore */ }
  try { restoreVars(); } catch { /* ignore */ }
  process.exit(2);
});
