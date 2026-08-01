/**
 * ビルド時 i18n: 選択した言語で public/index.html を生成する。
 *   使い方:  APP_LANG=en node scripts/build-i18n.mjs   (en/ja。既定 ja)
 *
 * 仕組み:
 *   - public/index.template.html の `{{key}}` を locales/<lang>.json の client.<key> で置換
 *   - `{{__T_JSON__}}` には client 全体の JSON を注入（JS から T.key で参照）
 *   - `{{__BODY_CLASS__}}` には UI_HIDE_NEW=1 のとき `hide-new` を注入（メニューの「新規作成」を CSS で隠す）
 * ランタイム切替ではなく「ビルド時に1言語を焼き込む」方式。
 * UI_HIDE_NEW も同じくビルド時にしか効かない（Docker はイメージビルド時、素の Node は npm start）。
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

// 0) UI_HIDE_NEW=1 なら <body> に hide-new を付けて、⋯ メニューの「新規作成」を CSS で隠す。
//    要素自体は DOM に残す（JS が #newBtn を直接参照しているため）。
//    空状態の文言も新規作成の導線に言及しないものへ差し替える。`{{__T_JSON__}}` の注入より前に
//    t を書き換えないと、HTML 側 (`{{emptyState}}`) と JS 側 (`T.emptyState`) がズレる。
const hideNew = process.env.UI_HIDE_NEW === '1';
html = html.split('{{__BODY_CLASS__}}').join(hideNew ? 'hide-new' : '');
if (hideNew && t.emptyStateNoNew) t.emptyState = t.emptyStateNoNew;

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
