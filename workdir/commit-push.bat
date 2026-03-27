@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: revert over-aggressive preprocessing - remove linear boost and double sharpening"
git push origin main
echo DONE
