/**
 * POST /api/parse
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES } from "@/lib/config";
import { buildParsePrompt, parseInvoiceWithLlm, runParsingPipeline } from "@/lib/parse-service";

export const maxDuration = 60;

// ── PDF helpers ────────────────────────────────────────────────────────────────

const PDF_NOISE_LINES = [
  /מסמך ממוחשב/, /מסמך זה הינו/, /page \d+ of \d+/i,
  /weezmo/i, /info@weezmo/i, /חתימה אלקטרונית/,
  /הוראות ניהול ספרים/, /verified by/i,
];

function isTextRtlReversed(text: string): boolean {
  const reversedMarkers = ["בשחוממ ךמסמ", ":קסע םש", ":ךיראת"];
  return reversedMarkers.some(m => text.includes(m));
}

function fixRtlReversedText(text: string): string {
  return text.split("\n").map(line => {
    const trimmed = line.trim();
    return /[\u05d0-\u05ea]/.test(trimmed) ? trimmed.split("").reverse().join("") : trimmed;
  }).join("\n");
}

function isPdfTextUsable(text: string): boolean {
  if (!text || text.length === 0) return false;
  let pua = 0, total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe000 && cp <= 0xf8ff) pua++;
    total++;
  }
  if (total > 0 && pua / total > 0.15) { console.log(`[parse] PDF rejected: garbled font`); return false; }

  const meaningfulText = text.split("\n")
    .map(l => l.trim()).filter(l => l.length > 2)
    .filter(l => !PDF_NOISE_LINES.some(p => p.test(l))).join("\n");

  if (meaningfulText.length < 100) { console.log(`[parse] PDF rejected: only ${meaningfulText.length} meaningful chars`); return false; }
  return true;
}

async function pdfPageToImageBlob(pdfBuffer: Buffer): Promise<Blob | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fromBuffer } = require("pdf2pic");
    const convert = fromBuffer(pdfBuffer, { density: 200, format: "jpeg", width: 1800, height: 2600, preserveAspectRatio: true });
    const result = await convert(1, { responseType: "buffer" });
    if (!result?.buffer) return null;
    const buf = result.buffer as Buffer;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Blob([ab as ArrayBuffer], { type: "image/jpeg" });
  } catch (err) { console.warn("[parse] pdf2pic failed:", err); return null; }
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const userCategories = await prisma.category.findMany({
    where: { userId: session.user.id }, select: { name: true }, orderBy: { name: "asc" },
  });
  const categories = userCategories.length > 0 ? userCategories.map(c => c.name) : [...DEFAULT_CATEGORIES];

  try {
    // ── PDF ──────────────────────────────────────────────────────────────────
    if (file.type === "application/pdf") {
      const pdfBuffer = Buffer.from(await file.arrayBuffer());
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const pdfData = await pdfParse(pdfBuffer);
      let rawText: string = pdfData.text ?? "";

      if (isTextRtlReversed(rawText)) {
        console.log("[parse] PDF: fixing RTL-reversed text");
        rawText = fixRtlReversedText(rawText);
      }

      if (isPdfTextUsable(rawText)) {
        console.log("[parse] PDF: using embedded text");
        const t0 = Date.now();
        const prompt = buildParsePrompt(rawText, categories);
        const { result: parsedInvoice, payload: llmPayload, ms: llmMs } = await parseInvoiceWithLlm(prompt);
        return NextResponse.json({
          data: parsedInvoice,
          ocrText: rawText,
          timings: { ocr: 0, llm: llmMs, total: Date.now() - t0 },
          debug: { pdfPath: "embedded-text", prompt, llmPayload: llmPayload as unknown as Record<string, unknown>, ocrResponse: rawText.substring(0, 500) + "…" },
        });
      }

      // Fallback: convert to image → OCR
      console.log("[parse] PDF: falling back to image OCR");
      const imageBlob = await pdfPageToImageBlob(pdfBuffer);
      if (imageBlob) {
        const imageFile = new File([imageBlob], "pdf_page.jpg", { type: "image/jpeg" });
        const { parsedInvoice, ocrText, prompt, llmPayload, timings } = await runParsingPipeline(imageFile, categories);
        return NextResponse.json({
          data: parsedInvoice, ocrText, timings,
          debug: { pdfPath: "ocr-fallback", prompt, llmPayload: llmPayload as unknown as Record<string, unknown>, ocrResponse: ocrText.substring(0, 500) + "…" },
        });
      }

      return NextResponse.json({ error: "לא ניתן לחלץ טקסט מה-PDF. נסה להמיר לתמונה (JPG/PNG) ולהעלות שוב." }, { status: 400 });
    }

    // ── Image ────────────────────────────────────────────────────────────────
    const { parsedInvoice, ocrText, prompt, llmPayload, timings } = await runParsingPipeline(file, categories);
    return NextResponse.json({
      data: parsedInvoice, ocrText, timings,
      debug: { prompt, llmPayload: llmPayload as unknown as Record<string, unknown>, ocrResponse: ocrText.substring(0, 500) + "…" },
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[parse] Pipeline error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
