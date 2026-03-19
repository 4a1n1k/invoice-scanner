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
  text = text.replace(/(\d),(\d{3})(?=[.\s,\n]|$)/g, "$1$2");
  text = text.replace(/([\u20aa$])\s*(\d+),(\d{3})/g, "$1$2$3");
  text = text.replace(/\b(\d{1,2})\.(\d{2})\.(\d{4})\b/g, "$1/$2/$3");
  return text;
}

// ─── Business name extraction ─────────────────────────────────────────────────

export function extractBusinessName(ocrText: string): string {
  const lines = ocrText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 1);

  const top = lines.slice(0, 8);

  // Priority 1: line with בע"מ / Ltd
  const companyLine = top.find(l => /בע[""']מ|בע"מ|בעמ|ltd\.?|llc\.?|inc\.?/i.test(l));
  if (companyLine) return companyLine.replace(/\d{2,}-\d{4,}/g, "").trim();

  // Priority 2: explicit label prefix
  const labelLine = top.find(l => /^(שם העסק|עסק|מסעדה|חנות|סניף|name)\s*[:\-]/i.test(l));
  if (labelLine) return labelLine.replace(/^[^:\-]+[:\-]\s*/, "").trim();

  // Priority 3: first line with enough Hebrew/Latin text
  const textLine = top.find(l => {
    const hebrewOrLatin = l.replace(/[^א-תa-z\s]/gi, "").trim();
    return hebrewOrLatin.length >= 3 && hebrewOrLatin.length >= l.length * 0.4;
  });
  if (textLine) return textLine.trim();

  // Priority 4: try to extract from domain/email at the end (e.g. pairzon.com → Pairzon)
  const domainLine = lines.slice(-5).find(l => /www\.|\.co\.il|\.com/i.test(l));
  if (domainLine) {
    const match = domainLine.match(/(?:www\.)?([a-z0-9\-]+)(?:\.co\.il|\.com)/i);
    if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1);
  }

  return top[0] ?? "לא ידוע";
}

// ─── LLM Prompt ──────────────────────────────────────────────────────────────

export function buildParsePrompt(rawOcrText: string, categories: string[]): string {
  const ocrText = preprocessOcrText(rawOcrText);
  const truncated = ocrText.substring(0, 1500);
  const today = new Date().toISOString().split("T")[0];
  const businessName = extractBusinessName(ocrText);

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

// ─── JSON repair ──────────────────────────────────────────────────────────────
/**
 * Tries to extract a valid ParsedInvoice from potentially truncated LLM output.
 *
 * Handles two cases:
 * 1. Complete JSON: {"amount":308.12,"date":"2026-03-13","type":"מזון","description":"Hermitage"}
 * 2. Truncated JSON (num_predict cut it short): {"amount":308.12,"date":"2026-03-13","type":"תשתיות","description":"א.ח הרמיטאז
 *    → we close the open string + object and parse field by field
 */
function repairAndParseJson(raw: string): ParsedInvoice | null {
  // First try: standard full JSON
  const fullMatch = raw.match(/\{[\s\S]*\}/);
  if (fullMatch) {
    try {
      return JSON.parse(fullMatch[0]);
    } catch {
      // fall through to repair
    }
  }

  // Second try: the JSON was truncated — close open string/object and try again
  let partial = raw;
  // Find the opening brace
  const start = partial.indexOf("{");
  if (start === -1) return null;
  partial = partial.slice(start);

  // Close any unclosed string
  const quoteCount = (partial.match(/(?<!\\)"/g) ?? []).length;
  if (quoteCount % 2 !== 0) partial += '"';

  // Close the object
  if (!partial.trimEnd().endsWith("}")) partial += "}";

  try {
    const obj = JSON.parse(partial);
    // Validate it has at least amount or date
    if (obj.amount !== undefined || obj.date !== undefined) return obj;
  } catch {
    // fall through to field-by-field extraction
  }

  // Third try: extract fields with regex fallback
  const amount = raw.match(/"amount"\s*:\s*([\d.]+)/)?.[1];
  const date = raw.match(/"date"\s*:\s*"([^"]+)"/)?.[1];
  const type = raw.match(/"type"\s*:\s*"([^"]+)"/)?.[1];
  const description = raw.match(/"description"\s*:\s*"([^"]+)"/)?.[1];

  if (amount || date) {
    return {
      amount: parseFloat(amount ?? "0"),
      date: date ?? new Date().toISOString().split("T")[0],
      type: type ?? "",
      description: description ?? "",
    };
  }

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
      temperature: 0,
      num_predict: 200, // raised from 120 → prevents truncation of Hebrew descriptions
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

    // Use repairAndParseJson instead of simple regex — handles truncated output
    let result = repairAndParseJson(rawText);
    if (!result) {
      throw new Error(`LLM returned no parseable JSON. Raw: ${rawText.slice(0, 200)}`);
    }

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
