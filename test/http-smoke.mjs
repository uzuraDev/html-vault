/**
 * Express 版 HTML Vault の HTTP レベル統合スモークテスト。
 *
 * 依存ゼロ (Node 22+ の組込み fetch のみ)。worker/test/http-smoke.mjs と同じ作りに
 * 揃えてある — record/check ヘルパ、フェーズごとにサーバーを起動し直す構成、
 * シグナルでの後始末、RESULT_JSON の要約行。片方を読めばもう片方も読めるようにするため。
 *
 * 目的は CONTRIBUTING.md の "Keep intact" を機械的に守らせること。
 * Express 版には振る舞いのテストが無く、CSRF が外れてもプレビューの sandbox に
 * allow-same-origin が付いても CI が緑のままだった。そこを塞ぐのがこのファイル。
 *
 * 自己完結: このファイルがサーバープロセスの起動と後始末まで持つ。
 *  - DATA_DIR は os.tmpdir() 配下に mkdtemp した使い捨てを渡す (リポジトリの data/ を汚さない)
 *  - AUTH_PASSWORD を渡して auth.json を初回起動時に作らせる
 *  - 終了時 (正常・例外・SIGINT いずれも) にプロセスを殺し一時ディレクトリを消す
 *
 * 起動前に `APP_LANG=en node scripts/build-i18n.mjs` を実行する。public/index.html は
 * locales/ + index.template.html から生成される gitignore 済みの成果物なので、
 * ここで上書きしても追跡対象は変わらない (静的配信のテストに必要)。
 *
 * フェーズ:
 *   1. normal   — MCP_SECRET_PATH と API_TOKEN を設定した通常構成
 *   2. minimal  — 両方とも未設定。/mcp が 404 であること・Bearer が無効であることを見る。
 *                 最後にログインのレート制限を確認する (ログイン回数を使い切るので必ず末尾)
 *   3. revoke   — ログアウトとパスワード変更でセッションがサーバー側から失効すること。
 *                 data/auth.json を差し替える = パスワードが変わるので必ず末尾に置く
 *
 * 使い方: node test/http-smoke.mjs
 * 環境変数: HV_PORT (既定 3799。フェーズごとに +1 して使う) / HV_PASSWORD /
 *           HV_MCP_SECRET / HV_API_TOKEN
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// server.js と同じ bcryptjs を使って auth.json を書き換える (= npm run setpass 相当)。
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// フェーズごとにポートをずらす。同じポートを使い回すと、前のサーバーを落とした直後の
// 解放待ち (TIME_WAIT) や fetch の keep-alive プールに残った古い接続と競合しうる。
// ポートを変えれば次のフェーズは必ず新規接続になり、待ち時間の勘に頼らずに済む。
const PORT = parseInt(process.env.HV_PORT || '3799', 10);
let port = PORT;
let BASE = `http://127.0.0.1:${port}`;
const PASSWORD = process.env.HV_PASSWORD || 'smoke-test-pass-1234';
const MCP_SECRET = process.env.HV_MCP_SECRET || 'localsmoketest';
const API_TOKEN = process.env.HV_API_TOKEN || 'smoke-api-token-abcdef';
const SESSION_SECRET = 'smoke-session-secret-0123456789';
const IS_WIN = process.platform === 'win32';
// server.js の loginLimiter は windowMs 15分 / max 10。値を変えたらここも合わせる。
const LOGIN_LIMIT = 10;

// 使い捨ての DATA_DIR。既存の data/ を絶対に触らない。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-express-smoke-'));
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
// revoke フェーズで setpass 相当の差し替えに使う新パスワード。
const NEW_PASSWORD = process.env.HV_NEW_PASSWORD || 'smoke-rotated-pass-5678';

// ---- 結果の集計 -----------------------------------------------------------
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

// ---- ヘッダ検査 -----------------------------------------------------------
function secHeaders(res) {
  return {
    nosniff: res.headers.get('x-content-type-options'),
    frame: res.headers.get('x-frame-options'),
    ref: res.headers.get('referrer-policy'),
    csp: res.headers.get('content-security-policy'),
  };
}
// helmet が全レスポンスに付けるべき基本ヘッダ。1つでも欠けたら helmet の設定が壊れている。
function checkSecHeaders(label, res) {
  const h = secHeaders(res);
  const ok = h.nosniff === 'nosniff' && h.frame === 'SAMEORIGIN' && h.ref === 'no-referrer';
  record(
    `sec-headers: ${label}`,
    ok,
    'nosniff / SAMEORIGIN / no-referrer',
    `nosniff=${h.nosniff} frame=${h.frame} ref=${h.ref}`
  );
}
// 本体UI側のCSP。default-src 'self' と object-src 'none' が生きていること。
function checkAppCsp(label, res) {
  const csp = res.headers.get('content-security-policy') || '';
  const ok =
    csp.includes("default-src 'self'") &&
    csp.includes("object-src 'none'") &&
    csp.includes("base-uri 'self'") &&
    csp.includes("frame-src 'self'");
  record(
    `app-CSP: ${label}`,
    ok,
    "default-src 'self' / object-src 'none' / base-uri 'self' / frame-src 'self'",
    csp || '(none)'
  );
}
// プレビューのCSP。sandbox のみで始まり allow-same-origin を含まないこと。
// allow-same-origin が付くと保存したHTMLが本体オリジンのCookie/APIに触れる = 設計が崩れる。
function checkSandboxCsp(label, res) {
  const csp = res.headers.get('content-security-policy') || '';
  const ok = csp.startsWith('sandbox ') && !csp.includes('allow-same-origin') && !csp.includes("default-src 'self'");
  record(
    `sandbox-CSP: ${label}`,
    ok,
    "'sandbox ' で始まり allow-same-origin と default-src 'self' を含まない",
    csp || '(none)'
  );
}

// ---- Cookie ---------------------------------------------------------------
// express-session のCookie名は hv.sid (ドット入りなのでエスケープが要る)。
function setCookieLines(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one ? [one] : [];
}
function extractSess(res) {
  for (const line of setCookieLines(res)) {
    const m = /(?:^|;\s*)hv\.sid=([^;]*)/.exec(line);
    if (m) return { value: m[1], raw: line };
  }
  return null;
}
// Cookie 値は署名付きの `s:<sid>.<sig>` (URLエンコード済み)。sid だけ取り出す。
// sessions.json のキーが sid なので、サーバー側に実体が残っていないかを直接見られる。
function sidOf(cookieValue) {
  const raw = decodeURIComponent(String(cookieValue || ''));
  const m = /^s:([^.]+)\./.exec(raw);
  return m ? m[1] : '';
}
function sessionStoreHas(sid) {
  if (!sid) return false;
  try {
    const obj = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return Object.prototype.hasOwnProperty.call(obj, sid);
  } catch {
    return false; // ファイルが無い = 実体も無い
  }
}

// ---- サーバープロセスの生死 ----------------------------------------------
// 生死の判定は child.exitCode を直接見る。'exit' イベントでフラグを立てる作りにすると、
// 殺した前フェーズのプロセスの 'exit' が次のプロセス起動後に届き、起動直後のサーバーを
// 「もう死んでいる」と誤判定する (実際に踏んだ)。
let child = null;
let childLog = [];

function recordLog(buf) {
  childLog.push(String(buf));
  if (childLog.length > 200) childLog.splice(0, childLog.length - 200);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ポートを誰かが掴んでいるか。接続できてしまうなら使用中。
function portInUse(p) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: p });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1000);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function killServer() {
  const proc = child;
  child = null;
  if (!proc || !proc.pid || proc.exitCode !== null) return;
  try {
    // PID を指定してプロセスツリーごと落とす。名前 (node.exe) で殺すと
    // マシン上の無関係な Node プロセスまで巻き込むので絶対にしない。
    if (IS_WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGKILL');
  } catch {
    /* 既に死んでいる場合は無視 */
  }
}

