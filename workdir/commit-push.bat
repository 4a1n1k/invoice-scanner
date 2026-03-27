@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: detect and fix RTL char-mirrored OCR output (MAX receipts)"
git push origin main
echo DONE
