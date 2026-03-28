@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: revert bad prompt changes - remove largest decimal fallback, fix date hint"
git push origin main
echo DONE