async function startServer(extraEnv) {
  if (await portInUse(port)) {
    throw new Error(`ポート ${port} は既に使用中。HV_PORT で別のポートを指定する。`);
  }
  const env = {
    ...process.env,
    APP_LANG: 'en',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR,
    SESSION_SECRET,
    AUTH_PASSWORD: PASSWORD,
    // 開発者の環境変数が紛れ込むと期待値が変わるので、関係するキーは必ず明示的に上書きする。
    BEHIND_HTTPS: '',
    API_TOKEN: '',
    MCP_SECRET_PATH: '',
    MAX_UPLOAD_MB: '10',
    ...extraEnv,
  };
  childLog = [];
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN, // POSIX ではプロセスグループごと殺せるようにする
  });
  child = proc;
  proc.stdout.on('data', recordLog);
  proc.stderr.on('data', recordLog);

  const deadline = Date.now() + 30_000;
  let lastErr = '(なし)';
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      lastErr = `プロセスが exit code ${proc.exitCode} で終了した`;
      break;
    }
    try {
      const r = await fetch(`${BASE}/api/me`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return;
      lastErr = `GET /api/me -> ${r.status}`;
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    await sleep(200);
  }
  throw new Error(
    `server.js (port ${port}) が起動しなかった。最後のエラー: ${lastErr}\n出力:\n` + childLog.join('')
  );
}

async function restart(extraEnv) {
  killServer();
  port += 1;
  BASE = `http://127.0.0.1:${port}`;
  await startServer(extraEnv);
}

// ---- fetch ヘルパ ---------------------------------------------------------
function req(pathname, opts = {}) {
  return fetch(BASE + pathname, { redirect: 'manual', ...opts });
}
// extraHeaders は「既存のセッションCookieを持ったまま再ログインする」ケースで使う
// (セッション固定対策の確認)。
function login(password, extraHeaders = {}) {
  return req('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ password }),
  });
}

