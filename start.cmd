@echo off
:: Double-click to start Grab locally and open it in your browser.
cd /d "%~dp0"
start "" http://localhost:3000/app
npm run local
