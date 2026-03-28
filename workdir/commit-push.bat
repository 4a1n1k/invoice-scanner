@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: increase Gemini maxOutputTokens to 8192 + repair truncated JSON response"
git push origin main
echo DONE
