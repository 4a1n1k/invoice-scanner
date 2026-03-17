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
/**
 * Extracts the business name from the FIRST few lines of the OCR text.
 *
 * Strategy (in order of priority):
 * 1. Line containing "בע\"מ" / "בע'מ" / "Ltd" / "LLC" — classic Israeli business name
 * 2. Line containing "שם העסק:" / "עסק:" / "מסעדה:" / "חנות:" prefix
 * 3. Very first non-empty line (receipts almost always start with business name)
 * 4. Second line if first is mostly numbers/symbols
 *
 * We look only at the first 8 lines to avoid false-positives from middle of receipt.
 */
export function extractBusinessName(ocrText: string): string {
  const lines = ocrText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 1); // remove empty / single-char lines

  const top = lines.slice(0, 8); // only look at the top of the receipt

  // Priority 1: line with בע"מ / Ltd / בע'מ — the official business name
  const companyLine = top.find(l =>
    /בע[""']מ|בע"מ|בעמ|ltd\.?|llc\.?|inc\.?/i.test(l)
  );
  if (companyLine) {
    // Clean up: remove noise like phone numbers, addresses
    return companyLine.replace(/\d{2,}-\d{4,}/g, "").trim();
  }

  // Priority 2: explicit label prefix
  const labelLine = top.find(l =>
    /^(שם העסק|עסק|מסעדה|חנות|סניף|name)\s*[:\-]/i.test(l)
  );
  if (labelLine) {
    return labelLine.replace(/^[^:\-]+[:\-]\s*/, "").trim();
  }

  // Priority 3: first line that is mostly Hebrew/Latin text (not numbers/symbols)
  const textLine = top.find(l => {
    const hebrewOrLatin = l.replace(/[^א-תa-z\s]/gi, "").trim();
    return hebrewOrLatin.length >= 3 && hebrewOrLatin.length >= l.length * 0.4;
  });
  if (textLine) return textLine.trim();

  // Priority 4: just the first non-empty line
  return top[0] ?? "לא ידוע";
}

// ─── LLM Prompt ──────────────────────────────────────────────────────────────

export function buildParsePrompt(rawOcrText: string, categories: string[]): string {
  const ocrText = preprocessOcrText(rawOcrText);
  const truncated = ocrText.substring(0, AI_CONFIG.llmMaxChars);
  const today = new Date().toISOString().split("T")[0];

  // Pre-extract business name server-side and inject it into the prompt.
  // This anchors the model to the correct business before it reads the full text,
  // preventing false matches like reading "CLUB" and thinking "קופת חולים".
  const businessName = extractBusinessName(ocrText);

  // Build category list — user's actual DB categories + keyword hints
  // so the model understands the *intent* without inventing new ones
  const categoryGuide = categories
    .map(name => {
      const hint = getCategoryHint(name);
      return hint ? `  • "${name}" (${hint})` : `  • "${name}"`;
    })
    .join("\n");

  return `אתה מומחה לחילוץ נתונים מחשבוניות ישראליות. חלץ מידע מובנה מטקסט OCR של חשבונית/קבלה.
הטקסט עשוי להיות בעברית, אנגלית, או שילוב. יתכנו שגיאות OCR.

━━━ שם העסק (זוהה מראש) ━━━
שם העסק בחשבונית זו הוא: "${businessName}"
השתמש במידע זה לקביעת הקטגוריה והתיאור. אל תחפש שם עסק אחר.

━━━ חוקי חילוץ ━━━

1. AMOUNT — הסכום הכולל לתשלום (מספר בלבד, ללא פסיקים, ללא סמל מטבע):
   • חפש: סה"כ, סה"כ לתשלום, לתשלום, סכום, Total, Grand Total, Amount Due
   • "1,769.94" → 1769.94 | "310.50" → 310.50
   • החזר מספר בלבד, לדוגמה: 310.5

2. DATE — תאריך החשבונית (YYYY-MM-DD):
   • פורמטים: DD/MM/YYYY, DD.MM.YYYY, YYYY-MM-DD
   • המר: 15/03/2026 → 2026-03-15
   • ברירת מחדל: ${today}

3. TYPE — בחר בדיוק אחת מהקטגוריות הבאות בהתאם לשם העסק "${businessName}" ולפריטים:
${categoryGuide}
   • התאם לפי: שם העסק + הפריטים שנרכשו
   • אם שם העסק הוא חנות מכולת/סופרמרקט → קטגוריית מזון
   • אם שם העסק הוא רופא/בית מרקחת/קופת חולים → קטגוריית בריאות
   • אל תמציא קטגוריה שאינה ברשימה

4. DESCRIPTION — תיאור קצר בעברית (3-6 מילים):
   • פורמט: "[שם עסק] — [תיאור מה נרכש]"
   • דוגמאות: "מזדו בכפר 23 — קניות מכולת" | "סופר-פארם — תרופות" | "חברת החשמל — חשבון חודשי"
   • אם הפריטים לא ברורים: "[שם עסק] — קנייה"

━━━ פלט ━━━
JSON בלבד, ללא הסברים, ללא markdown:
{"amount": <number>, "date": "<YYYY-MM-DD>", "type": "<category>", "description": "<description>"}

━━━ טקסט החשבונית ━━━
${truncated}`;
}

/**
 * Returns a SHORT keyword hint for a category name.
 * Used to help the model understand intent — NOT to give examples from real receipts
 * (which caused false-positives like "CLUB" → "קופת חולים").
 */
function getCategoryHint(categoryName: string): string | null {
  const n = categoryName.toLowerCase();
  if (/מזון|אוכל|מכולת|סופר|קניות|food|grocery/.test(n))
    return "סופרמרקט, מכולת, מסעדה, קפה";
  if (/ביגוד|בגדים|הנעלה|נעל|אופנה|clothes|fashion/.test(n))
    return "חנות בגדים, נעליים, אופנה";
  if (/בריאות|רפואי|רפואה|רופא|תרופ|קופת|מרפאה|health|medical|pharma/.test(n))
    return "רופא, בית מרקחת, קופת חולים, אופטיקה";
  if (/חוג|חינוך|לימוד|קורס|בית ספר|גן|שיעור|class|edu/.test(n))
    return "גן, חוג, שיעורים, קורס";
  if (/חשמל|מים|גז|ארנונה|ועד|תשתית|utility|electric|water/.test(n))
    return "חברת חשמל, בזק, מים, ארנונה";
  if (/תחבורה|נסיעה|רכב|דלק|חניה|transport|car|fuel/.test(n))
    return "דלק, חניה, נסיעות";
  if (/ספורט|כושר|gym|sport|fitness/.test(n))
    return "מכון כושר, ציוד ספורט";
  return null;
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
    if (!jsonMatch) throw new Error(`LLM returned no JSON. Raw: ${rawText.slice(0, 200)}`);
    let result: ParsedInvoice = JSON.parse(jsonMatch[0]);
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
