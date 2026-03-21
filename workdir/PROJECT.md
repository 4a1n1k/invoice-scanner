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
| LLM | Ollama local — **qwen2.5:3b** (החלפה מ-gemma3:4b) |
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

**Server specs:** AMD EPYC 8 cores, 15GB RAM, no GPU → LLM runs on CPU

---

## LLM Models on Server

| מודל | גודל | סטטוס | זמן תגובה |
|------|------|--------|-----------|
| `qwen2.5:3b` | 1.9GB | ✅ **פעיל** | ~6-12 שניות |
| `gemma3:4b` | 3.3GB | ⚠️ installed (backup) | ~35-50 שניות |
| `smollm2:135m` | 270MB | ❌ **נמחק** | — |

**למה qwen2.5:3b עדיף:**
- מצוין לעברית (Alibaba multilingual training)
- 1.9GB במקום 3.3GB → פחות לחץ על swap
- ~21 tokens/sec vs ~8 tokens/sec של gemma3
- benchmark: 5.8s vs 35-50s (!!)

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
│       ├── internal/parse/route.ts — Internal API (machine-to-machine) ← אל תגע!
│       └── reports/
│           ├── data/route.ts       — GET invoices by month
│           ├── export/route.ts     — Excel export
│           ├── pdf/route.ts        — HTML print-ready report
│           └── download-zip/route.ts
├── components/
│   ├── Dashboard.tsx
│   └── Navbar.tsx
└── lib/
    ├── config.ts                   — AI_CONFIG, STORAGE_CONFIG, DEFAULT_CATEGORIES
    ├── types.ts                    — InvoiceDTO, CategoryDTO, ParsedInvoice
    ├── parse-service.ts            — Full OCR+LLM pipeline
    └── prisma.ts
```

---

## ⚠️ CRITICAL — Internal API (אל תשנה!)

**Endpoint:** `POST /api/internal/parse`
**Header:** `x-internal-key: <INTERNAL_API_KEY>`
**Response:**
```json
{
  "success": true,
  "data": { "amount": 248.7, "date": "2026-02-23", "type": "מזון", "description": "סופר-פארם מעלות" },
  "timings": { "ocr": 1900, "llm": 5800, "total": 7700 }
}
```
**INTERNAL_API_KEY=6fb6447f6e5f461b86dca1abb68cdc66** (ב-.env בשרת)
**שימוש:** home-manager שולח קובץ ומקבל נתוני חשבונית — אל תגע בendpoint הזה!

---

## Deployment

```bash
# Deploy update:
cd D:\Projects\Antigravity\invoice-scanner
git add -A && git commit -m "message" && git push origin main

# On server (rebuild):
ssh -p 2299 root@116.203.149.15 "cd /opt/invoice-scanner && git pull && docker compose down && docker compose build --no-cache && docker compose up -d"

# Quick restart (no rebuild):
ssh -p 2299 root@116.203.149.15 "cd /opt/invoice-scanner && docker compose down && docker compose up -d"

# Health check:
curl http://116.203.149.15:3005/api/health

# Logs:
ssh -p 2299 root@116.203.149.15 "docker logs invoice-scanner --tail=30"
```

---

## Parse Pipeline (parse-service.ts)

```
קובץ הועלה (תמונה / PDF)
        ↓
[PDF] pdf-parse → RTL reversal check → fix → quality check
      ↓ אם ריק/גרוע → pdf2pic (Ghostscript) → image
[Image] sharp → rotate(EXIF) + sharpen(σ1.2) + normalize + resize 2400px, q92
        ↓
OCR (Tesseract port 5050, PSM 6, heb+eng)
        ↓
preprocessOcrText() — decimal comma fix + date normalization
        ↓
extractBusinessName() — server-side, before LLM
        ↓
extractInvoiceContext() — HEAD(400) + expanding window search (25%→50%→75%→100%)
        ↓
buildParsePrompt() — ~500-700 chars focused prompt
        ↓
LLM (Ollama qwen2.5:3b, temperature=0, num_predict=200)
        ↓
repairAndParseJson()
        ↓
{amount, date, type, description}
```

---

## OCR Tuning

| פרמטר | ערך | סיבה |
|-------|-----|------|
| PSM | 6 | Single block — receipts |
| OEM | 1 | LSTM neural network |
| Lang | heb+eng | Hebrew + English |
| Sharp sigma | 1.2 | sharpen blurry mobile text |
| Normalize | ✅ | fix uneven lighting |
| JPEG quality | 92 | less artifacts on small text |

---

## Environment Variables

| משתנה | ברירת מחדל | תיאור |
|-------|-----------|-------|
| `AUTH_SECRET` | — | חובה, NextAuth secret |
| `AUTH_URL` | `http://116.203.149.15:3005` | כתובת האפליקציה |
| `OCR_API_URL` | `http://host.docker.internal:5050/ocr/file` | שירות OCR |
| `LLM_API_URL` | `http://host.docker.internal:11434/api/generate` | Ollama |
| `LLM_MODEL` | `qwen2.5:3b` | מודל LLM |
| `AI_TIMEOUT_MS` | `55000` | timeout |
| `INTERNAL_API_KEY` | — | מפתח לendpoint פנימי |

---

## Session History

### Session 1 (מרץ 2026) — הקמה
- הקמת פרויקט: Next.js + Prisma + NextAuth + OCR + LLM
- Deploy ל-Docker, תיקון UntrustedHost
- manual entry mode, ZIP download, Hebrew PDF report

### Session 2 (מרץ 2026) — שיפורי parsing
- EXIF rotation fix, RTL reversal fix (weezmo)
- Smart context extraction (expanding window)
- Decimal comma fix, description = שם עסק בלבד
- PDF fallback (Ghostscript), timing display
- OCR: PSM 3→6, sharpen, normalize

### Session 3 (מרץ 2026) — Internal API + LLM upgrade
- נוסף `POST /api/internal/parse` לintegration עם home-manager
- **החלפת LLM: gemma3:4b → qwen2.5:3b**
- מחיקת smollm2:135m (לא בשימוש)
- ביצועים: 35-50s → **~6-12s** ✅
- docker-compose.yml: default LLM_MODEL עודכן ל-qwen2.5:3b

---
*עודכן לאחרונה: מרץ 2026 — Session 3*
