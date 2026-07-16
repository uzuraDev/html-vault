/**
 * seed-demo.mjs — build a KV bulk-upload file from a directory of .html files.
 *
 * Usage:
 *   node scripts/seed-demo.mjs <directory-with-html-files>
 *
 * Reads every *.html / *.htm file in <directory> and writes seed-bulk.json
 * (in the current working directory) in the `wrangler kv bulk put` format:
 *   [{ "key": "...", "value": "..." }, ...]
 *
 * The keys follow the KV schema used by src/worker.js:
 *   - "index"     : JSON array of snippet metadata
 *                   [{ id, title, tags, created, updated, bytes }, ...]
 *   - "snip:<id>" : raw HTML body (id = 32 lowercase hex chars)
 *
 * Titles are taken from each file's <title> tag (falling back to the file name).
 * This script does NOT call wrangler itself — it prints the command to run.
 *
 * IMPORTANT: seed a DEDICATED demo KV namespace only. DEMO_MODE makes every
 * snippet in the bound namespace publicly readable without login, so never
 * enable it on (or seed into) the namespace that holds your real vault.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/seed-demo.mjs <directory-with-html-files>');
  process.exit(1);
}

let files;
try {
  files = readdirSync(dir).filter((f) => /\.html?$/i.test(f)).sort();
} catch (e) {
  console.error('Cannot read directory: ' + dir);
  process.exit(1);
}
if (files.length === 0) {
  console.error('No .html files found in ' + dir);
  process.exit(1);
}

// Same extraction rule as guessTitle() in src/worker.js (<title> first).
// Control characters are stripped to mirror sanitizeText() in src/worker.js,
// so seeded index entries match what the running Worker would store.
function titleOf(html, fallback) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  return (t || fallback).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200).trim();
}

const entries = [];
const metas = [];
const now = Date.now();
files.forEach((f, i) => {
  const html = readFileSync(join(dir, f), 'utf8');
  const id = randomBytes(16).toString('hex'); // matches validId(): /^[a-f0-9]{32}$/
  const title = titleOf(html, basename(f).replace(/\.html?$/i, ''));
  // Stagger timestamps so the list order (newest first) follows file order.
  const ts = now - i * 60000;
  metas.push({ id, title, tags: '', created: ts, updated: ts, bytes: Buffer.byteLength(html, 'utf8') });
  entries.push({ key: 'snip:' + id, value: html });
});
entries.push({ key: 'index', value: JSON.stringify(metas) });

writeFileSync('seed-bulk.json', JSON.stringify(entries, null, 2));

console.log(`Wrote seed-bulk.json (${metas.length} snippet(s)):`);
for (const m of metas) console.log(`  - ${m.title} (${m.bytes} bytes)`);
console.log('');
console.log('Now upload it to your KV namespace:');
console.log('  npx wrangler kv bulk put seed-bulk.json --binding VAULT --remote');
console.log('');
console.log('Note: this REPLACES the "index" key. Use it ONLY on a dedicated, empty demo');
console.log('namespace — never on a vault that already has snippets. DEMO_MODE makes every');
console.log('snippet in the bound namespace publicly readable without login.');
