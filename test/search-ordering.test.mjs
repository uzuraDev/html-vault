/**
 * search-ordering.test.mjs — 検索の「古い応答が新しい入力を上書きする」回帰を防ぐ。
 *
 * 検索は2段構えになっている:
 *   入力 → applyLocalFilter() でタイトル/タグを即座に絞り込む (0ms)
 *        → 150ms のデバウンス後 runBodySearch() が本文検索をサーバーへ投げる
 *
 * 本文検索の応答が遅れて届いたとき、それが「今の検索欄の中身」に対する応答でない限り
 * 表示へ反映してはいけない。進行中リクエストの無効化 (発行番号の更新 + abort) を
 * デバウンス後まで遅らせると、その隙間に届いた古い応答がローカル絞り込みの結果を
 * 上書きし、検索欄と一覧が食い違ったまま残る (PR #57 で報告された不具合)。
 *
 * ブラウザを起動せずにこれを検証するため、両エディションの HTML から検索まわりの
 * 関数だけを取り出し、DOM とネットワークを差し替えた小さなサンドボックスで動かす。
 * 依存パッケージは足していない (CONTRIBUTING の方針)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let total = 0;
let passed = 0;
const failures = [];

function record(name, ok, expected, actual) {
  total += 1;
  if (ok) {
    passed += 1;
    console.log(`[PASS] ${name}`);
  } else {
    failures.push({ name, expected, actual });
    console.log(`[FAIL] ${name}\n       expected: ${expected}\n       actual:   ${actual}`);
  }
}

// ---- HTML から関数定義を取り出す -----------------------------------------
// 対象は「トップレベルに素で書かれた function 宣言」だけなので、宣言の頭から
// 波括弧の対応が閉じるところまでを取れば十分 (文字列/コメント内の括弧は考慮する)。
function extractFunction(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`関数 ${name} が見つからない`);
  const start = m.index;
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error(`関数 ${name} の本体が見つからない`);
  let depth = 0;
  let inStr = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i += 1; }
      continue;
    }
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; i += 1; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`関数 ${name} の終端が見つからない`);
}

const FUNCS = ['applyLocalFilter', 'showBodyResults', 'invalidateBodySearch', 'runBodySearch', 'onSearchInput'];

// ---- サンドボックス --------------------------------------------------------
function makeSandbox(html) {
  const body = FUNCS.map((n) => extractFunction(html, n)).join('\n\n');

  // 制御下のタイマー。デバウンスを明示的に進めたいので実時間には頼らない。
  const source = `
    'use strict';
    let SNIPPETS = __fixtures.snippets;
    let SEARCH_RESULTS = null;
    let SEARCH_Q = '';
    let CSRF = '';
    let searchAbort = null;
    let searchSeq = 0;
    let searchTimer = null;
    const searchMemo = new Map();
    function memoPut(q, payload){ searchMemo.set(q, payload); }
    function perfMark(){}
    function perfMeasure(){}
    function setSearchStatus(v){ __state.status = v; }
    function renderList(){ __state.renders += 1; __state.rendered = SEARCH_RESULTS; }
    function $(){ return __dom.search; }
    const T = { searching: 'Searching…', searchTruncated: 'first {n}' };
    const api = __net.api;
    const setTimeout = __timers.setTimeout;
    const clearTimeout = __timers.clearTimeout;

    ${body}

    return {
      onSearchInput,
      runBodySearch,
      get searchSeq(){ return searchSeq; },
      get results(){ return SEARCH_RESULTS; },
      get query(){ return SEARCH_Q; },
    };
  `;

  const state = { renders: 0, rendered: null, status: null };
  const dom = { search: { value: '' } };

  const timers = (() => {
    let pending = null;
    return {
      setTimeout(fn) { pending = fn; return 1; },
      clearTimeout() { pending = null; },
      fire() { const fn = pending; pending = null; if (fn) return fn(); return undefined; },
      get hasPending() { return pending !== null; },
    };
  })();

  const net = (() => {
    const inflight = [];
    return {
      api(_method, url, _body, _quiet, signal) {
        return new Promise((resolve, reject) => {
          const entry = { url, resolve, reject, aborted: false };
          if (signal) {
            signal.addEventListener('abort', () => {
              entry.aborted = true;
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
          inflight.push(entry);
        });
      },
      inflight,
    };
  })();

  const fixtures = {
    snippets: [
      { id: 'a1', title: 'date picker #28', tags: 'ui' },
      { id: 'a2', title: 'tooltip', tags: 'ui' },
      { id: 'a3', title: 'invoice ~ draft', tags: 'billing' },
    ],
  };

  // eslint-disable-next-line no-new-func
  const factory = new Function('__fixtures', '__state', '__dom', '__timers', '__net', source);
  const api = factory(fixtures, state, dom, timers, net);
  return { api, state, dom, timers, net };
}

// ---- 本題: 遅れて届いた本文検索の応答が、新しい入力を上書きしないこと --------
async function checkStaleResponse(label, html) {
  const { api, state, dom, timers, net } = makeSandbox(html);

  // 1. 'zqxbody' を入力 → ローカル絞り込み (一致0件) 後、デバウンスで本文検索が飛ぶ
  dom.search.value = 'zqxbody';
  api.onSearchInput();
  const pendingRun = timers.fire(); // デバウンス満了 → runBodySearch()
  await Promise.resolve();
  record(
    `${label}: 2文字以上の入力で本文検索が飛ぶ`,
    net.inflight.length === 1 && net.inflight[0].url.includes('zqxbody'),
    '/api/search?q=zqxbody へのリクエストが1本',
    net.inflight.map((r) => r.url).join(',') || '(なし)'
  );

  // 2. 応答が届く前に検索欄を '~' へ変更 (1文字なので本文検索は走らない)
  dom.search.value = '~';
  api.onSearchInput();
  const afterLocal = state.rendered;
  record(
    `${label}: 1文字の入力でもローカル絞り込みは即座に反映される`,
    Array.isArray(afterLocal) && afterLocal.length === 1 && afterLocal[0].id === 'a3',
    "'~' を含む1件 (a3)",
    JSON.stringify((afterLocal || []).map((s) => s.id))
  );

  // 3. ここで古い 'zqxbody' の応答が届く
  const stale = net.inflight[0];
  record(
    `${label}: 入力の時点で古いリクエストが abort されている`,
    stale.aborted === true,
    'abort 済み',
    String(stale.aborted)
  );
  stale.resolve({
    results: [
      { id: 'a1', title: 'date picker #28', field: 'body', excerpt: 'zqxbody' },
      { id: 'a2', title: 'tooltip', field: 'body', excerpt: 'zqxbody' },
    ],
    truncated: false,
    scanned: 2,
  });
  await pendingRun;
  await new Promise((r) => setTimeout(r, 0));

  // 4. 表示は '~' のローカル結果のままでなければならない
  const finalIds = (api.results || []).map((s) => s.id);
  record(
    `${label}: 古い応答が届いても表示は現在の入力のまま`,
    finalIds.length === 1 && finalIds[0] === 'a3',
    "['a3'] (検索欄 '~' のローカル絞り込み)",
    JSON.stringify(finalIds)
  );
  record(
    `${label}: 表示中のクエリが検索欄と一致している`,
    api.query === '~',
    "'~'",
    JSON.stringify(api.query)
  );
}

// ---- 実行 ------------------------------------------------------------------
const targets = [
  ['Express版 (public/index.template.html)', path.join(root, 'public/index.template.html')],
  ['Workers版 (worker/public/index.html)', path.join(root, 'worker/public/index.html')],
];

for (const [label, file] of targets) {
  const html = fs.readFileSync(file, 'utf8');
  await checkStaleResponse(label, html);
}

console.log('\n========================================');
console.log(`TOTAL ${total}  PASSED ${passed}  FAILED ${failures.length}`);
console.log('========================================\n');
console.log('RESULT_JSON ' + JSON.stringify({ total, passed, failed: failures.length, failures }));
if (failures.length) process.exit(1);
