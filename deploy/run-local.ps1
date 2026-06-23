# HTML Vault をローカルで本番モード起動するスクリプト
#   - SESSION_SECRET を data/.session_secret に固定保存して使い回す(再起動でログアウトしない)
#   - data/ は .gitignore 対象なので秘密値はgitに載らない
#   - BEHIND_HTTPS=1 で Cloudflare(HTTPS終端)背後の Secure Cookie が有効
#
# 使い方: PowerShell で  .\deploy\run-local.ps1

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$secretFile = Join-Path "data" ".session_secret"
if (-not (Test-Path "data")) { New-Item -ItemType Directory "data" | Out-Null }
if (-not (Test-Path $secretFile)) {
    $s = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    [IO.File]::WriteAllText((Resolve-Path "data").Path + "\.session_secret", $s.Trim())
    Write-Host "Generated new SESSION_SECRET -> $secretFile"
}

$env:SESSION_SECRET = (Get-Content $secretFile -Raw).Trim()
$env:PORT = "3000"
$env:BEHIND_HTTPS = "1"

Write-Host "Starting HTML Vault (PORT=$($env:PORT), BEHIND_HTTPS=1, SESSION_SECRET fixed)"
node server.js
