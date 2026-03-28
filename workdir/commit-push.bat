@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: remove double-processing - only rotate+resize, let OCR service handle sharpen"
git push origin main
echo DONE
