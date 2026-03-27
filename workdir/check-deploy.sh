#!/bin/bash
echo "=== Git version ==="
cd /opt/invoice-scanner && git log --oneline -2

echo ""
echo "=== Checking sigma value in compiled code ==="
grep -r "sigma" /app --include="*.js" 2>/dev/null | grep -v node_modules | head -5

echo ""
echo "=== Checking linear in compiled code ==="
grep -r "linear" /app --include="*.js" 2>/dev/null | grep -v node_modules | head -5

echo ""
echo "=== Checking normalizeImageForOcr function ==="
grep -r "withoutEnlargement\|targetWidth\|isSmall\|3000\|2400" /app --include="*.js" 2>/dev/null | grep -v node_modules | head -10

echo ""
echo "=== OCR service psm value ==="
grep "psm" /app/src/index.js
