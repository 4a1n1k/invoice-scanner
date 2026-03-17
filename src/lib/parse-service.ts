/**
 * Invoice parsing service.
 *
 * Encapsulates the full OCR → LLM pipeline so route handlers stay thin.
 * All external URLs come from `lib/config.ts` — never hardcoded here.
 */

import { AI_CONFIG } from "./config";
import type { ParsedInvoice } from "./types";

// ─── OCR ─────────────────────────────────────────────────────────────────────

export async function extractTextViaOcr(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("image", file);

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

// ─── LLM Prompt ──────────────────────────────────────────────────────────────

/**
 * Builds a rich, robust prompt for invoice parsing.
 *
 * Improvements over the previous version:
 * - Explicit instructions for mobile/photo invoice quality (blurry, angled)
 * - Hebrew-aware: instructs model to handle both Hebrew and English text
 * - Explicit amount extraction rules (look for סה"כ / סכום / total / grand total)
 * - Date extraction rules (DD/MM/YYYY, YYYY-MM-DD, Hebrew month names)
 * - Category matching: fuzzy match against the user's list, never invent new ones
 * - Fallback rules for each field if extraction fails
 * - Output format is strict JSON, no markdown, no extra text
 */
export function buildParsePrompt(ocrText: string, categories: string[]): string {
  const truncated = ocrText.substring(0, AI_CONFIG.llmMaxChars);
  const catList = categories.map((c) => `"${c}"`).join(", ");
  const today = new Date().toISOString().split("T")[0];

  return `You are an expert invoice data extraction assistant. Your task is to extract structured data from OCR text of an invoice or receipt. The text may come from a mobile phone photo and could contain OCR errors, mixed Hebrew and English, or partial text.

EXTRACTION RULES:

1. AMOUNT (number):
   - Find the TOTAL amount paid. Look for: סה"כ, סכום לתשלום, לתשלום, סה"כ לשלם, Total, Grand Total, Amount Due, לתשלום סופי
   - If multiple totals exist, pick the LARGEST final total (after tax/VAT)
   - Strip currency symbols (₪, NIS, ILS, $) and return only the number
   - If VAT (מע"מ) is listed separately, include it in the total
   - Fallback: if no clear total, sum up all line items
   - Return as a decimal number (e.g., 150.50)

2. DATE (string YYYY-MM-DD):
   - Find the invoice/receipt date. Look for: תאריך, Date, Invoice Date, Receipt Date
   - Support formats: DD/MM/YYYY, DD.MM.YYYY, YYYY-MM-DD, D בחודש YYYY
   - Hebrew months: ינואר=01, פברואר=02, מרץ=03, אפריל=04, מאי=05, יוני=06, יולי=07, אוגוסט=08, ספטמבר=09, אוקטובר=10, נובמבר=11, דצמבר=12
   - Always output as YYYY-MM-DD
   - Fallback: use today's date: ${today}

3. TYPE (string — must be one of the allowed categories):
   Allowed categories: [${catList}]
   - Analyze the invoice content and business name to determine the best matching category
   - Examples of matching:
     * Pharmacy (בית מרקחת), doctor (רופא), medical (רפואי), dental (שיניים), optician (אופטיקה) → pick the health/medical category
     * Supermarket (סופרמרקט), restaurant (מסעדה), food (מזון), groceries → pick the food category
     * Clothing store (חנות בגדים), shoes (נעליים), fashion → pick the clothing category
     * After-school activity, music class, sports club, tuition (שכר לימוד), kindergarten (גן) → pick the classes/education category
   - If no category fits well, pick the closest one from the allowed list
   - NEVER invent a category not in the list

4. DESCRIPTION (string):
   - Write a short 3-6 word description in Hebrew describing what was purchased
   - Be specific: "נעליים לילד", "ביקור רופא ילדים", "חוג כדורגל", "קניות מכולת"
   - Use the business name and items purchased to create the description
   - Keep it concise and meaningful

OUTPUT FORMAT:
Return ONLY a valid JSON object. No markdown, no explanation, no extra text.
{
  "amount": <number>,
  "date": "<YYYY-MM-DD>",
  "type": "<one of the allowed categories>",
  "description": "<short Hebrew description>"
}

INVOICE TEXT:
${truncated}`;
}

/** Raw payload sent to the Ollama-compatible LLM API */
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

    // Strip markdown fences if present
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`LLM response contained no JSON object. Raw: ${rawText.slice(0, 200)}`);
    }

    const result: ParsedInvoice = JSON.parse(jsonMatch[0]);
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
