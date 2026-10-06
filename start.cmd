@echo off
:: Double-click to start Grab locally and open it in your browser.
cd /d "%~dp0"
start "" http://127.0.0.1:3000
npm start
