/**
 * HTML に埋め込まれたインライン JavaScript の構文チェッカー。
 *   使い方:  node scripts/check-inline-js.mjs
 *
 * なぜ要るか:
 *   ci.yml の `node --check` は .js / .mjs しか見ていない。だがこのリポジトリの UI は
 *   public/index.template.html と worker/public/index.html の <script> に丸ごと埋まっており、
 *   そこは構文チェックすら受けていない。Boot smoke は `GET /` が 200 を返すかしか見ないので、
 *   インライン JS が構文エラーで画面が真っ白でも CI は緑になる。その穴を塞ぐためのチェッカー。
 *
 * 設計方針:
 *   - 依存ゼロ（Node 組込みのみ）。外部パーサは入れない。
 *   - 対象ファイルは走査で拾う。HTML が増えても自動でチェック対象に入る。
 *     ただし走査だけでは「今ある UI が対象から外れていないこと」は保証できないので、
 *     絶対に外れてはいけないファイルは REQUIRED_FILES で別建てに保証する。
 *   - 抽出したコードの手前に「<script> 開始行 - 1」個の改行を詰めてから解析する。
 *     こうするとパーサが報告する行番号がそのまま元 HTML の行番号になる。
 *     オフセットを後から足し引きする方式はズレたときに調査不能になるので採らない。
 *   - 検査対象 0 件は成功にしない。全体でも、REQUIRED_FILES の各ファイル単位でも成功にしない。
 *     静かに何もしないのが最悪の失敗モードで、「チェックしているつもりで実は
 *     何も見ていない CI」を生むため。
 *   - 判定に迷うブロックは「検査する」側に倒す。誤検知は構文エラーとして騒がしく落ちるので
 *     すぐ直せるが、取りこぼしは誰にも気づかれないまま残るため。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 走査から外すディレクトリ。node_modules は論外として、.wrangler は wrangler の生成物、
// data は実行時のスニペット保存先（＝利用者がアップロードした他人の HTML）で、
// どちらもこのリポジトリが責任を持つソースではない。
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'data', 'dist', 'coverage', '.next']);

// public/index.html は locales/ + index.template.html から生成される成果物（.gitignore 済み）。
// 原本を検査すれば足りる。入れても同じエラーを二重報告するだけなので外す。
const SKIP_FILES = new Set(['public/index.html']);

// 走査に加えて「このファイルは必ず 1 ブロック以上検査したこと」を個別に要求するリスト。
//
// なぜ固定リストを持つのか:
//   走査は「HTML が増えたら勝手に対象に入る」ためのもので、「今ある UI が対象から
//   外れていないこと」は保証しない。抽出条件が 1 つ変わっただけであるファイルの
//   <script> が丸ごと skip 側に落ちても、走査は静かに 0 ブロックを返すだけで、
//   他のファイルに 1 ブロックでも残っていれば全体集計は 0 にならず CI は緑のまま通る。
//   実際 type 属性の判定を変えるだけでこれが起きた（片方の UI 全体が無検査に戻る）。
//   この 2 ファイルは 2 エディションのフロント本体そのもので、ここが無検査になるのは
//   このスクリプトが存在する意味を失う状態なので、全体集計とは別に個別に要求する。
//
// ファイルが存在しなくなった場合も失敗させる:
//   リポジトリ構成が変わって移動・削除されたなら、それはこのリストを更新すべき変更である。
//   「無ければ黙って飛ばす」にすると、リネーム 1 回で保証が静かに消えるため。
const REQUIRED_FILES = ['public/index.template.html', 'worker/public/index.html'];

// HTML 仕様の「JavaScript MIME type」相当。type 省略もクラシックスクリプト扱い。
// ここに無い type（application/json, text/template など）はそもそも実行されないので検査しない。
const CLASSIC_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
]);

// index.template.html の <script> には build-i18n.mjs が置換する前の {{key}} が生で残っている
// （`const T = {{__T_JSON__}};`）。これは JS としては構文エラーなので、検査前に潰す。
// パターンは scripts/build-i18n.mjs:35 の残存チェックと同じ形に合わせてある。
const PLACEHOLDER_RE = /\{\{[a-zA-Z0-9_]+\}\}/g;

const toPosix = (p) => p.split(sep).join('/');

/** HTML ファイルを再帰的に集める。シンボリックリンクは辿らない（isFile/isDirectory が false）。 */
function collectHtmlFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectHtmlFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** 開始タグの属性文字列から属性値を取り出す。値なし属性は空文字を返す。 */
function readAttr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*(?:=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+)))?`, 'i').exec(attrs);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

/**
 * HTML コメント `<!-- ... -->` を空白で潰す。文字数と改行位置はそのまま保つ。
 *
 * なぜ要るか:
 *   動かないコードを一旦コメントアウトして PR を出す、という普通の作業で
 *   `<!-- <script>壊れたコード</script> -->` が生まれる。ブラウザは実行しないのに
 *   このチェッカーだけが構文エラーで CI を止めていた。
 *
 * なぜ単純な正規表現の一括置換にしないか:
 *   <script> の中は HTML のコメント状態にならない（script data state）。
 *   JS の中に `<!--` と `-->` が現れただけで一括置換するとコード本体を消してしまい、
 *   「静かに検査されない」に化ける。なのでコメントと <script> を先頭から順に見て、
 *   <script> の中身には手を触れない。
 *
 * 文字数を保つ理由:
 *   後段が行番号も列番号も元 HTML 上のオフセットから計算しているため。
 *   改行数だけ保っても列がズレる。長さごと保てば何もズレない。
 */
function maskHtmlComments(html) {
  const TOKEN_RE = /<!--|<script\b/gi;
  const CLOSE_RE = /<\/script\s*>/gi;
  let out = '';
  let i = 0;
  let m;
  while ((m = TOKEN_RE.exec(html)) !== null) {
    if (m[0] === '<!--') {
      // 終端が無いコメントはファイル末尾まで続く（ブラウザも同じ扱い）。
      const close = html.indexOf('-->', m.index + 4);
      const end = close === -1 ? html.length : close + 3;
      out += html.slice(i, m.index) + html.slice(m.index, end).replace(/[^\n]/g, ' ');
      i = end;
    } else {
      // <script> 開始から閉じタグまでは素通し。閉じタグが無ければ末尾まで素通し。
      CLOSE_RE.lastIndex = m.index + m[0].length;
      const c = CLOSE_RE.exec(html);
      const end = c ? c.index + c[0].length : html.length;
      out += html.slice(i, end);
      i = end;
    }
    TOKEN_RE.lastIndex = i;
  }
  return out + html.slice(i);
}

/**
 * <script> ブロックを抽出する。
 * 属性部を [^>]* にしているので属性値に `>` が入ると崩れるが、それはブラウザのタグ解釈と
 * ほぼ同じ挙動で、文字列中の `</script>` でブロックが切れるのも同様にブラウザ準拠。
 */
function extractScripts(html) {
  const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  const blocks = [];
  let m;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const attrs = m[1];
    const code = m[2];
    const openTagEnd = m.index + m[0].indexOf('>') + 1;
    // 開始タグ直後の位置が何行目か（1 始まり）。この行が抽出コードの 1 行目になる。
    const startLine = countNewlines(html, 0, openTagEnd) + 1;
    // 大文字小文字は無視（HTML 仕様も type の照合は ASCII 大小無視）。
    const rawType = (readAttr(attrs, 'type') ?? '').trim().toLowerCase();
    // MIME のパラメータ部を落とした本体（essence）で照合する。
    // `type="text/javascript;charset=utf-8"` はブラウザが JS と判定して実行するので、
    // 完全一致で比較していると「ブラウザは実行するがチェッカーは見ない」ブロックができる。
    // これは唯一の静かな取りこぼし経路なので、パラメータは必ず切り落とす。
    // module はパラメータを許さない（`module;x` はどちらでもない）ので rawType で見る。
    const essence = rawType.includes(';') ? rawType.slice(0, rawType.indexOf(';')).trim() : rawType;
    const isModule = rawType === 'module';

    let skipReason = null;
    if (readAttr(attrs, 'src') !== null) skipReason = 'src 属性つき（中身は外部ファイル）';
    else if (!isModule && !CLASSIC_TYPES.has(essence)) skipReason = `type="${rawType}"（JS ではない）`;
    else if (code.trim() === '') skipReason = '空ブロック';

    blocks.push({
      code,
      startLine,
      endLine: startLine + countNewlines(code, 0, code.length),
      isModule,
      skipReason,
    });
  }
  return blocks;
}

function countNewlines(s, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** {{key}} を同じ文字数の有効な式に置換する。文字数を保つのは列番号をズラさないため。 */
function neutralizePlaceholders(code) {
  return code.replace(PLACEHOLDER_RE, (m) => 'null'.padEnd(m.length, ' '));
}

/**
 * パーサが吐いた「先頭3行 + SyntaxError 行」から位置とメッセージを取り出す。
 *   <filename>:<line>
 *   <該当行のソース>
 *   <キャレット行>
 * filename には Windows の絶対パス（C:\...）が来ることがあるので、行末の `:数字` だけを見る。
 */
function parseErrorReport(text) {
  const lines = String(text ?? '').split('\n');
  const head = /:(\d+)$/.exec((lines[0] ?? '').trimEnd());
  const caret = lines[2] ?? '';
  const message = lines.find((l) => /^[A-Za-z]*Error(:|$)/.test(l.trim()))?.trim() ?? '構文エラー';
  return {
    line: head ? Number(head[1]) : null,
    column: caret.includes('^') ? caret.indexOf('^') + 1 : null,
    message,
  };
}

/**
 * 構文検証。クラシックスクリプトは vm.Script でそのまま解析できる。
 * type="module" は import/export が入るので vm.Script だと誤検知する。
 * vm.SourceTextModule は --experimental-vm-modules が必要なので、
 * 一時ファイルを .mjs で書いて `node --check` に投げる（どちらも改行詰めで行番号は保たれる）。
 */
function checkSyntax(code, displayName, isModule) {
  if (!isModule) {
    try {
      new vm.Script(code, { filename: displayName });
      return null;
    } catch (err) {
      return parseErrorReport(err.stack);
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'check-inline-js-'));
  try {
    const file = join(dir, 'block.mjs');
    writeFileSync(file, code);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status === 0) return null;
    return parseErrorReport(r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 実行 ----------------------------------------------------------------

const htmlFiles = collectHtmlFiles(ROOT)
  .map((abs) => ({ abs, rel: toPosix(relative(ROOT, abs)) }))
  .filter(({ rel }) => !SKIP_FILES.has(rel))
  .sort((a, b) => a.rel.localeCompare(b.rel));

const seenFiles = new Set(htmlFiles.map(({ rel }) => rel));

const failures = [];
// REQUIRED_FILES の判定に使う。ファイル単位の検査ブロック数と、skip した理由。
const checkedBlocksByFile = new Map();
const skipReasonsByFile = new Map();
let checkedFiles = 0;
let checkedBlocks = 0;
let checkedLines = 0;
let skippedBlocks = 0;

for (const { abs, rel } of htmlFiles) {
  const html = maskHtmlComments(readFileSync(abs, 'utf8'));
  const blocks = extractScripts(html);
  const targets = blocks.filter((b) => b.skipReason === null);

  const reasons = [];
  for (const b of blocks) {
    if (b.skipReason !== null) {
      skippedBlocks++;
      reasons.push(`${rel}:${b.startLine} — ${b.skipReason}`);
      console.log(`[check-inline-js] skip  ${rel}:${b.startLine} — ${b.skipReason}`);
    }
  }
  skipReasonsByFile.set(rel, reasons);
  checkedBlocksByFile.set(rel, targets.length);
  if (targets.length === 0) continue;

  checkedFiles++;
  const ranges = [];
  for (const b of targets) {
    // 元 HTML の行番号に一致させるため、開始行の手前を改行で埋めてから解析する。
    const padded = '\n'.repeat(b.startLine - 1) + neutralizePlaceholders(b.code);
    const lines = b.endLine - b.startLine + 1;
    checkedBlocks++;
    checkedLines += lines;
    ranges.push(`L${b.startLine}-L${b.endLine}`);

    const err = checkSyntax(padded, rel, b.isModule);
    if (err) failures.push({ rel, block: b, err });
  }
  console.log(`[check-inline-js] check ${rel} — ${targets.length} ブロック (${ranges.join(', ')})`);
}

// 全体集計はファイル単位の取りこぼしを隠す（他ファイルに 1 ブロックあれば 0 にならない）ので、
// 「必ず検査されるべきファイル」は個別に確認する。
const missingRequired = REQUIRED_FILES.filter((rel) => (checkedBlocksByFile.get(rel) ?? 0) === 0);

// 構文エラーと検査漏れは原因が別なので、片方で打ち切らず両方出してから落とす。
// 打ち切ると「直して再実行したらもう片方が出る」を繰り返すことになるため。
let failed = false;

if (failures.length > 0) {
  failed = true;
  console.error('');
  for (const { rel, block, err } of failures) {
    // 行が取れなければブロック開始行を指す。「どのファイルか」だけでも分かる方がマシ。
    const line = err.line ?? block.startLine;
    const where = err.column ? `${rel}:${line}:${err.column}` : `${rel}:${line}`;
    console.error(`[check-inline-js] FAIL ${where} — ${err.message}`);
    // GitHub Actions のアノテーション（メッセージに改行を含められないので1行に潰す）
    const annotation = err.message.replace(/\r?\n/g, ' ');
    const col = err.column ? `,col=${err.column}` : '';
    console.error(`::error file=${rel},line=${line}${col}::${annotation}`);
  }
  console.error('');
  console.error(`[check-inline-js] ${failures.length} 件の構文エラー。`);
}

if (checkedBlocks === 0) {
  // REQUIRED_FILES を空にした場合の保険。ここを成功で抜けると
  // 「チェックしているつもりで何も見ていない CI」が出来上がる。
  failed = true;
  console.error('');
  console.error('[check-inline-js] 検査対象のインライン JS が 1 件も見つかりませんでした。');
  console.error(`  走査したルート: ${toPosix(ROOT)}`);
  console.error(`  見つかった HTML: ${htmlFiles.length} 件 / 除外した <script>: ${skippedBlocks} 件`);
  console.error('  抽出ロジックか除外条件が壊れている可能性が高いので、失敗として扱う。');
  console.error('::error::インライン JS の検査対象が見つかりません（scripts/check-inline-js.mjs）');
}

// 最後に出す。CI ログの末尾に残るのが「UI が丸ごと無検査になっている」という一番重い事実になる。
if (missingRequired.length > 0) {
  failed = true;
  console.error('');
  console.error('[check-inline-js] 必ず検査されるべきファイルのインライン JS が検査されていません。');
  for (const rel of missingRequired) {
    if (!seenFiles.has(rel)) {
      // 走査で拾えていない＝移動・削除・除外条件の変更。リストを更新すべき変更なので落とす。
      console.error(`  ${rel} — 走査対象に存在しない（移動/削除、または SKIP_DIRS/SKIP_FILES による除外）`);
    } else {
      console.error(`  ${rel} — 検査対象の <script> が 0 件`);
      for (const reason of skipReasonsByFile.get(rel) ?? []) console.error(`      skip: ${reason}`);
    }
    console.error(
      `::error file=${rel}::インライン JS が 1 件も検査されていません（scripts/check-inline-js.mjs の REQUIRED_FILES）`,
    );
  }
  console.error('  意図した変更なら scripts/check-inline-js.mjs の REQUIRED_FILES を更新すること。');
}

if (failed) process.exit(1);

console.log(
  `[check-inline-js] OK — ${checkedFiles} ファイル / ${checkedBlocks} ブロック / ${checkedLines} 行を検査しました。`,
);
