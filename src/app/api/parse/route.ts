/**
 * POST /api/parse
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES } from "@/lib/config";
import { buildParsePrompt, parseInvoiceWithLlm, runParsingPipeline } from "@/lib/parse-service";

export const maxDuration = 60;

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
    if (file.type === "application/pdf") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const buffer = Buffer.from(await file.arrayBuffer());
      const pdfData = await pdfParse(buffer);
      const ocrText: string = pdfData.text ?? "";

      if (!ocrText.trim() || ocrText.trim().length < 20) {
        return NextResponse.json(
          { error: "No text found in PDF. Please upload as JPG or PNG instead." },
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
          llmPayload: llmPayload as unknown as Record<string, unknown>,
          ocrResponse: ocrText.substring(0, 500) + "…",
        },
      });
    } else {
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
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[parse] Pipeline error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
