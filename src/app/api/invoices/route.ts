/**
 * POST /api/invoices
 * Saves an invoice. The file attachment is OPTIONAL (manual mode has no file).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { STORAGE_CONFIG } from "@/lib/config";
import { join, relative } from "path";
import { writeFile, mkdir } from "fs/promises";
import { randomUUID } from "crypto";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const invoiceDataStr = formData.get("invoiceData") as string | null;

  if (!invoiceDataStr) {
    return NextResponse.json({ error: "Missing invoiceData" }, { status: 400 });
  }

  let parsedData: { amount?: unknown; date?: unknown; type?: unknown; description?: unknown; ocrText?: unknown; };
  try {
    parsedData = JSON.parse(invoiceDataStr);
  } catch {
    return NextResponse.json({ error: "Invalid invoiceData JSON" }, { status: 400 });
  }

  const dateObj = parsedData.date ? new Date(parsedData.date as string) : new Date();
  if (isNaN(dateObj.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  // ── Optional file save ────────────────────────────────────────────────────
  let filePathRel = "";

  if (file && file.size > 0) {
    const year = dateObj.getFullYear().toString();
    const month = (dateObj.getMonth() + 1).toString().padStart(2, "0");
    const uploadDirAbs = join(process.cwd(), STORAGE_CONFIG.uploadRoot, year, month);
    await mkdir(uploadDirAbs, { recursive: true });

    const ext = file.name.split(".").pop() ?? "bin";
    const safeType = String(parsedData.type ?? "unknown").replace(/[^a-z0-9א-ת\-_]/gi, "_");
    const safeDate = dateObj.toISOString().split("T")[0];
    const fileName = `${safeType}_${safeDate}_${randomUUID().slice(0, 6)}.${ext}`;
    const filePathAbs = join(uploadDirAbs, fileName);
    filePathRel = relative(process.cwd(), filePathAbs);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePathAbs, buffer);
  }

  // ── Persist to DB ─────────────────────────────────────────────────────────
  try {
    const invoice = await prisma.invoice.create({
      data: {
        userId: session.user.id,
        amount: Number(parsedData.amount) || 0,
        expenseType: String(parsedData.type ?? "אחר"),
        date: dateObj,
        description: String(parsedData.description ?? ""),
        originalName: file?.name ?? null,
        filePath: filePathRel,
        ocrText: String(parsedData.ocrText ?? ""),
      },
    });
    return NextResponse.json({ success: true, invoice });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[invoices POST] DB error:", message);
    return NextResponse.json({ error: "Could not save: " + message }, { status: 500 });
  }
}
