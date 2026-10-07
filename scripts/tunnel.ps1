# npm run tunnel: serve the live Vercel site from the download engine on THIS PC.
#
# YouTube bot-blocks cloud servers like Render, but trusts a home connection. This script:
#   1. starts the engine on 127.0.0.1 (Google sign-in ON, from .env; refuses to run without it)
#   2. opens a free Cloudflare quick tunnel to it (bin/cloudflared.exe, no account needed)
#   3. points the Vercel site at the tunnel (Vercel env GRAB_API_URL) and redeploys it
# Leave the window open; Ctrl+C stops everything. While this PC is off, the site shows "Server unreachable".
# The tunnel address changes every run, which is why step 3 redeploys Vercel each time (~30 s).
# To go back to the Render engine: npm run tunnel -- -Revert
param([switch]$Revert)

$ErrorActionPreference = "Stop"
$Port = 3100
# The live site (Vercel project "grabb"). Its domain must be in Firebase > Authentication > Authorized domains.
$WebUrl = "https://grabb-xi.vercel.app"
$VercelOrgId = "team_agX3kRnBGT49s3HeHHGOccXq"
$VercelProjectId = "prj_55QFFvVfBq2u8uCmUSaqMconXKbL"
$RenderUrl = "https://grab-dkfd.onrender.com"

$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:APPDATA\npm"
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force data | Out-Null

function Set-VercelApi([string]$Url) {
  Write-Host "Pointing $WebUrl at $Url ..." -ForegroundColor Cyan
  # Target the site's project explicitly; this folder's .vercel link may point at another project.
  $env:VERCEL_ORG_ID = $VercelOrgId; $env:VERCEL_PROJECT_ID = $VercelProjectId
  try {
    cmd /c "vercel env add GRAB_API_URL production --value $Url --force --yes >nul 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "Could not set GRAB_API_URL on Vercel (run: vercel login)." }
    $out = cmd /c "vercel deploy --prod --yes 2>&1"
    if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 15 | Write-Host; throw "Vercel deploy failed." }
  } finally { Remove-Item Env:VERCEL_ORG_ID, Env:VERCEL_PROJECT_ID -ErrorAction SilentlyContinue }
}

if ($Revert) { Set-VercelApi $RenderUrl; Write-Host "Done. $WebUrl uses the Render engine again." -ForegroundColor Green; exit 0 }

if (-not (Test-Path bin\cloudflared.exe)) {
  Write-Host "Downloading cloudflared..." -ForegroundColor Cyan
  curl.exe -sSL -o bin\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is busy. Is a tunnel already running?" }

$engineLog = "data\tunnel-engine.log"; $tunnelLog = "data\cloudflared.log"
Remove-Item $engineLog, "$engineLog.err", $tunnelLog -ErrorAction SilentlyContinue

# The engine inherits these; .env still supplies the Firebase keys.
$env:PORT = "$Port"; $env:HOST = "127.0.0.1"; $env:HOSTED = "1"; $env:ALLOWED_ORIGINS = $WebUrl
$engine = $null; $tunnel = $null
try {
  $engine = Start-Process node -ArgumentList "--import tsx src/server.ts" -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $engineLog -RedirectStandardError "$engineLog.err"
  $health = $null
  for ($i = 0; $i -lt 30 -and -not $health; $i++) {
    Start-Sleep 1
    try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 } catch {}
  }
  if (-not $health) { Get-Content "$engineLog.err" -Tail 20 | Write-Host; throw "Engine didn't start." }
  # The tunnel makes this PC reachable from the internet, so never expose it without sign-in.
  if (-not $health.auth.firebase) { throw "Firebase sign-in isn't configured (.env FIREBASE_*). Refusing to expose this PC without it." }
  Write-Host "Engine running on this PC (yt-dlp $($health.ytdlpVersion), Google sign-in on)." -ForegroundColor Green

  $tunnel = Start-Process bin\cloudflared.exe -ArgumentList "tunnel --no-autoupdate --url http://127.0.0.1:$Port" `
    -WindowStyle Hidden -PassThru -RedirectStandardError $tunnelLog -RedirectStandardOutput "$tunnelLog.out"
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep 1
    $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
  if (-not $url) { Get-Content $tunnelLog -Tail 20 | Write-Host; throw "Cloudflare tunnel didn't start." }

  $ok = $false
  for ($i = 0; $i -lt 45 -and -not $ok; $i++) {
    Start-Sleep 2
    try { $ok = [bool](Invoke-RestMethod "$url/api/health" -TimeoutSec 5).ok } catch {}
  }
  if (-not $ok) { throw "Tunnel $url isn't reachable from the internet." }
  Write-Host "Tunnel up: $url" -ForegroundColor Green

  Set-VercelApi $url
  Write-Host ""
  Write-Host "LIVE: $WebUrl now downloads through this PC." -ForegroundColor Green
  Write-Host "Keep this window open. Press Ctrl+C to stop (the site goes offline until you run this again)." -ForegroundColor Yellow

  while (-not $engine.HasExited -and -not $tunnel.HasExited) { Start-Sleep 5 }
  if ($engine.HasExited) { Write-Host "Engine stopped unexpectedly:" -ForegroundColor Red; Get-Content "$engineLog.err" -Tail 20 | Write-Host }
  if ($tunnel.HasExited) { Write-Host "Tunnel stopped unexpectedly:" -ForegroundColor Red; Get-Content $tunnelLog -Tail 20 | Write-Host }
  exit 1
} finally {
  foreach ($p in $tunnel, $engine) { if ($p -and -not $p.HasExited) { taskkill /PID $p.Id /T /F 2>&1 | Out-Null } }
  Write-Host "Stopped engine and tunnel." -ForegroundColor Cyan
}
