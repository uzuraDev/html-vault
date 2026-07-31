/**
 * seed-local.mjs — 開発用に「それらしい件数」のローカルデータを作る。
 *
 *   使い方:  node scripts/seed-local.mjs <件数> [出力先]     (既定の出力先: data-seed)
 *   起動:    DATA_DIR=data-seed npm start
 *
 * <出力先>/index.json と <出力先>/snippets/<id>.html を生成する。
 * 検索まわりの前後比較 (タイトル一致は即時か / 本文検索は何 ms か) をするための土台で、
 * 製品コードからは一切参照されない。
 *
 * 本文サイズは数KB〜数百KBでばらつかせ、次の3種類が必ず混ざるようにしている:
 *   - タイトル/タグだけに検索語がある行 (クライアント側フィルタだけで出るはず)
 *   - 本文だけに検索語がある行           (サーバーの本文走査が要る)
 *   - どちらにも無い行
 *
 * 重要: 出力先に実データの data/ を指定しないこと。index.json を丸ごと上書きする。
 * 誤爆を避けるため、既存の index.json がある出力先には --force なしでは書かない。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2).filter((a) => a !== '--force');
const force = process.argv.slice(2).includes('--force');
const count = Number(args[0]);
const outArg = args[1] || 'data-seed';
const outDir = resolve(outArg);

if (!Number.isInteger(count) || count < 1 || count > 5000) {
  console.error('Usage: node scripts/seed-local.mjs <1-5000> [outDir] [--force]');
  process.exit(1);
}
if (existsSync(join(outDir, 'index.json')) && !force) {
  console.error('Refusing to overwrite an existing index.json: ' + join(outDir, 'index.json'));
  console.error('Pass --force if you really mean it. Never point this at your real data/ directory.');
  process.exit(1);
}

const TOPICS = [
  'flexbox centering', 'grid gallery', 'dark mode toggle', 'sticky header', 'toast notification',
  'modal dialog', 'sortable table', 'sparkline chart', 'markdown preview', 'drag and drop upload',
  'infinite scroll', 'virtual list', 'form validation', 'date picker', 'color palette',
];
const TAGS = ['css', 'layout', 'js', 'ui', 'a11y', 'perf', 'form', 'chart', 'demo'];
// 検索の当て先として仕込む語。タイトル側と本文側で別語にして、経路を切り分けられるようにする。
const TITLE_NEEDLE = 'zqxtitle';
const BODY_NEEDLE = 'zqxbody';

const pick = (arr, i) => arr[i % arr.length];
// 数KB〜数百KBのばらつき。3件に1件だけ大きめにして、平均で潰れないようにする。
function bodySize(i) {
  if (i % 17 === 0) return 300 * 1024;
  if (i % 3 === 0) return 40 * 1024;
  return 3 * 1024;
}
function filler(bytes, i) {
  const line = `<p>Sample paragraph ${i} — lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>\n`;
  return line.repeat(Math.max(1, Math.ceil(bytes / line.length)));
}

mkdirSync(join(outDir, 'snippets'), { recursive: true });

const index = [];
const now = Date.now();
for (let i = 0; i < count; i++) {
  const id = randomBytes(16).toString('hex'); // server.js の newId() と同じ形式
  // 5件に1件はタイトルに、7件に1件は本文にだけ検索語を仕込む (両方に入る行も出る)。
  const inTitle = i % 5 === 0;
  const inBody = i % 7 === 0;
  const title = `${pick(TOPICS, i)} #${i}${inTitle ? ' ' + TITLE_NEEDLE : ''}`;
  const tags = [pick(TAGS, i), pick(TAGS, i + 3)].join(', ');
  const body =
    `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n` +
    `<h1>${title}</h1>\n` +
    (inBody ? `<p>needle ${BODY_NEEDLE} appears only in the body of this one.</p>\n` : '') +
    filler(bodySize(i), i) +
    `</body>\n</html>\n`;
  writeFileSync(join(outDir, 'snippets', id + '.html'), body, 'utf8');
  index.push({
    id,
    title,
    tags,
    // 更新日時をばらけさせて、一覧の既定順 (更新日時の新しい順) が意味を持つようにする
    created: now - (count - i) * 3600_000,
    updated: now - (count - i) * 3600_000,
    bytes: Buffer.byteLength(body, 'utf8'),
    pinned: false,
  });
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));

console.log(`[seed-local] ${count} snippets -> ${outDir}`);
console.log(`[seed-local] title-only needle: "${TITLE_NEEDLE}" / body-only needle: "${BODY_NEEDLE}"`);
console.log(`[seed-local] run: AUTH_PASSWORD=devdev DATA_DIR=${outArg} npm start`);
