# One-command Render workflow for this project.
#   npm run deploy                 commit everything, push, wait until live, health-check
#   npm run deploy -- "message"    same, with a commit message
#   npm run render:status          latest deploys + health
#   npm run render:logs            stream live logs (Ctrl+C to stop)
#   npm run render:open            open the app in the browser
param(
  [ValidateSet("deploy", "status", "logs", "open")] [string]$Command = "deploy",
  [string]$Message = ""
)

$ErrorActionPreference = "Stop"
$ServiceId = "srv-db2hopmi0phs73eo57cg"
$AppUrl = "https://grab-dkfd.onrender.com"

# Pick up CLIs installed after this terminal was opened (winget updates PATH only for new shells).
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
Set-Location (Split-Path $PSScriptRoot -Parent)

function Get-Deploys {
  # Assign first: Windows PowerShell 5.1's ConvertFrom-Json emits a JSON array as one object, assignment unrolls it.
  $list = render deploys list $ServiceId -o json --confirm | Out-String | ConvertFrom-Json
  $list
}

function Test-Health {
  try {
    $h = Invoke-RestMethod "$AppUrl/api/health" -TimeoutSec 90
    Write-Host "Health: ok=$($h.ok) yt-dlp=$($h.ytdlpVersion) hosted=$($h.hosted)" -ForegroundColor Green
  } catch { Write-Host "Health check failed: $($_.Exception.Message)" -ForegroundColor Red }
}

switch ($Command) {
  "deploy" {
    if (git status --porcelain) {
      git add -A
      git commit -q -m $(if ($Message) { $Message } else { "Update $(Get-Date -Format 'yyyy-MM-dd HH:mm')" })
    }
    git push -q origin main
    if ($LASTEXITCODE -ne 0) { throw "git push failed." }
    $sha = (git rev-parse HEAD).Trim()
    Write-Host "Pushed $($sha.Substring(0, 7)). Waiting for Render to build and go live..." -ForegroundColor Cyan

    $deadline = (Get-Date).AddMinutes(20)
    $last = ""
    while ((Get-Date) -lt $deadline) {
      Start-Sleep 10
      $d = Get-Deploys | Where-Object { $_.commit.id -eq $sha } | Select-Object -First 1
      if (-not $d) { continue } # auto-deploy hasn't registered the push yet
      if ($d.status -ne $last) { Write-Host "  $(Get-Date -Format HH:mm:ss)  $($d.status)"; $last = $d.status }
      if ($d.status -eq "live") { Write-Host "Live: $AppUrl" -ForegroundColor Green; Test-Health; exit 0 }
      if ($d.status -match "failed|canceled|deactivated") {
        Write-Host "Deploy $($d.status). Recent logs:" -ForegroundColor Red
        render logs -r $ServiceId --limit 60 -o text --confirm
        exit 1
      }
    }
    Write-Host "Timed out waiting. Check: npm run render:status" -ForegroundColor Yellow
    exit 1
  }
  "status" {
    Get-Deploys | Select-Object -First 5 | ForEach-Object {
      "{0}  {1,-20} {2}  {3}" -f $_.createdAt, $_.status, $_.commit.id.Substring(0, 7), ($_.commit.message -split "`n")[0]
    }
    Test-Health
  }
  "logs" { render logs -r $ServiceId --tail -o text --confirm }
  "open" { Start-Process $AppUrl }
}
