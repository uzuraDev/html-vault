# Cloudflare Tunnel（無料HTTPS）

[English](CLOUDFLARE.md) | **日本語**

ローカルで動くインスタンスを、コード変更も VPS もなしに Cloudflare 経由で自動 HTTPS 公開します。TLS は Cloudflare が終端するので、アプリは `BEHIND_HTTPS=1` で起動します。

## クイックトンネル（アカウント不要・URLは毎回変わる）

```powershell
$env:BEHIND_HTTPS="1"; $env:SESSION_SECRET=(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
node server.js
cloudflared tunnel --url http://localhost:3000   # https://xxxx.trycloudflare.com が出る
```

## 名前付きトンネル（恒久・独自ドメイン）

ドメインが Cloudflare 管理下（ネームサーバー切替済み）であること。

```powershell
cloudflared tunnel login
cloudflared tunnel create html-vault
cloudflared tunnel route dns html-vault vault.example.com
```

`~\.cloudflared\config.yml`:
```yaml
tunnel: html-vault
credentials-file: C:\Users\<you>\.cloudflared\<UUID>.json
ingress:
  - hostname: vault.example.com
    service: http://localhost:3000
  - service: http_status:404
```

サービス化: `cloudflared service install`（Linux: `sudo cloudflared service install`）。

## 任意: Cloudflare Access（メール関門）

Zero Trust → Access → Applications → Add（Self-hosted）→ ホスト名 `vault.example.com` → One-time PIN を有効 → ポリシー Allow / 自分のメールを Include。アプリのパスワードの前段にメール OTP の関門を追加できます。

注意: ホストが起きている間だけ公開。`data/` は定期バックアップを。URL は誰でも到達可能だが、ログイン必須＋bcrypt＋レート制限で保護されます。
