# One-command deploy workflow for this project (Render = backend + API, Vercel = static frontend).
#   npm run deploy                 commit everything, push, wait until Render is live, then deploy Vercel
#   npm run deploy -- "message"    same, with a commit message
#   npm run render:status          latest deploys + health
#   npm run render:logs            stream live logs (Ctrl+C to stop)
#   npm run render:open            open the app in the browser
#   npm run render:cookies         upload ./cookies.txt as a Render Secret File, redeploy, verify YouTube works
#   npm run render:env -- KEY VAL  set a Render environment variable
#   npm run vercel:deploy          deploy only the frontend to Vercel
param(
  [ValidateSet("deploy", "status", "logs", "open", "cookies", "env", "vercel")] [string]$Command = "deploy",
  [string]$Message = ""
)
$Rest = $args

$ErrorActionPreference = "Stop"
$ServiceId = "srv-db2hopmi0phs73eo57cg"
$AppUrl = "https://grab-dkfd.onrender.com"
$WebUrl = "https://grab-blond.vercel.app"

# Pick up CLIs installed after this terminal was opened (winget/npm -g update PATH only for new shells).
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:APPDATA\npm"
Set-Location (Split-Path $PSScriptRoot -Parent)

function Deploy-Vercel {
  Write-Host "Deploying frontend to Vercel..." -ForegroundColor Cyan
  # Run through cmd so the CLI's stderr progress output isn't turned into terminating errors by PowerShell 5.1.
  $out = cmd /c "vercel deploy --prod --yes 2>&1"
  if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 20 | Write-Host; throw "Vercel deploy failed." }
  Write-Host "Frontend live: $WebUrl" -ForegroundColor Green
}

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

# The CLI can't edit env vars or secret files, so call the Render API with the token from `render login`
# (or RENDER_API_KEY if set).
function Invoke-RenderApi([string]$Path, [hashtable]$Body) {
  $key = $env:RENDER_API_KEY
  if (-not $key) {
    $line = (Get-Content "$HOME\.render\cli.yaml") -match '^\s+key:\s*' | Select-Object -First 1
    $key = ($line -replace '^\s+key:\s*', '').Trim('"', "'", ' ')
  }
  $json = $Body | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Method Put -Uri "https://api.render.com/v1/services/$ServiceId/$Path" `
      -Headers @{ Authorization = "Bearer $key" } -ContentType "application/json" `
      -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
  } catch { throw "Render API call failed ($($_.Exception.Message)). If your login expired, run: render login" }
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
      if ($d.status -eq "live") { Write-Host "Live: $AppUrl" -ForegroundColor Green; Test-Health; Deploy-Vercel; exit 0 }
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
  "open" { Start-Process $WebUrl }
  "vercel" { Deploy-Vercel }
  "env" {
    # npm run render:env -- KEY VALUE   (takes effect on the next deploy)
    if (-not $Message -or $Rest.Count -lt 1) { throw "Usage: npm run render:env -- KEY VALUE" }
    Invoke-RenderApi "env-vars/$Message" @{ value = [string]$Rest[0] }
    Write-Host "Set $Message on Render. It applies on the next deploy (npm run deploy, or: render deploys create $ServiceId --wait --confirm)." -ForegroundColor Green
  }
  "cookies" {
    $file = Join-Path (Get-Location) "cookies.txt"
    if (-not (Test-Path $file)) { throw "Export cookies.txt (Netscape format) from a browser logged into YouTube and put it in $(Get-Location)." }

    Invoke-RenderApi "secret-files/cookies.txt" @{ content = [IO.File]::ReadAllText($file) }
    Write-Host "Uploaded cookies.txt. Redeploying so the server picks it up..." -ForegroundColor Cyan

    render deploys create $ServiceId --wait --confirm -o text
    if ($LASTEXITCODE -ne 0) { throw "Redeploy failed. See: npm run render:logs" }
    Test-Health

    $pwLine = Get-Content .render-password.txt -ErrorAction SilentlyContinue | Where-Object { $_ -like "password: *" }
    if ($pwLine) {
      $auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("grab:" + $pwLine.Substring(10)))
      try {
        $info = Invoke-RestMethod -Method Post -Uri "$AppUrl/api/info" -TimeoutSec 150 -ContentType "application/json" `
          -Headers @{ Authorization = "Basic $auth" } -Body '{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ"}'
        Write-Host "YouTube OK: '$($info.title)' ($($info.qualities.Count) qualities)" -ForegroundColor Green
      } catch {
        $msg = $_.ErrorDetails.Message
        Write-Host "YouTube still blocking: $msg" -ForegroundColor Red
        Write-Host "Re-export fresh cookies (private/incognito window, then close it) and run this again." -ForegroundColor Yellow
      }
    }
  }
}
