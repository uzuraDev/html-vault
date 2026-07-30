/**
 * scripts/check-inline-js.mjs の回帰テスト。
 *   使い方:  node test/check-inline-js.test.mjs
 *
 * このチェッカーで一番怖いのは「構文エラーを見逃す」ことではなく、
 * 「ブロックを検査対象から静かに外して、見ているつもりの CI になる」こと。
 * なのでテストの主眼は exit code そのものより「このブロックは検査されたか」に置く。
 * 検査されたことを示すために、各フィクスチャの中身は必ず構文エラーにしてある
 * （検査されれば必ず落ちる = exit 1 が「検査された」の証拠になる）。
 *
 * 依存ゼロ。フィクスチャは一時ディレクトリに書き、--root で走査ルートごと差し替える。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'check-inline-js.mjs');

const BROKEN = 'const broken = ;'; // 検査されたら必ず SyntaxError になる
const VALID = 'const ok = 1;';

let total = 0;
let failed = 0;
const failures = [];

function record(name, pass, expected, actual) {
  total++;
  if (pass) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    failures.push({ name, expected, actual });
    console.log(`[FAIL] ${name}\n       expected: ${expected}\n       actual:   ${actual}`);
  }
}

/** フィクスチャ HTML を1枚だけ置いた一時ルートでチェッカーを走らせる。 */
function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'hv-inline-js-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 「このブロックは検査された」= 構文エラーで exit 1 になった、を検証する。 */
function expectChecked(name, html) {
  const { status, out } = run({ 'a.html': html });
  record(name, status === 1 && /SyntaxError/.test(out), 'exit 1 + SyntaxError（＝検査された）', `exit ${status} / ${out.trim().split('\n').pop()}`);
}

/** 「このブロックは検査対象外」= 壊れていても通る、を検証する。 */
function expectSkipped(name, html, alsoValidBlock = true) {
  // 検査対象が 0 件だと別の理由（0 件ガード）で落ちるので、
  // 比較対象として必ず検査される正常なブロックを1つ足しておく。
  const body = alsoValidBlock ? `${html}\n<script>${VALID}</script>` : html;
  const { status, out } = run({ 'a.html': body });
  record(name, status === 0, 'exit 0（＝検査対象外として skip）', `exit ${status} / ${out.trim().split('\n').pop()}`);
}

console.log('=== 抽出ロジック ===');

expectChecked('type 省略のインライン JS は検査される', `<script>\n${BROKEN}\n</script>`);

// --- 回帰: 属性値の中の src を属性として誤認していた ---------------------------
// 旧実装は属性文字列全体に正規表現を当てていたため、別属性の値に src=... を含めると
// 「外部ファイル」と誤判定してブロックを丸ごと skip していた（ブラウザは実行する）。
expectChecked(
  '[回帰] 別属性の値に src= が入っていても外部ファイル扱いしない',
  `<script data-note=" src='not-really-external.js' ">\n${BROKEN}\n</script>`,
);
expectChecked(
  '[回帰] 属性値に > が入っても開始タグが崩れない',
  `<script data-x="a>b">\n${BROKEN}\n</script>`,
);
expectChecked(
  '[回帰] 引用符なしの属性値の中の src= も誤認しない',
  `<script data-note=x-src=y>\n${BROKEN}\n</script>`,
);

expectSkipped('本物の src 属性は skip する', `<script src="x.js">${BROKEN}</script>`);
expectSkipped('値なしの src 属性も skip する', `<script src>${BROKEN}</script>`);

console.log('');
console.log('=== type の判定（HTML 仕様の essence match）===');

// --- 回帰: JavaScript MIME type の一覧が不完全だった -------------------------
// text/jscript などは mimesniff の JavaScript MIME type essence に含まれる＝ブラウザは実行する。
// 一覧から漏れていると構文エラーが静かに素通りする。
expectChecked('[回帰] text/jscript は検査される', `<script type="text/jscript">\n${BROKEN}\n</script>`);
expectChecked('[回帰] text/livescript は検査される', `<script type="text/livescript">\n${BROKEN}\n</script>`);
expectChecked('[回帰] text/javascript1.5 は検査される', `<script type="text/javascript1.5">\n${BROKEN}\n</script>`);
expectChecked('application/javascript は検査される', `<script type="application/javascript">\n${BROKEN}\n</script>`);
expectChecked('大文字の TEXT/JAVASCRIPT も検査される', `<script type="TEXT/JAVASCRIPT">\n${BROKEN}\n</script>`);
expectChecked('前後の空白は落として照合する', `<script type="  text/javascript  ">\n${BROKEN}\n</script>`);
expectChecked('type="module" は検査される', `<script type="module">\n${BROKEN}\n</script>`);

