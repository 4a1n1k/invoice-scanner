/**
 * POST /api/internal/parse
 *
 * Internal endpoint for Family War Room integration.
 * Protected by x-internal-key header (no session required).
 *
 * Supports two modes:
 *   A) File upload  — multipart/form-data with "file" field (PDF / image)
 *   B) SMS / text   — JSON body with "text" field containing SMS message with URL
 *
 * Returns:
 *   { success, data: { amount, date, type, description, items?, storeAddress?, provider? }, timings }
 *
 * Note: Does NOT save to DB — caller (Family War Room) owns persistence.
 */

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_CATEGORIES, AI_CONFIG } from "@/lib/config";
import { runParsingPipeline, buildParsePrompt, parseInvoiceWithLlm } from "@/lib/parse-service";
import {
  detectProvider,
  fetchReceiptByUrl,
  type ReceiptData,
} from "@/lib/receipt-providers";

export const maxDuration = 60;

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const key = req.headers.get("x-internal-key");
  const expected = process.env.INTERNAL_API_KEY ?? "";
  return !!expected && key === expected;
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

const PDF_NOISE_LINES = [
  /מסמך ממוחשב/, /מסמך זה הינו/, /page \d+ of \d+/i,
  /weezmo/i, /info@weezmo/i, /חתימה אלקטרונית/,
  /הוראות ניהול ספרים/, /verified by/i,
];

function isTextRtlReversed(text: string): boolean {
  return ["בשחוממ ךמסמ", ":קסע םש", ":ךיראת", "כ\"הס"].some(m => text.includes(m));
}

function smartReverseRtlLine(line: string): string {
  if (!/[\u05d0-\u05ea]/.test(line)) return line;
  let rev = line.split("").reverse().join("");
  rev = rev.replace(/\d[\d.:,/]*\d|\d/g, m => m.split("").reverse().join(""));
  return rev;
}

function fixRtlReversedText(text: string): string {
  return text.split("\n").map(l => smartReverseRtlLine(l.trim())).join("\n");
}

function isPdfTextUsable(text: string): boolean {
  if (!text?.length) return false;
  let pua = 0, total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe000 && cp <= 0xf8ff) pua++;
    total++;
  }
  if (total > 0 && pua / total > 0.15) return false;
  const meaningful = text.split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 2 && !PDF_NOISE_LINES.some(p => p.test(l)))
    .join("\n");
  return meaningful.length >= 100;
}

async function pdfPageToImageBlob(pdfBuffer: Buffer): Promise<Blob | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fromBuffer } = require("pdf2pic");
    const convert = fromBuffer(pdfBuffer, {
      density: 200, format: "jpeg", width: 1800, height: 2600, preserveAspectRatio: true,
    });
    const result = await convert(1, { responseType: "buffer" });
    if (!result?.buffer) return null;
    const buf = result.buffer as Buffer;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Blob([ab as ArrayBuffer], { type: "image/jpeg" });
  } catch { return null; }
}

// ── Smart URL extraction ──────────────────────────────────────────────────────
//
// SMS messages often contain multiple URLs, e.g.:
//   "בהתאם למדיניות הפרטיות: https://wee.ai/l/xxx   לצפייה: https://wee.ai/r/yyy"
//
// Strategy (3 passes):
//   Pass 1 — URL after explicit receipt keyword AND without skip keyword nearby (strict)
//   Pass 2 — URL NOT preceded by a privacy/legal keyword
//   Pass 3 — Last URL in text (receipt link usually comes after privacy link)
//
// NOTE: 'קבלה' intentionally excluded from Pass 1 — too generic.
//       It appears in general SMS text ("הגיעה אליך קבלה") before the privacy URL.

const RECEIPT_KEYWORDS_BEFORE =
  /לצפ|לצפיה|לצפייה|חשבונ|receipt|invoice|view/i;

const SKIP_KEYWORDS_BEFORE =
  /פרטי[וו]?ת|privacy|תקנון|terms|policy|legal|הסכם|תנאי|ביטול|cancel/i;

function extractBestUrl(text: string): string | null {
  const matches = [...text.matchAll(/https?:\/\/[^\s\u200B\u200C\u200D\uFEFF"'<>]+/g)];
  if (matches.length === 0) return null;

  const urls = matches.map(m => ({
    url: m[0].replace(/[.,;!?)\]]+$/, ""),
    index: m.index ?? 0,
  }));

  if (urls.length === 1) return urls[0].url;

  // Pass 1: receipt keyword nearby AND no skip keyword (strict)
  for (const { url, index } of urls) {
    const before = text.slice(Math.max(0, index - 40), index);
    if (RECEIPT_KEYWORDS_BEFORE.test(before) && !SKIP_KEYWORDS_BEFORE.test(before)) return url;
  }

  // Pass 2: URL NOT preceded by a skip keyword (within 60 chars)
  for (const { url, index } of urls) {
    const before = text.slice(Math.max(0, index - 60), index);
    if (!SKIP_KEYWORDS_BEFORE.test(before)) return url;
  }

  // Pass 3: last URL (receipt link usually comes after privacy link)
  return urls[urls.length - 1].url;
}

async function extractUrlFromText(text: string): Promise<string | null> {
  const url = extractBestUrl(text);
  if (url) return url;

  // LLM fallback
  const prompt = `הטקסט הבא מכיל קישור לחשבונית דיגיטלית. חלץ את ה-URL של החשבונית בלבד (לא קישורי מדיניות פרטיות).
אם אין URL לחשבונית, החזר null.
טקסט: ${text.slice(0, 600)}
החזר JSON בלבד: {"url":"..."} או {"url":null}`;

  const res = await fetch(AI_CONFIG.llmUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_CONFIG.llmModel, prompt, stream: false, format: "json",
      options: { temperature: 0, num_predict: 100 },
    }),
  });
  if (!res.ok) return null;
  try {
    const data = await res.json();
    return JSON.parse(data.response ?? "{}")?.url ?? null;
  } catch { return null; }
}

