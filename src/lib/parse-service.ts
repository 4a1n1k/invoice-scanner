/**
 * Invoice parsing service.
 * OCR → text cleaning → LLM pipeline.
 */

import { AI_CONFIG } from "./config";
import type { ParsedInvoice } from "./types";

// ─── Image pre-processing ─────────────────────────────────────────────────────
/**
 * Normalizes a mobile photo before OCR:
 * 1. Auto-rotates based on EXIF orientation (fixes upside-down/sideways photos)
 * 2. Converts to JPEG if needed (some formats confuse OCR servers)
 * 3. Limits max dimension to 2400px (reduces upload time without losing quality)
 *
 * Returns a new Blob ready to send as "image" to the OCR endpoint.
 */
async function normalizeImageForOcr(file: File): Promise<Blob> {
  try {
    // sharp is available server-side only — lazy import to avoid edge-runtime issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require("sharp");
    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    const outputBuffer: Buffer = await sharp(inputBuffer)
      .rotate()                          // auto-rotate from EXIF — critical for mobile photos
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    return new Blob([outputBuffer], { type: "image/jpeg" });
  } catch {
    // If sharp fails (e.g., unsupported format), fall back to the original file
    console.warn("[OCR] sharp preprocessing failed, using original file");
    return file;
  }
}

// ─── OCR ─────────────────────────────────────────────────────────────────────

export async function extractTextViaOcr(file: File): Promise<string> {
  // Normalize image (fix EXIF rotation from mobile cameras)
  const processedBlob = await normalizeImageForOcr(file);

  const formData = new FormData();
  // Use processed blob with a safe filename
  const fileName = file.name.replace(/\.[^.]+$/, "") + "_normalized.jpg";
  formData.append("image", processedBlob, fileName);

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

    if (!text?.trim()) {
      throw new Error("OCR service returned empty text");
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Text pre-processing ──────────────────────────────────────────────────────
/**
 * Cleans raw OCR/PDF text before sending to the LLM.
 */
export function preprocessOcrText(raw: string): string {
  let text = raw;

  // Remove thousands-separator commas inside numbers: 1,769.94 → 1769.94
  text = text.replace(/(\d),(\d{3})(?=[.\s,\n]|$)/g, "$1$2");

  // Also handle: ₪1,769 or NIS 1,769
  text = text.replace(/([\u20aa$])\s*(\d+),(\d{3})/g, "$1$2$3");

  // Normalize dot-separated dates: 26.02.2026 → 26/02/2026
  text = text.replace(/\b(\d{1,2})\.(\d{2})\.(\d{4})\b/g, "$1/$2/$3");

  return text;
}

// ─── LLM Prompt ──────────────────────────────────────────────────────────────

export function buildParsePrompt(rawOcrText: string, categories: string[]): string {
  const ocrText = preprocessOcrText(rawOcrText);
  const truncated = ocrText.substring(0, AI_CONFIG.llmMaxChars);
  const catList = categories.map((c) => `"${c}"`).join(", ");
  const today = new Date().toISOString().split("T")[0];

  return `You are an expert invoice data extraction assistant. Extract structured data from the invoice text below. The text may be in Hebrew or English.

EXTRACTION RULES:

1. AMOUNT (number, NO commas, NO currency symbols):
   - Find the TOTAL amount paid. Look for: סה"כ, סה"כ לתשלום, לתשלום, Total, Grand Total, Amount Due
   - CRITICAL: Numbers may appear as "1769.94" or "1,769.94" — strip ALL commas, return only digits and decimal point
   - Return as plain number: 1769.94 (NOT "1,769.94", NOT "₪1769")
   - If VAT (מע"מ) is listed separately, the total already includes it
   - If you see "1769.94" anywhere near סה"כ or Total, that IS the amount

2. DATE (YYYY-MM-DD):
   - Look for: תאריך, Date, שולם ב
   - Formats you may see: DD/MM/YYYY, DD.MM.YYYY, YYYY-MM-DD
   - Convert DD/MM/YYYY → YYYY-MM-DD (example: 26/02/2026 → 2026-02-26)
   - Fallback: today = ${today}

3. TYPE — must be exactly one of: [${catList}]
   - Match by content: electricity/חשמל/חברת חשמל → utility/בריאות/אחר
   - Supermarket/מכולת → food category
   - Never invent a new category

4. DESCRIPTION (Hebrew, 3-6 words):
   - Describe what was paid, e.g.: "חשבון חשמל פברואר", "קניות סופרמרקט", "נעליים לילד"

OUTPUT — return ONLY this JSON, no other text:
{"amount": <number>, "date": "<YYYY-MM-DD>", "type": "<category>", "description": "<hebrew description>"}

INVOICE TEXT:
${truncated}`;
}

// ─── LLM call ─────────────────────────────────────────────────────────────────

interface LlmPayload {
  model: string;
  prompt: string;
  stream: false;
  format: "json";
}

export async function parseInvoiceWithLlm(
  prompt: string
): Promise<{ result: ParsedInvoice; payload: LlmPayload }> {
  const payload: LlmPayload = {
    model: AI_CONFIG.llmModel,
    prompt,
    stream: false,
    format: "json",
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
    if (!jsonMatch) {
      throw new Error(`LLM returned no JSON. Raw: ${rawText.slice(0, 200)}`);
    }

    let result: ParsedInvoice = JSON.parse(jsonMatch[0]);

    // Post-process: sanitize amount if LLM returned it as string
    if (typeof result.amount === "string") {
      result = { ...result, amount: parseFloat((result.amount as string).replace(/,/g, "")) };
    }
    if (!result.amount || isNaN(result.amount)) {
      const amountMatch = rawText.match(/"amount"\s*:\s*"?([\d,]+\.?\d*)/) ??
                          prompt.match(/סה"כ[^\d]*([\d,]+\.?\d*)/);
      if (amountMatch) {
        result.amount = parseFloat(amountMatch[1].replace(/,/g, ""));
      }
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

export async function runParsingPipeline(
  file: File,
  categories: string[]
): Promise<PipelineResult> {
  const ocrText = await extractTextViaOcr(file);
  const prompt = buildParsePrompt(ocrText, categories);
  const { result: parsedInvoice, payload: llmPayload } = await parseInvoiceWithLlm(prompt);

  return { parsedInvoice, ocrText, prompt, llmPayload };
}
