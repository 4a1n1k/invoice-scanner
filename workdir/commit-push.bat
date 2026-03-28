@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: Hebrew ratio check - retry OCR with 180deg if low Hebrew output"
git push origin main
echo DONE
