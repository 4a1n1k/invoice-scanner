/**
 * POST /api/parse
 *
 * PDF handling strategy:
 *   1. Extract embedded text via pdf-parse
 *   2. Detect RTL-reversed text (weezmo PDFs render Hebrew mirrored) → fix it
 *   3. Check content usability (length + quality)
 *   4. If unusable → convert page to image → OCR
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES } from "@/lib/config";
import { buildParsePrompt, parseInvoiceWithLlm, runParsingPipeline } from "@/lib/parse-service";

export const maxDuration = 60;

// ── Helpers ────────────────────────────────────────────────────────────────────

const PDF_NOISE_LINES = [
  /מסמך ממוחשב/,
  /מסמך זה הינו/,
  /page \d+ of \d+/i,
  /weezmo/i,
  /info@weezmo/i,
  /חתימה אלקטרונית/,
  /הוראות ניהול ספרים/,
  /verified by/i,
];

/**
 * Detects whether PDF text has been extracted RTL-reversed (mirrored).
 * Weezmo and some other Israeli PDF generators produce this artifact.
 *
 * Detection: if >30% of Hebrew-containing lines are char-reversed
 * (i.e., reversing the chars produces recognizable Hebrew words)
 */
function isTextRtlReversed(text: string): boolean {
  const hebrewLines = text
    .split("\n")
    .map(l => l.trim())
    .filter(l => /[\u05d0-\u05ea]/.test(l) && l.length > 3);

  if (hebrewLines.length === 0) return false;

  // Known reversed markers — if we see these, text is definitely reversed
  const reversedMarkers = [
    "בשחוממ ךמסמ",   // "מסמך ממוחשב" reversed
    ":קסע םש",       // "שם עסק:" reversed
    ":ךיראת",        // "תאריך:" reversed
    "ללכ",           // various
  ];

  return reversedMarkers.some(marker => text.includes(marker));
}

/**
 * Reverses each line's characters to fix RTL-mirrored PDF text.
 * "תולעמ םראפ-רפוס" → "סופר-פארם מעלות"
 * Numbers and mixed lines are handled gracefully.
 */
function fixRtlReversedText(text: string): string {
  return text
    .split("\n")
    .map(line => {
      const trimmed = line.trim();
      // Only reverse lines that contain Hebrew
      if (/[\u05d0-\u05ea]/.test(trimmed)) {
        return trimmed.split("").reverse().join("");
      }
      return trimmed;
    })
    .join("\n");
}

/**
 * Decides whether extracted PDF text is usable for invoice parsing.
 */
function isPdfTextUsable(text: string): boolean {
  if (!text || text.length === 0) return false;

  // Check PUA (garbled custom fonts)
  let pua = 0;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe000 && cp <= 0xf8ff) pua++;
    total++;
  }
  if (total > 0 && pua / total > 0.15) {
    console.log(`[parse] PDF rejected: ${(pua / total * 100).toFixed(0)}% PUA chars`);
    return false;
  }

  // Check meaningful content length after stripping noise
  const meaningfulLines = text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 2)
    .filter(l => !PDF_NOISE_LINES.some(p => p.test(l)));

  const meaningfulText = meaningfulLines.join("\n");
  if (meaningfulText.length < 100) {
    console.log(`[parse] PDF rejected: only ${meaningfulText.length} meaningful chars`);
    return false;
  }

  return true;
}

/**
 * Converts the first page of a PDF buffer to a JPEG image blob via Ghostscript.
 */
async function pdfPageToImageBlob(pdfBuffer: Buffer): Promise<Blob | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fromBuffer } = require("pdf2pic");
    const convert = fromBuffer(pdfBuffer, {
      density: 200,
      format: "jpeg",
      width: 1800,
      height: 2600,
      preserveAspectRatio: true,
    });
    const result = await convert(1, { responseType: "buffer" });
    if (!result?.buffer) return null;

    const buf = result.buffer as Buffer;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Blob([ab as ArrayBuffer], { type: "image/jpeg" });
  } catch (err) {
    console.warn("[parse] pdf2pic failed:", err);
    return null;
  }
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const userCategories = await prisma.category.findMany({
    where: { userId: session.user.id },
    select: { name: true },
    orderBy: { name: "asc" },
  });

  const categories =
    userCategories.length > 0
      ? userCategories.map((c) => c.name)
      : [...DEFAULT_CATEGORIES];

  try {
    // ── PDF path ───────────────────────────────────────────────────────────────
    if (file.type === "application/pdf") {
      const pdfBuffer = Buffer.from(await file.arrayBuffer());

      // Step 1: extract embedded text
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const pdfData = await pdfParse(pdfBuffer);
      let rawText: string = pdfData.text ?? "";

      // Step 2: fix RTL-reversed text (weezmo artifact)
      if (isTextRtlReversed(rawText)) {
        console.log("[parse] PDF: detected RTL-reversed text, fixing...");
        rawText = fixRtlReversedText(rawText);
      }

      // Step 3: check if usable
      if (isPdfTextUsable(rawText)) {
        console.log("[parse] PDF: using embedded text");
        const prompt = buildParsePrompt(rawText, categories);
        const { result: parsedInvoice, payload: llmPayload } = await parseInvoiceWithLlm(prompt);
        return NextResponse.json({
          data: parsedInvoice,
          ocrText: rawText,
          debug: {
            pdfPath: "embedded-text",
            prompt,
            llmPayload: llmPayload as unknown as Record<string, unknown>,
            ocrResponse: rawText.substring(0, 500) + "…",
          },
        });
      }

      // Step 4: fallback — convert to image → OCR
      console.log("[parse] PDF: falling back to image OCR");
      const imageBlob = await pdfPageToImageBlob(pdfBuffer);

      if (imageBlob) {
        const imageFile = new File([imageBlob], "pdf_page.jpg", { type: "image/jpeg" });
        const { parsedInvoice, ocrText, prompt, llmPayload } = await runParsingPipeline(
          imageFile, categories
        );
        return NextResponse.json({
          data: parsedInvoice,
          ocrText,
          debug: {
            pdfPath: "ocr-fallback",
            prompt,
            llmPayload: llmPayload as unknown as Record<string, unknown>,
            ocrResponse: ocrText.substring(0, 500) + "…",
          },
        });
      }

      return NextResponse.json(
        { error: "לא ניתן לחלץ טקסט מה-PDF. נסה להמיר לתמונה (JPG/PNG) ולהעלות שוב." },
        { status: 400 }
      );
    }

    // ── Image path ─────────────────────────────────────────────────────────────
    const { parsedInvoice, ocrText, prompt, llmPayload } = await runParsingPipeline(file, categories);
    return NextResponse.json({
      data: parsedInvoice,
      ocrText,
      debug: {
        prompt,
        llmPayload: llmPayload as unknown as Record<string, unknown>,
        ocrResponse: ocrText.substring(0, 500) + "…",
      },
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[parse] Pipeline error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
