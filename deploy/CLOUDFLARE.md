# Cloudflare Tunnel (free HTTPS)

**English** | [日本語](CLOUDFLARE.ja.md)

Expose a locally-running instance over Cloudflare with automatic HTTPS, no code changes, no VPS. Cloudflare terminates TLS, so run the app with `BEHIND_HTTPS=1`.

## Quick tunnel (no account; URL changes each run)

```powershell
$env:BEHIND_HTTPS="1"; $env:SESSION_SECRET=(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
node server.js
cloudflared tunnel --url http://localhost:3000   # prints https://xxxx.trycloudflare.com
```

## Named tunnel (permanent, custom domain)

Domain must be on Cloudflare (nameservers switched).

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

Run as a service: `cloudflared service install` (Linux: `sudo cloudflared service install`).

## Optional: Cloudflare Access (email gate)

Zero Trust → Access → Applications → Add (Self-hosted) → hostname `vault.example.com` → enable One-time PIN → policy Allow / Include your emails. Adds an email-OTP gate in front of the app password.

Notes: only public while the host is awake. Back up `data/` periodically. The URL is reachable by anyone but protected by login + bcrypt + rate limiting.
