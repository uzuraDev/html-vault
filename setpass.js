/**
 * パスワード設定スクリプト
 * 使い方: npm run setpass
 * 入力したパスワードを bcrypt でハッシュ化し data/auth.json に保存します。
 * 平文は一切保存しません。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const bcrypt = require('bcryptjs');

// server.js と同じく DATA_DIR を環境変数で上書き可能にする。
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// 入力を伏せ字にする
function questionHidden(query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    stdin.resume();
    let input = '';
    const onData = (char) => {
      char = char.toString('utf8');
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '\u0003') {
        process.exit(1);
      } else if (char === '\u007f' || char === '\b') {
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on('data', onData);
  });
}

(async () => {
  const p1 = await questionHidden('新しいパスワード: ');
  if (!p1 || p1.length < 8) {
    console.log('8文字以上にしてください。');
    process.exit(1);
  }
  const p2 = await questionHidden('もう一度入力: ');
  if (p1 !== p2) {
    console.log('一致しません。');
    process.exit(1);
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  rl.close();

  const hash = bcrypt.hashSync(p1, 12);
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ hash }, null, 2));
  console.log('✓ パスワードを設定しました (data/auth.json)。');
  process.exit(0);
})();
