#!/bin/bash
echo "=== OCR service /ocr/file code ==="
grep -A 15 "ocr/file" /app/src/index.js

echo ""
echo "=== Testing OCR directly with mirzav image ==="
# Send the actual image directly to OCR service and see what comes back
curl -s -X POST http://localhost:5050/ocr/file \
  -F "image=@/tmp/test.jpg" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('TEXT:'); print(d.get('text','NO TEXT')[:500])"
