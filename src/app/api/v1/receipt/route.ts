/**
 * POST /api/v1/receipt
 *
 * Universal receipt parsing endpoint — accepts URL, SMS text, or file upload.
 * Designed for integration with external services (n8n, Zapier, home-manager, etc.)
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * Requires Bearer token in Authorization header:
 *   Authorization: Bearer <API_KEY>
 *
 * The API_KEY is set via the API_KEY env variable on the server.
 * Falls back to session-based auth (cookie) for browser clients.
 *
 * ── Input modes (mutually exclusive, in priority order) ────────────────────
 *
 *  1. URL / SMS text  → application/json
 *     { "text": "...SMS or URL string..." }
 *     { "text": "...", "overrideUrl": "https://..." }   ← force specific URL
 *
 *  2. File upload     → multipart/form-data
 *     file=<PDF or image blob>
 *     userId=<optional, for server-to-server without session>
 *
 * ── Response (success 200) ──────────────────────────────────────────────────
 * {
 *   "ok": true,
 *   "source": "weezmo" | "pairzon" | "ksp" | "ocr" | "url-llm",
 *   "url": "https://...",          // detected URL (if input was text/URL)
 *   "allUrls": ["..."],            // all URLs found in the text
 *   "invoice": {
 *     "amount": 148.90,            // number, ₪
 *     "date": "2026-03-25",        // ISO date string
 *     "description": "סופרפארם",   // store / merchant name
 *     "type": "בריאות",            // expense category
 *     "items": [                   // line items (may be empty)
 *       { "name": "...", "price": 12.5, "quantity": 1 }
 *     ],
 *     "storeAddress": "...",       // optional
 *     "provider": "weezmo"         // optional raw provider hint
 *   },
 *   "timings": { "ocr": 0, "llm": 450, "total": 612 }  // ms
 * }
 *
 * ── Response (error 4xx/5xx) ────────────────────────────────────────────────
 * {
 *   "ok": false,
 *   "error": "human-readable message",
 *   "code": "NO_URL" | "INVALID_URL" | "PROVIDER_ERROR" | "OCR_FAILED" |
 *           "PARSE_FAILED" | "BAD_INPUT" | "UNAUTHORIZED",
 *   "allUrls": ["..."],            // URLs found (even on failure)
 *   "suggestion": "..."            // optional user-facing hint
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES } from "@/lib/config";
import { runParsingPipeline } from "@/lib/parse-service";
import { parseTextWithGemini } from "@/lib/gemini-service";
import {
  detectProvider,
  fetchReceiptByUrl,
  type ReceiptData,
} from "@/lib/receipt-providers";

export const maxDuration = 60;

// ── Types ─────────────────────────────────────────────────────────────────────

type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_INPUT"
  | "NO_URL"
  | "INVALID_URL"
  | "PROVIDER_ERROR"
  | "SPA_PAGE"
  | "OCR_FAILED"
  | "PARSE_FAILED";

interface SuccessResponse {
  ok: true;
  source: string;
  url?: string;
  allUrls?: string[];
  invoice: InvoiceResult;
  timings: { ocr: number; llm: number; total: number };
}

interface ErrorResponse {
  ok: false;
  error: string;
  code: ErrorCode;
  allUrls?: string[];
  suggestion?: string;
}

interface InvoiceResult {
  amount: number;
  date: string;
  description: string;
  type: string;
  items: {
    barcode?: string;
    name: string;
    quantity: number;
    unitPrice: number;
    total: number;
    discount?: number;
    finalPrice: number;
  }[];
  vat?: number;
  paymentMethod?: string;
  storeAddress?: string;
  provider?: string;
}

// ── Auth helper ───────────────────────────────────────────────────────────────

async function resolveUserId(req: NextRequest): Promise<string | null> {
  // 1. Bearer token (server-to-server)
  const apiKey = process.env.API_KEY;
  const authHeader = req.headers.get("authorization") ?? "";
  if (apiKey && authHeader === `Bearer ${apiKey}`) {
    // When using API key, caller may pass userId in header or body
    const headerUserId = req.headers.get("x-user-id");
    if (headerUserId) return headerUserId;
    // Fall through to find first user in DB as default
    const firstUser = await prisma.user.findFirst({ select: { id: true } });
    return firstUser?.id ?? null;
  }

  // 2. Session cookie (browser)
  const session = await auth();
  return session?.user?.id ?? null;
}

// ── URL extraction ────────────────────────────────────────────────────────────

const RECEIPT_PATH_HINT = /\/r\/|\/receipt|\/notification|\/doc|\/cms/i;
const PRIVACY_PATH_HINT = /\/l\/|\/privacy|\/terms|\/policy|\/legal/i;
const RECEIPT_KEYWORDS_BEFORE = /לצפ|לצפיה|לצפייה|חשבונ|receipt|invoice|view/i;
const SKIP_KEYWORDS_BEFORE = /פרטי[וו]?ת|privacy|תקנון|terms|policy|legal|הסכם|תנאי|ביטול|cancel/i;

function extractAllUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s\u200B\u200C\u200D\uFEFF"'<>]+/g)]
    .map(m => m[0].replace(/[.,;!?)\]]+$/, ""));
}

function pickBestUrl(text: string): { url: string | null; all: string[] } {
  const all = extractAllUrls(text);
  if (all.length === 0) return { url: null, all };
  if (all.length === 1) return { url: all[0], all };

  const indexed = [...text.matchAll(/https?:\/\/[^\s\u200B\u200C\u200D\uFEFF"'<>]+/g)]
    .map(m => ({ url: m[0].replace(/[.,;!?)\]]+$/, ""), index: m.index ?? 0 }));

  // Pass 0 — URL path hints
  for (const { url } of indexed)
    if (RECEIPT_PATH_HINT.test(url) && !PRIVACY_PATH_HINT.test(url))
      return { url, all };

  // Pass 1 — keyword before URL
  for (const { url, index } of indexed) {
    const before = text.slice(Math.max(0, index - 40), index);
    if (RECEIPT_KEYWORDS_BEFORE.test(before) && !SKIP_KEYWORDS_BEFORE.test(before))
      return { url, all };
  }

  // Pass 2 — no privacy keyword before
  for (const { url, index } of indexed) {
    const before = text.slice(Math.max(0, index - 60), index);
    if (!SKIP_KEYWORDS_BEFORE.test(before))
      return { url, all };
  }

  // Pass 3 — last URL
  return { url: all[all.length - 1], all };
}

// ── HTML fetch ────────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<\/?(td|th)[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function fetchPageText(url: string): Promise<{ text: string; isSpa: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if ((res.headers.get("content-type") ?? "").includes("pdf"))
      throw new Error("PDF_LINK");
    const html = await res.text();
    const text = htmlToText(html);
    return { text, isSpa: html.length > 500 && text.length < 100 };
  } finally {
    clearTimeout(t);
  }
}

// ── receiptData → InvoiceResult ───────────────────────────────────────────────

function toInvoice(receipt: ReceiptData, categories: string[]): InvoiceResult {
  const name = receipt.storeName.toLowerCase();
  let type = categories[0] ?? "אחר";
  if (/סופר.פארם|superpharm|pharma/i.test(name))
    type = categories.find(c => /בריאות|רפואי/i.test(c)) ?? type;
  else if (/carrefour|קרפור|רמי|שופרסל|מגה|סופר/i.test(name))
    type = categories.find(c => /מזון|אוכל|קניות/i.test(c)) ?? type;

  // Normalize ReceiptItem → InvoiceResult items
  const items = receipt.items.map(item => ({
    name: item.name,
    quantity: item.quantity ?? 1,
    unitPrice: item.price ?? 0,
    total: (item.price ?? 0) * (item.quantity ?? 1),
    finalPrice: (item.price ?? 0) * (item.quantity ?? 1),
  }));

  return {
    amount: receipt.total,
    date: receipt.date,
    description: receipt.storeName,
    type,
    items,
    storeAddress: receipt.storeAddress,
    provider: receipt.provider,
  };
}

// ── Error helper ──────────────────────────────────────────────────────────────

function err(
  status: number,
  code: ErrorCode,
  error: string,
  extra: Partial<ErrorResponse> = {}
): NextResponse<ErrorResponse> {
  return NextResponse.json({ ok: false, error, code, ...extra }, { status });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const userId = await resolveUserId(req);
  if (!userId) return err(401, "UNAUTHORIZED", "Authentication required. Pass Bearer token or login cookie.");

  // ── Fetch user categories ─────────────────────────────────────────────────
  // Priority: categories passed in body > categories from DB > DEFAULT_CATEGORIES
  const userCategories = await prisma.category.findMany({
    where: { userId }, select: { name: true }, orderBy: { name: "asc" },
  });
  const dbCategories = userCategories.length > 0
    ? userCategories.map(c => c.name)
    : [...DEFAULT_CATEGORIES];

  const contentType = req.headers.get("content-type") ?? "";
  const t0 = Date.now();

  // ══════════════════════════════════════════════════════════════════════════
  // MODE A — multipart/form-data → OCR pipeline (image / PDF)
  // ══════════════════════════════════════════════════════════════════════════
  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try { formData = await req.formData(); }
    catch { return err(400, "BAD_INPUT", "Could not parse multipart form data."); }

    const file = formData.get("file") as File | null;
    if (!file || file.size === 0)
      return err(400, "BAD_INPUT", "No file provided. Send a PDF or image as 'file' field.");

    // Accept caller-supplied categories (e.g. from home-manager expense_categories)
    const bodyCatsRaw = formData.get("categories");
    const categories: string[] = bodyCatsRaw
      ? JSON.parse(String(bodyCatsRaw))
      : dbCategories;

    try {
      let parsedInvoice: Record<string, unknown>;
      let ocrText = "";
      let timings = { ocr: 0, llm: 0, total: 0 };

      if (file.type === "application/pdf") {
        // PDF path — extract text first, then Gemini
        const pdfBuffer = Buffer.from(await file.arrayBuffer());
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdfParse = require("pdf-parse/lib/pdf-parse.js");
        const pdfData = await pdfParse(pdfBuffer);
        const rawText = pdfData.text ?? "";

        if (rawText.length > 100) {
          const { parseTextWithGemini } = await import("@/lib/gemini-service");
          const t1 = Date.now();
          const { result, ms } = await parseTextWithGemini(rawText, categories);
          parsedInvoice = result as unknown as Record<string, unknown>;
          ocrText = rawText;
          timings = { ocr: 0, llm: ms, total: Date.now() - t1 };
        } else {
          return err(422, "OCR_FAILED", "Could not extract text from PDF. Try uploading as JPG/PNG.");
        }
      } else {
        // Image path — Gemini Vision
        const pipeline = await runParsingPipeline(file, categories);
        parsedInvoice = pipeline.parsedInvoice as unknown as Record<string, unknown>;
        ocrText = pipeline.ocrText;
        timings = pipeline.timings;
      }

      const inv = parsedInvoice as unknown as import("@/lib/types").ParsedInvoice;
      return NextResponse.json({
        ok: true,
        source: "gemini",
        invoice: {
          amount: inv.amount || 0,
          date: inv.date || new Date().toISOString().split("T")[0],
          description: inv.description || "",
          type: inv.type || categories[0] || "אחר",
          items: inv.items || [],
          vat: inv.vat,
          paymentMethod: inv.paymentMethod,
          storeAddress: inv.storeAddress,
        },
        timings: { ...timings, total: Date.now() - t0 },
      } satisfies SuccessResponse);

    } catch (e) {
      return err(500, "OCR_FAILED", e instanceof Error ? e.message : "OCR pipeline failed.");
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODE B — application/json → URL / SMS text
  // ══════════════════════════════════════════════════════════════════════════
  let body: { text?: string; overrideUrl?: string; categories?: string[] };
  try { body = await req.json(); }
  catch { return err(400, "BAD_INPUT", "Invalid JSON body."); }

  // Accept caller-supplied categories
  const categories: string[] = (Array.isArray(body?.categories) && body.categories.length > 0)
    ? body.categories
    : dbCategories;

  const rawText = (body?.text ?? "").trim();
  if (!rawText) return err(400, "BAD_INPUT", "Body must contain a 'text' field with URL or SMS message.");

  // Extract URL
  let url: string | null;
  let allUrls: string[] = [];

  if (body.overrideUrl?.trim()) {
    url = body.overrideUrl.trim();
    allUrls = extractAllUrls(rawText);
  } else {
    const picked = pickBestUrl(rawText);
    url = picked.url;
    allUrls = picked.all;
  }

  if (!url) return err(422, "NO_URL", "No invoice URL found in text.", { allUrls });

  // Validate URL
  try { new URL(url); } catch {
    return err(422, "INVALID_URL", `Invalid URL: ${url}`, { allUrls });
  }

  // ── Known provider → direct API ───────────────────────────────────────────
  const provider = detectProvider(url);
  if (provider) {
    try {
      const receipt = await fetchReceiptByUrl(url);
      const invoice = toInvoice(receipt, categories);
      return NextResponse.json({
        ok: true, source: provider, url, allUrls, invoice,
        timings: { ocr: 0, llm: 0, total: Date.now() - t0 },
      } satisfies SuccessResponse);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Provider API failed.";
      // Don't give up — fall through to HTML scrape
      console.warn(`[v1/receipt] ${provider} direct API failed: ${msg} — trying HTML fallback`);
    }
  }

  // ── Generic HTML fallback → LLM ───────────────────────────────────────────
  let pageText: string;
  let isSpa = !!provider;
  try {
    const result = await fetchPageText(url);
    pageText = result.text;
    isSpa = isSpa || result.isSpa;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to fetch URL";
    if (msg === "PDF_LINK")
      return err(422, "INVALID_URL", "URL points to a PDF. Upload the file directly instead.", { allUrls });
    return err(422, "INVALID_URL", msg, { allUrls });
  }

  if (isSpa || pageText.length < 50) {
    const platformName = provider ? provider.toUpperCase() : "האתר";
    return err(422, "SPA_PAGE",
      `${platformName} page cannot be read directly (SPA / JavaScript-rendered).`,
      { allUrls, suggestion: "Take a screenshot of the receipt and upload it via the scan tab." }
    );
  }

  // LLM parse via Gemini
  try {
    const { result: parsedInvoice, ms: llmMs } = await parseTextWithGemini(pageText, categories);
    return NextResponse.json({
      ok: true, source: "url-gemini", url, allUrls,
      invoice: {
        amount: parsedInvoice.amount,
        date: parsedInvoice.date,
        description: parsedInvoice.description,
        type: parsedInvoice.type,
        items: parsedInvoice.items,
        vat: parsedInvoice.vat,
        paymentMethod: parsedInvoice.paymentMethod,
        storeAddress: parsedInvoice.storeAddress,
      },
      timings: { ocr: 0, llm: llmMs, total: Date.now() - t0 },
    } satisfies SuccessResponse);
  } catch (e) {
    return err(500, "PARSE_FAILED", e instanceof Error ? e.message : "LLM parse failed.", { allUrls });
  }
}
