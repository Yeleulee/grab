# Railway deploy helper — run:  npm run railway:deploy
# Prerequisites: npm i -g @railway/cli  &&  railway login
param([string]$Action = "deploy")

switch ($Action) {
    "deploy" {
        Write-Host "`n  Deploying to Railway..." -ForegroundColor Cyan
        railway up --detach
        Write-Host "`n  Deploy triggered. Check status with:  npm run railway:status" -ForegroundColor Green
    }
    "status" {
        railway status
    }
    "logs" {
        railway logs
    }
    "open" {
        railway open
    }
    "link" {
        Write-Host "`n  Linking this project to a Railway service..." -ForegroundColor Cyan
        railway link
    }
    "env" {
        Write-Host "`n  Current Railway environment variables:" -ForegroundColor Cyan
        railway variables
    }
    "domain" {
        Write-Host "`n  Generating a public domain for the service..." -ForegroundColor Cyan
        railway domain
    }
    "cookies" {
        $file = Join-Path (Get-Location) "cookies.txt"
        if (-not (Test-Path $file)) { throw "No cookies.txt found. Run: npm run cookies:export" }
        Write-Host "`n  Reading cookies.txt and converting to Base64..." -ForegroundColor Cyan
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $b64 = [Convert]::ToBase64String($bytes)
        Write-Host "  Uploading cookies to Railway..." -ForegroundColor Cyan
        railway variables set "YTDLP_COOKIES_BASE64=$b64"
        Write-Host "  Cookies updated on Railway! Redeploying service..." -ForegroundColor Green
        railway up --service balanced-heart --detach
    }
    default {
        Write-Host "Usage: railway.ps1 [deploy|status|logs|open|link|env|domain|cookies]"
    }
}
