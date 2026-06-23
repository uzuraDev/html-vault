#!/usr/bin/env bash
# HTML Vault データバックアップスクリプト
#
# data/ (auth.json / index.json / snippets/) を tar.gz で固めて保存。
# cron で1日1回などの定期実行を想定。世代は14日分を保持。
#
# cron 例 (毎日 3:15 に実行 / htmlvault ユーザーの crontab):
#   15 3 * * * /opt/html-vault/deploy/backup-html-vault.sh >> /var/log/html-vault-backup.log 2>&1

set -euo pipefail

APP_DIR="/opt/html-vault"
DATA_DIR="${APP_DIR}/data"
BACKUP_DIR="/var/backups/html-vault"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${BACKUP_DIR}/html-vault-data-${STAMP}.tar.gz"

# data/ をまるごとアーカイブ
tar -czf "${ARCHIVE}" -C "${APP_DIR}" data

echo "[$(date '+%F %T')] backup created: ${ARCHIVE}"

# 保持期間を過ぎた古いバックアップを削除
find "${BACKUP_DIR}" -name 'html-vault-data-*.tar.gz' -type f -mtime "+${RETENTION_DAYS}" -delete

echo "[$(date '+%F %T')] cleanup done (kept last ${RETENTION_DAYS} days)"
