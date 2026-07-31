/**
 * HTML Vault — セルフホスト型のHTMLスニペット保管庫
 *
 * セキュリティ方針:
 *  - パスワード認証 (bcryptハッシュ。平文保存しない)
 *  - ログイン試行レート制限
 *  - セッションCookieは HttpOnly / SameSite=Strict / (HTTPS時)Secure
 *  - ログアウトはサーバー側のセッション実体 (sessions.json) ごと破棄する
 *  - セッションはログイン時のパスワードハッシュ指紋を持ち、パスワードを変えると
 *    (setpass.js 等) 既存セッションは全て無効になる
 *  - 変更系APIはCSRFトークン必須
 *  - アップロードHTMLのプレビューは sandbox iframe で隔離 (本体オリジンで実行させない)
 *  - 生ソースは別エンドポイントで text/plain として返す
 *  - ファイルはサーバー側でID採番。ユーザー入力をパスに使わない (パストラバーサル防止)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const helmet = require('helmet');

// ---- 表示言語 (ビルド時に APP_LANG で固定。en/ja・既定 ja。ランタイム切替はしない) ----
const APP_LANG = (process.env.APP_LANG || 'en').toLowerCase() === 'ja' ? 'ja' : 'en';
const STR = require(`./locales/${APP_LANG}.json`).server;

// ---- 設定 ----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// 待受アドレス。既定はローカルのみ (リバースプロキシ/トンネル経由でのみ公開する)。
// LAN等から直接到達させたい特殊用途のときだけ HOST=0.0.0.0 を明示する。
// (Docker イメージ側では既定を 0.0.0.0 に上書きしている)
const HOST = process.env.HOST || '127.0.0.1';
// データ保存先。Docker 等ではボリュームへ逃がせるよう環境変数で上書き可能。
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const SNIPPET_DIR = path.join(DATA_DIR, 'snippets');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');

// アップロード/保存できる HTML の最大サイズ(MB)。既定 10MB。
const MAX_UPLOAD_MB =
  Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const BODY_LIMIT = `${MAX_UPLOAD_MB}mb`;

// HTTPSの背後 (リバースプロキシ) で動かすなら true を推奨
const BEHIND_HTTPS = process.env.BEHIND_HTTPS === '1';

// セッション署名鍵。環境変数が無ければ起動毎にランダム生成 (= 再起動でログアウト)
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// 任意: ヘッダ `Authorization: Bearer <API_TOKEN>` での書き込み/一覧を許可する。
// MCP サーバ等のヘッドレスなアップロード用 (Claude が生成した HTML を直接保存する等)。
// 未設定ならトークン認証は無効 = 従来どおりセッション認証のみ。
const API_TOKEN = process.env.API_TOKEN ? String(process.env.API_TOKEN) : '';

// 任意: claude.ai 等のリモートMCPコネクター用エンドポイント /mcp/<MCP_SECRET_PATH>。
// authless + 秘匿パスで保護。未設定なら /mcp は無効 (常に404)。生成例: openssl rand -hex 24
// ※ claude.ai は Anthropic クラウドから接続するため、このサーバを公開HTTPSで
//    到達可能にする必要がある (localhost / LAN内 / VPN内では繋がらない)。
const MCP_SECRET_PATH = process.env.MCP_SECRET_PATH ? String(process.env.MCP_SECRET_PATH) : '';

// 数値の環境変数を読む。未設定・空文字・空白のみ・数値でない場合は既定値に倒す。
// (`.env` に `NAME=` の行があるだけで 0 として扱われる事故を避ける)
// 0 を有効値として受けるので、0 を不正扱いする MAX_UPLOAD_MB は従来式のまま据え置く。
function envNumber(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---- 初期化 --------------------------------------------------------------
for (const dir of [DATA_DIR, SNIPPET_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, '[]');

// auth.json が無ければ初期パスワードを用意する。
//  - AUTH_PASSWORD が与えられていればそれを採用して作成する
//  - 無ければ「パスワードをログに出さない」方針のため自動生成せず、
//    案内だけ出して未設定のままにする (loadAuth()=null → /api/login が拒否)。
//    利用者は AUTH_PASSWORD を設定するか setpass.js を実行する。
function ensureInitialAuth() {
  if (fs.existsSync(AUTH_FILE)) return;
  const fromEnv = process.env.AUTH_PASSWORD ? String(process.env.AUTH_PASSWORD) : '';
  if (!fromEnv) {
    console.log(STR.authNotSet);
    return;
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ hash: bcrypt.hashSync(fromEnv, 12) }, null, 2));
  console.log(STR.authInitFromEnv);
}
ensureInitialAuth();

// ファイルが差し替わったかを stat で判定するための鍵。
// mtime だけだと tar でのバックアップ復元 (mtime を復元する) をすり抜けうるので、
// ファイルの置き換え・書き込みで必ず動く ctime も見る。それでも「同一 stat のまま
// 中身だけ変える」ような書き換えは検知できないため、更新系のハンドラでは
// キャッシュを明示的に破棄している。
function statKey(st) {
  return st ? st.mtimeMs + ':' + st.ctimeMs + ':' + st.size : null;
}
function statKeyOf(file) {
  try {
    return statKey(fs.statSync(file));
  } catch {
    return null;
  }
}

// index.json のパース結果をメモリに保持する。検索は 1 キーストロークごとに
// loadIndex() を呼ぶため、毎回 read + JSON.parse するとそれだけで無駄が大きい。
// stat が一致する間だけ再利用するので、外部プロセス (バックアップ復元や別インスタンス)
// が index.json を差し替えた場合は読み直す。
let indexCache = null; // { key, list }
function loadIndex() {
  const key = statKeyOf(INDEX_FILE);
  if (indexCache && key && indexCache.key === key) {
    // 呼び出し側が sort/push/splice で書き換えるので、配列自体は複製して渡す
    // (要素オブジェクトは共有。更新系は必ず saveIndex まで通す作りなので問題ない)。
    return indexCache.list.slice();
  }
  let list;
  try {
    list = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    indexCache = null;
    return [];
  }
  if (!Array.isArray(list)) {
    indexCache = null;
    return [];
  }
  indexCache = key ? { key, list: list.slice() } : null;
  return list;
}
function saveIndex(list) {
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    // 書き込みに失敗したらディスクは元のまま。呼び出し側は meta を書き換えた後なので、
    // キャッシュを無効にして「保存されていない値」を返し続けないようにする。
    indexCache = null;
    throw e;
  }
  // 書いた直後の stat を覚えておく (次の loadIndex を再パースなしで通すため)。
  const key = statKeyOf(INDEX_FILE);
  indexCache = key ? { key, list: list.slice() } : null;
}
function loadAuth() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ---- 認証バージョン (パスワード変更で既存セッションを一括失効させる) --------
// セッションにはログイン時点の「認証バージョン」を焼き込む。auth.json が差し替わる
// (setpass.js / AUTH_PASSWORD での初期化) とバージョンが変わり、以前に発行した
// セッションは認証ガードで弾かれて破棄される。
// サーバー側に失効リストを持たないので、パスワードを変えたプロセスと動いている
// プロセスが別でも (setpass.js は別プロセス)、再起動を挟んでも成立する。
// バージョンはハッシュそのものではなく sha256 の先頭16文字。sessions.json に
// bcrypt ハッシュを写さないため。
function authVersionOfHash(hash) {
  const h = typeof hash === 'string' ? hash : '';
  if (!h) return '';
  return crypto.createHash('sha256').update(h).digest('hex').slice(0, 16);
}
// auth.json の stat が変わらない間だけ再利用する (認証ガードは毎リクエスト通るため)。
// stat が同一のまま中身だけ差し替わる書き換えは検知できないが、その場合でも
// パスワードが変わっていればログインし直しで新しいバージョンが入る。
let authVersionCache = null; // { key, version }
function authVersion() {
  const key = statKeyOf(AUTH_FILE);
  if (authVersionCache && key && authVersionCache.key === key) return authVersionCache.version;
  const auth = loadAuth();
  const version = authVersionOfHash(auth && auth.hash);
  authVersionCache = key ? { key, version } : null;
  return version;
}

// ---- ファイルバックドのセッションストア --------------------------------
// express-session の既定 MemoryStore は再起動でログインが揮発する。
// セッションを DATA_DIR/sessions.json に sid -> { sess, expires } で永続化し、
// 起動時に読み込む(期限切れは捨てる)。set/destroy は即時書き込み、touch は
// メモリ上の期限だけ更新して短いデバウンス後にまとめて書く(rolling のディスク連打回避)。
// ※ 再起動を跨いで有効なのは SESSION_SECRET が固定されているときのみ。
class FileStore extends session.Store {
  constructor(opts = {}) {
    super();
    this.file = opts.file;
    // sess.cookie が maxAge/expires を持たない場合のフォールバック TTL。
    this.ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : 1000 * 60 * 60 * 24;
    this.sessions = new Map(); // sid -> { sess, expires(ms epoch) }
    this.flushTimer = null;
    this.loadSync();
  }

  // 起動時ロード。壊れていたら空で始める。期限切れは読み捨てる。
  loadSync() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // ファイル無し = 何もしない
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return; // 壊れていたら空で始める
    }
    const now = Date.now();
    for (const sid of Object.keys(obj || {})) {
      const entry = obj[sid];
      if (!entry || typeof entry !== 'object') continue;
      const expires = Number(entry.expires);
      if (!expires || expires <= now) continue; // 期限切れは捨てる
      if (!entry.sess || typeof entry.sess !== 'object') continue;
      this.sessions.set(sid, { sess: entry.sess, expires });
    }
  }

  // sess.cookie から失効時刻(ms epoch)を求める。無ければ ttlMs を足す。
  expiryOf(sess) {
    const cookie = sess && sess.cookie;
    if (cookie) {
      if (cookie.expires) {
        const t = new Date(cookie.expires).getTime();
        if (t) return t;
      }
      if (Number(cookie.originalMaxAge) > 0) {
        return Date.now() + Number(cookie.originalMaxAge);
      }
      if (Number(cookie.maxAge) > 0) {
        return Date.now() + Number(cookie.maxAge);
      }
    }
    return Date.now() + this.ttlMs;
  }

  // メモリ内容を sessions.json へアトミックに書き出す(一時ファイル→rename)。
  flushSync() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const out = Object.create(null);
    const now = Date.now();
    for (const [sid, entry] of this.sessions) {
      if (entry.expires <= now) {
        this.sessions.delete(sid);
        continue;
      }
      out[sid] = { sess: entry.sess, expires: entry.expires };
    }
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // ディスク書き込み失敗は致命ではない(メモリ上は有効)。握りつぶす。
    }
  }

  // touch の連打用: 即書きせず短時間でまとめて1回書く。
  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, 5000);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  get(sid, cb) {
    const entry = this.sessions.get(sid);
    if (!entry) return cb(null, null);
    if (entry.expires <= Date.now()) {
      this.sessions.delete(sid);
      this.flushSync();
      return cb(null, null);
    }
    // express-session は破壊的変更を避けるため複製を渡す。
    let sess;
    try {
      sess = JSON.parse(JSON.stringify(entry.sess));
    } catch {
      return cb(null, null);
    }
    cb(null, sess);
  }

  set(sid, sess, cb) {
    let stored;
    try {
      stored = JSON.parse(JSON.stringify(sess));
    } catch (e) {
      return cb && cb(e);
    }
    this.sessions.set(sid, { sess: stored, expires: this.expiryOf(sess) });
    this.flushSync(); // 即時書き込み
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    this.sessions.delete(sid);
    this.flushSync(); // 即時書き込み
    if (cb) cb(null);
  }

  // rolling 時に毎リクエスト呼ばれる。期限だけ更新しデバウンスして書く。
  touch(sid, sess, cb) {
    const entry = this.sessions.get(sid);
    if (entry) {
      entry.expires = this.expiryOf(sess);
      this.scheduleFlush();
    }
    if (cb) cb(null);
  }
}

// プロセス終了時に未フラッシュの touch を書き出す。
const sessionStore = new FileStore({
  file: SESSION_FILE,
  ttlMs: 1000 * 60 * 60 * 8, // cookie.maxAge と同じ既定(8時間)
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { sessionStore.flushSync(); } catch {}
    process.exit(0);
  });
}

// ---- アプリ --------------------------------------------------------------
const app = express();
// プロキシ背後(BEHIND_HTTPS)のときだけ X-Forwarded-* を信頼する。
// 直接公開時に信頼するとクライアントが IP を詐称でき、レート制限のキーを偽装される。
if (BEHIND_HTTPS) app.set('trust proxy', 1);

// セキュリティヘッダ + Content-Security-Policy
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 本体UIのインラインスクリプト/スタイルのみ許可。外部読み込みは不可。
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        // プレビューiframeは srcdoc + sandbox。frame-src は自オリジンのみ。
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // プレビューを<iframe>で出すので本体は同一オリジン埋め込みのみ許可
    frameguard: { action: 'sameorigin' },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

app.use(
  session({
    name: 'hv.sid',
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: BEHIND_HTTPS,
      maxAge: 1000 * 60 * 60 * 8, // 8時間
    },
  })
);

// ログイン試行レート制限 (総当たり対策)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: STR.rateLimited },
});

// ---- CSRF (セッション保持トークン × x-csrf-token ヘッダ照合) -------------
function ensureCsrf(req) {
  if (!req.session.csrf) {
    req.session.csrf = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrf;
}
function checkCsrf(req, res, next) {
  const token = req.get('x-csrf-token');
  if (!token || token !== req.session.csrf) {
    return res.status(403).json({ error: STR.csrfInvalid });
  }
  next();
}

// ---- 認証ガード ----------------------------------------------------------
// セッションが「今も有効か」を判定する唯一の入口。authed が立っているだけでは
// 足りず、ログイン時に焼き込んだ認証バージョンが現行と一致することまで見る。
// ズレていたら (= パスワードが変わった) その場でサーバー側のセッションを破棄する。
// 破棄すると express-session は req.session を外すので、呼び出し側は false の
// あとに req.session を触らないこと。
function sessionAuthed(req) {
  if (!(req.session && req.session.authed)) return false;
  const current = authVersion();
  if (current && req.session.pwv === current) return true;
  try {
    req.session.destroy(() => {});
  } catch {
    /* 破棄に失敗しても「無効」として扱う */
  }
  return false;
}

