@echo off
cd /d D:\Projects\Antigravity\invoice-scanner
git add -A
git commit -m "feat: replace Tesseract+Ollama with Gemini Vision - full items extraction with discounts"
git push origin main
echo DONE
