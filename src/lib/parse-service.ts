/**
 * Invoice parsing service.
 * OCR → text cleaning → LLM pipeline.
 */

import { AI_CONFIG } from "./config";
import type { ParsedInvoice } from "./types";

// ─── Image pre-processing ─────────────────────────────────────────────────────
async function normalizeImageForOcr(file: File): Promise<{ blob: Blob; filename: string }> {
  const normalizedName = file.name.replace(/\.[^.]+$/, "") + "_normalized.jpg";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require("sharp");
    const inputBuffer = Buffer.from(await file.arrayBuffer());
    const outputBuffer: Buffer = await sharp(inputBuffer)
      .rotate()
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const plainArrayBuffer = outputBuffer.buffer.slice(
      outputBuffer.byteOffset,
      outputBuffer.byteOffset + outputBuffer.byteLength
    );
    return {
      blob: new Blob([plainArrayBuffer as ArrayBuffer], { type: "image/jpeg" }),
      filename: normalizedName,
    };
  } catch {
    console.warn("[OCR] sharp preprocessing failed, using original file");
    return { blob: file, filename: file.name };
  }
}

// ─── OCR ─────────────────────────────────────────────────────────────────────

export async function extractTextViaOcr(file: File): Promise<string> {
  const { blob, filename } = await normalizeImageForOcr(file);
  const formData = new FormData();
  formData.append("image", blob, filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CONFIG.timeoutMs);
  try {
    const res = await fetch(AI_CONFIG.ocrUrl, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OCR service returned ${res.status}: ${detail}`);
    }
    const data = await res.json();
    const text: string = data.text ?? data.result ?? JSON.stringify(data);
    if (!text?.trim()) throw new Error("OCR service returned empty text");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Text pre-processing ──────────────────────────────────────────────────────

export function preprocessOcrText(raw: string): string {
  let text = raw;
  // Remove thousands-separator commas: 1,769.94 → 1769.94
  text = text.replace(/(\d),(\d{3})(?=[.\s,\n]|$)/g, "$1$2");
  text = text.replace(/([\u20aa$])\s*(\d+),(\d{3})/g, "$1$2$3");
  // Normalize dot dates: 26.02.2026 → 26/02/2026
  text = text.replace(/\b(\d{1,2})\.(\d{2})\.(\d{4})\b/g, "$1/$2/$3");
  return text;
}

// ─── Business name extraction (server-side, before LLM) ──────────────────────
/**
 * Extracts business name from the FIRST few lines of OCR text.
 * Priority: בע"מ line → label prefix → first meaningful text line
 */
export function extractBusinessName(ocrText: string): string {
  const lines = ocrText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 1);

  const top = lines.slice(0, 8);

  const companyLine = top.find(l => /בע[""']מ|בע"מ|בעמ|ltd\.?|llc\.?|inc\.?/i.test(l));
  if (companyLine) return companyLine.replace(/\d{2,}-\d{4,}/g, "").trim();

  const labelLine = top.find(l => /^(שם העסק|עסק|מסעדה|חנות|סניף|name)\s*[:\-]/i.test(l));
  if (labelLine) return labelLine.replace(/^[^:\-]+[:\-]\s*/, "").trim();

  const textLine = top.find(l => {
    const hebrewOrLatin = l.replace(/[^א-תa-z\s]/gi, "").trim();
    return hebrewOrLatin.length >= 3 && hebrewOrLatin.length >= l.length * 0.4;
  });
  if (textLine) return textLine.trim();

  return top[0] ?? "לא ידוע";
}

// ─── LLM Prompt ──────────────────────────────────────────────────────────────
/**
 * Optimized prompt — ~350 tokens instead of ~800.
 *
 * Key optimizations:
 * 1. Business name pre-extracted server-side → no chain-of-thought needed in model
 * 2. OCR text truncated to 1500 chars (enough for any receipt)
 * 3. Category list compact — one line per category with short hint
 * 4. Single-sentence rules instead of bullet lists
 * 5. Explicit num_predict limit passed via LLM payload to cap output tokens
 */
export function buildParsePrompt(rawOcrText: string, categories: string[]): string {
  const ocrText = preprocessOcrText(rawOcrText);

  // Truncate to 1500 chars — receipts are short, extra text just costs tokens
  const truncated = ocrText.substring(0, 1500);
  const today = new Date().toISOString().split("T")[0];

  // Pre-extract business name to anchor the model
  const businessName = extractBusinessName(ocrText);

  // Compact category list: "מזון (סופרמרקט, מסעדה)" — one line each
  const catLines = categories
    .map(name => `"${name}"${getCategoryHint(name) ? ` (${getCategoryHint(name)})` : ""}`)
    .join(" | ");

  return `חלץ נתונים מחשבונית ישראלית. שם העסק: "${businessName}". תאריך ברירת מחדל: ${today}.

קטגוריות: ${catLines}

חוקים:
- amount: סה"כ לתשלום כמספר בלבד (ללא פסיקים, ללא ₪). "310,50"→310.50
- date: DD/MM/YYYY→YYYY-MM-DD. אחרת: ${today}
- type: בחר בדיוק אחת מהקטגוריות לפי שם העסק והפריטים
- description: "[שם עסק] — [מה נרכש]" בעברית, 3-5 מילים

החזר JSON בלבד:
{"amount":<number>,"date":"<YYYY-MM-DD>","type":"<category>","description":"<text>"}

טקסט:
${truncated}`;
}

function getCategoryHint(categoryName: string): string | null {
  const n = categoryName.toLowerCase();
  if (/מזון|אוכל|מכולת|סופר|קניות|food|grocery/.test(n)) return "סופרמרקט, מסעדה";
  if (/ביגוד|בגדים|הנעלה|נעל|אופנה|clothes|fashion/.test(n)) return "בגדים, נעליים";
  if (/בריאות|רפואי|רופא|תרופ|קופת|מרפאה|health|medical|pharma/.test(n)) return "רופא, בית מרקחת";
  if (/חוג|חינוך|לימוד|קורס|גן|שיעור|class|edu/.test(n)) return "גן, חוג, קורס";
  if (/חשמל|מים|גז|ארנונה|utility|electric|water/.test(n)) return "חברת חשמל, בזק, מים";
  if (/תחבורה|רכב|דלק|חניה|transport|car|fuel/.test(n)) return "דלק, חניה, נסיעה";
  if (/ספורט|כושר|gym|sport/.test(n)) return "מכון כושר, ציוד ספורט";
  return null;
}

// ─── LLM call ─────────────────────────────────────────────────────────────────

interface LlmPayload {
  model: string;
  prompt: string;
  stream: false;
  format: "json";
  options: {
    temperature: number;
    num_predict: number;
  };
}

export async function parseInvoiceWithLlm(
  prompt: string
): Promise<{ result: ParsedInvoice; payload: LlmPayload }> {
  const payload: LlmPayload = {
    model: AI_CONFIG.llmModel,
    prompt,
    stream: false,
    format: "json",
    options: {
      temperature: 0,    // deterministic — no creative guessing
      num_predict: 120,  // JSON output is ~80-100 tokens, cap at 120
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CONFIG.timeoutMs);
  try {
    const res = await fetch(AI_CONFIG.llmUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LLM service returned ${res.status}: ${detail}`);
    }
    const llmData = await res.json();
    const rawText: string = llmData.response?.trim() ?? "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`LLM returned no JSON. Raw: ${rawText.slice(0, 200)}`);
    let result: ParsedInvoice = JSON.parse(jsonMatch[0]);

    // Sanitize amount
    if (typeof result.amount === "string") {
      result = { ...result, amount: parseFloat((result.amount as string).replace(/,/g, "")) };
    }
    if (!result.amount || isNaN(result.amount)) {
      const m = rawText.match(/"amount"\s*:\s*"?([\d,]+\.?\d*)/) ??
                prompt.match(/סה"כ[^\d]*([\d,]+\.?\d*)/);
      if (m) result.amount = parseFloat(m[1].replace(/,/g, ""));
    }

    return { result, payload };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Full pipeline ────────────────────────────────────────────────────────────

export interface PipelineResult {
  parsedInvoice: ParsedInvoice;
  ocrText: string;
  prompt: string;
  llmPayload: LlmPayload;
}

export async function runParsingPipeline(file: File, categories: string[]): Promise<PipelineResult> {
  const ocrText = await extractTextViaOcr(file);
  const prompt = buildParsePrompt(ocrText, categories);
  const { result: parsedInvoice, payload: llmPayload } = await parseInvoiceWithLlm(prompt);
  return { parsedInvoice, ocrText, prompt, llmPayload };
}
