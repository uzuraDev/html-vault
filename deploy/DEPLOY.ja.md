# VPS デプロイ

[English](DEPLOY.md) | **日本語**

Ubuntu VPS + Caddy（自動HTTPS）+ systemd。`<...>` は置き換える。前提: `<DOMAIN>` の A レコードが VPS の IP を指す、80/443 開放、sudo 可能な SSH。

> 以下は公式インストーラを `curl | sudo bash` で実行します。気になる場合は公式ドキュメントで配布元を確認してください。

```bash
# 0. 専用ユーザー + /opt/html-vault に配置
sudo useradd --system --create-home --home-dir /opt/html-vault --shell /usr/sbin/nologin htmlvault
sudo mkdir -p /opt/html-vault && sudo cp -r ./* /opt/html-vault/ && sudo chown -R htmlvault:htmlvault /opt/html-vault
cd /opt/html-vault

# 1. Node.js (NodeSource LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

# 2. 依存 + 言語（日本語は APP_LANG=ja、既定 en）
sudo -u htmlvault npm ci --omit=dev
sudo -u htmlvault APP_LANG=ja npm run build:i18n

# 3. パスワード（自分で入力）
sudo -u htmlvault npm run setpass

# 4. SESSION_SECRET を root 専用ドロップインで注入（git に載せない）
sudo mkdir -p /etc/systemd/system/html-vault.service.d
printf '[Service]\nEnvironment=SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" \
  | sudo tee /etc/systemd/system/html-vault.service.d/secret.conf >/dev/null
sudo chmod 600 /etc/systemd/system/html-vault.service.d/secret.conf

# 5. systemd（ExecStart の node パスが `command -v node` と一致するか確認）
sudo cp deploy/html-vault.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now html-vault.service

# 6. Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# 7. Caddyfile（自動 Let's Encrypt）+ reload
sudo sed "s/REPLACE_WITH_YOUR_DOMAIN/<DOMAIN>/" deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl reload caddy

# 8. 日次バックアップ
sudo chmod +x deploy/backup-html-vault.sh
( sudo -u htmlvault crontab -l 2>/dev/null; echo "15 3 * * * /opt/html-vault/deploy/backup-html-vault.sh" ) | sudo -u htmlvault crontab -
```

`https://<DOMAIN>` を確認。HTTP→HTTPS リダイレクト、ログイン/ログアウト、貼り付け→プレビュー、`.html` アップロード、`systemctl restart html-vault` 後もデータ保持、`/var/backups/html-vault/` にバックアップ、を確認。
