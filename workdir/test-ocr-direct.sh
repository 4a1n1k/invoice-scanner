#!/bin/bash
# Test OCR service directly with a simple image
echo "=== Testing OCR service directly ==="
curl -s http://localhost:5050/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('OCR service:', d)"

echo ""
echo "=== Creating test image ==="
# Create a simple Hebrew text image using imagemagick or python
python3 -c "
import subprocess, os, tempfile

# Check if we have imagemagick
result = subprocess.run(['which', 'convert'], capture_output=True, text=True)
if result.returncode == 0:
    # Create test image with Hebrew text
    subprocess.run([
        'convert', '-size', '800x200', 'white',
        '-font', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '-pointsize', '40', '-fill', 'black',
        '-draw', 'text 50,100 \"Test OCR 123.45 shuphersal\"',
        '/tmp/test_ocr.jpg'
    ])
    print('Created test image')
    
    # Send to OCR
    result = subprocess.run([
        'curl', '-s', '-X', 'POST', 
        'http://localhost:5050/ocr/file',
        '-F', 'image=@/tmp/test_ocr.jpg'
    ], capture_output=True, text=True)
    print('OCR result:', result.stdout[:200])
else:
    print('imagemagick not available, skipping image test')
"