// ── HTML → text ───────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "").replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<\/?(td|th)[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&rlm;/g, "").replace(/&lrm;/g, "")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Auto-categorize ───────────────────────────────────────────────────────────

function autoCategorize(storeName: string, categories: string[]): string {
  const n = storeName.toLowerCase();
  if (/סופר.פארם|superpharm|pharma/i.test(n))
    return categories.find(c => /בריאות|רפואי/i.test(c)) ?? categories[0] ?? "אחר";
  if (/carrefour|קרפור|רמי|שופרסל|ויקטורי|מגה|סופר/i.test(n))
    return categories.find(c => /מזון|אוכל|קניות|grocery/i.test(c)) ?? categories[0] ?? "אחר";
  return categories[0] ?? "אחר";
}

// ── Convert ReceiptData → response ────────────────────────────────────────────

function receiptToResponse(receipt: ReceiptData, categories: string[]) {
  return {
    amount: receipt.total,
    date: receipt.date,
    type: autoCategorize(receipt.storeName, categories),
    description: receipt.storeName,
    items: receipt.items,
    storeAddress: receipt.storeAddress,
    provider: receipt.provider,
  };
}

// ── MODE A: File parsing ──────────────────────────────────────────────────────

async function parseFile(file: File, categories: string[]) {
  if (file.type === "application/pdf") {
    const pdfBuffer = Buffer.from(await file.arrayBuffer());
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse/lib/pdf-parse.js");
    const pdfData = await pdfParse(pdfBuffer);
    let rawText: string = pdfData.text ?? "";
    if (isTextRtlReversed(rawText)) rawText = fixRtlReversedText(rawText);

    if (isPdfTextUsable(rawText)) {
      const t0 = Date.now();
      const prompt = buildParsePrompt(rawText, categories);
      const { result, ms: llmMs } = await parseInvoiceWithLlm(prompt);
      return { data: { ...result, items: [] }, timings: { ocr: 0, llm: llmMs, total: Date.now() - t0 }, source: "pdf-text" };
    }

    const imageBlob = await pdfPageToImageBlob(pdfBuffer);
    if (imageBlob) {
      const imageFile = new File([imageBlob], "pdf_page.jpg", { type: "image/jpeg" });
      const { parsedInvoice, timings } = await runParsingPipeline(imageFile, categories);
      return { data: { ...parsedInvoice, items: [] }, timings, source: "pdf-ocr" };
    }
    throw new Error("לא ניתן לחלץ טקסט מה-PDF");
  }

  const { parsedInvoice, timings } = await runParsingPipeline(file, categories);
  return { data: { ...parsedInvoice, items: [] }, timings, source: "ocr" };
}

// ── MODE B: SMS / text → URL → receipt ───────────────────────────────────────

async function parseSmsText(text: string, categories: string[]) {
  const t0 = Date.now();

  // 1. Extract receipt URL (smart — skips privacy/terms links)
  const url = await extractUrlFromText(text);
  if (!url) throw new Error("לא נמצא קישור חשבונית בטקסט");

  // 2. Known provider → direct API
  const provider = detectProvider(url);
  if (provider) {
    try {
      const receipt = await fetchReceiptByUrl(url);
      const data = receiptToResponse(receipt, categories);
      return { data, url, timings: { ocr: 0, llm: 0, total: Date.now() - t0 }, source: provider };
    } catch (err) {
      console.warn(`[internal/parse] ${provider} API failed, trying HTML:`, err);
    }
  }

  // 3. Generic HTML fallback
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let pageText: string;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        "Accept-Language": "he-IL,he;q=0.9",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pageText = htmlToText(await res.text());
  } finally {
    clearTimeout(timer);
  }

  if (!pageText || pageText.length < 50) {
    throw new Error("הדף ריק — ייתכן שהקישור פג תוקף או שהאתר דורש JavaScript");
  }

  const prompt = buildParsePrompt(pageText, categories);
  const { result, ms: llmMs } = await parseInvoiceWithLlm(prompt);
  return {
    data: { ...result, items: [] as ReceiptData["items"] },
    url,
    timings: { ocr: 0, llm: llmMs, total: Date.now() - t0 },
    source: "html-llm",
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const categories = [...DEFAULT_CATEGORIES];
  const contentType = req.headers.get("content-type") ?? "";

  try {
    // ── Mode B: JSON body with "text" field ──
    if (contentType.includes("application/json")) {
      const body = await req.json().catch(() => null);
      const text: string = body?.text?.trim() ?? "";
      if (!text) return NextResponse.json({ error: "שדה 'text' חסר" }, { status: 400 });

      const result = await parseSmsText(text, categories);
      return NextResponse.json({ success: true, ...result });
    }

    // ── Mode A: multipart file upload ──
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file and no text provided" }, { status: 400 });

    const result = await parseFile(file, categories);
    return NextResponse.json({ success: true, ...result });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[internal/parse]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
