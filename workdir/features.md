# features.md — Invoice Scanner Feature Registry

> כל פיצ'ר חדש נרשם כאן לפני ואחרי מימוש.

---

## ✅ מומשו

### [F-001] OCR Pipeline — parse-service.ts
- **סטטוס:** מומש, בייצור
- **תיאור:** Pipeline מלא: image preprocessing → OCR → LLM → JSON
- **Dependencies:** sharp, Tesseract (port 5050), Ollama (port 11434)
- **Session:** 1-2

---

### [F-002] SMS/URL Parsing — parse-url/route.ts
- **סטטוס:** מומש, בייצור
- **תיאור:** חילוץ URL חכם מ-SMS עם 4 passes, תמיכה ב-Weezmo/Pairzon/KSP
- **Dependencies:** receipt-providers.ts
- **Session:** 4

---

### [F-003] Receipt Providers — receipt-providers.ts
- **סטטוס:** מומש, בייצור
- **תיאור:** Adapters ל-Weezmo, Pairzon, KSP — JSON API ישיר, ללא OCR
- **Dependencies:** fetch, redirect follow
- **Session:** 4

---

### [F-004] URL Picker UI — upload/page.tsx
- **סטטוס:** מומש, בייצור
- **תיאור:** Dropdown לבחירה ידנית של URL כשיש מספר קישורים ב-SMS
- **Dependencies:** allUrls מ-API, overrideUrl
- **Session:** 4

---

### [F-005] External API v1 — /api/v1/receipt
- **סטטוס:** מומש, בייצור
- **תיאור:** Unified endpoint לאינטגרציה חיצונית — JSON/SMS/file, Bearer auth
- **Dependencies:** parse-service, receipt-providers
- **Session:** 4
- **תיעוד:** invoice-scanner-api.md

---

### [F-006] OCR Quality Gate — assessOcrQuality()
- **סטטוס:** מומש, בייצור
- **תיאור:** בדיקת איכות OCR לפני LLM — score 0-100, warnings, usable flag
- **Checks:** gibberish ratio, Hebrew/Latin/digit ratio, PUA chars, line count
- **Session:** 5

---

### [F-007] OCR Quality Badge + Warning UI
- **סטטוס:** מומש, בייצור
- **תיאור:** Badge צבעוני (✓/⚠/✗) ב-TimingBadge, banner כתום כשscore < 40
- **Session:** 5

---

### [F-008] 180° Auto-Detection — detectUpsideDown()
- **סטטוס:** מומש, בייצור
- **תיאור:** זיהוי חשבוניות צולמו הפוך — השוואת בהירות 12% עליון vs תחתון
- **Session:** 5

---

### [F-009] Improved Preprocessing — normalizeImageForOcr()
- **סטטוס:** מומש, בייצור
- **שינויים:** sigma 1.5, m1/m2, linear contrast boost, quality 95, smart resize
- **Session:** 5

---

## 🔲 בתכנון

### [F-010] Prompt Few-Shot Examples
- **תיאור:** הוספת דוגמאות לפרומפט כדי לשפר דיוק LLM
- **כדאיות:** 8/10 — השקעה נמוכה, ROI גבוה
- **Priority:** גבוה

### [F-011] Sole Trader Mode (עוסק פטור/זעיר)
- **תיאור:** מצב עבודה לעוסקים פטורים — מעקב הכנסות, התראת מחזור, סיכום שנתי
- **כדאיות:** 7/10 — requires new DB schema
- **Priority:** בינוני

### [F-012] Handwritten Receipt Support
- **תיאור:** GPT-4o Vision או Google Cloud Vision לקבלות בכתב יד
- **כדאיות:** 6/10 — עלות חיצונית, מקרי קצה
- **Priority:** נמוך
