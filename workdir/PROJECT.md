# Invoice Scanner — Project Documentation
> קובץ זה מתעדכן לאחר כל שינוי משמעותי ומשמש כ-context לצ'אטים חדשים עם Claude.

---

## סקירת הפרויקט

**שם:** סורק חשבוניות (Invoice Scanner)
**מטרה:** אפליקציית web לסריקה ופענוח חשבוניות ישראליות, בעיקר להוצאות ילדים.
**משתמש:** Alexander Tumarkin (4a1n1k)
**אינטגרציה:** משמש כ-OCR/LLM service לפרויקט home-manager דרך Internal API

---

## Tech Stack

| שכבה | טכנולוגיה |
|------|-----------|
| Framework | Next.js 16 (App Router) + TypeScript |
| Styling | Tailwind CSS v4 |
| DB | Prisma + SQLite |
| Auth | NextAuth v5 (credentials) |
| OCR | Tesseract (node-tesseract-ocr, PSM 6, heb+eng) |
| LLM | Ollama local — gemma3:4b |
| Image processing | sharp |
| PDF processing | pdf-parse + pdf2pic + ghostscript |

---

## Infrastructure

| שרת | פרטים |
|-----|--------|
| Production URL | `http://116.203.149.15:3005` |
| SSH | `ssh -p 2299 root@116.203.149.15` |
| App directory | `/opt/invoice-scanner` |
| GitHub | `https://github.com/4a1n1k/invoice-scanner` |
| Docker container | `invoice-scanner` |
| OCR service | `home-manager-ocr-service-1` on port 5050 |
| LLM | `ollamaQwen7B` container on port 11434 |

**Server specs:** AMD EPYC 8 cores, 15GB RAM, no GPU → LLM runs on CPU (~15-30s per invoice)

---

## Project Structure

```
src/
├── app/
│   ├── page.tsx                    — Dashboard (server component)
│   ├── upload/page.tsx             — Upload + manual entry (2-tab mode)
│   ├── settings/page.tsx           — Category management
│   ├── reports/page.tsx            — Reports page
│   └── api/
│       ├── auth/[...nextauth]/     — NextAuth handler
│       ├── auth/register/          — User registration
│       ├── categories/route.ts     — CRUD categories
│       ├── files/[id]/route.ts     — Serve uploaded files
│       ├── health/route.ts         — Docker health check
│       ├── invoices/route.ts       — POST invoice
│       ├── invoices/[id]/route.ts  — PATCH/DELETE invoice
│       ├── parse/route.ts          — OCR+LLM pipeline (user-facing)
│       ├── internal/parse/route.ts — Internal API endpoint (machine-to-machine)
│       └── reports/
│           ├── data/route.ts       — GET invoices by month
│           ├── export/route.ts     — Excel export
│           ├── pdf/route.ts        — HTML print-ready report
│           └── download-zip/route.ts — ZIP of invoice files
├── components/
│   ├── Dashboard.tsx               — Main dashboard
│   └── Navbar.tsx
└── lib/
    ├── config.ts                   — AI_CONFIG, STORAGE_CONFIG, DEFAULT_CATEGORIES
    ├── types.ts                    — InvoiceDTO, CategoryDTO, ParsedInvoice
    ├── parse-service.ts            — Full OCR+LLM pipeline
    └── prisma.ts                   — Prisma client singleton
```

---

## Internal API (machine-to-machine)

**Endpoint:** `POST /api/internal/parse`
**Header:** `x-internal-key: <INTERNAL_API_KEY>`
**Response:**
```json
{
  "success": true,
  "data": {
    "amount": 248.7,
    "date": "2026-02-23",
    "type": "מזון",
    "description": "סופר-פארם מעלות"
  },
  "timings": { "ocr": 1900, "llm": 18400, "total": 20300 }
}
```

**משתנה סביבה:** `INTERNAL_API_KEY=6fb6447f6e5f461b86dca1abb68cdc66`
(מוגדר ב-`/opt/invoice-scanner/.env` ומועבר ל-Docker דרך docker-compose.yml)

**שימוש בפרויקט home-manager:** שולח קובץ תמונה/PDF ומקבל נתוני חשבונית מפוענחים ללא צורך ב-UI.

---

## Deployment

```bash
# Deploy update (מ-Windows):
cd D:\Projects\Antigravity\invoice-scanner
git add -A && git commit -m "message" && git push origin main

# On server (rebuild):
ssh -p 2299 root@116.203.149.15 "cd /opt/invoice-scanner && git pull && docker compose down && docker compose build --no-cache && docker compose up -d"

# Quick restart (no rebuild):
ssh -p 2299 root@116.203.149.15 "cd /opt/invoice-scanner && docker compose restart"

# Health check:
curl http://116.203.149.15:3005/api/health

# Logs:
ssh -p 2299 root@116.203.149.15 "docker logs invoice-scanner --tail=30"
```

**Server .env location:** `/opt/invoice-scanner/.env`

---

## Parse Pipeline (parse-service.ts)

```
קובץ הועלה (תמונה / PDF)
        ↓
[PDF] pdf-parse → בדיקת RTL reversal → תיקון → בדיקת איכות טקסט
      ↓ אם ריק/גרוע → pdf2pic (Ghostscript) → תמונה
[תמונה] sharp → rotate (EXIF) + sharpen(σ1.2) + normalize + resize 2400px, quality 92
        ↓
OCR (Tesseract port 5050, PSM 6, heb+eng)
        ↓
preprocessOcrText() — תיקון פסיקים עשרוניים/אלפים + תאריכים
        ↓
extractBusinessName() — חילוץ שם עסק server-side (לפני LLM)
        ↓
extractInvoiceContext() — HEAD(400) + expanding window search לסכום
        ↓ חיפוש ב: 25% → 50% → 75% → 100% + סינון boilerplate
buildParsePrompt() — prompt ממוקד ~500-700 תווים
        ↓
LLM (Ollama gemma3:4b, temperature=0, num_predict=200)
        ↓
repairAndParseJson() — תיקון JSON חתוך/שבור
        ↓
{amount, date, type, description}
```

