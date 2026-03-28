@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: increase maxOutputTokens to 16384 for large receipts with 150+ items"
git push origin main
echo DONE
