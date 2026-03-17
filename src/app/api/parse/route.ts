/**
 * POST /api/parse
 *
 * Accepts a multipart upload (PDF or image), runs it through the OCR→LLM
 * pipeline, and returns structured invoice data plus debug info.
 *
 * All AI configuration comes from `lib/config.ts` — nothing is hardcoded here.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES } from "@/lib/config";
import { buildParsePrompt, parseInvoiceWithLlm, runParsingPipeline } from "@/lib/parse-service";
import type { ParseApiResponse, ParseApiError } from "@/lib/types";

export const maxDuration = 60; // seconds — allow time for OCR + LLM

export async function POST(req: NextRequest): Promise<NextResponse<ParseApiResponse | ParseApiError>> {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── File extraction ─────────────────────────────────────────────────────────
  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // ── Resolve categories for this user ────────────────────────────────────────
  const userCategories = await prisma.category.findMany({
    where: { userId: session.user.id },
    select: { name: true },
    orderBy: { name: "asc" },
  });

  const categories =
    userCategories.length > 0
      ? userCategories.map((c) => c.name)
      : [...DEFAULT_CATEGORIES];

  // ── Parse based on file type ─────────────────────────────────────────────────
  try {
    if (file.type === "application/pdf") {
      // PDF: extract text locally — no OCR needed
      // Lazy-require to avoid issues with Next.js bundler in edge runtime
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const buffer = Buffer.from(await file.arrayBuffer());
      const pdfData = await pdfParse(buffer);
      const ocrText: string = pdfData.text ?? "";

      if (!ocrText.trim() || ocrText.trim().length < 20) {
        return NextResponse.json(
          {
            error:
              "No text found in PDF. If this is a scanned image, please upload it as JPG or PNG instead.",
          },
          { status: 400 }
        );
      }

      const prompt = buildParsePrompt(ocrText, categories);
      const { result: parsedInvoice, payload: llmPayload } = await parseInvoiceWithLlm(prompt);

      return NextResponse.json({
        data: parsedInvoice,
        ocrText,
        debug: {
          prompt,
          llmPayload,
          ocrResponse: ocrText.substring(0, 500) + "…",
        },
      });
    } else {
      // Image: OCR → LLM
      const { parsedInvoice, ocrText, prompt, llmPayload } = await runParsingPipeline(
        file,
        categories
      );

      return NextResponse.json({
        data: parsedInvoice,
        ocrText,
        debug: {
          prompt,
          llmPayload,
          ocrResponse: ocrText.substring(0, 500) + "…",
        },
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[parse] Pipeline error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
