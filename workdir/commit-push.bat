@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: restore original sharpen-before-normalize order for thermal receipts"
git push origin main
echo DONE