function requireAuth(req, res, next) {
  if (sessionAuthed(req)) return next();
  return res.status(401).json({ error: STR.unauthorized });
}

// `Authorization: Bearer <API_TOKEN>` が一致するか (定数時間比較)。
// API_TOKEN 未設定なら常に false (= トークン認証は無効)。
function bearerOk(req) {
  if (!API_TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 読み取りAPI用: Bearerトークン or セッションのどちらかでOK。
// セッション判定を先に通すのは、Bearer で入ってきた場合でも失効済みセッションを
// ここで破棄しておくため (ハンドラ側の csrf 返却が古いセッションを拾わない)。
function requireAuthOrToken(req, res, next) {
  if (sessionAuthed(req) || bearerOk(req)) return next();
  return res.status(401).json({ error: STR.unauthorized });
}

// 書き込みAPI用: Bearerトークン、または (セッション + CSRFトークン) を要求。
// ブラウザ経由(Cookie)のときだけ CSRF を課す。Bearer はヘッダ認証なので
// CSRF の対象外 (ブラウザが自動付与しない = CSRF攻撃の経路にならない)。
function requireWriteAuth(req, res, next) {
  if (bearerOk(req)) return next();
  if (!sessionAuthed(req)) {
    return res.status(401).json({ error: STR.unauthorized });
  }
  const token = req.get('x-csrf-token');
  if (!token || token !== req.session.csrf) {
    return res.status(403).json({ error: STR.csrfInvalid });
  }
  next();
}

// ---- multer (メモリ上で受ける。HTML/テキストのみ・MAX_UPLOAD_MB まで) -----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const okType =
      file.mimetype === 'text/html' ||
      file.mimetype === 'text/plain' ||
      /\.html?$/i.test(file.originalname);
    if (!okType) return cb(new Error(STR.fileTypeOnly));
    cb(null, true);
  },
});

