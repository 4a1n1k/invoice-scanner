# Invoice Scanner — API Reference
> עדכון אחרון: מרץ 2026 — Session 6
> **שינוי מרכזי:** הוחלף Tesseract OCR + Ollama ב-Gemini Vision API. כל חשבונית — מודפסת, מצולמת, כתב יד — עוברת דרך Gemini ישירות.

---

## Base URLs

| Endpoint | תיאור |
|---------|--------|
| `POST /api/v1/receipt` | External API — לאינטגרציה עם n8n, home-manager, בוטים |
| `POST /api/internal/parse` | Internal API — לפרויקט home-manager בלבד |

```
http://116.203.149.15:3005
```

---

## Authentication

### External API (`/api/v1/receipt`)
```
Authorization: Bearer 6fb6447f6e5f461b86dca1abb68cdc66
```
אפשר גם להעביר `x-user-id` ב-header לבחירת משתמש ספציפי.

### Internal API (`/api/internal/parse`)
```
x-internal-key: 6fb6447f6e5f461b86dca1abb68cdc66
```

---

## `POST /api/v1/receipt` — External API

### שלושה מצבי קלט

**1 — URL / SMS טקסט (JSON)**
```bash
curl -X POST http://116.203.149.15:3005/api/v1/receipt \
  -H "Authorization: Bearer 6fb6447f6e5f461b86dca1abb68cdc66" \
  -H "Content-Type: application/json" \
  -d '{"text": "הגיעה קבלה מ שילב https://wee.ai/l/xx לצפייה: https://wee.ai/r/abc123"}'
```

**2 — Override URL**
```json
{
  "text": "...המסרון המלא...",
  "overrideUrl": "https://wee.ai/r/abc123"
}
```

**3 — קובץ PDF / תמונה (multipart)**
```bash
curl -X POST http://116.203.149.15:3005/api/v1/receipt \
  -H "Authorization: Bearer 6fb6447f6e5f461b86dca1abb68cdc66" \
  -F "file=@receipt.jpg"
```
תומך ב-`image/jpeg`, `image/png`, `application/pdf`.

---

### Response — הצלחה `200`

```json
{
  "ok": true,
  "source": "gemini",
  "url": "https://wee.ai/r/abc123",
  "allUrls": ["https://wee.ai/l/xx", "https://wee.ai/r/abc123"],
  "invoice": {
    "description": "שופרסל בע\"מ יין כוכב הצפון מעלות",
    "date": "2026-03-28",
    "amount": 232.61,
    "vat": 35.48,
    "paymentMethod": "ויזה",
    "type": "מזון",
    "storeAddress": "כפר ורדים",
    "items": [
      {
        "barcode": "7290112494351",
        "name": "קורנפלקס אלופים",
        "quantity": 1,
        "unitPrice": 20.90,
        "total": 20.90,
        "discount": null,
        "finalPrice": 20.90
      },
      {
        "barcode": "7290019205807",
        "name": "שניצלונים 600 גרם",
        "quantity": 2,
        "unitPrice": 19.90,
        "total": 39.80,
        "discount": null,
        "finalPrice": 39.80
      }
    ],
    "provider": "gemini"
  },
  "timings": { "ocr": 0, "llm": 3200, "total": 3250 }
}
```

### שדות ה-invoice

| שדה | טיפוס | תיאור |
|-----|--------|--------|
| `description` | string | שם העסק המלא |
| `date` | string | תאריך ISO (`YYYY-MM-DD`) |
| `amount` | number | סכום לתשלום כולל מע"מ (₪) |
| `vat` | number? | סכום המע"מ בשקלים |
| `paymentMethod` | string? | ויזה / מסטרקארד / מזומן / ביט / null |
| `type` | string | קטגוריית הוצאה (מהקטגוריות של המשתמש) |
| `storeAddress` | string? | כתובת הסניף |
| `items` | array | פריטים מפורטים (ראה למטה) |

### שדות כל פריט (`items[]`)

| שדה | טיפוס | תיאור |
|-----|--------|--------|
| `barcode` | string? | ברקוד הפריט |
| `name` | string | שם הפריט |
| `quantity` | number | כמות |
| `unitPrice` | number | מחיר ליחידה (₪) |
| `total` | number | סה"כ לפני הנחה |
| `discount` | number? | הנחה בשקלים (null אם אין) |
| `finalPrice` | number | מחיר סופי לאחר הנחה |

### שדה `source`

| ערך | מצב |
|-----|-----|
| `gemini` | פענוח תמונה/PDF ישירות ע"י Gemini Vision |
| `url-gemini` | HTML מ-URL → Gemini |
| `weezmo` | Weezmo JSON API (ספק מזוהה) |
| `pairzon` | Pairzon JSON API (ספק מזוהה) |
| `ksp` | KSP HTML parse (ספק מזוהה) |

---

