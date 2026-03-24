/**
 * POST /api/parse-url
 *
 * Accepts free-text (SMS / WhatsApp) and extracts invoice data.
 *
 * Strategy (priority order):
 *   1. Detect known provider (Weezmo / Pairzon) → direct JSON API (fastest, 100% accurate)
 *   2. Unknown URL → fetch HTML → strip tags → LLM parse (fallback)
 *   3. SPA / empty page → return helpful error with suggestion
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AI_CONFIG, DEFAULT_CATEGORIES } from "@/lib/config";
import { buildParsePrompt, parseInvoiceWithLlm } from "@/lib/parse-service";
import {
  detectProvider,
  fetchReceiptByUrl,
  type ReceiptData,
} from "@/lib/receipt-providers";

export const maxDuration = 60;

// ── HTML → plain text ─────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<\/?(td|th)[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rlm;/g, "")
    .replace(/&lrm;/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Smart URL extraction ──────────────────────────────────────────────────────
//
// SMS messages often contain multiple URLs:
//   - Privacy policy / terms (to skip)
//   - The actual receipt link (to use)
//
// Strategy:
//   1. Prefer URL that appears after receipt-related keywords (לצפייה, חשבונית, קבלה...)
//   2. Fall back to first URL NOT preceded by privacy/legal keywords
//   3. Last resort: any URL in text
//   4. If still none: ask LLM

const RECEIPT_KEYWORDS_BEFORE =
  /לצפ|לצפיה|לצפייה|חשבונ|קבל[הת]|receipt|invoice|view|לפרט|פרטי.?הקנ/i;

const SKIP_KEYWORDS_BEFORE =
  /פרטי[ו]?ת|privacy|תקנון|terms|policy|legal|הסכם|תנאי|ביטול|cancel/i;

function extractBestUrl(text: string): string | null {
  // Collect all URLs with their positions
  const matches = [...text.matchAll(/https?:\/\/[^\s\u200B\u200C\u200D\uFEFF"'<>]+/g)];
  if (matches.length === 0) return null;

  const urls = matches.map(m => ({
    url: m[0].replace(/[.,;!?)\]]+$/, ""),
    index: m.index ?? 0,
  }));

  if (urls.length === 1) return urls[0].url;

  // Pass 1: URL immediately following a receipt keyword (within 40 chars)
  for (const { url, index } of urls) {
    const before = text.slice(Math.max(0, index - 40), index);
    if (RECEIPT_KEYWORDS_BEFORE.test(before)) return url;
  }

  // Pass 2: URL NOT preceded by a skip keyword (within 60 chars)
  for (const { url, index } of urls) {
    const before = text.slice(Math.max(0, index - 60), index);
    if (!SKIP_KEYWORDS_BEFORE.test(before)) return url;
  }

  // Pass 3: last URL in text (usually the receipt link comes after privacy link)
  return urls[urls.length - 1].url;
}

async function extractUrlFromText(text: string): Promise<string | null> {
  // Fast path: smart regex extraction
  const url = extractBestUrl(text);
  if (url) return url;

  // LLM fallback (for very unusual formats)
  const prompt = `הטקסט הבא מכיל קישור לחשבונית דיגיטלית. חלץ את ה-URL של החשבונית בלבד (לא קישורי מדיניות פרטיות או תקנון).
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
    const parsed = JSON.parse(data.response ?? "{}");
    return parsed.url ?? null;
  } catch { return null; }
}

// ── Fetch generic HTML page ───────────────────────────────────────────────────

async function fetchReceiptPage(url: string): Promise<{ text: string; isSpa: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`שגיאת HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("pdf")) throw new Error("הקישור מוביל ל-PDF. העלה אותו דרך סריקה.");
    const html = await res.text();
    const text = htmlToText(html);
    const isSpa = html.length > 500 && text.length < 100;
    return { text, isSpa };
  } finally {
    clearTimeout(timer);
  }
}

// ── Convert ReceiptData to invoice fields ─────────────────────────────────────

function receiptDataToInvoice(receipt: ReceiptData, categories: string[]) {
  const name = receipt.storeName.toLowerCase();
  let type = categories[0] ?? "אחר";
  if (/סופר.פארם|superpharm|pharmacy|farmacia|pharma/i.test(name)) {
    type = categories.find(c => /בריאות|רפואי|pharma/i.test(c)) ?? type;
  } else if (/carrefour|קרפור|supermarket|סופר|רמי|שופרסל|ויקטורי|מגה/i.test(name)) {
    type = categories.find(c => /מזון|אוכל|מכולת|קניות|food|grocery/i.test(c)) ?? type;
  }

  return {
    amount: receipt.total,
    date: receipt.date,
    type,
    description: receipt.storeName,
    items: receipt.items,
    storeAddress: receipt.storeAddress,
    provider: receipt.provider,
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const rawText: string = body?.text?.trim() ?? "";
  if (!rawText)
    return NextResponse.json({ error: "לא התקבל טקסט" }, { status: 400 });

  // 1. Extract URL (smart — prefers receipt link over privacy links)
  const url = await extractUrlFromText(rawText);
  if (!url)
    return NextResponse.json(
      { error: "לא נמצא קישור חשבונית בטקסט. ודא שהדבקת את המסרון המלא." },
      { status: 422 }
    );

  // 2. Get user categories
  const userCategories = await prisma.category.findMany({
    where: { userId: session.user.id },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  const categories = userCategories.length > 0
    ? userCategories.map(c => c.name)
    : [...DEFAULT_CATEGORIES];

  const t0 = Date.now();

  // 3. Known provider → direct API
  const provider = detectProvider(url);
  if (provider) {
    try {
      const receipt = await fetchReceiptByUrl(url);
      const invoiceData = receiptDataToInvoice(receipt, categories);
      return NextResponse.json({
        data: invoiceData,
        url,
        provider,
        timings: { ocr: 0, llm: 0, total: Date.now() - t0 },
        debug: { url, rawJson: receipt.rawJson },
      });
    } catch (err) {
      console.warn(`[parse-url] ${provider} API failed, falling back to HTML:`, err);
    }
  }

  // 4. Generic HTML fallback
  let pageText: string;
  let isSpa = !!provider;
  try {
    const result = await fetchReceiptPage(url);
    pageText = result.text;
    isSpa = isSpa || result.isSpa;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "שגיאה בטעינת הקישור" },
      { status: 422 }
    );
  }

  // 5. SPA detected → friendly error
  if (isSpa || pageText.length < 50) {
    const platformName = provider === "weezmo" ? "Weezmo" : provider === "pairzon" ? "Pairzon" : "האתר";
    return NextResponse.json({
      error: `הקישור מ-${platformName} לא ניתן לקריאה ישירה.`,
      isSpa: true,
      url,
      suggestion: `צלם סקרינשוט של החשבונית ועלה אותו דרך טאב "סריקה".`,
    }, { status: 422 });
  }

  // 6. LLM parse from HTML text
  const prompt = buildParsePrompt(pageText, categories);
  const { result: parsedInvoice, ms: llmMs } = await parseInvoiceWithLlm(prompt);

  return NextResponse.json({
    data: parsedInvoice,
    url,
    timings: { ocr: 0, llm: llmMs, total: Date.now() - t0 },
    debug: { url, prompt, ocrResponse: pageText.slice(0, 500) + "…" },
  });
}
