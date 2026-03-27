@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: 180deg auto-detection, contrast boost, watermark filter, better prompt"
git push origin main
echo DONE
