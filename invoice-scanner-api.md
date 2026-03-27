# Invoice Scanner — API Reference

## `POST /api/v1/receipt`

Endpoint מאוחד לפענוח חשבוניות מ-URL, SMS, או קובץ.
מיועד לאינטגרציה עם שירותים חיצוניים (n8n, home-manager, Telegram bot וכו').

---

## Base URL

```
http://116.203.149.15:3005/api/v1/receipt
```

---

## Authentication

כל קריאה מחייבת Bearer token:

```
Authorization: Bearer 6fb6447f6e5f461b86dca1abb68cdc66
```

אפשר גם להעביר `x-user-id` ב-header לבחירת משתמש ספציפי (server-to-server).

---

## שלושה מצבי קלט

### 1 — URL / SMS טקסט (JSON)

```bash
curl -X POST http://116.203.149.15:3005/api/v1/receipt \
  -H "Authorization: Bearer 6fb6447f6e5f461b86dca1abb68cdc66" \
  -H "Content-Type: application/json" \
  -d '{"text": "הגיעה קבלה מ שילב https://wee.ai/l/xx לצפייה: https://wee.ai/r/abc123"}'
```

המערכת מזהה אוטומטית את קישור החשבונית מתוך הטקסט (גם אם יש מספר קישורים).


### 2 — Override URL (כשהזיהוי האוטומטי לא מדויק)

```json
{
  "text": "...המסרון המלא...",
  "overrideUrl": "https://wee.ai/r/abc123"
}
```

### 3 — קובץ PDF / תמונה (multipart)

```bash
curl -X POST http://116.203.149.15:3005/api/v1/receipt \
  -H "Authorization: Bearer 6fb6447f6e5f461b86dca1abb68cdc66" \
  -F "file=@receipt.jpg"
```

תומך ב-`image/jpeg`, `image/png`, `application/pdf`.

---

## Response — הצלחה `200`

```json
{
  "ok": true,
  "source": "weezmo",
  "url": "https://wee.ai/r/abc123",
  "allUrls": ["https://wee.ai/l/xx", "https://wee.ai/r/abc123"],
  "invoice": {
    "amount": 164.70,
    "date": "2026-03-19",
    "description": "סופרפארם",
    "type": "בריאות",
    "items": [
      { "name": "משחת שיניים", "price": 12.50, "quantity": 1 }
    ],
    "storeAddress": "דיזנגוף 50 תל אביב",
    "provider": "weezmo"
  },
  "timings": { "ocr": 0, "llm": 0, "total": 776 }
}
```

| שדה | תיאור |
|-----|--------|
| `ok` | `true` בהצלחה |
| `source` | `weezmo` / `pairzon` / `ksp` / `ocr` / `url-llm` |
| `url` | הקישור שנבחר |
| `allUrls` | כל הקישורים שנמצאו בטקסט |
| `invoice.amount` | סכום בשקלים |
| `invoice.date` | תאריך ISO (`YYYY-MM-DD`) |
| `invoice.description` | שם העסק |
| `invoice.type` | קטגוריית הוצאה |
| `invoice.items` | פירוט פריטים (מערך, יכול להיות ריק) |
| `timings` | זמני עיבוד במילישניות |


---

## Response — שגיאה `4xx/5xx`

```json
{
  "ok": false,
  "error": "No invoice URL found in text.",
  "code": "NO_URL",
  "allUrls": [],
  "suggestion": "..."
}
```

| Code | Status | מתי קורה |
|------|--------|-----------|
| `UNAUTHORIZED` | 401 | Bearer token חסר או שגוי |
| `BAD_INPUT` | 400 | חסר שדה `text` או JSON לא תקין |
| `NO_URL` | 422 | לא נמצא URL בטקסט |
| `INVALID_URL` | 422 | URL נמצא אך לא נגיש (403 / DNS fail / timeout) |
| `SPA_PAGE` | 422 | הדף JS-rendered — לא ניתן לסריקה |
| `OCR_FAILED` | 500 | פענוח תמונה/PDF נכשל |
| `PARSE_FAILED` | 500 | ה-LLM לא הצליח לפענח |

---

## ספקים נתמכים

| ספק | URL Pattern | שיטה | דוגמה |
|-----|------------|-------|--------|
| **Weezmo** | `wee.ai`, `weezmo.com` | JSON API ישיר | סופרפארם, רמי לוי, מקדונלד'ס |
| **Pairzon** | `*.pairzon.com` | JSON API ישיר | Carrefour, סונול, יינות ביתן |
| **KSP** | `dsdoc.ksp.co.il` | HTML parse | KSP |
| **שילב** | `wee.ai/r/...` | Weezmo (אוטומטי) | שילב |
| **כל שאר** | כל URL | HTML → LLM | כל אתר חשבוניות |

זיהוי URL חכם — מתוך SMS עם מספר קישורים המערכת מזהה את קישור החשבונית
ומתעלמת מקישורי מדיניות פרטיות (`/l/`, `/privacy/` וכו').


---

## דוגמאות אינטגרציה

### n8n — HTTP Request Node

```json
{
  "method": "POST",
  "url": "http://116.203.149.15:3005/api/v1/receipt",
  "authentication": "genericCredentialType",
  "genericAuthType": "httpHeaderAuth",
  "headers": {
    "Authorization": "Bearer 6fb6447f6e5f461b86dca1abb68cdc66"
  },
  "body": {
    "text": "{{ $json.sms_body }}"
  }
}
```

### Python

```python
import requests

def parse_receipt(sms_text: str) -> dict:
    r = requests.post(
        "http://116.203.149.15:3005/api/v1/receipt",
        headers={"Authorization": "Bearer 6fb6447f6e5f461b86dca1abb68cdc66"},
        json={"text": sms_text},
        timeout=60,
    )
    data = r.json()
    if data["ok"]:
        inv = data["invoice"]
        return {"amount": inv["amount"], "store": inv["description"], "date": inv["date"]}
    else:
        raise ValueError(f"[{data['code']}] {data['error']}")
```

### JavaScript / Node.js

```javascript
async function parseReceipt(smsText) {
  const res = await fetch("http://116.203.149.15:3005/api/v1/receipt", {
    method: "POST",
    headers: {
      "Authorization": "Bearer 6fb6447f6e5f461b86dca1abb68cdc66",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: smsText }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`[${data.code}] ${data.error}`);
  return data.invoice;
}
```

### curl — קישור ישיר

```bash
curl -X POST http://116.203.149.15:3005/api/v1/receipt \
  -H "Authorization: Bearer 6fb6447f6e5f461b86dca1abb68cdc66" \
  -H "Content-Type: application/json" \
  -d '{"text":"https://wee.ai/r/abc123"}'
```

---

## תוצאות בדיקות חיות

| בדיקה | Status | תוצאה |
|-------|--------|--------|
| ללא auth | `401 UNAUTHORIZED` | ✅ |
| טקסט בלי URL | `422 NO_URL` | ✅ |
| שילב SMS (2 URLs) | `200 weezmo` | ✅ ₪164.70 סופרפארם, 776ms |
| Sonol Pairzon | `200 pairzon` | ✅ ₪218.89 Sonol, 442ms |
| Override URL | `200 weezmo` | ✅ אותה חשבונית, 263ms |
| URL לא קיים | `422 INVALID_URL` | ✅ fetch failed |
