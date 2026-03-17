/**
 * GET /api/reports/download-zip?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Returns a ZIP archive containing all invoice files for the date range.
 * Each file is named: YYYY-MM-DD_category_description.ext
 * Also includes a summary CSV inside the ZIP.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readFile, access } from "fs/promises";
import { join } from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require("adm-zip");

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const startStr = searchParams.get("start");
    const endStr = searchParams.get("end");

    if (!startStr || !endStr) {
      return new NextResponse("Missing start/end parameters", { status: 400 });
    }

    const startDate = new Date(startStr);
    const endDate = new Date(endStr);
    endDate.setHours(23, 59, 59, 999);

    const invoices = await prisma.invoice.findMany({
      where: {
        userId: session.user.id,
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { date: "asc" },
    });

    if (invoices.length === 0) {
      return new NextResponse("No invoices found in this date range", { status: 404 });
    }

    const zip = new AdmZip();

    // ── Add each invoice file ─────────────────────────────────────────────────
    const usedNames = new Set<string>();
    let filesAdded = 0;

    for (const inv of invoices) {
      if (!inv.filePath) continue;

      // Resolve absolute path (filePath stored relative to cwd)
      const absPath = inv.filePath.startsWith("/") || inv.filePath.match(/^[A-Z]:/i)
        ? inv.filePath
        : join(process.cwd(), inv.filePath);

      try {
        await access(absPath);
      } catch {
        // File missing on disk — skip silently
        continue;
      }

      const fileBuffer = await readFile(absPath);
      const ext = absPath.split(".").pop()?.toLowerCase() ?? "bin";

      // Build a descriptive filename
      const dateStr = inv.date.toISOString().split("T")[0];
      const safeDesc = (inv.description ?? "")
        .replace(/[^א-תa-z0-9\-_ ]/gi, "")
        .trim()
        .replace(/\s+/g, "_")
        .substring(0, 30);
      const safeType = inv.expenseType.replace(/[^א-תa-z0-9\-_]/gi, "_").substring(0, 20);

      let fileName = `${dateStr}_${safeType}_${safeDesc}.${ext}`;

      // Deduplicate filenames
      if (usedNames.has(fileName)) {
        fileName = `${dateStr}_${safeType}_${safeDesc}_${filesAdded}.${ext}`;
      }
      usedNames.add(fileName);

      zip.addFile(fileName, fileBuffer);
      filesAdded++;
    }

    // ── Add summary CSV ───────────────────────────────────────────────────────
    const total = invoices.reduce((s, i) => s + i.amount, 0);
    const csvHeader = "תאריך,קטגוריה,תיאור,סכום\n";
    const csvRows = invoices
      .map(i =>
        [
          i.date.toLocaleDateString("he-IL"),
          `"${i.expenseType}"`,
          `"${(i.description ?? "").replace(/"/g, '""')}"`,
          i.amount.toFixed(2),
        ].join(",")
      )
      .join("\n");
    const csvTotal = `\nסה"כ,,,${total.toFixed(2)}`;

    // UTF-8 BOM so Excel opens Hebrew correctly
    const csvContent = "\uFEFF" + csvHeader + csvRows + csvTotal;
    zip.addFile("סיכום.csv", Buffer.from(csvContent, "utf8"));

    // ── Return ZIP ────────────────────────────────────────────────────────────
    const zipBuffer = zip.toBuffer();
    const fileName = `invoices_${startStr}_${endStr}.zip`;

    return new NextResponse(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": zipBuffer.length.toString(),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[download-zip] error:", message);
    return new NextResponse("Internal Server Error: " + message, { status: 500 });
  }
}