// ===========================================================================
//  PHASE 1: normal (MCP_SECRET_PATH + API_TOKEN あり)
// ===========================================================================
async function phaseNormal() {
  console.log('\n=== PHASE: normal ===');

  // --- 未認証はすべて弾かれる (ログインより先に確認する) ---
  check('unauth: GET /api/snippets -> 401', (await req('/api/snippets')).status, 401);
  check('unauth: GET /api/search?q=ab -> 401', (await req('/api/search?q=ab')).status, 401);
  check('unauth: POST /api/logout -> 401', (await req('/api/logout', { method: 'POST' })).status, 401);
  {
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>x</p>', title: 't' }),
    });
    check('unauth: POST /api/snippets -> 401', r.status, 401);
  }
  {
    // 未認証には大きい上限を与えない。壊れた JSON を 64KB 超で送ると、パースまで
    // 行っていれば 400 (entity.parse.failed) になる。パースの前に弾けていれば 401。
    // = 未認証のまま 10MB をバッファ+パースさせられないことの裏取り。
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"html":"' + 'x'.repeat(256 * 1024),
    });
    await r.text();
    check('body-limit: unauth POST /api/snippets 256KB -> 401 (パース前に終わる)', r.status, 401);
  }
  {
    // 未認証で叩ける /api/login はパスワードしか運ばない。アプリ側の上限 (64KB) が
    // 効いていれば、bcrypt 比較にもレート制限カウンタにも到達せず 413 で終わる。
    // 上限が外れると 401 (パスワード不一致) になるのでこのケースが落ちる。
    const r = await req('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a'.repeat(128 * 1024) }),
    });
    await r.text();
    check('body-limit: unauth POST /api/login 128KB -> 413', r.status, 413);
  }
  {
    const r = await req('/api/me');
    const b = await r.json().catch(() => ({}));
    record(
      'unauth: GET /api/me -> authed:false csrf:null',
      r.status === 200 && b.authed === false && b.csrf === null,
      '200 authed=false csrf=null',
      `status=${r.status} authed=${b.authed} csrf=${b.csrf}`
    );
  }

  // --- ログイン失敗。パスワードを応答に混ぜないこと ---
  {
    const wrong = 'definitely-wrong-pass';
    const r = await login(wrong);
    const text = await r.text();
    record(
      'login: 誤りパスワード -> 401 かつ本文にパスワードが出ない',
      r.status === 401 && !text.includes(wrong) && !text.includes(PASSWORD),
      '401 で本文にパスワード文字列を含まない',
      `status=${r.status} body=${text.slice(0, 120)}`
    );
    record(
      'login: 失敗時にセッションCookieを発行しない',
      extractSess(r) === null,
      'Set-Cookie に hv.sid が無い',
      String(setCookieLines(r).join(' | ') || '(none)')
    );
  }

  // --- ログイン成功 ---
  const loginRes = await login(PASSWORD);
  const loginBody = await loginRes.json().catch(() => ({}));
  const sess = extractSess(loginRes);
  const csrf = loginBody.csrf;
  record(
    'login: 正しいパスワード -> 200 + Cookie + csrf',
    loginRes.status === 200 && !!sess && typeof csrf === 'string' && csrf.length >= 32,
    '200 で hv.sid Cookie と csrf トークンが返る',
    `status=${loginRes.status} cookie=${!!sess} csrf=${csrf ? csrf.length + '文字' : 'なし'}`
  );
  if (!sess) throw new Error('ログインに失敗したので以降のテストを続行できない');
  {
    const raw = sess.raw;
    const ok = /HttpOnly/i.test(raw) && /SameSite=Strict/i.test(raw);
    record('login: Cookie が HttpOnly + SameSite=Strict', ok, 'HttpOnly と SameSite=Strict', raw);
  }
  // --- セッション固定対策: ログインのたびにセッションIDが入れ替わること ---
  // server.js のログインは req.session.regenerate() を通してから authed を立てている。
  // ここを外すと、認証前に配られたセッションIDが認証後もそのまま有効になる (セッション固定)。
  // 「200 が返る」だけを見るテストではこの改変が素通りするので、ID が変わることと
  // 古いIDが無効になることの両方を明示的に見る。
  // 以降のテストは、この再ログインで得た新しいセッションを使う。
  const relogin = await login(PASSWORD, { Cookie: `hv.sid=${sess.value}` });
  const reloginBody = await relogin.json().catch(() => ({}));
  const sess2 = extractSess(relogin);
  record(
    'session: 再ログインでセッションIDが入れ替わる (固定攻撃対策)',
    relogin.status === 200 && !!sess2 && sess2.value !== sess.value,
    '200 で hv.sid が前回と異なる値になる',
    `status=${relogin.status} 変化=${!!sess2 && sess2.value !== sess.value}`
  );
  if (!sess2) throw new Error('再ログインでセッションCookieが返らなかったので続行できない');
  {
    const r = await req('/api/snippets', { headers: { Cookie: `hv.sid=${sess.value}` } });
    check('session: 入れ替わる前の古いセッションIDは無効 -> 401', r.status, 401);
  }

  const authH = { Cookie: `hv.sid=${sess2.value}` };
  const authCsrf = { ...authH, 'x-csrf-token': reloginBody.csrf };
  const jsonCsrf = { ...authCsrf, 'content-type': 'application/json' };

  // --- CSRF: セッションはあるがトークンが無い/違う変更系は 403 ---
  {
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authH, 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>x</p>', title: 't' }),
    });
    check('csrf: POST /api/snippets トークン無し -> 403', r.status, 403);
  }
  {
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...authH, 'content-type': 'application/json', 'x-csrf-token': 'deadbeef' },
      body: JSON.stringify({ html: '<p>x</p>', title: 't' }),
    });
    check('csrf: POST /api/snippets 不正トークン -> 403', r.status, 403);
  }

  // --- 作成 (正常系)。IDはサーバー採番であること ---
  const forgedId = 'f'.repeat(32);
  const createRes = await req('/api/snippets', {
    method: 'POST',
    headers: jsonCsrf,
    body: JSON.stringify({
      id: forgedId, // クライアント指定のIDは無視されるはず
      title: 'UniqueTitleZQX123',
      tags: 'qa,smoke',
      html: '<!doctype html><title>UniqueTitleZQX123</title><h1>hello</h1><p>ordinary content</p>',
    }),
  });
  const createBody = await createRes.json().catch(() => ({}));
  const meta = createBody.snippet || {};
  check('create: 認証+CSRF -> 200', createRes.status, 200);
  checkSecHeaders('POST /api/snippets', createRes);
  record(
    'id: クライアント指定のIDを採用しない (サーバー採番の32桁hex)',
    /^[a-f0-9]{32}$/.test(meta.id || '') && meta.id !== forgedId,
    `32桁hex かつ ${forgedId} ではない`,
    `id=${meta.id}`
  );
  const id = meta.id;

  // 本文だけに現れる語を持つ2件目 (検索の field=body 用)
  {
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: jsonCsrf,
      body: JSON.stringify({
        title: 'PlainDoc',
        tags: '',
        html: '<!doctype html><title>PlainDoc</title><body><p>the marker is BODYNEEDLEWORD42 inside text</p></body>',
      }),
    });
    check('create: 2件目 -> 200', r.status, 200);
  }

  // --- 一覧・検索 ---
  {
    const r = await req('/api/snippets', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const list = b.snippets || [];
    record(
      'list: 認証済み -> 200 で作成した2件が見える',
      r.status === 200 && list.length === 2 && list.some((s) => s.id === id),
      '200 で2件',
      `status=${r.status} count=${list.length}`
    );
    record(
      'list: 詐称IDのスニペットは存在しない',
      !list.some((s) => s.id === forgedId),
      `id=${forgedId} を含まない`,
      list.map((s) => s.id).join(',')
    );
    checkSecHeaders('GET /api/snippets', r);
  }
  {
    const r = await req('/api/search?q=uniquetitlezqx', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const first = (b.results || [])[0] || {};
    record(
      'search: タイトル一致 -> field=title',
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
      'search: 本文のみ一致 -> field=body + 抜粋あり',
      r.status === 200 && first.field === 'body' && !!first.excerpt,
      'field=body で excerpt が空でない',
      `status=${r.status} field=${first.field} excerpt="${first.excerpt || ''}"`
    );
  }
  {
    // ?excerpt=0 はタイトル/タグ一致行の本文読み込みを省く (抜粋が付かなくなるだけで、件数は同じ)
    const r = await req('/api/search?q=uniquetitlezqx&excerpt=0', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const first = (b.results || [])[0] || {};
    record(
      'search: excerpt=0 -> タイトル一致行はヒットしたまま抜粋なし',
      r.status === 200 && (b.results || []).length === 1 && first.field === 'title' && first.excerpt === '',
      '1件・field=title・excerpt は空',
      `status=${r.status} results=${(b.results || []).length} field=${first.field} excerpt="${first.excerpt}"`
    );
  }
  {
    // excerpt=0 でも本文のみ一致は従来どおり見つかる (本文走査を止める指定ではない)
    const r = await req('/api/search?q=bodyneedleword42&excerpt=0', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const first = (b.results || [])[0] || {};
    record(
      'search: excerpt=0 でも本文のみ一致は抜粋つきで返る',
      r.status === 200 && first.field === 'body' && !!first.excerpt,
      'field=body で excerpt が空でない',
      `status=${r.status} field=${first.field} excerpt="${first.excerpt || ''}"`
    );
  }
  {
    const r = await req('/api/search?q=uniquetitlezqx', { headers: authH });
    await r.text().catch(() => '');
    const st = r.headers.get('server-timing') || '';
    record(
      'search: Server-Timing で走査時間を返す',
      /^search;dur=\d+(\.\d+)?;desc="scan"$/.test(st),
      'search;dur=<ms>;desc="scan"',
      `Server-Timing="${st}"`
    );
  }

  // --- 取得系。未認証は 401、認証済みは 200 ---
  check('unauth: GET /api/snippets/:id/raw -> 401', (await req(`/api/snippets/${id}/raw`)).status, 401);
  check('unauth: GET /api/snippets/:id/download -> 401', (await req(`/api/snippets/${id}/download`)).status, 401);
  check('unauth: GET /api/snippets/:id/preview -> 401', (await req(`/api/snippets/${id}/preview`)).status, 401);

  {
    const r = await req(`/api/snippets/${id}/raw`, { headers: authH });
    const ct = r.headers.get('content-type') || '';
    const body = await r.text();
    record(
      'raw: 200 かつ text/plain で返す (HTMLとして実行させない)',
      r.status === 200 && ct.startsWith('text/plain') && body.includes('<h1>hello</h1>'),
      '200 text/plain で原文',
      `status=${r.status} content-type=${ct}`
    );
    checkSecHeaders('GET /api/snippets/:id/raw', r);
  }
  {
    const r = await req(`/api/snippets/${id}/download`, { headers: authH });
    const cd = r.headers.get('content-disposition') || '';
    record(
      'download: 200 かつ attachment で返す',
      r.status === 200 && /^attachment;/.test(cd) && cd.includes('UniqueTitleZQX123'),
      'attachment; filename=... にタイトル由来の名前',
      `status=${r.status} content-disposition=${cd}`
    );
    checkSecHeaders('GET /api/snippets/:id/download', r);
  }
  {
    const r = await req(`/api/snippets/${id}/preview`, { headers: authH });
    check('preview: 認証済み -> 200', r.status, 200);
    checkSecHeaders('GET /api/snippets/:id/preview', r);
    checkSandboxCsp('GET /api/snippets/:id/preview', r);
    await r.text();
  }

  // --- ID検証とパストラバーサル ---
  check('id: 不正な形式の :id/raw -> 404', (await req('/api/snippets/zzz/raw', { headers: authH })).status, 404);
  {
    // %2e%2e%2f = ../ 。snippetPath の hex 検証で弾かれ、data/ の外に出ない。
    const r = await req('/api/snippets/%2e%2e%2f%2e%2e%2fpackage.json/raw', { headers: authH });
    record(
      'id: パストラバーサル形の :id/raw が通らない',
      r.status === 404 || r.status === 400,
      '404 か 400',
      `status=${r.status}`
    );
  }
  {
    // 実在するスニペットへ「../snippets/<実ID>」という遠回りのIDで到達できないこと。
    // 上の %2e%2e%2f 版だけでは足りない: snippetPath は id に .html を足すので、
    // hex 検証を外しても存在しないファイル名になり 404 のままになる。つまり
    // 「16進32文字チェックが消えた」ことを検出できない。実在ファイルに解決される形なら、
    // チェックが外れた瞬間に 200 になってこのケースが落ちる。
    const enc = encodeURIComponent(`../snippets/${id}`);
    const r = await req(`/api/snippets/${enc}/raw`, { headers: authH });
    check('id: ../ を含むIDで実在スニペットに到達できない', r.status, 404);
  }
  check(
    'id: 形式は正しいが存在しないID -> 404',
    (await req(`/api/snippets/${'a'.repeat(32)}/raw`, { headers: authH })).status,
    404
  );

  // --- 更新: CSRF 無しは 403、有りは 200 ---
  {
    // メタデータ (title/tags/pinned) と本文 (html) を同時に書き換えにいく。
    // CSRF が「403 を返すがハンドラも動く」形に退行すると、この一撃で両方が汚れる。
    const r = await req(`/api/snippets/${id}`, {
      method: 'PUT',
      headers: { ...authH, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'ShouldNotStick',
        tags: 'shouldnotstick',
        pinned: true,
        html: '<!doctype html><title>ShouldNotStick</title><p>SHOULDNOTSTICKBODY</p>',
      }),
    });
    check('csrf: PUT /api/snippets/:id トークン無し -> 403', r.status, 403);
  }
  // 403 で弾かれた更新が本当に書かれていないことの裏取り。
  // ※ 必ず「成功する PUT の前」に置く。後ろに置くと成功 PUT が同じフィールドを
  //   上書きするので、書き込まれていても検出できない (常に真になるアサートになる)。
  {
    const r = await req('/api/snippets', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const found = (b.snippets || []).find((s) => s.id === id) || {};
    record(
      'csrf: 403 になった更新がメタデータに残っていない',
      found.title === 'UniqueTitleZQX123' && found.tags === 'qa,smoke' && found.pinned === false,
      '作成時のまま title=UniqueTitleZQX123 tags=qa,smoke pinned=false',
      `title=${found.title} tags=${found.tags} pinned=${found.pinned}`
    );
  }
  {
    const r = await req(`/api/snippets/${id}/raw`, { headers: authH });
    const text = await r.text();
    record(
      'csrf: 403 になった更新が本文に残っていない',
      r.status === 200 && text.includes('<h1>hello</h1>') && !text.includes('SHOULDNOTSTICKBODY'),
      '200 で作成時の本文のまま (SHOULDNOTSTICKBODY を含まない)',
      `status=${r.status} 元の本文=${text.includes('<h1>hello</h1>')} 混入=${text.includes('SHOULDNOTSTICKBODY')}`
    );
  }
  {
    const r = await req(`/api/snippets/${id}`, {
      method: 'PUT',
      headers: jsonCsrf,
      body: JSON.stringify({ title: 'UpdatedTitle', tags: 'qa', pinned: true }),
    });
    const b = await r.json().catch(() => ({}));
    record(
      'update: 認証+CSRF -> 200 でタイトルとピンが反映',
      r.status === 200 && b.snippet && b.snippet.title === 'UpdatedTitle' && b.snippet.pinned === true,
      '200 title=UpdatedTitle pinned=true',
      `status=${r.status} title=${b.snippet && b.snippet.title} pinned=${b.snippet && b.snippet.pinned}`
    );
  }
  {
    // 成功した更新がディスク (index.json) に載っていること。
    // レスポンスの snippet はハンドラ内のオブジェクトなので、保存が落ちても 200 は返る。
    const r = await req('/api/snippets', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const found = (b.snippets || []).find((s) => s.id === id) || {};
    record(
      'update: 更新結果が一覧にも反映されている',
      found.title === 'UpdatedTitle' && found.pinned === true,
      'title=UpdatedTitle pinned=true',
      `title=${found.title} pinned=${found.pinned}`
    );
  }

  // --- 並べ替え (/api/snippets/order が :id より先に登録されていること) ---
  {
    const r = await req('/api/snippets/order', {
      method: 'PUT',
      headers: jsonCsrf,
      body: JSON.stringify({ ids: ['x'] }),
    });
    // :id ルートに落ちていれば 404 になる。400 なら order ルートが先に効いている。
    check('order: 不正なids -> 400 (:id ルートに落ちていない)', r.status, 400);
  }
  {
    const r = await req('/api/snippets/order', {
      method: 'PUT',
      headers: { ...authH, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    check('csrf: PUT /api/snippets/order トークン無し -> 403', r.status, 403);
  }

  // --- Bearer トークン (MCP等のヘッドレス用) ---
  {
    const r = await req('/api/snippets', { headers: { Authorization: `Bearer ${API_TOKEN}` } });
    check('token: 正しい Bearer で一覧 -> 200', r.status, 200);
  }
  {
    const r = await req('/api/snippets', { headers: { Authorization: 'Bearer wrong-token' } });
    check('token: 誤った Bearer -> 401', r.status, 401);
  }
  {
    // 正しいトークンで始まるだけの長いトークン。bearerOk の長さ比較を落として
    // 前方一致で通す実装に変わると、ここが 200 になって落ちる。
    const r = await req('/api/snippets', { headers: { Authorization: `Bearer ${API_TOKEN}extra` } });
    check('token: 正しいトークンで始まるだけの長い Bearer -> 401', r.status, 401);
  }
  {
    // 末尾を1文字削ったトークン。前方一致の向きが逆の実装を弾く。
    const r = await req('/api/snippets', { headers: { Authorization: `Bearer ${API_TOKEN.slice(0, -1)}` } });
    check('token: 末尾を削った Bearer -> 401', r.status, 401);
  }
  {
    // Bearer はブラウザが自動付与しないので CSRF の対象外 (server.js の requireWriteAuth)
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ViaToken', html: '<p>token upload</p>' }),
    });
    check('token: 正しい Bearer で作成 -> 200 (CSRF不要)', r.status, 200);
    const b = await r.json().catch(() => ({}));
    if (b.snippet && b.snippet.id) {
      await req(`/api/snippets/${b.snippet.id}`, { method: 'DELETE', headers: authCsrf });
    }
  }

  // --- 本文サイズ上限 (スニペット経路は大きい上限、ただし無制限ではない) ---
  {
    // 64KB を超えても、スニペットを運ぶ経路なら通ること
    // (認証経路と同じ小さい上限を全体に当ててしまう実装を弾く)。
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: jsonCsrf,
      body: JSON.stringify({ title: 'BigButAllowed', html: '<p>' + 'b'.repeat(256 * 1024) + '</p>' }),
    });
    const b = await r.json().catch(() => ({}));
    check('body-limit: 256KB のスニペット作成は通る', r.status, 200);
    if (b.snippet && b.snippet.id) {
      await req(`/api/snippets/${b.snippet.id}`, { method: 'DELETE', headers: authCsrf });
    }
  }
  {
    // 保存上限 (10MB) を超える HTML は 413。'x' はエスケープされないので JSON の
    // 外枠は通り、ハンドラの byteLength 検査で弾かれる経路。
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: jsonCsrf,
      body: JSON.stringify({ title: 'TooBigToStore', html: 'x'.repeat(11 * 1024 * 1024) }),
    });
    await r.text();
    check('body-limit: 11MB のスニペット作成 -> 413', r.status, 413);
  }
  {
    // 外枠 (MAX_UPLOAD_BYTES*2 + 余裕分) すら超える本文は、Content-Length を見て
    // パースの前に弾く。ハンドラまで届かない。
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: jsonCsrf,
      body: JSON.stringify({ title: 'WayTooBig', html: 'x'.repeat(21 * 1024 * 1024) }),
    });
    await r.text();
    check('body-limit: 21MB のスニペット作成 -> 413 (パース前)', r.status, 413);
  }
  {
    // 回帰: JSON は本文をエスケープするので、リクエスト全体は HTML より大きくなる。
    // 引用符だけの HTML はちょうど2倍 (6MiB -> 12MiB超) に膨らむが、保存されるのは
    // 6MiB で上限内。外枠を MAX_UPLOAD_BYTES + 少し にしていると、この正当な
    // アップロードを 413 にしてしまう (PR #55 の指摘)。
    const quoted = '"'.repeat(6 * 1024 * 1024);
    const body = JSON.stringify({ title: 'QuoteHeavy', html: quoted });
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: jsonCsrf,
      body,
    });
    const b = await r.json().catch(() => ({}));
    record(
      'body-limit: JSON エスケープで2倍に膨らむ 6MiB の HTML は通る',
      r.status === 200 && Buffer.byteLength(body) > 10 * 1024 * 1024 + 256 * 1024,
      `200 かつ リクエスト本文 > 10MiB+256KiB (実際 ${Buffer.byteLength(body)} バイト)`,
      `status=${r.status} bodyBytes=${Buffer.byteLength(body)}`
    );
    if (b.snippet && b.snippet.id) {
      await req(`/api/snippets/${b.snippet.id}`, { method: 'DELETE', headers: authCsrf });
    }
  }
  {
    // 413 で弾かれた作成が保存されていないことの裏取り。
    const r = await req('/api/snippets', { headers: authH });
    const b = await r.json().catch(() => ({}));
    const titles = (b.snippets || []).map((s) => s.title);
    record(
      'body-limit: 413 になった作成が一覧に残っていない',
      !titles.includes('TooBigToStore') &&
        !titles.includes('WayTooBig') &&
        !titles.includes('BigButAllowed') &&
        !titles.includes('QuoteHeavy'),
      '413 になった2件も、作成後に削除した2件も含まない',
      titles.join(',') || '(空)'
    );
  }

  // --- 静的UI ---
  {
    const r = await req('/');
    const html = await r.text();
    record(
      'static: GET / -> 200 でビルド済み index.html',
      r.status === 200 && html.includes('<iframe'),
      '200 で iframe を含むHTML',
      `status=${r.status} length=${html.length}`
    );
    checkSecHeaders('GET /', r);
    checkAppCsp('GET /', r);
    record(
      'sandbox属性: index.html の iframe に allow-same-origin が無い',
      html.includes('sandbox="allow-scripts') && !html.includes('allow-same-origin'),
      'sandbox="allow-scripts... で allow-same-origin を含まない',
      `hasSandbox=${html.includes('sandbox="allow-scripts')} hasAllowSameOrigin=${html.includes('allow-same-origin')}`
    );
  }

  // --- MCP (秘匿パス設定済み) ---
  {
    const r = await req(`/mcp/${MCP_SECRET}`, { method: 'GET' });
    check('mcp: GET /mcp/<secret> -> 405', r.status, 405);
    check('mcp: 405 に Allow: POST', r.headers.get('allow'), 'POST');
  }
  {
    const r = await req(`/mcp/${MCP_SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), // id 無し
    });
    check('mcp: 通知のみのPOST -> 202', r.status, 202);
  }
  {
    const r = await req(`/mcp/${MCP_SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const b = await r.json().catch(() => ({}));
    const tools = (b.result && b.result.tools) || [];
    record(
      'mcp: tools/list が2ツールを返す',
      r.status === 200 && tools.length === 2 && tools.some((t) => t.name === 'upload_html'),
      '200 で upload_html を含む2件',
      `status=${r.status} tools=${tools.map((t) => t.name).join(',')}`
    );
  }
  {
    // 秘匿パスが違えば存在自体を伏せて 404 (401 ではない)
    const r = await req('/mcp/wrong-secret-value', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check('mcp: 誤った秘匿パス -> 404', r.status, 404);
  }
  {
    const r = await req(`/mcp/${MCP_SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'upload_html', arguments: { html: '<title>McpDoc</title><p>via mcp</p>' } },
      }),
    });
    const b = await r.json().catch(() => ({}));
    const text = (b.result && b.result.content && b.result.content[0] && b.result.content[0].text) || '';
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      /* パースできなければ下の判定で落ちる */
    }
    record(
      'mcp: upload_html でスニペットが作られる',
      r.status === 200 && parsed.ok === true && /^[a-f0-9]{32}$/.test(parsed.id || '') && parsed.title === 'McpDoc',
      'ok:true / 32桁hexのid / <title>由来のタイトル',
      `status=${r.status} ok=${parsed.ok} id=${parsed.id} title=${parsed.title}`
    );
    if (parsed.id) {
      await req(`/api/snippets/${parsed.id}`, { method: 'DELETE', headers: authCsrf });
    }
  }

  // --- 削除 ---
  {
    const r = await req(`/api/snippets/${id}`, { method: 'DELETE', headers: authH });
    check('csrf: DELETE /api/snippets/:id トークン無し -> 403', r.status, 403);
  }
  check('unauth: DELETE /api/snippets/:id -> 401', (await req(`/api/snippets/${id}`, { method: 'DELETE' })).status, 401);
  {
    const r = await req(`/api/snippets/${id}`, { method: 'DELETE', headers: authCsrf });
    check('delete: 認証+CSRF -> 200', r.status, 200);
  }
  {
    const r = await req(`/api/snippets/${id}/raw`, { headers: authH });
    check('delete: 削除後の取得 -> 404', r.status, 404);
  }

  // --- ログアウト (セッションを壊すのでフェーズ最後に置く) ---
  {
    const r = await req('/api/logout', { method: 'POST', headers: authH });
    check('csrf: POST /api/logout トークン無し -> 403', r.status, 403);
  }
  {
    const r = await req('/api/logout', { method: 'POST', headers: authCsrf });
    check('logout: 認証+CSRF -> 200', r.status, 200);
  }
  {
    // サーバー側でセッションが破棄されているので、同じCookieはもう通らない。
    const r = await req('/api/snippets', { headers: authH });
    check('logout: 破棄後の同一Cookie -> 401', r.status, 401);
  }
}

// ===========================================================================
//  PHASE 2: minimal (MCP_SECRET_PATH / API_TOKEN 未設定 + レート制限)
// ===========================================================================
async function phaseMinimal() {
  console.log('\n=== PHASE: minimal ===');

  // --- MCP 未設定なら常に 404 (存在を秘匿する) ---
  {
    const r = await req('/mcp/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check('mcp-unset: POST /mcp/x -> 404', r.status, 404);
  }
  check('mcp-unset: GET /mcp/x -> 404', (await req('/mcp/x', { method: 'GET' })).status, 404);

  // --- API_TOKEN 未設定なら Bearer は一切通らない ---
  {
    const r = await req('/api/snippets', { headers: { Authorization: `Bearer ${API_TOKEN}` } });
    check('token-unset: Bearer 付きでも -> 401', r.status, 401);
  }
  {
    const r = await req('/api/snippets', { headers: { Authorization: 'Bearer ' } });
    check('token-unset: 空 Bearer -> 401', r.status, 401);
  }

  // --- ログインのレート制限 (windowMs 15分 / max 10)。
  //     ここでこのフェーズのログイン回数を使い切るので必ず最後に置く。 ---
  {
    const statuses = [];
    for (let i = 0; i < LOGIN_LIMIT + 2; i++) {
      const r = await login('brute-force-attempt');
      statuses.push(r.status);
      await r.text();
    }
    const withinLimit = statuses.slice(0, LOGIN_LIMIT).every((s) => s === 401);
    const blocked = statuses.slice(LOGIN_LIMIT).every((s) => s === 429);
    record(
      `rate-limit: ログイン失敗 ${LOGIN_LIMIT} 回までは401、それ以降は429`,
      withinLimit && blocked,
      `先頭${LOGIN_LIMIT}件が401 / 以降が429`,
      statuses.join(',')
    );
    // 制限中は正しいパスワードでも通さない (ブロックがハンドラより前で効いている)
    const r = await login(PASSWORD);
    check('rate-limit: 制限中は正しいパスワードでも429', r.status, 429);
  }
}

// ===========================================================================
//  PHASE 3: revoke (ログアウト / パスワード変更でのセッション失効)
//  auth.json を差し替える = 以降このパスワードでしかログインできなくなるので、
//  必ず最後のフェーズに置く。
// ===========================================================================
async function phaseRevoke() {
  console.log('\n=== PHASE: revoke ===');

  // --- 独立したセッションを2つ作る (A: ログアウトする側 / B: 残す側) ---
  const resA = await login(PASSWORD);
  const bodyA = await resA.json().catch(() => ({}));
  const sessA = extractSess(resA);
  const resB = await login(PASSWORD);
  const bodyB = await resB.json().catch(() => ({}));
  const sessB = extractSess(resB);
  if (!sessA || !sessB) throw new Error('revoke フェーズのログインに失敗したので続行できない');
  const headA = { Cookie: `hv.sid=${sessA.value}` };
  const headB = { Cookie: `hv.sid=${sessB.value}` };
  const csrfHeadA = { ...headA, 'x-csrf-token': bodyA.csrf };
  const csrfHeadB = { ...headB, 'x-csrf-token': bodyB.csrf };
  const sidA = sidOf(sessA.value);
  const sidB = sidOf(sessB.value);

  check('revoke: セッションA は有効 -> 200', (await req('/api/snippets', { headers: headA })).status, 200);
  check('revoke: セッションB は有効 -> 200', (await req('/api/snippets', { headers: headB })).status, 200);
  record(
    'revoke: 2セッションがサーバー側に実体を持つ',
    sidA !== '' && sidB !== '' && sidA !== sidB && sessionStoreHas(sidA) && sessionStoreHas(sidB),
    'sessions.json に両方の sid がある',
    `sidA=${sidA ? 'あり' : 'なし'}(store=${sessionStoreHas(sidA)}) sidB=${sidB ? 'あり' : 'なし'}(store=${sessionStoreHas(sidB)})`
  );

  // --- ログアウト: サーバー側の実体まで消えること ---
  check('revoke: logout A -> 200', (await req('/api/logout', { method: 'POST', headers: csrfHeadA })).status, 200);
  check('revoke: logout 後の A で読み取り -> 401', (await req('/api/snippets', { headers: headA })).status, 401);
  {
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...csrfHeadA, 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>after-logout</p>', title: 'nope' }),
    });
    check('revoke: logout 後の A で書き込み -> 401', r.status, 401);
  }
  {
    const r = await req('/api/me', { headers: headA });
    const b = await r.json().catch(() => ({}));
    check('revoke: logout 後の A で /api/me -> authed:false', b.authed, false);
  }
  record(
    'revoke: logout でサーバー側のセッション実体が消える',
    !sessionStoreHas(sidA),
    'sessions.json に sidA が無い',
    `store=${sessionStoreHas(sidA)}`
  );
  // 片方のログアウトが他方を巻き込まないこと (巻き込むと「全部落ちるから通った」だけになる)
  check('revoke: A の logout は B に影響しない -> 200', (await req('/api/snippets', { headers: headB })).status, 200);

  // --- パスワード変更: 既存セッションが全て無効になること ---
  // npm run setpass と同じことをする (auth.json の hash を差し替える)。
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ hash: bcrypt.hashSync(NEW_PASSWORD, 10) }, null, 2));

  check('revoke: パスワード変更後の B で読み取り -> 401', (await req('/api/snippets', { headers: headB })).status, 401);
  {
    const r = await req('/api/snippets', {
      method: 'POST',
      headers: { ...csrfHeadB, 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>after-rotate</p>', title: 'nope' }),
    });
    check('revoke: パスワード変更後の B で書き込み -> 401', r.status, 401);
  }
  {
    const r = await req(`/api/snippets/order`, {
      method: 'PUT',
      headers: { ...csrfHeadB, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    check('revoke: パスワード変更後の B で並べ替え -> 401', r.status, 401);
  }
  {
    const r = await req('/api/me', { headers: headB });
    const b = await r.json().catch(() => ({}));
    record(
      'revoke: パスワード変更後の B で /api/me -> authed:false csrf:null',
      r.status === 200 && b.authed === false && b.csrf === null,
      '200 authed=false csrf=null',
      `status=${r.status} authed=${b.authed} csrf=${b.csrf}`
    );
  }
  record(
    'revoke: パスワード変更でサーバー側のセッション実体も破棄される',
    !sessionStoreHas(sidB),
    'sessions.json に sidB が無い',
    `store=${sessionStoreHas(sidB)}`
  );

  // --- 新しいパスワードだけが通り、そのセッションは正常に使えること ---
  check('revoke: 旧パスワードでのログイン -> 401', (await login(PASSWORD)).status, 401);
  const resC = await login(NEW_PASSWORD);
  const bodyC = await resC.json().catch(() => ({}));
  const sessC = extractSess(resC);
  record(
    'revoke: 新パスワードでログインできる',
    resC.status === 200 && !!sessC && typeof bodyC.csrf === 'string',
    '200 で hv.sid Cookie と csrf が返る',
    `status=${resC.status} cookie=${!!sessC}`
  );
  if (sessC) {
    const headC = { Cookie: `hv.sid=${sessC.value}` };
    check('revoke: 新セッションで読み取り -> 200', (await req('/api/snippets', { headers: headC })).status, 200);
  }
}

// ===========================================================================
//  MAIN
// ===========================================================================
async function main() {
  // 静的配信のテストに必要。public/index.html は gitignore 済みの生成物。
  const build = spawnSync(process.execPath, ['scripts/build-i18n.mjs'], {
    cwd: ROOT,
    env: { ...process.env, APP_LANG: 'en' },
    stdio: 'inherit',
  });
  if (build.status !== 0) throw new Error('scripts/build-i18n.mjs が失敗した');

  try {
    await startServer({ MCP_SECRET_PATH: MCP_SECRET, API_TOKEN });
    await phaseNormal();

    await restart({}); // MCP秘匿パスとAPIトークンを外し、レート制限のカウンタもリセットする
    await phaseMinimal();

    await restart({}); // phaseMinimal でログイン回数を使い切っているのでプロセスごと入れ替える
    await phaseRevoke();
  } finally {
    killServer();
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
  // 機械可読の要約行 (worker 版と同じ形式)
  console.log(
    '\nRESULT_JSON ' +
      JSON.stringify({
        total: results.length,
        passed,
        failed,
        failures: results
          .filter((x) => !x.pass)
          .map((x) => ({ name: x.name, expected: x.expected, actual: x.actual })),
      })
  );
  process.exit(failed > 0 ? 1 : 0);
}

// 一時ディレクトリの後始末。Windows はハンドルが残ることがあるのでリトライさせる。
function cleanupDataDir() {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 消せなくてもテスト結果には影響しない */
  }
}

// Ctrl+C / 終了シグナルでもサーバーと一時ディレクトリを残さない。
let cleanedUp = false;
function cleanupOnSignal(signal) {
  if (cleanedUp) return;
  cleanedUp = true;
  killServer();
  cleanupDataDir();
  console.log(`\n${signal} で中断。サーバーを停止し ${DATA_DIR} を削除した。`);
  process.exit(130);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => cleanupOnSignal(sig));
}
process.on('exit', () => {
  killServer();
  cleanupDataDir();
});

main().catch((e) => {
  console.error('HARNESS ERROR:', (e && e.stack) || e);
  killServer();
  cleanupDataDir();
  process.exit(2);
});