// 一覧の共通ソート: ピン留めを先頭に、各グループ内は表示順キーの昇順。
// 表示順キーは手動並べ替え済みなら order (0,1,2,...)、未設定なら -updated。
// -updated は大きな負値になるため、並べ替え後に作られた新規スニペットは
// 自動的にグループ先頭 (新しい順) に浮き、ドラッグされた時点で order が確定する。
// 一度も並べ替えていなければ従来どおり更新日時の新しい順になる。
function displayKey(m) {
  return m.order != null ? m.order : -(m.updated || 0);
}
function byDisplayOrder(a, b) {
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || displayKey(a) - displayKey(b);
}

// ---- ユーティリティ ------------------------------------------------------
function newId() {
  return crypto.randomBytes(16).toString('hex'); // 入力非依存のID
}
function snippetPath(id) {
  // idは16進32文字のみ。念のため検証してパストラバーサルを完全に防ぐ。
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  return path.join(SNIPPET_DIR, id + '.html');
}
function sanitizeText(s, max = 200) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, max)
    .trim();
}
// ダウンロード用ファイル名 (タイトル由来。OS禁止文字を置換し .html を付ける)
function downloadName(title) {
  const s = sanitizeText(title, 100).replace(/[\\/:*?"<>|]/g, '_').trim();
  return (s || 'snippet') + '.html';
}

// HTMLから推測タイトルを得る (<title> → <h1> → 'Untitled')。MCPのupload_htmlでtitle未指定時に使う。
function guessTitle(html) {
  const s = String(html == null ? '' : html);
  const mt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  if (mt) {
    const t = mt[1].replace(/<[^>]+>/g, '').trim();
    if (t) return t;
  }
  const mh = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(s);
  if (mh) {
    const t = mh[1].replace(/<[^>]+>/g, '').trim();
    if (t) return t;
  }
  return 'Untitled';
}

// スニペット作成の共通処理。/api/snippets(POST) と /mcp(upload_html) の両方から呼ぶ。
// 成功で { meta } を、入力不正で { error, status } を返す。
function createSnippet({ html, title, tags }) {
  const body = typeof html === 'string' ? html : '';
  if (!body.trim()) return { error: STR.emptyContent, status: 400 };
  if (Buffer.byteLength(body, 'utf8') > MAX_UPLOAD_BYTES) {
    return { error: STR.tooLarge.replace('{mb}', MAX_UPLOAD_MB), status: 413 };
  }
  const id = newId();
  fs.writeFileSync(snippetPath(id), body, 'utf8');
  const now = Date.now();
  const meta = {
    id,
    title: sanitizeText(title) || STR.untitled,
    tags: sanitizeText(tags, 120),
    created: now,
    updated: now,
    bytes: Buffer.byteLength(body, 'utf8'),
    pinned: false,
  };
  const list = loadIndex();
  list.push(meta);
  saveIndex(list);
  return { meta };
}

// ===========================================================================
//  認証API
// ===========================================================================
app.get('/api/me', (req, res) => {
  const authed = sessionAuthed(req);
  res.json({ authed, csrf: authed ? ensureCsrf(req) : null });
});

app.post('/api/login', loginLimiter, (req, res) => {
  const auth = loadAuth();
  if (!auth) {
    return res
      .status(500)
      .json({ error: STR.noPassword });
  }
  const password = (req.body && req.body.password) || '';
  bcrypt.compare(String(password), auth.hash, (err, ok) => {
    if (err) return res.status(500).json({ error: STR.internalError });
    if (!ok) return res.status(401).json({ error: STR.wrongPassword });
    req.session.regenerate((e) => {
      if (e) return res.status(500).json({ error: STR.sessionError });
      req.session.authed = true;
      // 認証したパスワードのバージョンを焼き込む。以後パスワードが変われば
      // このセッションは認証ガードで弾かれる (= 全セッションが失効する)。
      req.session.pwv = authVersionOfHash(auth.hash);
      const csrf = ensureCsrf(req);
      res.json({ ok: true, csrf });
    });
  });
});

app.post('/api/logout', requireAuth, checkCsrf, (req, res) => {
  // destroy でサーバー側 (sessions.json) から実体を消す。あわせて Cookie も
  // 失効させ、同じ sid が使い回されないようにする。
  req.session.destroy(() => {
    res.clearCookie('hv.sid', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: BEHIND_HTTPS,
    });
    res.json({ ok: true });
  });
});

// ===========================================================================
//  スニペットAPI (すべて認証必須)
// ===========================================================================

// 一覧 (メタデータのみ)
app.get('/api/snippets', requireAuthOrToken, (req, res) => {
  const list = loadIndex().sort(byDisplayOrder);
  res.json({ snippets: list, csrf: sessionAuthed(req) ? ensureCsrf(req) : null });
});

// 全文検索 (タイトル/タグ/本文。本文はHTMLをプレーン化して走査する)
// 想定規模では線形スキャンで十分。q は2文字以上のときだけ走査する。
const SEARCH_EXCERPT_RADIUS = 60; // マッチ前後に確保する文字数 (合計 ~120字)

// HTMLからプレーンテキストを作る (依存を増やさず手書き)。
// script/style の中身を除去 → タグ除去 → 主要エンティティを軽く復元 → 空白圧縮。
// ここは意図的に手を入れていない。パス数を減らす書き換えをいくつか試したが、
//  - 除去系を1本のオルタネーションに畳むと、コメントとタグが交差する入力で結果が変わる
//  - unrolled loop 形にすると閉じない <script> が連続する入力で最大17倍遅くなる
//  - エンティティ復元をコールバック1本に畳むと、エンティティが密な入力でむしろ遅い
// いずれも実測で確認した。速度は呼び出し回数を減らすこと (下のキャッシュ) で稼ぐ。
function htmlToText(html) {
  return String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- 本文テキストのキャッシュ --------------------------------------------
// 検索は毎リクエストで全スニペットHTMLを読み直し htmlToText に通していた
// (200件/25MiB で p50 約260ms)。正規化済みテキストを id ごとに持ち、
// stat (statKey) が一致する間だけ再利用する。ファイル読み込みと正規表現が
// 「変更されたスニペットの初回だけ」に減る。
// 検証に stat を使うので、外部プロセスが data/ を差し替えても (バックアップ復元等)
// 次の検索で読み直される。それでもすり抜ける書き換えに備えて、
// 更新/削除の各ハンドラでも明示的に破棄する。
// メモリは文字数で上限を設ける (SEARCH_CACHE_MB、既定64MB。0で実質無効)。
// 上限に達したら「入らない分はキャッシュしない」= 先に入ったものを保持する。
// LRU にすると、検索が毎回すべてのスニペットを同じ順に走査する都合上
// 「次に必要になるものから捨てる」形になりヒット率がほぼ0に落ちるため。
// (総量が上限を超える環境では、先頭から入る分だけが速くなり、残りは従来どおり)
const SEARCH_CACHE_MB = envNumber(process.env.SEARCH_CACHE_MB, 64);
// V8 は非Latin1文字列を2バイト/文字で保持するので、1MB ≒ 512K文字と見積もる。
// (text と lower の2本を保持するので、実メモリはおおむねこの見積り通りになる)
const SEARCH_CACHE_MAX_CHARS = Math.floor(SEARCH_CACHE_MB * 512 * 1024);
const searchCache = new Map(); // id -> { key, text, lower }
let searchCacheChars = 0;

function dropSearchCache(id) {
  const e = searchCache.get(id);
  if (!e) return;
  searchCacheChars -= e.text.length + e.lower.length;
  searchCache.delete(id);
}

// id の本文を正規化済みで返す { text, lower }。ファイルが無い/読めないときは null。
function getSearchText(id) {
  const file = snippetPath(id);
  if (!file) return null; // id が不正 (パストラバーサル防止は snippetPath 側)
  const key = statKeyOf(file);
  if (!key) {
    dropSearchCache(id); // ファイルが消えていたらキャッシュも捨てる
    return null;
  }
  const hit = searchCache.get(id);
  if (hit && hit.key === key) return hit;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    dropSearchCache(id);
    return null;
  }
  const text = htmlToText(raw);
  const entry = { key, text, lower: text.toLowerCase() };
  dropSearchCache(id); // 古い版が居たら先に外して枠を空ける
  const cost = entry.text.length + entry.lower.length;
  if (searchCacheChars + cost <= SEARCH_CACHE_MAX_CHARS) {
    searchCache.set(id, entry);
    searchCacheChars += cost;
  }
  return entry; // 入らなくても今回の検索には使う
}

// text の idx 位置 (一致開始点) の周辺を抜き出して抜粋を作る。
// 一致位置は呼び出し側が lower.indexOf で既に求めているので、ここでは再走査しない。
function makeExcerpt(text, idx, needleLen) {
  const start = Math.max(0, idx - SEARCH_EXCERPT_RADIUS);
  const end = Math.min(text.length, idx + needleLen + SEARCH_EXCERPT_RADIUS);
  let ex = text.slice(start, end);
  if (start > 0) ex = '…' + ex;
  if (end < text.length) ex = ex + '…';
  return ex;
}

app.get('/api/search', requireAuthOrToken, (req, res) => {
  const q = String((req.query && req.query.q) || '').trim();
  if (q.length < 2) {
    // 2文字未満は検索しない (空の結果を返す。UI側は全件表示にフォールバックする)
    return res.json({ results: [], q, csrf: sessionAuthed(req) ? ensureCsrf(req) : null });
  }
  const needle = q.toLowerCase();
  const list = loadIndex();
  const hits = []; // { meta, field, excerpt }
  const seen = new Set(); // 走査した id (キャッシュの掃除に使う)
  for (const meta of list) {
    seen.add(meta.id);
    const inTitle = (meta.title || '').toLowerCase().includes(needle);
    // field はタイトル優先なので、タイトルで確定していればタグは見なくてよい。
    const inTags = !inTitle && (meta.tags || '').toLowerCase().includes(needle);

    // 本文はキャッシュ経由で読む (ファイル欠損は無視してメタのみで判定)。
    // タイトル/タグでヒットしていても、本文にも語があれば抜粋を出す
    // — これは元からの挙動なので変えない。一致位置はここで1回だけ求め、
    // 抜粋生成側では再走査しない。
    const entry = getSearchText(meta.id);
    const idx = entry ? entry.lower.indexOf(needle) : -1;

    if (!inTitle && !inTags && idx === -1) continue;

    const field = inTitle ? 'title' : inTags ? 'tags' : 'body';
    const excerpt = idx === -1 ? '' : makeExcerpt(entry.text, idx, needle.length);
    hits.push({ meta, field, excerpt });
  }
  // index から消えた id のキャッシュを解放する。
  // 更新/削除ハンドラを通らない消え方 (data/ を丸ごと差し替えるバックアップ復元や
  // 再インポート) があるため、ここで掃除しないと死んだテキストが上限を占め続け、
  // 以後どのスニペットもキャッシュに入れなくなる (再起動するまで直らない)。
  for (const id of searchCache.keys()) {
    if (!seen.has(id)) dropSearchCache(id);
  }
  // 並べ替えは絞り込みの後に行う (全件ではなくヒット分だけ)。
  // ソートは必ず meta 実体に対して行うこと — order を持つのは meta 側なので、
  // 整形後のオブジェクトを並べると手動並べ替え (D&D) が検索結果で無視される。
  hits.sort((a, b) => byDisplayOrder(a.meta, b.meta));
  const results = hits.map(({ meta, field, excerpt }) => ({
    id: meta.id,
    title: meta.title,
    tags: meta.tags,
    created: meta.created,
    updated: meta.updated,
    bytes: meta.bytes,
    pinned: !!meta.pinned,
    field,
    excerpt,
  }));
  res.json({ results, q, csrf: sessionAuthed(req) ? ensureCsrf(req) : null });
});

// 作成 (貼り付け or ファイルアップロード)
app.post(
  '/api/snippets',
  requireWriteAuth, // Bearerトークン or (セッション+CSRF)。multerより前に弾く
  upload.single('file'),
  (req, res) => {
    let html = '';
    if (req.file) {
      html = req.file.buffer.toString('utf8');
    } else if (req.body && typeof req.body.html === 'string') {
      html = req.body.html;
    }
    const r = createSnippet({ html, title: req.body.title, tags: req.body.tags });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, snippet: r.meta });
  }
);

