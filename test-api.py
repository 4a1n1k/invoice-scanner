# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import urllib.request, json

data = json.dumps({'text': 'receipt https://wee.ai/r/6RoyYpbZJkqtpQkzNFZ2MQshi'}).encode('utf-8')
req = urllib.request.Request(
    'http://116.203.149.15:3005/api/internal/parse',
    data=data,
    headers={'Content-Type': 'application/json', 'x-internal-key': '6fb6447f6e5f461b86dca1abb68cdc66'}
)
try:
    resp = urllib.request.urlopen(req, timeout=30)
    result = json.loads(resp.read().decode('utf-8'))
    print('SUCCESS')
    print('provider:', result.get('source'))
    print('url:', result.get('url'))
    d = result.get('data', {})
    print('amount:', d.get('amount'))
    print('date:', d.get('date'))
    print('description:', d.get('description'))
    items = d.get('items', [])
    print('items:', len(items))
    for item in items[:3]:
        print(' -', item)
except Exception as e:
    print('Error:', type(e).__name__, str(e)[:200])
