# VPS deployment

**English** | [日本語](DEPLOY.ja.md)

Ubuntu VPS + Caddy (auto HTTPS) + systemd. Replace `<...>`. Prerequisites: `<DOMAIN>` A record → VPS IP, ports 80/443 open, sudo SSH access.

> Steps below run official installers via `curl | sudo bash`. Verify the source in the official docs if concerned.

```bash
# 0. dedicated user + app at /opt/html-vault
sudo useradd --system --create-home --home-dir /opt/html-vault --shell /usr/sbin/nologin htmlvault
sudo mkdir -p /opt/html-vault && sudo cp -r ./* /opt/html-vault/ && sudo chown -R htmlvault:htmlvault /opt/html-vault
cd /opt/html-vault

# 1. Node.js (NodeSource LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

# 2. deps + language (APP_LANG=ja for Japanese, default en)
sudo -u htmlvault npm ci --omit=dev
sudo -u htmlvault APP_LANG=en npm run build:i18n

# 3. password (you type it)
sudo -u htmlvault npm run setpass

# 4. SESSION_SECRET via root-only drop-in (kept out of git)
sudo mkdir -p /etc/systemd/system/html-vault.service.d
printf '[Service]\nEnvironment=SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" \
  | sudo tee /etc/systemd/system/html-vault.service.d/secret.conf >/dev/null
sudo chmod 600 /etc/systemd/system/html-vault.service.d/secret.conf

# 5. systemd (check ExecStart node path matches `command -v node`)
sudo cp deploy/html-vault.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now html-vault.service

# 6. Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# 7. Caddyfile (auto Let's Encrypt) + reload
sudo sed "s/REPLACE_WITH_YOUR_DOMAIN/<DOMAIN>/" deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl reload caddy

# 8. daily backup
sudo chmod +x deploy/backup-html-vault.sh
( sudo -u htmlvault crontab -l 2>/dev/null; echo "15 3 * * * /opt/html-vault/deploy/backup-html-vault.sh" ) | sudo -u htmlvault crontab -
```

Visit `https://<DOMAIN>`. Verify: HTTP→HTTPS redirect, login/logout, paste→preview, `.html` upload, data survives `systemctl restart html-vault`, backups in `/var/backups/html-vault/`.