// 生ソース取得 (本体UIのソース表示用。HTMLとして実行させずテキストで返す)
app.get('/api/snippets/:id/raw', requireAuth, (req, res) => {
  const file = snippetPath(req.params.id);
  if (!file || !fs.existsSync(file)) {
    return res.status(404).json({ error: STR.notFound });
  }
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
});

// ダウンロード (Content-Disposition: attachment で1ファイルずつ保存。スマホでもそのまま保存できる)
app.get('/api/snippets/:id/download', requireAuth, (req, res) => {
  const file = snippetPath(req.params.id);
  if (!file || !fs.existsSync(file)) {
    return res.status(404).json({ error: STR.notFound });
  }
  const meta = loadIndex().find((s) => s.id === req.params.id);
  const name = downloadName(meta && meta.title);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res
    .type('text/html; charset=utf-8')
    .set(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
    )
    .send(fs.readFileSync(file, 'utf8'));
});

// プレビュー (sandbox iframe で隔離表示するためのHTML本体)
// 直接ブラウザで開いても sandbox 属性付きiframe経由でのみ実行される設計。
app.get('/api/snippets/:id/preview', requireAuth, (req, res) => {
  const file = snippetPath(req.params.id);
  if (!file || !fs.existsSync(file)) {
    // このレスポンスはUI側の sandbox iframe 内に表示されるので JSON にはしない
    // (利用者に生JSONが見えてしまう)。viewport が無いと iOS が980pxで描画するため付ける。
    // STR.notFound は locales の固定文言でユーザー入力を含まない＝エスケープ不要。
    return res
      .status(404)
      .type('text/html; charset=utf-8')
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<body style="font-family:sans-serif;padding:24px;color:#333"><p>' +
          STR.notFound +
          '</p></body></html>'
      );
  }
  // このレスポンス自体は同一オリジンだが、UI側で sandbox iframe に入れる。
  // 万一直接アクセスされても Cookie を読めないよう、追加で隔離ヘッダを付与。
  res
    .type('text/html; charset=utf-8')
    .set('X-Frame-Options', 'SAMEORIGIN')
    // 直接URLアクセスされても sandbox 扱いにして本体オリジンと分離する。
    // (UI側の sandbox iframe と同等の権限。allow-same-origin は付けない＝
    //  Cookie/同一オリジンAPIに触れない＝セッション窃取・API濫用を防止)
    .set(
      'Content-Security-Policy',
      'sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock'
    )
    .send(fs.readFileSync(file, 'utf8'));
});