---

## Key Implementation Details

### PDF Types Handled
1. **Text PDF readable:** חשמל, חשבוניות רגילות → pdf-parse ישיר
2. **RTL Reversed (weezmo):** סופר-פארם, KSP → `smartReverseRtlLine()` + preserves numbers
3. **Image-based PDF:** מקדונלדס, Amazon, Hermitage → Ghostscript → image → OCR

### Smart Context Extraction
חשבוניות גדולות (KSP = 14,000 תווים) מכילות תנאי אחריות ארוכים.
`extractInvoiceContext()`: HEAD 400 תווים + expanding window search לסכום (25%→50%→75%→100%).
מסנן boilerplate (תנאי אחריות, ביטול עסקה, הגנת הצרכן).

### Amount Extraction Rules (בפרומפט)
- סדר עדיפות: `סה"כ לתשלום > לתשלום > Grand Total > סה"כ`
- תמיד לקחת את **הגדול ביותר** = כולל מע"מ
- לא לקחת: `סה"כ ללא מע"מ`, מחיר ליחידה, מע"מ בנפרד

### Description Field
**שם עסק בלבד** — המלא והמדויק כפי שמופיע בחשבונית.
דוגמאות: `"63 קיי אס פי מחשבים אילת"`, `"סופר-פארם מעלות"`.

---

## OCR Tuning

| פרמטר | ערך | סיבה |
|-------|-----|------|
| PSM | 6 | Single block — מתאים לקבלות (שונה מ-3 שהיה קודם) |
| OEM | 1 | LSTM neural network |
| Lang | heb+eng | עברית + אנגלית |
| Sharp sigma | 1.2 | מחדד טקסט מצילום נייד |
| Normalize | ✅ | מאזן תאורה לא אחידה |
| JPEG quality | 92 | פחות artifacts על טקסט קטן |

---

## Environment Variables

| משתנה | ברירת מחדל | תיאור |
|-------|-----------|-------|
| `AUTH_SECRET` | — | חובה, NextAuth secret |
| `AUTH_URL` | `http://116.203.149.15:3005` | כתובת האפליקציה |
| `OCR_API_URL` | `http://host.docker.internal:5050/ocr/file` | שירות OCR |
| `LLM_API_URL` | `http://host.docker.internal:11434/api/generate` | Ollama |
| `LLM_MODEL` | `gemma3:4b` | מודל LLM |
| `AI_TIMEOUT_MS` | `55000` | timeout לקריאות AI |
| `INTERNAL_API_KEY` | — | מפתח לendpoint פנימי |

---

## Known Issues & Limitations

1. **OCR מהנייד < OCR ממחשב** — JPEG compression + perspective distortion. שופר עם sharp preprocessing ו-PSM 6.
2. **LLM מהירות** — ~15-30 שניות. נובע מ-CPU בלבד. gemma3:4b הוא האופטימלי על ה-hardware הנוכחי.
3. **KSP multi-page PDF** — הסכום בעמוד 2. נפתר עם expanding window search.

---

## Planned / Future Features

- [ ] Background job לפירוק פריטים מחשבונית (items[] + price per item)
- [ ] שמירת rawText ב-DB לreprocessing
- [ ] Deskew/perspective correction לצילומי נייד

---

## Session History

### Session 1 (מרץ 2026) — הקמה
- הקמת פרויקט בסיסי: Next.js + Prisma + NextAuth + OCR + LLM
- Deploy ל-Docker על שרת Hetzner
- תיקון UntrustedHost (NextAuth v5)
- תיקון PDF parsing (pdf-parse + standalone bundle)
- הוספת manual entry mode (2 tabs)
- הוספת ZIP download + Hebrew PDF report

### Session 2 (מרץ 2026) — שיפורי parsing
- תיקון EXIF rotation לתמונות מנייד (sharp .rotate())
- שדרוג LLM prompt: חילוץ שם עסק server-side, קטגוריות מה-DB עם hints
- description = שם עסק בלבד (לא מה נרכש)
- תיקון RTL reversed text מ-weezmo PDFs (smartReverseRtlLine)
- תיקון decimal comma: 310,50 → 310.50
- PDF fallback pipeline: Ghostscript + pdf2pic לimage-based PDFs
- Smart context extraction: expanding window search (25%→50%→75%→100%)
- Timing display (OCR ms + LLM ms + total) בממשק
- Mobile: כפתורי עריכה/מחיקה תמיד גלויים
- OCR tuning: PSM 3→6, sharpen(σ1.2), normalize, quality 92
- Amount rule: תמיד הגדול ביותר = כולל מע"מ

### Session 3 (מרץ 2026) — Internal API
- נוסף endpoint: `POST /api/internal/parse`
- מוגן ב-`x-internal-key` header
- מחזיר `{ success, data: { amount, date, type, description }, timings }`
- נוסף `INTERNAL_API_KEY` ל-`.env` ול-`docker-compose.yml`
- הפרויקט משמש עכשיו כ-service עבור home-manager

---
*עודכן לאחרונה: מרץ 2026 — Session 3*
