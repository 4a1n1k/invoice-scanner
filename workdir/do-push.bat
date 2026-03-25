@echo off
cd /d D:\Projects\Antigravity\invoice-scanner

git add src/app/api/parse-url/route.ts src/app/upload/page.tsx src/lib/receipt-providers.ts

git commit -m "feat: flexible URL extraction, KSP provider, URL picker UX"

git push origin main

echo.
echo === PUSH DONE ===
echo.