// 並べ替え (ドラッグ&ドロップの表示順を保存)
// ※ 下の /api/snippets/:id (PUT) にもマッチするパスなので、必ず先に登録する。
// body.ids は「現在の表示順そのままの完全なID列」。各スニペットの order に列内の位置を保存する。
// ピン留め/非ピンのグループ分けはソート側 (byDisplayOrder) が pinned を優先するため、
// order はグループを跨いだ通し番号で問題ない (グループ内の相対順だけが効く)。
// ids に無いスニペット (並べ替え後に別クライアントで作られた等) は order を付けず、
// 未設定フォールバック (-updated) でグループ先頭に浮かせる。
app.put('/api/snippets/order', requireAuth, checkCsrf, (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || !ids.every((v) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v))) {
    return res.status(400).json({ error: STR.invalidId });
  }
  const pos = new Map(ids.map((id, i) => [id, i]));
  const list = loadIndex();
  for (const meta of list) {
    if (pos.has(meta.id)) meta.order = pos.get(meta.id);
  }
  saveIndex(list);
  res.json({ ok: true });
});

// 更新 (タイトル・タグ・内容・ピン留め)
app.put('/api/snippets/:id', requireAuth, checkCsrf, (req, res) => {
  const list = loadIndex();
  const meta = list.find((s) => s.id === req.params.id);
  if (!meta) return res.status(404).json({ error: STR.notFound });

  let contentChanged = false;
  if (typeof req.body.html === 'string') {
    const file = snippetPath(req.params.id);
    if (!file) return res.status(400).json({ error: STR.invalidId });
    if (req.body.html.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: STR.tooLarge.replace('{mb}', MAX_UPLOAD_MB) });
    }
    fs.writeFileSync(file, req.body.html, 'utf8');
    // 本文が変わったら検索用テキストのキャッシュを捨てる。
    // (stat 検証もあるが、mtime の分解能が粗い環境で「同一秒・同一サイズ」の
    //  上書きをすり抜けるため、書き込み側でも必ず落とす。空文字での更新も同様。)
    dropSearchCache(req.params.id);
    meta.bytes = Buffer.byteLength(req.body.html, 'utf8');
    contentChanged = true;
  }
  if (typeof req.body.title === 'string') {
    meta.title = sanitizeText(req.body.title) || STR.untitled;
    contentChanged = true;
  }
  if (typeof req.body.tags === 'string') {
    meta.tags = sanitizeText(req.body.tags, 120);
    contentChanged = true;
  }
  // ピン留めの付け外し (幾つでも可)。並び順だけの変更なので updated は動かさない。
  if (typeof req.body.pinned === 'boolean') meta.pinned = req.body.pinned;
  if (contentChanged) meta.updated = Date.now();
  saveIndex(list);
  res.json({ ok: true, snippet: meta });
});

