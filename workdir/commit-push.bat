@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: restore original f6b912a preprocessing - rotate+resize+sharpen+normalize"
git push origin main
echo DONE
