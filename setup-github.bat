@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: setup-github.bat
:: Run this ONCE to push the project to GitHub and set up the server
:: ─────────────────────────────────────────────────────────────────────────────
cd /d D:\Projects\Antigravity\invoice-scanner

echo === Step 1: Initialize git repo (if not already) ===
git init
git add -A
git commit -m "feat: initial commit - invoice scanner with arch refactor"

echo.
echo === Step 2: Create GitHub repo and push ===
echo Create the repo at: https://github.com/new
echo Name: invoice-scanner
echo Visibility: Private (recommended)
echo Then run:
echo   git remote add origin https://github.com/YOUR_USERNAME/invoice-scanner.git
echo   git branch -M main
echo   git push -u origin main
echo.
pause