// 削除
app.delete('/api/snippets/:id', requireAuth, checkCsrf, (req, res) => {
  const list = loadIndex();
  const idx = list.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: STR.notFound });
  const file = snippetPath(req.params.id);
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
  dropSearchCache(req.params.id); // 削除済みが検索にヒットし続けないように
  list.splice(idx, 1);
  saveIndex(list);
  res.json({ ok: true });
});

// ===========================================================================
//  リモートMCP (Streamable HTTP / ステートレス / 手書きJSON-RPC)
//  claude.ai 等のカスタムコネクター(リモートMCP)用。/mcp/<MCP_SECRET_PATH> を
//  authless + 秘匿パスで保護 (MCP_SECRET_PATH 未設定なら 404 = 無効)。
//  Claude Code 向けの stdio 版 MCP (mcp/server.mjs) とは別系統。
// ===========================================================================
const MCP_PROTOCOL_VERSION = '2025-06-18';
// クライアントが要求したバージョンが既知ならそれに合わせ、未知なら自分の最新で応答する(MCP流儀)。
const MCP_SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_TOOLS = [
  {
    name: 'upload_html',
    description:
      '生成したHTMLをhtml-vaultに保存し、閲覧URLを返す (Save generated HTML to the vault and return its view URL).',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: '保存するHTML全体' },
        title: { type: 'string', description: '任意。未指定ならHTMLの<title>/<h1>から推測' },
        tags: { type: 'string', description: '任意。カンマ区切りタグ' },
      },
      required: ['html'],
    },
  },
  {
    name: 'list_snippets',
    description:
      'html-vault内のスニペットを新しい順に一覧する (List snippets in the vault, newest first).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: '既定20' } },
    },
  },
];
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// 秘匿パスを定数時間で照合。未設定なら常に false。
function mcpSecretOk(given) {
  if (!MCP_SECRET_PATH) return false;
  const a = Buffer.from(String(given == null ? '' : given));
  const b = Buffer.from(MCP_SECRET_PATH);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// リバースプロキシ背後でも正しい scheme://host を得る (viewUrl 用)。
function reqOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return proto + '://' + host;
}

