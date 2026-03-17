import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import * as xlsx from "xlsx";

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const startDateStr = searchParams.get("start");
    const endDateStr = searchParams.get("end");

    if (!startDateStr || !endDateStr) {
      return new NextResponse("Missing date parameters", { status: 400 });
    }

    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
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

    const total = invoices.reduce((s, i) => s + i.amount, 0);

    // ── Build rows ────────────────────────────────────────────────────────────
    const excelData = invoices.map((inv) => ({
      "תאריך": new Date(inv.date).toLocaleDateString("he-IL"),
      "סכום (₪)": inv.amount,
      "קטגוריה": inv.expenseType,
      "תיאור": inv.description ?? "",
      "שם קובץ מקורי": inv.originalName ?? "",
    }));

    // Add totals row
    excelData.push({
      "תאריך": "",
      "סכום (₪)": total,
      "קטגוריה": `סה"כ (${invoices.length} חשבוניות)`,
      "תיאור": "",
      "שם קובץ מקורי": "",
    });

    // ── Build workbook ────────────────────────────────────────────────────────
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(excelData);

    ws["!dir"] = "rtl";
    ws["!cols"] = [
      { wch: 14 }, // Date
      { wch: 12 }, // Amount
      { wch: 20 }, // Category
      { wch: 35 }, // Description
      { wch: 40 }, // Filename
    ];

    // Bold the totals row
    const lastRow = excelData.length + 1; // 1-indexed + header
    ["A", "B", "C", "D", "E"].forEach((col) => {
      const cellRef = `${col}${lastRow}`;
      if (ws[cellRef]) {
        ws[cellRef].s = { font: { bold: true } };
      }
    });

    xlsx.utils.book_append_sheet(wb, ws, "הוצאות ילדים");

    const excelBuffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="invoices_${startDateStr}_to_${endDateStr}.xlsx"`,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Export Error:", message);
    return new NextResponse("Internal Server Error: " + message, { status: 500 });
  }
}
