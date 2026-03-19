# Invoice Scanner — Project Documentation
> קובץ זה מתעדכן לאחר כל שינוי משמעותי ומשמש כ-context לצ'אטים חדשים עם Claude.

---

## סקירת הפרויקט

**שם:** סורק חשבוניות (Invoice Scanner)  
**מטרה:** אפליקציית web לסריקה ופענוח חשבוניות ישראליות, בעיקר להוצאות ילדים.  
**משתמש:** Alexander Tumarkin (4a1n1k)

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
| Docker | `invoice-scanner` container |
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
│       ├── parse/route.ts          — OCR+LLM pipeline entry point
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
    ├── parse-service.ts            — Full OCR+LLM pipeline (see below)
    └── prisma.ts                   — Prisma client singleton
```

---

## Deployment

```bash
# Deploy update:
cd D:\Projects\Antigravity\invoice-scanner
git add -A && git commit -m "message" && git push origin main

# On server:
ssh -p 2299 root@116.203.149.15 "cd /opt/invoice-scanner && git pull && docker compose down && docker compose build --no-cache && docker compose up -d"

# Health check:
curl http://116.203.149.15:3005/api/health
```

**Server .env location:** `/opt/invoice-scanner/.env`

---

## Parse Pipeline (parse-service.ts)

המסלול המרכזי של הפרויקט:

```
קובץ הועלה (תמונה / PDF)
        ↓
[PDF] pdf-parse → בדיקת RTL reversal → תיקון → בדיקת איכות
      ↓ אם ריק/גרוע → pdf2pic (Ghostscript) → תמונה
[תמונה] sharp → rotate (EXIF) + sharpen + normalize + resize 2400px
        ↓
OCR (Tesseract port 5050, PSM 6, heb+eng)
        ↓
preprocessOcrText() — תיקון פסיקים עשרוניים/אלפים + תאריכים
        ↓
extractBusinessName() — חילוץ שם עסק server-side
        ↓
extractInvoiceContext() — HEAD(400) + expanding window search לסכום
        ↓
buildParsePrompt() — prompt ממוקד ~500-700 תווים
        ↓
LLM (Ollama gemma3:4b, temperature=0, num_predict=200)
        ↓
repairAndParseJson() — תיקון JSON חתוך
        ↓
{amount, date, type, description}
```

---

## Key Implementation Details

### PDF Types Handled
1. **Text PDF (readable):** חשמל, חשבוניות רגילות → pdf-parse ישיר
2. **RTL Reversed (weezmo):** סופר-פארם, KSP → `smartReverseRtlLine()` + fix numbers
3. **Image-based PDF:** מקדונלדס, Amazon, Hermitage → Ghostscript → OCR

### Smart Context Extraction
חשבוניות גדולות (KSP = 14,000 תווים) מכילות תנאי אחריות ארוכים.
הפתרון: `extractInvoiceContext()` — HEAD 400 תווים + window search לסכום (25%→50%→75%→100%).

### Description Field
**שם עסק בלבד** (לא "מה נרכש"). לדוגמה: `"63 קיי אס פי מחשבים אילת"`.
פירוק פריטים מפורט מתוכנן כ-background job בעתיד.

### Amount Extraction Rules
- סדר עדיפות: `סה"כ לתשלום > לתשלום > Grand Total > סה"כ`
- תמיד לקחת את **הגדול ביותר** (כולל מע"מ)
- לא לקחת: `סה"כ ללא מע"מ`, מחיר ליחידה, מע"מ בנפרד

---

## OCR Tuning

| פרמטר | ערך | סיבה |
|-------|-----|------|
| PSM | 6 | Single block — מתאים לקבלות |
| OEM | 1 | LSTM neural network |
| Lang | heb+eng | עברית + אנגלית |
| Sharp sigma | 1.2 | מחדד טקסט מצילום נייד |
| Normalize | ✅ | מאזן תאורה לא אחידה |
| JPEG quality | 92 | פחות artifacts |

---

## Known Issues & Limitations

1. **OCR מהנייד < OCR ממחשב** — JPEG compression + perspective distortion. שופר עם sharp preprocessing ו-PSM 6.
2. **KSP multi-page PDF** — הסכום בעמוד 2. נפתר עם expanding window search.
3. **Hermitage PDF** — image-based weezmo → fallback ל-Ghostscript OCR.
4. **LLM מהירות** — ~15-30 שניות. נובע מ-CPU בלבד, אין GPU. gemma3:4b הוא הטוב ביותר על ה-hardware הנוכחי.

---

## Planned / Future Features

- [ ] Background job לפירוק פריטים מחשבונית (items[] + price per item)
- [ ] שמירת rawText ב-DB לreprocessing
- [ ] שדרוג ל-OpenAI gpt-4o-mini אם רוצים מהירות + דיוק (כ-$0.002/חשבונית)
- [ ] Deskew/perspective correction לצילומי נייד

---

## Session History

### Session 1 (מרץ 2026)
- הקמת פרויקט בסיסי: Next.js + Prisma + NextAuth + OCR + LLM
- Deploy ל-Docker על שרת Hetzner
- תיקון UntrustedHost (NextAuth v5)
- תיקון PDF parsing (pdf-parse + standalone bundle)
- הוספת manual entry mode (2 tabs)
- הוספת ZIP download
- הוספת Hebrew PDF report

### Session 2 (מרץ 2026)
- תיקון EXIF rotation לתמונות מנייד (sharp .rotate())
- שדרוג LLM prompt:
  - חילוץ שם עסק server-side לפני LLM
  - קטגוריות מה-DB עם hints
  - description = שם עסק בלבד
- תיקון RTL reversed text מ-weezmo PDFs
- תיקון decimal comma: 310,50 → 310.50
- PDF fallback pipeline: Ghostscript + pdf2pic
- Smart context extraction: expanding window search
- Timing display (OCR ms + LLM ms + total)
- Mobile: כפתורי עריכה/מחיקה תמיד גלויים
- OCR tuning: PSM 3→6, sharpen, normalize

---
*עודכן לאחרונה: מרץ 2026*