function mcpUploadHtml(args, origin) {
  const a = args || {};
  const title = (a.title && String(a.title).trim()) || guessTitle(a.html);
  const r = createSnippet({ html: a.html, title, tags: a.tags });
  if (r.error) throw new Error(r.error);
  return JSON.stringify(
    {
      ok: true,
      id: r.meta.id,
      title: r.meta.title,
      bytes: r.meta.bytes,
      viewUrl: origin + '/',
      previewUrl: origin + '/api/snippets/' + r.meta.id + '/preview',
    },
    null,
    2
  );
}

function mcpListSnippets(args) {
  const n = parseInt((args && args.limit) || 20, 10);
  const limit = Math.min(Math.max(Number.isFinite(n) ? n : 20, 1), 100);
  const list = loadIndex().sort(byDisplayOrder).slice(0, limit);
  return JSON.stringify(
    list.map((s) => ({
      id: s.id, title: s.title, tags: s.tags, bytes: s.bytes,
      pinned: !!s.pinned,
      updated: new Date(s.updated).toISOString(),
    })),
    null,
    2
  );
}

function mcpDispatch(msg, origin) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const reqV = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: MCP_SUPPORTED_VERSIONS.includes(reqV) ? reqV : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'html-vault', version: '1.0.0' },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        let text;
        if (name === 'upload_html') text = mcpUploadHtml(args, origin);
        else if (name === 'list_snippets') text = mcpListSnippets(args);
        else return rpcError(id, -32602, 'Unknown tool: ' + name);
        return rpcResult(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        // ツール実行時の失敗は JSON-RPC エラーではなく isError:true の結果で返す (MCP流儀)
        return rpcResult(id, {
          content: [{ type: 'text', text: 'エラー: ' + ((e && e.message) || e) }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, 'Method not found: ' + method);
  }
}

// MCP本体。authless想定 (秘匿パスがゲート)。request が無ければ 202、あれば JSON で1応答。
function handleMcp(req, res) {
  const body = req.body;
  const batch = Array.isArray(body);
  const msgs = batch ? body : [body];
  const hasRequest = msgs.some((m) => m && m.id !== undefined && m.id !== null && typeof m.method === 'string');
  if (!hasRequest) return res.status(202).end(); // notification/response のみ
  const origin = reqOrigin(req);
  const out = [];
  for (const m of msgs) {
    // request(id付き + method文字列)のみ応答。notification や response オブジェクトは無視する。
    if (!m || m.id == null || typeof m.method !== 'string') continue;
    out.push(mcpDispatch(m, origin));
  }
  res.json(batch ? out : out[0]);
}

// POST: JSON-RPC を処理。GET: SSE未提供で405。秘匿パス不一致/未設定は 404 (存在を秘匿)。
app.post('/mcp/:secret', (req, res) => {
  if (!mcpSecretOk(req.params.secret)) return res.status(404).json({ error: STR.notFound });
  handleMcp(req, res);
});
app.get('/mcp/:secret', (req, res) => {
  if (!mcpSecretOk(req.params.secret)) return res.status(404).json({ error: STR.notFound });
  res.set('Allow', 'POST').status(405).send('Method Not Allowed');
});

// ---- 静的UI --------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// multerなどのエラーハンドラ
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || STR.genericError });
  next();
});

app.listen(PORT, HOST, () => {
  console.log(STR.listening.replace('{host}', HOST).replace('{port}', PORT));
  console.log(STR.sessionStoreReady.replace('{count}', sessionStore.sessions.size));
  if (!process.env.SESSION_SECRET) {
    console.log(STR.sessionSecretWarn);
  }
});
