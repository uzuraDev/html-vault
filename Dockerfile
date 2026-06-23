# syntax=docker/dockerfile:1

# ─── build stage: 本番依存のみ取得 ──────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ─── runtime stage ─────────────────────────────────────────────
FROM node:20-slim

# 表示言語をビルド時に選択（en/ja）。例: docker build --build-arg APP_LANG=ja .
ARG APP_LANG=en
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    APP_LANG=${APP_LANG}

WORKDIR /app

# 依存とアプリ本体をコピー（必要なものだけ）
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js setpass.js ./
COPY locales ./locales
COPY scripts ./scripts
COPY public ./public

# 選択言語で public/index.html を生成（ビルド時に1言語を焼き込む）
RUN node scripts/build-i18n.mjs

# データ用ボリューム。非rootの node ユーザーが書き込めるよう所有権を付与。
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]

USER node
EXPOSE 3000

# 簡易ヘルスチェック（/api/me は無認証で 200 を返す）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/me',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
