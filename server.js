/**
 * HTML Vault — 学習用HTMLスニペット保管庫 (自分専用)
 *
 * セキュリティ方針:
 *  - パスワード認証 (bcryptハッシュ。平文保存しない)
 *  - ログイン試行レート制限
 *  - セッションCookieは HttpOnly / SameSite=Strict / (HTTPS時)Secure
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

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveIndex(list) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2));
}
function loadAuth() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
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
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
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
function requireAuthOrToken(req, res, next) {
  if (bearerOk(req) || (req.session && req.session.authed)) return next();
  return res.status(401).json({ error: STR.unauthorized });
}

// 書き込みAPI用: Bearerトークン、または (セッション + CSRFトークン) を要求。
// ブラウザ経由(Cookie)のときだけ CSRF を課す。Bearer はヘッダ認証なので
// CSRF の対象外 (ブラウザが自動付与しない = CSRF攻撃の経路にならない)。
function requireWriteAuth(req, res, next) {
  if (bearerOk(req)) return next();
  if (!(req.session && req.session.authed)) {
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

// ===========================================================================
//  認証API
// ===========================================================================
app.get('/api/me', (req, res) => {
  const authed = !!(req.session && req.session.authed);
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
      const csrf = ensureCsrf(req);
      res.json({ ok: true, csrf });
    });
  });
});

app.post('/api/logout', requireAuth, checkCsrf, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ===========================================================================
//  スニペットAPI (すべて認証必須)
// ===========================================================================

// 一覧 (メタデータのみ)
app.get('/api/snippets', requireAuthOrToken, (req, res) => {
  const list = loadIndex().sort((a, b) => b.updated - a.updated);
  res.json({ snippets: list, csrf: req.session && req.session.authed ? ensureCsrf(req) : null });
});

// 全文検索 (タイトル/タグ/本文。本文はHTMLをプレーン化して走査する)
// 個人用なので線形スキャンで十分。q は2文字以上のときだけ走査する。
const SEARCH_EXCERPT_RADIUS = 60; // マッチ前後に確保する文字数 (合計 ~120字)

// HTMLからプレーンテキストを作る (依存を増やさず手書き)。
// script/style の中身を除去 → タグ除去 → 主要エンティティを軽く復元 → 空白圧縮。
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

// text 内の最初の q (小文字化済み needle) の周辺を抜き出して抜粋を作る。
function makeExcerpt(text, lowerNeedle) {
  const idx = text.toLowerCase().indexOf(lowerNeedle);
  if (idx === -1) return '';
  const start = Math.max(0, idx - SEARCH_EXCERPT_RADIUS);
  const end = Math.min(text.length, idx + lowerNeedle.length + SEARCH_EXCERPT_RADIUS);
  let ex = text.slice(start, end);
  if (start > 0) ex = '…' + ex;
  if (end < text.length) ex = ex + '…';
  return ex;
}

app.get('/api/search', requireAuthOrToken, (req, res) => {
  const q = String((req.query && req.query.q) || '').trim();
  if (q.length < 2) {
    // 2文字未満は検索しない (空の結果を返す。UI側は全件表示にフォールバックする)
    return res.json({ results: [], q, csrf: req.session && req.session.authed ? ensureCsrf(req) : null });
  }
  const needle = q.toLowerCase();
  const list = loadIndex().sort((a, b) => b.updated - a.updated);
  const results = [];
  for (const meta of list) {
    const title = (meta.title || '').toLowerCase();
    const tags = (meta.tags || '').toLowerCase();
    const inTitle = title.includes(needle);
    const inTags = tags.includes(needle);

    // 本文は必要時のみ読む。ファイル欠損は無視してメタのみで判定する。
    let bodyText = null;
    const file = snippetPath(meta.id);
    if (file && fs.existsSync(file)) {
      try {
        bodyText = htmlToText(fs.readFileSync(file, 'utf8'));
      } catch {
        bodyText = null;
      }
    }
    const inBody = !!(bodyText && bodyText.toLowerCase().includes(needle));

    if (!inTitle && !inTags && !inBody) continue;

    const field = inTitle ? 'title' : inTags ? 'tags' : 'body';
    const excerpt = inBody ? makeExcerpt(bodyText, needle) : '';
    results.push({
      id: meta.id,
      title: meta.title,
      tags: meta.tags,
      created: meta.created,
      updated: meta.updated,
      bytes: meta.bytes,
      field,
      excerpt,
    });
  }
  res.json({ results, q, csrf: req.session && req.session.authed ? ensureCsrf(req) : null });
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
    if (!html.trim()) {
      return res.status(400).json({ error: STR.emptyContent });
    }
    if (html.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: STR.tooLarge.replace('{mb}', MAX_UPLOAD_MB) });
    }

    const id = newId();
    const file = snippetPath(id);
    fs.writeFileSync(file, html, 'utf8');

    const now = Date.now();
    const meta = {
      id,
      title: sanitizeText(req.body.title) || STR.untitled,
      tags: sanitizeText(req.body.tags, 120),
      created: now,
      updated: now,
      bytes: Buffer.byteLength(html, 'utf8'),
    };
    const list = loadIndex();
    list.push(meta);
    saveIndex(list);
    res.json({ ok: true, snippet: meta });
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

// プレビュー (sandbox iframe で隔離表示するためのHTML本体)
// 直接ブラウザで開いても sandbox 属性付きiframe経由でのみ実行される設計。
app.get('/api/snippets/:id/preview', requireAuth, (req, res) => {
  const file = snippetPath(req.params.id);
  if (!file || !fs.existsSync(file)) {
    return res.status(404).send(STR.notFound);
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

// 更新 (タイトル・タグ・内容)
app.put('/api/snippets/:id', requireAuth, checkCsrf, (req, res) => {
  const list = loadIndex();
  const meta = list.find((s) => s.id === req.params.id);
  if (!meta) return res.status(404).json({ error: STR.notFound });

  if (typeof req.body.html === 'string') {
    const file = snippetPath(req.params.id);
    if (!file) return res.status(400).json({ error: STR.invalidId });
    if (req.body.html.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: STR.tooLarge.replace('{mb}', MAX_UPLOAD_MB) });
    }
    fs.writeFileSync(file, req.body.html, 'utf8');
    meta.bytes = Buffer.byteLength(req.body.html, 'utf8');
  }
  if (typeof req.body.title === 'string') meta.title = sanitizeText(req.body.title) || STR.untitled;
  if (typeof req.body.tags === 'string') meta.tags = sanitizeText(req.body.tags, 120);
  meta.updated = Date.now();
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
  list.splice(idx, 1);
  saveIndex(list);
  res.json({ ok: true });
});

// ===========================================================================
//  エクスポート / インポート (全スニペットのバックアップ・移行)
// ===========================================================================

// 全スニペットを本体ごと JSON バンドルで書き出す。
// 読み取り系なので requireAuthOrToken。GET なので CSRF 不要。
app.get('/api/export', requireAuthOrToken, (req, res) => {
  const list = loadIndex();
  const snippets = [];
  for (const meta of list) {
    const file = snippetPath(meta.id);
    let html = '';
    if (file && fs.existsSync(file)) {
      try {
        html = fs.readFileSync(file, 'utf8');
      } catch {
        html = '';
      }
    }
    snippets.push({
      id: meta.id,
      title: meta.title,
      tags: meta.tags,
      created: meta.created,
      updated: meta.updated,
      html,
    });
  }
  const bundle = {
    app: 'html-vault',
    version: 1,
    exportedAt: Date.now(),
    snippets,
  };
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  res
    .type('application/json; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="html-vault-export-${date}.json"`)
    .send(JSON.stringify(bundle, null, 2));
});

// バンドルを取り込む。各エントリは必ず新しいIDで作成し、既存データを壊さない。
// 書き込み系なので requireWriteAuth。
app.post('/api/import', requireWriteAuth, (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body.snippets)
    ? body.snippets
    : Array.isArray(body)
      ? body
      : null;
  if (!incoming) {
    return res.status(400).json({ error: STR.importInvalid });
  }

  const list = loadIndex();
  let imported = 0;
  let skipped = 0;

  for (const entry of incoming) {
    if (!entry || typeof entry.html !== 'string') {
      skipped++;
      continue;
    }
    const html = entry.html;
    if (!html.trim() || html.length > MAX_UPLOAD_BYTES) {
      skipped++;
      continue;
    }
    // 受け取った id は使わず必ず採番し直す (既存データの上書きを防ぐ)
    const id = newId();
    const file = snippetPath(id);
    if (!file) {
      skipped++;
      continue;
    }
    try {
      fs.writeFileSync(file, html, 'utf8');
    } catch {
      skipped++;
      continue;
    }
    const now = Date.now();
    const created = Number.isFinite(entry.created) ? entry.created : now;
    const updated = Number.isFinite(entry.updated) ? entry.updated : now;
    list.push({
      id,
      title: sanitizeText(entry.title) || STR.untitled,
      tags: sanitizeText(entry.tags, 120),
      created,
      updated,
      bytes: Buffer.byteLength(html, 'utf8'),
    });
    imported++;
  }

  saveIndex(list);
  res.json({ ok: true, imported, skipped });
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
