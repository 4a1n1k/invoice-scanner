/**
 * Invoice parsing service.
 * OCR → text cleaning → LLM pipeline.
 */

import { AI_CONFIG } from "./config";
import type { ParsedInvoice } from "./types";

// ─── Image pre-processing ─────────────────────────────────────────────────────

/**
 * Detects if image is rotated 180° by looking at pixel density:
 * Receipts start with a header (dense text/logo at top).
 * If top strip is lighter than bottom, image is likely upside down.
 */
async function detectUpsideDown(sharpInstance: ReturnType<typeof import("sharp")>): Promise<boolean> {
  try {
    // Sample top and bottom 10% of image — compare brightness
    const { data, info } = await sharpInstance
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    const strip = Math.floor(h * 0.12); // 12% top/bottom

    let topSum = 0, bottomSum = 0;
    for (let y = 0; y < strip; y++) {
      for (let x = 0; x < w; x++) {
        topSum += data[y * w + x];
        bottomSum += data[(h - 1 - y) * w + x];
      }
    }
    const topBrightness = topSum / (strip * w);
    const bottomBrightness = bottomSum / (strip * w);

    // If bottom is significantly darker than top → header is at bottom → upside down.
    // Threshold calibration (0-255 brightness scale):
    //   - Real upside-down (Shufersol flipped): top≈170, bottom≈86  → diff≈84 ✅
    //   - False positive  (Mirzav correct):     top≈232, bottom≈174 → diff≈58 ❌
    // Using threshold of 70: catches real flips (≥70) but ignores normal contrast (≤60).
    const isUpsideDown = (topBrightness - bottomBrightness) > 70;
    if (isUpsideDown) {
      console.log(`[OCR] detected upside-down: top=${topBrightness.toFixed(1)} bottom=${bottomBrightness.toFixed(1)}`);
    }
    return isUpsideDown;
  } catch {
    return false;
  }
}

async function normalizeImageForOcr(file: File): Promise<{ blob: Blob; filename: string }> {
  // No preprocessing — send original file directly to OCR service.
  // The OCR service already applies grayscale + sharpen internally.
  // All preprocessing attempts caused regressions.
  console.log(`[OCR] sending original: ${file.name}, ${Math.round(file.size / 1024)}KB`);
  return { blob: file, filename: file.name };
}

// ─── OCR ─────────────────────────────────────────────────────────────────────

// ── Hebrew ratio check ────────────────────────────────────────────────────────
// Returns the fraction of Hebrew characters in the text (0–1).
function hebrewRatio(text: string): number {
  const total = text.replace(/\s/g, "").length;
  if (total === 0) return 0;
  const heb = (text.match(/[\u05d0-\u05ea]/g) ?? []).length;
  return heb / total;
}

