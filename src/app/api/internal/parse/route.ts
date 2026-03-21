/**
 * POST /internal/parse
 * Internal endpoint for Family War Room integration.
 * Protected by x-internal-key header (not full auth session).
 * Returns: { success, data: { amount, date, type, description }, timings }
 */

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_CATEGORIES } from "@/lib/config";
import { runParsingPipeline, buildParsePrompt, parseInvoiceWithLlm } from "@/lib/parse-service";

export const maxDuration = 60;

const PDF_NOISE_LINES = [
  /מסמך ממוחשב/, /מסמך זה הינו/, /page \d+ of \d+/i,
  /weezmo/i, /info@weezmo/i, /חתימה אלקטרונית/,
  /הוראות ניהול ספרים/, /verified by/i,
];

function isTextRtlReversed(text: string): boolean {
  return ["בשחוממ ךמסמ", ":קסע םש", ":ךיראת", "כ\"הס"].some(m => text.includes(m));
}

function smartReverseRtlLine(line: string): string {
  if (!/[\u05d0-\u05ea]/.test(line)) return line;
  let rev = line.split("").reverse().join("");
  rev = rev.replace(/\d[\d.:,/]*\d|\d/g, m => m.split("").reverse().join(""));
  return rev;
}

function fixRtlReversedText(text: string): string {
  return text.split("\n").map(l => smartReverseRtlLine(l.trim())).join("\n");
}

function isPdfTextUsable(text: string): boolean {
  if (!text?.length) return false;
  let pua = 0, total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe000 && cp <= 0xf8ff) pua++;
    total++;
  }
  if (total > 0 && pua / total > 0.15) return false;
  const meaningful = text.split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 2 && !PDF_NOISE_LINES.some(p => p.test(l)))
    .join("\n");
  return meaningful.length >= 100;
}

async function pdfPageToImageBlob(pdfBuffer: Buffer): Promise<Blob | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fromBuffer } = require("pdf2pic");
    const convert = fromBuffer(pdfBuffer, {
      density: 200, format: "jpeg", width: 1800, height: 2600, preserveAspectRatio: true,
    });
    const result = await convert(1, { responseType: "buffer" });
    if (!result?.buffer) return null;
    const buf = result.buffer as Buffer;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Blob([ab as ArrayBuffer], { type: "image/jpeg" });
  } catch { return null; }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth: x-internal-key
  const key = req.headers.get("x-internal-key");
  const expected = process.env.INTERNAL_API_KEY || "";
  if (!expected || key !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const categories = [...DEFAULT_CATEGORIES];

  try {
    if (file.type === "application/pdf") {
      const pdfBuffer = Buffer.from(await file.arrayBuffer());
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const pdfData = await pdfParse(pdfBuffer);
      let rawText: string = pdfData.text ?? "";
      if (isTextRtlReversed(rawText)) rawText = fixRtlReversedText(rawText);

      if (isPdfTextUsable(rawText)) {
        const t0 = Date.now();
        const prompt = buildParsePrompt(rawText, categories);
        const { result, ms: llmMs } = await parseInvoiceWithLlm(prompt);
        return NextResponse.json({
          success: true,
          data: result,
          timings: { ocr: 0, llm: llmMs, total: Date.now() - t0 },
        });
      }

      const imageBlob = await pdfPageToImageBlob(pdfBuffer);
      if (imageBlob) {
        const imageFile = new File([imageBlob], "pdf_page.jpg", { type: "image/jpeg" });
        const { parsedInvoice, timings } = await runParsingPipeline(imageFile, categories);
        return NextResponse.json({ success: true, data: parsedInvoice, timings });
      }
      return NextResponse.json(
        { error: "לא ניתן לחלץ טקסט מה-PDF. נסה להמיר לתמונה." },
        { status: 400 }
      );
    }

    // Image flow
    const { parsedInvoice, timings } = await runParsingPipeline(file, categories);
    return NextResponse.json({ success: true, data: parsedInvoice, timings });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[internal/parse]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
