@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: remove ALL preprocessing - send original file directly to OCR service"
git push origin main
echo DONE
