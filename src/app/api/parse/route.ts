/**
 * POST /api/parse
 *
 * PDF handling strategy:
 *   1. Extract embedded text via pdf-parse
 *   2. Check BOTH quality AND content length — weezmo/image PDFs pass quality but have no invoice content
 *   3. If text is too short OR garbled → convert page to image → OCR
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES } from "@/lib/config";
import { buildParsePrompt, parseInvoiceWithLlm, runParsingPipeline } from "@/lib/parse-service";

export const maxDuration = 60;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Decides whether extracted PDF text is usable for invoice parsing.
 *
 * Two failure modes we handle:
 * A) Garbled/encoded text (custom font): high PUA character ratio → quality < 0.6
 * B) Image-based PDF (e.g. weezmo): text exists but it's only metadata/footer,
 *    not the actual invoice — detected by short meaningful content length
 *
 * "Meaningful" = lines that look like invoice content (numbers, amounts, dates, items)
 * NOT just "מסמך ממוחשב", "Page 1 of 1", "www.weezmo.com" footer lines
 */
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

function isPdfTextUsable(text: string): boolean {
  if (!text || text.length === 0) return false;

  // Check 1: PUA (Private Use Area) ratio — garbled custom fonts
  let pua = 0;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isPUA = cp >= 0xe000 && cp <= 0xf8ff;
    if (isPUA) pua++;
    total++;
  }
  if (total > 0 && pua / total > 0.15) {
    console.log(`[parse] PDF rejected: ${(pua/total*100).toFixed(0)}% PUA chars (garbled font)`);
    return false;
  }

  // Check 2: meaningful content length
  // Strip known noise lines and see what's left
  const meaningfulLines = text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 2)
    .filter(l => !PDF_NOISE_LINES.some(p => p.test(l)));

  const meaningfulText = meaningfulLines.join("\n");

  // Need at least 100 chars of actual invoice content
  // (a real invoice has amounts, dates, items — way more than 100 chars)
  if (meaningfulText.length < 100) {
    console.log(`[parse] PDF rejected: only ${meaningfulText.length} meaningful chars (image-based PDF)`);
    return false;
  }

  return true;
}

/**
 * Converts the first page of a PDF buffer to a JPEG image blob
 * using pdf2pic (wraps Ghostscript/GraphicsMagick).
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

      // Step 1: try embedded text
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const pdfData = await pdfParse(pdfBuffer);
      const rawText: string = pdfData.text ?? "";

      if (isPdfTextUsable(rawText)) {
        // Good embedded text — use directly (fast, no OCR needed)
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

      // Step 2: fallback — convert PDF page to image → OCR
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

      // Step 3: both failed
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
