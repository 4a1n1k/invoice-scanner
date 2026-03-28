/**
 * gemini-service.ts
 *
 * Replaces Tesseract OCR + Ollama LLM with a single Gemini Vision API call.
 * Handles: image files, PDF files, and plain text (from URL scraping).
 *
 * Gemini receives the image/text and returns structured JSON directly —
 * no preprocessing pipeline, no two-step OCR → LLM chain.
 */

import { AI_CONFIG } from "./config";
import type { ParsedInvoice, InvoiceItem } from "./types";

// ─── Gemini API types ─────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiRequest {
  contents: Array<{ parts: GeminiPart[] }>;
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    responseMimeType: string;
  };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

export function buildGeminiPrompt(categories: string[], today: string): string {
  const catList = categories.map(c => `"${c}"`).join(" | ");
  return `אתה מומחה לפענוח חשבוניות ישראליות. נתח את החשבונית ותחזיר JSON בלבד.

קטגוריות אפשריות: ${catList}

החזר JSON עם המבנה הבא בדיוק (ללא טקסט נוסף):
{
  "businessName": "שם העסק המלא",
  "date": "YYYY-MM-DD",
  "totalAmount": 0.00,
  "vat": 0.00,
  "paymentMethod": "ויזה/מסטרקארד/מזומן/אמריקן אקספרס/ביט/פייבוקס/העברה/null",
  "category": "אחת מהקטגוריות שלמעלה",
  "storeAddress": "כתובת העסק אם מופיעה או null",
  "items": [
    {
      "barcode": "ברקוד או null",
      "name": "שם הפריט",
      "quantity": 1,
      "unitPrice": 0.00,
      "total": 0.00,
      "discount": 0.00,
      "finalPrice": 0.00
    }
  ]
}

כללים:
- date: המר DD/MM/YYYY ל-YYYY-MM-DD. אם לא קיים תאריך: "${today}"
- totalAmount: הסכום הסופי לתשלום כולל מע"מ (שדה "לתשלום")
- vat: סכום המע"מ (₪), לא אחוז
- discount: הנחה בשקלים לפריט (0 אם אין הנחה)
- finalPrice: מחיר הפריט לאחר הנחה
- אם אין פריטים מפורטים בחשבונית, החזר items: []
- אל תמציא נתונים שאינם בחשבונית
- paymentMethod: null אם לא רשום`;
}

// ─── Core Gemini API call ─────────────────────────────────────────────────────

async function callGeminiApi(parts: GeminiPart[]): Promise<string> {
  const apiKey = AI_CONFIG.geminiApiKey;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const model = AI_CONFIG.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body: GeminiRequest = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 16384, // supports up to ~150 line items per receipt
      responseMimeType: "application/json",
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_CONFIG.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned empty response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ─── JSON parser ──────────────────────────────────────────────────────────────

function repairTruncatedJson(raw: string): string {
  // Close unclosed strings, arrays, objects to recover partial JSON
  let s = raw.trim();

  // Count unclosed braces/brackets
  let braces = 0, brackets = 0;
  let inString = false, escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }

  // If we're mid-string, close it
  if (inString) s += '"';
  // Close any open arrays/objects
  s += ']'.repeat(Math.max(0, brackets));
  s += '}'.repeat(Math.max(0, braces));

  return s;
}

function parseGeminiJson(raw: string, categories: string[], today: string): ParsedInvoice {
  // Strip markdown fences if present
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // Try to repair truncated JSON (e.g. response cut mid-items array)
    console.warn("[Gemini] JSON parse failed, attempting repair...");
    try {
      const repaired = repairTruncatedJson(cleaned);
      obj = JSON.parse(repaired);
      console.log("[Gemini] JSON repaired successfully");
    } catch {
      throw new Error(`Gemini returned invalid JSON: ${cleaned.slice(0, 300)}`);
    }
  }

  // Normalize items
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items: InvoiceItem[] = rawItems.map((item: Record<string, unknown>) => {
    const unitPrice = parseFloat(String(item.unitPrice ?? item.unit_price ?? 0)) || 0;
    const quantity = parseFloat(String(item.quantity ?? 1)) || 1;
    const total = parseFloat(String(item.total ?? unitPrice * quantity)) || unitPrice * quantity;
    const discount = parseFloat(String(item.discount ?? 0)) || 0;
    const finalPrice = parseFloat(String(item.finalPrice ?? item.final_price ?? total - discount)) || total - discount;

    return {
      barcode: item.barcode ? String(item.barcode) : undefined,
      name: String(item.name ?? "פריט לא ידוע"),
      quantity,
      unitPrice,
      total,
      discount: discount > 0 ? discount : undefined,
      finalPrice,
    };
  });

  // Validate & normalize top-level fields
  const amount = parseFloat(String(obj.totalAmount ?? obj.amount ?? 0)) || 0;
  const vat = parseFloat(String(obj.vat ?? 0)) || undefined;
  const date = String(obj.date ?? today);
  const description = String(obj.businessName ?? obj.description ?? "לא ידוע");
  const paymentMethod = obj.paymentMethod && obj.paymentMethod !== "null"
    ? String(obj.paymentMethod) : undefined;
  const storeAddress = obj.storeAddress && obj.storeAddress !== "null"
    ? String(obj.storeAddress) : undefined;

  // Category matching — Gemini picks from our list
  const rawType = String(obj.category ?? obj.type ?? "");
  const type = categories.find(c => c === rawType) ?? categories[0] ?? "אחר";

  return { amount, date, type, description, items, vat, paymentMethod, storeAddress };
}

// ─── Image parsing ────────────────────────────────────────────────────────────

/**
 * Parse an invoice image (JPEG, PNG, HEIC, etc.) via Gemini Vision.
 * Sends the image directly — no Tesseract preprocessing needed.
 */
export async function parseImageWithGemini(
  file: File,
  categories: string[],
): Promise<{ result: ParsedInvoice; ms: number }> {
  const t0 = Date.now();
  const today = new Date().toISOString().split("T")[0];

  // Convert file to base64
  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mimeType = (file.type || "image/jpeg") as string;

  const parts: GeminiPart[] = [
    { inlineData: { mimeType, data: base64 } },
    { text: buildGeminiPrompt(categories, today) },
  ];

  const raw = await callGeminiApi(parts);
  const result = parseGeminiJson(raw, categories, today);

  console.log(`[Gemini] image parsed: ${result.description} | ₪${result.amount} | ${result.items.length} items | ${Date.now() - t0}ms`);
  return { result, ms: Date.now() - t0 };
}

// ─── Text parsing ─────────────────────────────────────────────────────────────

/**
 * Parse invoice text (from URL scraping or PDF extraction) via Gemini.
 * Text-only call — no image.
 */
export async function parseTextWithGemini(
  text: string,
  categories: string[],
): Promise<{ result: ParsedInvoice; ms: number }> {
  const t0 = Date.now();
  const today = new Date().toISOString().split("T")[0];
  const prompt = buildGeminiPrompt(categories, today);

  const parts: GeminiPart[] = [
    { text: `${prompt}\n\nטקסט החשבונית:\n${text.slice(0, 8000)}` },
  ];

  const raw = await callGeminiApi(parts);
  const result = parseGeminiJson(raw, categories, today);

  console.log(`[Gemini] text parsed: ${result.description} | ₪${result.amount} | ${result.items.length} items | ${Date.now() - t0}ms`);
  return { result, ms: Date.now() - t0 };
}
