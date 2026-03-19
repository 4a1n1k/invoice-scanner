/**
 * POST /api/parse
 *
 * PDF handling strategy:
 *   1. Try pdf-parse to extract embedded text
 *   2. Validate the text quality (garbled/encoded PDFs fail the check)
 *   3. If quality fails → convert PDF page to image → send to OCR (same as image pipeline)
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES } from "@/lib/config";
import { buildParsePrompt, parseInvoiceWithLlm, runParsingPipeline } from "@/lib/parse-service";

export const maxDuration = 60;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Returns a quality score 0-1 for extracted PDF text.
 * Low score = garbled / custom-encoded font → need OCR fallback.
 *
 * Checks:
 * - Ratio of printable ASCII + Hebrew chars to total chars
 * - If >30% chars are in Private Use Area (U+E000–U+F8FF) → garbage
 */
function pdfTextQuality(text: string): number {
  if (!text || text.length === 0) return 0;
  let good = 0;
  let pua = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isHebrew = cp >= 0x05d0 && cp <= 0x05ea;
    const isLatin = cp >= 0x20 && cp <= 0x7e;
    const isCommon = cp === 0x0a || cp === 0x0d || cp === 0x09; // newline/tab
    const isPUA = cp >= 0xe000 && cp <= 0xf8ff;
    if (isHebrew || isLatin || isCommon) good++;
    if (isPUA) pua++;
  }
  const total = text.length;
  if (pua / total > 0.15) return 0; // >15% PUA = definitely garbled
  return good / total;
}

/**
 * Converts the first page of a PDF buffer to a JPEG image buffer
 * using pdf2pic (which wraps GraphicsMagick/Ghostscript).
 * Returns null if conversion fails.
 */
async function pdfPageToImageBlob(pdfBuffer: Buffer): Promise<Blob | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fromBuffer } = require("pdf2pic");
    const convert = fromBuffer(pdfBuffer, {
      density: 200,        // DPI — enough for OCR accuracy
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
    console.warn("[parse] pdf2pic conversion failed:", err);
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

      // Step 1: try embedded text extraction
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const pdfData = await pdfParse(pdfBuffer);
      const rawText: string = pdfData.text ?? "";
      const quality = pdfTextQuality(rawText);

      console.log(`[parse] PDF text quality: ${(quality * 100).toFixed(0)}% (${rawText.length} chars)`);

      if (quality >= 0.6 && rawText.trim().length >= 20) {
        // Good quality text — use it directly (fast path, no OCR needed)
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

      // Step 2: garbled/encoded PDF → convert to image → OCR (same as photo)
      console.log("[parse] PDF text quality too low, falling back to image OCR");
      const imageBlob = await pdfPageToImageBlob(pdfBuffer);

      if (imageBlob) {
        const imageFile = new File([imageBlob], "pdf_page.jpg", { type: "image/jpeg" });
        const { parsedInvoice, ocrText, prompt, llmPayload } = await runParsingPipeline(
          imageFile,
          categories
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

      // Step 3: both failed
      return NextResponse.json(
        {
          error:
            "לא ניתן לחלץ טקסט מה-PDF. נסה להמיר לתמונה (JPG/PNG) ולהעלות שוב.",
        },
        { status: 400 }
      );
    }

    // ── Image path ─────────────────────────────────────────────────────────────
    const { parsedInvoice, ocrText, prompt, llmPayload } = await runParsingPipeline(
      file,
      categories
    );
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
