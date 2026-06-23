/**
 * ビルド時 i18n: 選択した言語で public/index.html を生成する。
 *   使い方:  APP_LANG=en node scripts/build-i18n.mjs   (en/ja。既定 ja)
 *
 * 仕組み:
 *   - public/index.template.html の `{{key}}` を locales/<lang>.json の client.<key> で置換
 *   - `{{__T_JSON__}}` には client 全体の JSON を注入（JS から T.key で参照）
 * ランタイム切替ではなく「ビルド時に1言語を焼き込む」方式。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const lang = (process.env.APP_LANG || 'en').toLowerCase() === 'ja' ? 'ja' : 'en';
const locale = JSON.parse(readFileSync(join(ROOT, 'locales', `${lang}.json`), 'utf8'));
const t = locale.client || {};

const htmlEscape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let html = readFileSync(join(ROOT, 'public', 'index.template.html'), 'utf8');

// 1) JS から参照する翻訳オブジェクトを注入（生のJSON。エスケープしない）
html = html.split('{{__T_JSON__}}').join(JSON.stringify(t));

// 2) 残りの {{key}} を HTML エスケープした値で置換
for (const [key, value] of Object.entries(t)) {
  html = html.split(`{{${key}}}`).join(htmlEscape(value));
}

// 未置換のプレースホルダが残っていたら警告（キー漏れの検知）
const leftover = html.match(/\{\{[a-zA-Z0-9_]+\}\}/g);
if (leftover) {
  console.warn('[build-i18n] 未定義のプレースホルダ:', [...new Set(leftover)].join(', '));
}

writeFileSync(join(ROOT, 'public', 'index.html'), html);
console.log(`[build-i18n] public/index.html を生成しました (APP_LANG=${lang})`);