// ── Single OCR call ────────────────────────────────────────────────────────────
async function ocrCall(blob: Blob, filename: string, signal: AbortSignal): Promise<string> {
  const formData = new FormData();
  formData.append("image", blob, filename);
  const res = await fetch(AI_CONFIG.ocrUrl, { method: "POST", body: formData, signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OCR service returned ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const text: string = data.text ?? data.result ?? JSON.stringify(data);
  if (!text?.trim()) throw new Error("OCR service returned empty text");
  return text;
}

export async function extractTextViaOcr(file: File): Promise<{ text: string; ms: number }> {
  const { blob, filename } = await normalizeImageForOcr(file);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CONFIG.timeoutMs);
  const t0 = Date.now();
  try {
    const text = await ocrCall(blob, filename, controller.signal);
    const ratio = hebrewRatio(text);
    console.log(`[OCR] hebrew ratio: ${(ratio * 100).toFixed(0)}%`);

    // If Hebrew ratio is very low, the image may be upside-down despite preprocessing.
    // Try again with explicit 180° rotation and pick whichever has more Hebrew.
    if (ratio < 0.15 && text.length > 30) {
      console.log("[OCR] low Hebrew ratio — retrying with forced 180° rotation");
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sharp = require("sharp");
        const inputBuffer = Buffer.from(await file.arrayBuffer());
        const rotBuf: Buffer = await sharp(inputBuffer)
          .rotate()        // EXIF first
          .rotate(180)     // then force flip
          .sharpen({ sigma: 1.2 })
          .normalize()
          .jpeg({ quality: 92 })
          .toBuffer();
        const rotBlob = new Blob(
          [rotBuf.buffer.slice(rotBuf.byteOffset, rotBuf.byteOffset + rotBuf.byteLength) as ArrayBuffer],
          { type: "image/jpeg" }
        );
        const text180 = await ocrCall(rotBlob, filename, controller.signal);
        const ratio180 = hebrewRatio(text180);
        console.log(`[OCR] 180° retry hebrew ratio: ${(ratio180 * 100).toFixed(0)}%`);
        if (ratio180 > ratio) {
          console.log("[OCR] 180° version has more Hebrew — using it");
          return { text: text180, ms: Date.now() - t0 };
        }
      } catch (retryErr) {
        console.warn("[OCR] 180° retry failed:", retryErr);
      }
    }

    return { text, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// ─── OCR quality gate ─────────────────────────────────────────────────────────
// Checks if OCR output is usable before sending to LLM.
// Returns a quality score 0-100 and a list of warnings.

export interface OcrQuality {
  score: number;          // 0 (gibberish) → 100 (clean)
  usable: boolean;        // score >= 40
  warnings: string[];
}

export function assessOcrQuality(text: string): OcrQuality {
  const warnings: string[] = [];

  if (!text || text.trim().length === 0) {
    return { score: 0, usable: false, warnings: ["OCR returned empty text"] };
  }

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const chars = text.replace(/\s/g, "");
  const totalChars = chars.length;

  if (totalChars < 20) {
    return { score: 5, usable: false, warnings: [`Very short OCR output: ${totalChars} chars`] };
  }

  let score = 100;

  // ── Check 1: gibberish ratio (non-printable / replacement chars) ──────────
  const gibberishChars = (text.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  const gibberishRatio = gibberishChars / totalChars;
  if (gibberishRatio > 0.05) {
    score -= 40;
    warnings.push(`High gibberish ratio: ${(gibberishRatio * 100).toFixed(0)}%`);
  }

  // ── Check 2: Hebrew/Latin/digit ratio (receipt must have some real text) ──
  const hebrewChars = (chars.match(/[\u05d0-\u05ea]/g) ?? []).length;
  const latinChars  = (chars.match(/[a-zA-Z]/g) ?? []).length;
  const digitChars  = (chars.match(/\d/g) ?? []).length;
  const meaningfulRatio = (hebrewChars + latinChars + digitChars) / totalChars;

  if (meaningfulRatio < 0.3) {
    score -= 35;
    warnings.push(`Low meaningful content: ${(meaningfulRatio * 100).toFixed(0)}% (heb+lat+dig)`);
  }

  // ── Check 3: must have at least one number (every receipt has prices) ─────
  if (digitChars < 3) {
    score -= 25;
    warnings.push("Almost no digits — likely OCR failure");
  }

  // ── Check 4: line structure — receipts have multiple lines ───────────────
  if (lines.length < 3) {
    score -= 15;
    warnings.push(`Very few lines: ${lines.length}`);
  }

  // ── Check 5: PUA chars (garbled custom fonts) ────────────────────────────
  const puaChars = (text.match(/[\uE000-\uF8FF]/g) ?? []).length;
  const puaRatio  = puaChars / totalChars;
  if (puaRatio > 0.1) {
    score -= 30;
    warnings.push(`High PUA ratio: ${(puaRatio * 100).toFixed(0)}% — garbled font`);
  }

  score = Math.max(0, Math.min(100, score));
  const usable = score >= 40;

  if (!usable) {
    warnings.push(`OCR quality too low (score=${score}) — result may be inaccurate`);
  }

  return { score, usable, warnings };
}

/**
 * Detects RTL character-mirroring in OCR output.
 * Happens with some receipt printers (e.g. MAX) where Tesseract reads
 * each line char-by-char in reverse. Hebrew words appear reversed.
 *
 * "לתשלום" reversed char-by-char → "מולשתל"
 * "חשבונית" reversed → "תינובשח"
 */
function isMirroredOcrText(text: string): boolean {
  const MIRRORED_MARKERS = [
    "מולשתל",  // לתשלום reversed
    "תינובשח", // חשבונית reversed
    "ךירואת",  // תאריך reversed
    "יראת",    // partial
  ];
  const sample = text.slice(0, 600);
  return MIRRORED_MARKERS.some(m => sample.includes(m));
}

/**
 * Reverses each line char-by-char to fix RTL-mirrored OCR output.
 * Numbers are re-reversed within each line to preserve digit order.
 */
function fixMirroredOcrText(text: string): string {
  return text
    .split("\n")
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      const rev = trimmed.split("").reverse().join("");
      // Numbers got reversed too — fix digit sequences back
      return rev.replace(/\d[\d.:,/\-]*\d|\d/g, m => m.split("").reverse().join(""));
    })
    .join("\n");
}

export function preprocessOcrText(raw: string): string {
  let text = raw;

  // Fix RTL character-mirroring (e.g. MAX receipts)
  if (isMirroredOcrText(text)) {
    console.log("[OCR] detected RTL-mirrored text — applying char-level reversal");
    text = fixMirroredOcrText(text);
  }

  // Israeli decimal comma fixes
  text = text.replace(/(\d),(\d{3})(?=\.\d|\D|$)/g, "$1$2");
  text = text.replace(/(\d),(\d{2})(?!\d)/g, "$1.$2");
  // Date normalization
  text = text.replace(/\b(\d{1,2})\.(\d{2})\.(\d{4})\b/g, "$1/$2/$3");
  return text;
}

// ─── Business name extraction ─────────────────────────────────────────────────

const NOISE_PATTERNS = [
  /מסמך ממוחשב/, /מסמך זה הינו/, /page \d+ of \d+/i,
  /weezmo/i, /info@weezmo/i, /חתימה אלקטרונית/,
  /הוראות ניהול ספרים/, /verified by/i,
  // Watermark patterns — large branding overlaid on receipt
  /^רמי\s*לוי$/i, /^שופרסל$/i, /^סופר.פארם$/i, /^מקס\s*סטוק$/i,
  /^carrefour$/i, /^victory$/i,
];

export function extractBusinessName(ocrText: string): string {
  const lines = ocrText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 1)
    .filter(l => !NOISE_PATTERNS.some(p => p.test(l)));

  const top = lines.slice(0, 10);

  const companyLine = top.find(l => /בע[""']מ|בע"מ|בעמ|ltd\.?|llc\.?|inc\.?/i.test(l));
  if (companyLine) return companyLine.replace(/\d{2,}-\d{4,}/g, "").trim();

  const labelLine = top.find(l => /^(שם העסק|עסק|מסעדה|חנות|סניף|name)\s*[:\-]/i.test(l));
  if (labelLine) return labelLine.replace(/^[^:\-]+[:\-]\s*/, "").trim();

  const textLine = top.find(l => {
    const hebrewOrLatin = l.replace(/[^א-תa-z\s]/gi, "").trim();
    return hebrewOrLatin.length >= 3 && hebrewOrLatin.length >= l.length * 0.4;
  });
  if (textLine) return textLine.trim();

  const domainLine = lines.slice(-10).find(l =>
    /www\.|\.co\.il|\.com/i.test(l) && !/weezmo|info@weezmo/.test(l)
  );
  if (domainLine) {
    const match = domainLine.match(/(?:www\.)?([a-z0-9\-]+)(?:\.co\.il|\.com)/i);
    if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1);
  }

  return top[0] ?? "לא ידוע";
}

// ─── Smart Invoice Context Extraction ────────────────────────────────────────

const TOTAL_KEYWORDS = [
  'סה"כ לתשלום',
  'לתשלום',
  'סה"כ כניה',
  'Grand Total',
  'Total:',
  'שולם / זוכה',
  'סכום כולל',
  'סה"כ קנייה',
];

const BOILERPLATE_PATTERNS = [
  /תנאי אחריות/, /תעודת אחריות/, /ביטול עסקה/,
  /הגנת הצרכן/, /הגבלת אחריות/, /מקרים בהם לא תחול/,
];

function findTotalPosition(text: string): number {
  const slices = [0.25, 0.50, 0.75, 1.0];
  for (const fraction of slices) {
    const searchEnd = Math.floor(text.length * fraction);
    const searchSlice = text.slice(0, searchEnd);
    for (const keyword of TOTAL_KEYWORDS) {
      const pos = searchSlice.indexOf(keyword);
      if (pos !== -1) {
        const surrounding = text.slice(Math.max(0, pos - 200), pos + 200);
        const isBoilerplate = BOILERPLATE_PATTERNS.some(p => p.test(surrounding));
        if (!isBoilerplate) return pos;
      }
    }
  }
  return -1;
}

export function extractInvoiceContext(fullText: string): string {
  if (fullText.length <= 1500) return fullText;

  const HEAD_SIZE = 400;
  const WINDOW_SIZE = 350;
  const head = fullText.slice(0, HEAD_SIZE);
  const totalPos = findTotalPosition(fullText);

  if (totalPos === -1) {
    console.log("[parse] No total keyword found, using HEAD + beginning");
    return fullText.slice(0, 1500);
  }

  const windowStart = Math.max(HEAD_SIZE, totalPos - 50);
  const windowEnd = Math.min(fullText.length, totalPos + WINDOW_SIZE);
  const totalWindow = fullText.slice(windowStart, windowEnd);
  const result = `${head}\n...\n${totalWindow}`;
  console.log(`[parse] Smart extraction: ${fullText.length} → ${result.length} chars (total at pos ${totalPos}/${fullText.length})`);
  return result;
}

// ─── LLM Prompt ──────────────────────────────────────────────────────────────

export function buildParsePrompt(rawOcrText: string, categories: string[]): string {
  const ocrText = preprocessOcrText(rawOcrText);
  const today = new Date().toISOString().split("T")[0];
  const businessName = extractBusinessName(ocrText);
  const relevantText = extractInvoiceContext(ocrText);

  const catLines = categories
    .map(name => `"${name}"${getCategoryHint(name) ? ` (${getCategoryHint(name)})` : ""}`)
    .join(" | ");

  return `חלץ נתונים מחשבונית ישראלית. שם העסק: "${businessName}". תאריך ברירת מחדל: ${today}.

קטגוריות: ${catLines}

חוקים:
- amount: הסכום הסופי כולל מע"מ, כמספר בלבד, ללא ₪ וללא פסיקים:
  * חפש בסדר עדיפות: "לתשלום" > "סה"כ לתשלום" > "סה"כ קנייה" > "Grand Total" > "סה"כ"
  * אם מופיעות כמה שורות "סה"כ" — קח תמיד את הגדולה ביותר (הסכום הכולל עם מע"מ)
  * אל תיקח: "סה"כ ללא מע"מ", מחיר ליחידה, מע"מ בנפרד, סכומי ביניים
  * אם הטקסט מקולקל ואין מילות מפתח ברורות — קח את המספר העשרוני הגדול ביותר בטקסט (הוא כמעט תמיד הסכום הכולל)
  * הסכום חייב להיות מספר חיובי. אם אתה רואה מספרים כמו 232.61 או 310.50 — זה הסכום הנכון
- type: בחר קטגוריה לפי שם העסק והפריטים
- description: שם העסק בדיוק כפי שמופיע בחשבונית — המלא והמדויק
  * דוגמאות טובות: "שופרסל בע״מ", "סופר-פארם מעלות", "מזרוו בכפר 23 בע״מ", "מקס סטוק"
  * אם מופיע ווטרמארק גדול בתמונה — התעלם ממנו, שם העסק הוא הכיתוב הקטן בראש הדף
  * אל תוסיף את מה שנרכש — רק שם העסק

החזר JSON בלבד, ללא טקסט נוסף:
{"amount":<number>,"date":"<YYYY-MM-DD>","type":"<category>","description":"<שם עסק>"}

טקסט החשבונית:
${relevantText}`;
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

function repairAndParseJson(raw: string): ParsedInvoice | null {
  const fullMatch = raw.match(/\{[\s\S]*\}/);
  if (fullMatch) {
    try { return JSON.parse(fullMatch[0]); } catch { /* fall through */ }
  }

  let partial = raw;
  const start = partial.indexOf("{");
  if (start === -1) return null;
  partial = partial.slice(start);
  const quoteCount = (partial.match(/(?<!\\)"/g) ?? []).length;
  if (quoteCount % 2 !== 0) partial += '"';
  if (!partial.trimEnd().endsWith("}")) partial += "}";
  try {
    const obj = JSON.parse(partial);
    if (obj.amount !== undefined || obj.date !== undefined) return obj;
  } catch { /* fall through */ }

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
  options: { temperature: number; num_predict: number };
}

export async function parseInvoiceWithLlm(
  prompt: string
): Promise<{ result: ParsedInvoice; payload: LlmPayload; ms: number }> {
  const payload: LlmPayload = {
    model: AI_CONFIG.llmModel,
    prompt,
    stream: false,
    format: "json",
    options: { temperature: 0, num_predict: 200 },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CONFIG.timeoutMs);
  const t0 = Date.now();
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
    const ms = Date.now() - t0;
    const rawText: string = llmData.response?.trim() ?? "";
    let result = repairAndParseJson(rawText);
    if (!result) throw new Error(`LLM returned no parseable JSON. Raw: ${rawText.slice(0, 200)}`);

    if (typeof result.amount === "string") {
      result = { ...result, amount: parseFloat((result.amount as string).replace(/,/g, "")) };
    }
    if (!result.amount || isNaN(result.amount)) {
      const m = rawText.match(/"amount"\s*:\s*"?([\d.]+)/) ??
                prompt.match(/סה"כ[^\d]*([\d.]+)/);
      if (m) result.amount = parseFloat(m[1]);
    }

    return { result, payload, ms };
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
  timings: { ocr: number; llm: number; total: number };
  ocrQuality: OcrQuality;
}

export async function runParsingPipeline(file: File, categories: string[]): Promise<PipelineResult> {
  const t0 = Date.now();
  const { text: ocrText, ms: ocrMs } = await extractTextViaOcr(file);

  // Quality gate — log warnings, continue anyway but surface score to client
  const quality = assessOcrQuality(ocrText);
  if (quality.warnings.length > 0) {
    console.warn(`[OCR] quality=${quality.score}/100 usable=${quality.usable}`, quality.warnings);
  } else {
    console.log(`[OCR] quality=${quality.score}/100 ✓`);
  }

  const prompt = buildParsePrompt(ocrText, categories);
  const { result: parsedInvoice, payload: llmPayload, ms: llmMs } = await parseInvoiceWithLlm(prompt);
  return {
    parsedInvoice, ocrText, prompt, llmPayload,
    timings: { ocr: ocrMs, llm: llmMs, total: Date.now() - t0 },
    ocrQuality: quality,
  };
}