// --- 回帰: パラメータ付き MIME を JS 扱いしていた -----------------------------
// 仕様は type の値そのものを essence と照合する（MIME として解析しない）。
// text/javascript;charset=utf-8 はブラウザでは実行されないデータブロックなので、
// ここで構文エラーを報告するのは誤検知だった。
expectSkipped(
  '[回帰] text/javascript;charset=utf-8 はブラウザが実行しないので skip する',
  `<script type="text/javascript;charset=utf-8">${BROKEN}</script>`,
);
expectSkipped('application/json は skip する', `<script type="application/json">${BROKEN}</script>`);
expectSkipped('text/template は skip する', `<script type="text/template">${BROKEN}</script>`);
expectSkipped('module;x は module でも JS でもないので skip する', `<script type="module;x">${BROKEN}</script>`);

console.log('');
console.log('=== 行番号 ===');

{
  const html = `<!doctype html>\n<html>\n<body>\n<script>\nconst a = 1;\n${BROKEN}\n</script>\n</body>\n</html>\n`;
  const { status, out } = run({ 'a.html': html });
  // <script> が 4 行目 → 中身の 1 行目が 5 行目 → BROKEN は 6 行目
  record('構文エラーの行番号が元 HTML の行と一致する', status === 1 && /a\.html:6:/.test(out), 'a.html:6', out.trim().split('\n').find((l) => l.includes('a.html:')) ?? `exit ${status}`);
}

{
  // HTML コメントを潰すときに文字数・改行数を保っていないと、後続の行番号がズレる。
  const html = `<!-- <script>function f( {</script> -->\n<script>\n${BROKEN}\n</script>\n`;
  const { status, out } = run({ 'a.html': html });
  record('HTML コメント内の script は誤検知しない（かつ後続の行がズレない）', status === 1 && /a\.html:3:/.test(out), 'a.html:3', out.trim().split('\n').find((l) => l.includes('a.html:')) ?? `exit ${status}`);
}

console.log('');
console.log('=== 0 件ガード ===');

{
  const { status, out } = run({ 'a.html': '<p>no script here</p>' });
  record('検査対象が 0 件なら成功にしない', status === 1 && /検査対象/.test(out), 'exit 1', `exit ${status}`);
}

{
  // 「全部 skip」も 0 件と同じく成功にしてはいけない。
  const { status } = run({ 'a.html': '<script src="x.js"></script>' });
  record('全ブロックが skip でも成功にしない', status === 1, 'exit 1', `exit ${status}`);
}

console.log('');
console.log('=== 複数ブロック / 複数ファイル ===');

{
  const html = `<script>${VALID}</script>\n<p>x</p>\n<script>\n${BROKEN}\n</script>\n`;
  const { status } = run({ 'a.html': html });
  record('1 ファイル内の 2 つ目のブロックも検査される', status === 1, 'exit 1', `exit ${status}`);
}

{
  const { status } = run({ 'a.html': `<script>${VALID}</script>`, 'sub/b.html': `<script>\n${BROKEN}\n</script>` });
  record('サブディレクトリの HTML も走査される', status === 1, 'exit 1', `exit ${status}`);
}

{
  const { status } = run({ 'node_modules/x/a.html': `<script>${BROKEN}</script>`, 'b.html': `<script>${VALID}</script>` });
  record('node_modules は走査から除外される', status === 0, 'exit 0', `exit ${status}`);
}

console.log('');
console.log('========================================');
console.log(`TOTAL ${total}  PASSED ${total - failed}  FAILED ${failed}`);
console.log('========================================');
if (failures.length > 0) {
  console.log('');
  console.log(`RESULT_JSON ${JSON.stringify({ total, passed: total - failed, failed, failures })}`);
  process.exit(1);
}
console.log('');
console.log(`RESULT_JSON ${JSON.stringify({ total, passed: total, failed: 0, failures: [] })}`);
