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
    default {
        Write-Host "Usage: railway.ps1 [deploy|status|logs|open|link|env|domain]"
    }
}
