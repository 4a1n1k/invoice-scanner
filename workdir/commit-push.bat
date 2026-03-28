@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "fix: prompt - largest decimal as fallback amount, date with time format"
git push origin main
echo DONE
