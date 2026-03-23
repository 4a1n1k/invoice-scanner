/**
 * POST /api/parse-url
 *
 * Accepts free-text (SMS message, email, etc.)
 * 1. Uses LLM to extract a URL from the text
 * 2. Fetches the URL server-side (no CORS / proxy issues)
 * 3. Strips HTML → plain text
 * 4. Uses LLM to parse invoice fields
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AI_CONFIG, DEFAULT_CATEGORIES } from "@/lib/config";
import { buildParsePrompt, parseInvoiceWithLlm } from "@/lib/parse-service";

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

// ── Extract URL from free text ────────────────────────────────────────────────

async function extractUrlFromText(text: string): Promise<string | null> {
  // Fast path: regex (handles 99% of cases — SMS links are plain text)
  const urlMatch = text.match(/https?:\/\/[^\s\u200B\u200C\u200D\uFEFF"'<>]+/);
  if (urlMatch) return urlMatch[0].replace(/[.,;!?)\]]+$/, "");

  // Slow path: LLM extraction (for obfuscated/wrapped text)
  const prompt = `הטקסט הבא מכיל קישור לחשבונית. חלץ את ה-URL המלא בלבד.
אם אין URL, החזר null.

טקסט: ${text.slice(0, 500)}

החזר JSON בלבד: {"url":"..."} או {"url":null}`;

  const res = await fetch(AI_CONFIG.llmUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_CONFIG.llmModel,
      prompt,
      stream: false,
      format: "json",
      options: { temperature: 0, num_predict: 100 },
    }),
  });

  if (!res.ok) return null;
  try {
    const data = await res.json();
    const parsed = JSON.parse(data.response ?? "{}");
    return parsed.url ?? null;
  } catch {
    return null;
  }
}

// ── Fetch URL ─────────────────────────────────────────────────────────────────

async function fetchReceiptPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`שגיאת HTTP ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("pdf")) {
      throw new Error("הקישור מוביל ל-PDF. העלה אותו ישירות דרך סריקה.");
    }

    const html = await res.text();
    const text = htmlToText(html);

    if (text.length < 50) {
      throw new Error("הדף ריק — ייתכן שהקישור פג תוקף.");
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
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

  // 1. Find URL
  const url = await extractUrlFromText(rawText);
  if (!url)
    return NextResponse.json(
      { error: "לא נמצא קישור בטקסט. ודא שהדבקת את המסרון המלא." },
      { status: 422 }
    );

  // 2. Fetch page
  let pageText: string;
  try {
    pageText = await fetchReceiptPage(url);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "שגיאה בטעינת הקישור" },
      { status: 422 }
    );
  }

  // 3. Parse
  const userCategories = await prisma.category.findMany({
    where: { userId: session.user.id },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  const categories =
    userCategories.length > 0
      ? userCategories.map((c) => c.name)
      : [...DEFAULT_CATEGORIES];

  const t0 = Date.now();
  const prompt = buildParsePrompt(pageText, categories);
  const { result: parsedInvoice, payload: llmPayload, ms: llmMs } =
    await parseInvoiceWithLlm(prompt);

  return NextResponse.json({
    data: parsedInvoice,
    url,
    timings: { ocr: 0, llm: llmMs, total: Date.now() - t0 },
    debug: {
      url,
      prompt,
      llmPayload: llmPayload as unknown as Record<string, unknown>,
      ocrResponse: pageText.slice(0, 500) + "…",
    },
  });
}
