/**
 * Password setup script (Cloudflare Workers edition)
 *   Usage: node setpass.mjs                → store the hash in the AUTH_HASH secret (production)
 *          node setpass.mjs --local        → write AUTH_HASH to .dev.vars (for `wrangler dev`)
 *          node setpass.mjs --url <url>    → after setting, verify login against your deployed Worker
 *          VAULT_URL=<url> node setpass.mjs  (same as --url)
 *
 * The password is hashed with PBKDF2(SHA-256); the plaintext is never stored.
 * The hash format matches verifyPassword in src/worker.js.
 */
import { spawnSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Cloudflare workerd caps PBKDF2 iterations at 100000 (throws above that).
const ITER = 100000;

// Read the password via readline so no characters are lost or garbled.
// Note: input IS echoed to the screen (local terminal only) — this is a plain
// line prompt, not a hidden one. What you type is exactly what gets stored.
function askLine(query) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

(async () => {
  const p1 = await askLine('New password: ');
  if (!p1 || p1.length < 8) { console.log('Use at least 8 characters.'); process.exit(1); }
  const p2 = await askLine('Type it again: ');
  if (p1 !== p2) { console.log('Passwords do not match.'); process.exit(1); }
  console.log(`(password length: ${p1.length} characters)`);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(p1), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, km, 256);
  const record = JSON.stringify({ iter: ITER, salt: b64u(salt), hash: b64u(new Uint8Array(bits)) });

  const local = process.argv.includes('--local');
  if (local) {
    // Local development: write AUTH_HASH to .dev.vars (read by `wrangler dev`)
    let lines = [];
    try {
      lines = readFileSync('.dev.vars', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('AUTH_HASH='));
    } catch { /* create new file if missing */ }
    lines.push('AUTH_HASH=' + record);
    writeFileSync('.dev.vars', lines.join('\n') + '\n');
    console.log('OK: wrote AUTH_HASH to .dev.vars (local).');
    process.exit(0);
  }

  // Production: store in the AUTH_HASH secret (strongly consistent, applied immediately).
  // Piping to stdin is unreliable on Windows, so use `secret bulk` which reads a JSON file.
  console.log('Storing the hash in the AUTH_HASH secret...');
  const tmp = '.auth-bulk.json';
  writeFileSync(tmp, JSON.stringify({ AUTH_HASH: record }));
  const r = spawnSync('npx', ['wrangler', 'secret', 'bulk', tmp], { stdio: 'inherit', shell: true });
  try { unlinkSync(tmp); } catch {}
  if (r.status !== 0) process.exit(r.status || 1);
  console.log('OK: secret set.');

  // Optional login verification: only when the deployment URL is provided
  // via the VAULT_URL environment variable or the --url argument.
  const vaultUrl = (process.env.VAULT_URL || argValue('--url')).replace(/\/+$/, '');
  if (!vaultUrl) {
    console.log('Skipping login verification (no VAULT_URL / --url given).');
    console.log('To verify: VAULT_URL=https://<your-worker>.workers.dev node setpass.mjs');
    process.exit(0);
  }
  process.stdout.write('Verifying login');
  let result = 0;
  for (let i = 0; i < 5; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    try {
      const res = await fetch(vaultUrl + '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: p1 }),
      });
      result = res.status;
      if (res.status === 200) break;
    } catch { /* retry */ }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  if (result === 200) {
    console.log('OK: login verified — this password works.');
  } else {
    console.log(`Could not verify yet (last response: HTTP ${result}). Wait ~30 seconds and try logging in at ${vaultUrl}.`);
  }
  process.exit(0);
})();
