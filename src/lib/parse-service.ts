/**
 * Invoice parsing service.
 * OCR → text cleaning → LLM pipeline.
 */

import { AI_CONFIG } from "./config";
import type { ParsedInvoice } from "./types";

// ─── Image pre-processing ─────────────────────────────────────────────────────
/**
 * Normalizes a mobile photo before OCR:
 * 1. Auto-rotates based on EXIF orientation (fixes upside-down/sideways phone photos)
 * 2. Limits max dimension to 2400px
 * 3. Converts to JPEG
 */
async function normalizeImageForOcr(file: File): Promise<{ blob: Blob; filename: string }> {
  const normalizedName = file.name.replace(/\.[^.]+$/, "") + "_normalized.jpg";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require("sharp");
    const inputBuffer = Buffer.from(await file.arrayBuffer());

    const outputBuffer: Buffer = await sharp(inputBuffer)
      .rotate()          // auto-rotate from EXIF — fixes sideways/upside-down mobile photos
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Copy into a plain ArrayBuffer to avoid SharedArrayBuffer TS type issues
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

// ─── LLM Prompt ──────────────────────────────────────────────────────────────

/**
 * Builds a rich prompt for invoice parsing.
 *
 * Key design decisions:
 * - Step 1: Extract business name FIRST (before categorizing) — forces the model
 *   to ground itself in the actual invoice content before guessing a category.
 * - Categories come from the DB (user-defined) with examples so the model understands
 *   the *intent* behind each category, not just the Hebrew label.
 * - Two-pass description: business name + what was bought = useful, searchable description.
 * - Explicit Israeli context: Israeli chains, Hebrew/English mixed receipts.
 */
export function buildParsePrompt(rawOcrText: string, categories: string[]): string {
  const ocrText = preprocessOcrText(rawOcrText);
  const truncated = ocrText.substring(0, AI_CONFIG.llmMaxChars);
  const today = new Date().toISOString().split("T")[0];

  // Build a rich category list with matching hints
  // This is the KEY improvement — the model sees the actual category names from the DB
  // plus examples of what belongs there, so it can fuzzy-match even unusual names
  const categoryGuide = categories
    .map((name) => {
      const examples = getCategoryExamples(name);
      return examples
        ? `  • "${name}" — לדוגמה: ${examples}`
        : `  • "${name}"`;
    })
    .join("\n");

  return `אתה מומחה לחילוץ נתונים מחשבוניות ישראליות. משימתך: לחלץ מידע מובנה מטקסט OCR של חשבונית או קבלה.
הטקסט עשוי להיות בעברית, אנגלית, או שילוב. יתכנו שגיאות OCR.

━━━ שלב 1: זיהוי העסק ━━━
לפני הכל — מצא את שם העסק/המקום בחשבונית.
חפש: שם בראש הקבלה, לוגו, "שם העסק:", כתובת עם שם.
דוגמאות לעסקים ישראליים: שופרסל, רמי לוי, מגה, ויקטורי, AM:PM, סופר-פארם, NEW PHARM,
קופת חולים, מאוחדת, כללית, מכבי, שלמה סיקסט, YES, HOT, חברת החשמל, בזק,
מזדו בכפר, בורגר קינג, מקדונלד'ס, אלקטרה, שאגה, נייס, H&M, ZARA, רנואר.
אם לא מזהה שם ברור — כתוב "לא ידוע".

━━━ שלב 2: חילוץ נתונים ━━━

1. AMOUNT (מספר בלבד, ללא פסיקים, ללא סמל מטבע):
   • חפש: סה"כ, סה"כ לתשלום, לתשלום, סכום, Total, Grand Total, Amount Due
   • חשוב מאוד: "1,769.94" → 1769.94 (הסר את הפסיק, שמור נקודה עשרונית)
   • אם יש מע"מ נפרד — הסכום הסופי כבר כולל אותו
   • החזר מספר בלבד: 310.50 ולא "₪310.50" ולא "310,50"

2. DATE (פורמט YYYY-MM-DD):
   • חפש: תאריך, Date, שולם ב, דפוס: DD/MM/YYYY או DD.MM.YYYY
   • המר: 15/03/2026 → 2026-03-15
   • ברירת מחדל אם לא נמצא: ${today}

3. TYPE (חובה — בחר בדיוק אחת מהקטגוריות הבאות):
${categoryGuide}
   • התאם לפי שם העסק שמצאת בשלב 1 + תוכן הקבלה
   • אם לא ברור — בחר את הקרובה ביותר מהרשימה
   • אסור להמציא קטגוריה חדשה שאינה ברשימה

4. DESCRIPTION (עברית, 3-6 מילים):
   • פורמט מועדף: "[שם העסק] — [מה נרכש]"
   • דוגמאות טובות: "שופרסל — קניות שבועיות", "קופת חולים — ביקור רופא", "חברת החשמל — חשבון פברואר"
   • אם שם העסק לא ידוע: תאר רק את מה שנרכש, למשל: "ביגוד לילדים", "תרופות מבית מרקחת"

━━━ פלט ━━━
החזר JSON בלבד — ללא הסברים, ללא markdown, ללא טקסט נוסף:
{"amount": <number>, "date": "<YYYY-MM-DD>", "type": "<category>", "description": "<description>"}

━━━ טקסט החשבונית ━━━
${truncated}`;
}

/**
 * Returns matching examples for known category name patterns.
 * Works with ANY category name — tries to match by keywords in the name.
 * If no match found, returns null (category shown without examples).
 */
function getCategoryExamples(categoryName: string): string | null {
  const name = categoryName.toLowerCase();

  if (/מזון|אוכל|מכולת|סופר|קניות|food|grocery/.test(name)) {
    return "שופרסל, רמי לוי, מגה, ויקטורי, AM:PM, מסעדה, קפה, מאפייה";
  }
  if (/ביגוד|בגדים|הנעלה|נעל|אופנה|clothes|fashion/.test(name)) {
    return "H&M, ZARA, נייס, רנואר, קסטרו, FOX, נעליים, ביגוד ילדים";
  }
  if (/בריאות|רפואי|רפואה|רופא|תרופ|קופת|מרפאה|health|medical|pharma/.test(name)) {
    return "קופת חולים, מאוחדת, כללית, מכבי, סופר-פארם, NEW PHARM, שב\"ן, ביקור רופא";
  }
  if (/חוג|חינוך|לימוד|קורס|כיתה|בית ספר|גן|שיעור|class|edu/.test(name)) {
    return "גן ילדים, חוג ספורט, שיעורי מוזיקה, בית ספר, קורס אמנות";
  }
  if (/חשמל|מים|גז|ארנונה|ועד|תשתית|ספק|utility|electric|water/.test(name)) {
    return "חברת חשמל, מקורות, בזק, HOT, YES, ועד בית, ארנונה";
  }
  if (/תחבורה|נסיעה|רכב|דלק|חניה|taxi|transport|car|fuel/.test(name)) {
    return "דלק, פז, סונול, חניה, רב-קו, מונית, אוטובוס";
  }
  if (/ספורט|כושר|gym|sport|fitness/.test(name)) {
    return "מכון כושר, ציוד ספורט, מנוי ספורט";
  }
  if (/אחר|other|כללי|misc/.test(name)) {
    return "כל מה שלא משתייך לקטגוריה אחרת";
  }

  return null; // Unknown category — show as-is without examples
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

    // Sanitize amount if returned as string
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
