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
    // Include the entire end date by setting time to 23:59:59
    endDate.setHours(23, 59, 59, 999);

    const invoices = await prisma.invoice.findMany({
      where: {
        userId: session.user.id,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { date: "asc" },
    });

    const host = req.headers.get("host");
    const protocol = process.env.NODE_ENV === "development" ? "http" : "https";
    const baseUrl = `${protocol}://${host}`;

    // Map data for Excel
    const excelData = invoices.map((inv: any) => ({
      "תאריך": new Date(inv.date).toLocaleDateString('he-IL'),
      "סכום": inv.amount,
      "סוג הוצאה": inv.expenseType,
      "תיאור": inv.description || "",
      "קישור לקובץ (מצריך התחברות)": `${baseUrl}/api/files/${inv.id}`,
    }));

    if (excelData.length === 0) {
      return new NextResponse("No invoices found in this date range", { status: 404 });
    }

    // Create workbook
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(excelData);
    
    // Add RTL (Right To Left) formatting to sheet
    ws['!dir'] = 'rtl';
    
    // Set column widths
    ws['!cols'] = [
      { wch: 15 }, // Date
      { wch: 10 }, // Amount
      { wch: 20 }, // Type
      { wch: 30 }, // Description
      { wch: 80 }  // Link
    ];

    xlsx.utils.book_append_sheet(wb, ws, "הוצאות ילדים");

    const excelBuffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="invoices_${startDateStr}_to_${endDateStr}.xlsx"`,
      },
    });

  } catch (err: any) {
    console.error("Export Error:", err);
    return new NextResponse("Internal Server Error: " + err.message, { status: 500 });
  }
}