### Response — שגיאה `4xx/5xx`

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
| `INVALID_URL` | 422 | URL נמצא אך לא נגיש |
| `SPA_PAGE` | 422 | הדף JS-rendered |
| `OCR_FAILED` | 500 | פענוח Gemini נכשל |
| `PARSE_FAILED` | 500 | לא ניתן לחלץ JSON תקין |

---

## `POST /api/internal/parse` — Internal API

מיועד **אך ורק** לפרויקט home-manager. לא שומר ל-DB.

### קלט — קובץ
```bash
curl -X POST http://116.203.149.15:3005/api/internal/parse \
  -H "x-internal-key: 6fb6447f6e5f461b86dca1abb68cdc66" \
  -F "file=@receipt.jpg"
```

### קלט — SMS / URL
```bash
curl -X POST http://116.203.149.15:3005/api/internal/parse \
  -H "x-internal-key: 6fb6447f6e5f461b86dca1abb68cdc66" \
  -H "Content-Type: application/json" \
  -d '{"text": "https://wee.ai/r/abc123"}'
```

### Response
```json
{
  "success": true,
  "source": "gemini",
  "data": {
    "description": "מזרוו בכפר 23 בע\"מ",
    "date": "2026-03-15",
    "amount": 310.50,
    "vat": 47.37,
    "paymentMethod": "ויזה",
    "type": "מזון",
    "items": [
      {
        "barcode": "7290019204701",
        "name": "רצועות צ'ונגר סופר קראנץ",
        "quantity": 1,
        "unitPrice": 42.90,
        "total": 42.90,
        "discount": 9.22,
        "finalPrice": 33.68
      }
    ]
  },
  "timings": { "ocr": 0, "llm": 2800, "total": 2850 }
}
```

---

## ספקים נתמכים

| ספק | URL Pattern | שיטה | דוגמה |
|-----|------------|-------|--------|
| **Weezmo** | `wee.ai`, `weezmo.com` | JSON API ישיר | סופרפארם, רמי לוי |
| **Pairzon** | `*.pairzon.com` | JSON API ישיר | Carrefour, סונול |
| **KSP** | `dsdoc.ksp.co.il` | HTML parse | KSP |
| **שילב** | `wee.ai/r/...` | Weezmo (אוטומטי) | שילב |
| **קובץ תמונה** | jpeg/png/heic | **Gemini Vision** | כל חשבונית מצולמת |
| **PDF** | application/pdf | **Gemini** | PDF מודפס |
| **כל שאר URL** | כל אתר | HTML → **Gemini** | חשבוניות דיגיטליות |

---

## קטגוריות

Gemini בוחר קטגוריה אוטומטית מתוך קטגוריות המשתמש.
ל-Internal API — קטגוריות ברירת מחדל: `מזון`, `ביגוד`, `חוגים`, `בריאות`, `אחר`.
ל-External API — קטגוריות מותאמות אישית של המשתמש (ממסד הנתונים).

---

## דוגמאות אינטגרציה

### JavaScript / home-manager
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

  const { invoice } = data;
  console.log(`${invoice.description} | ₪${invoice.amount} | ${invoice.date}`);
  console.log(`הנחות: ₪${invoice.items.reduce((s, i) => s + (i.discount || 0), 0).toFixed(2)}`);
  return invoice;
}
```

### Python
```python
import requests

def parse_receipt(sms_or_path: str) -> dict:
    headers = {"Authorization": "Bearer 6fb6447f6e5f461b86dca1abb68cdc66"}

    if sms_or_path.startswith("http") or not sms_or_path.endswith((".jpg", ".png", ".pdf")):
        r = requests.post(
            "http://116.203.149.15:3005/api/v1/receipt",
            headers=headers,
            json={"text": sms_or_path},
            timeout=60,
        )
    else:
        with open(sms_or_path, "rb") as f:
            r = requests.post(
                "http://116.203.149.15:3005/api/v1/receipt",
                headers=headers,
                files={"file": f},
                timeout=60,
            )

    data = r.json()
    if not data["ok"]:
        raise ValueError(f"[{data['code']}] {data['error']}")

    inv = data["invoice"]
    total_discount = sum(i.get("discount") or 0 for i in inv["items"])
    print(f"{inv['description']} | ₪{inv['amount']} | חסכת: ₪{total_discount:.2f}")
    return inv
```

---

## ארכיטקטורה — שינויים ב-Session 6

### לפני (Sessions 1–5)
```
תמונה → sharp preprocessing → Tesseract OCR → Ollama (qwen2.5:3b) → JSON
```

### אחרי (Session 6+)
```
תמונה/PDF/URL → Gemini Vision API → JSON ישירות
```

**יתרונות:**
- תמיכה מלאה בעברית, כתב יד, חשבוניות הפוכות, קמטים
- פריטים מפורטים כולל ברקוד, הנחות, מע"מ, אמצעי תשלום
- ללא dependencies מקומיות (הוסרו Tesseract + Ollama)
- Free tier: ~7,500 חשבוניות/חודש
