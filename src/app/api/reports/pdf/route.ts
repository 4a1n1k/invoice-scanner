/**
 * GET /api/reports/pdf
 *
 * Returns an HTML page (print-ready) with Hebrew support.
 * The browser handles RTL, fonts and printing via Ctrl+P / window.print().
 *
 * Why HTML instead of jsPDF?
 * jsPDF requires embedding a full Hebrew font file (>500 KB) and complex RTL
 * shaping. The browser already handles all of that natively — so we return a
 * styled HTML page the user can print-to-PDF from any device, including mobile.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");

    if (!start || !end) {
      return new NextResponse("Missing start/end params", { status: 400 });
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const invoices = await prisma.invoice.findMany({
      where: {
        userId: session.user.id,
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { date: "asc" },
    });

    const total = invoices.reduce((s, inv) => s + inv.amount, 0);

    // ── Group by category for summary ─────────────────────────────────────────
    const byCategory: Record<string, number> = {};
    for (const inv of invoices) {
      byCategory[inv.expenseType] = (byCategory[inv.expenseType] ?? 0) + inv.amount;
    }

    // ── Format helpers ────────────────────────────────────────────────────────
    const fmt = (n: number) =>
      new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" }).format(n);
    const fmtDate = (d: Date) =>
      new Date(d).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });

    // ── Build rows ────────────────────────────────────────────────────────────
    const rows = invoices
      .map(
        (inv, i) => `
      <tr class="${i % 2 === 0 ? "even" : ""}">
        <td>${fmtDate(inv.date)}</td>
        <td><span class="badge">${inv.expenseType}</span></td>
        <td>${inv.description ?? ""}</td>
        <td class="amount">${fmt(inv.amount)}</td>
      </tr>`
      )
      .join("");

    const summaryRows = Object.entries(byCategory)
      .sort(([, a], [, b]) => b - a)
      .map(
        ([cat, sum]) => `
      <tr>
        <td>${cat}</td>
        <td class="amount">${fmt(sum)}</td>
        <td class="amount pct">${((sum / total) * 100).toFixed(1)}%</td>
      </tr>`
      )
      .join("");

    // ── HTML ──────────────────────────────────────────────────────────────────
    const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>דוח הוצאות ${start} – ${end}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;900&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Heebo', Arial, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      direction: rtl;
      padding: 0;
    }

    .page {
      max-width: 860px;
      margin: 0 auto;
      padding: 40px 32px;
    }

    /* ── Header ── */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 3px solid #4f46e5;
      padding-bottom: 20px;
      margin-bottom: 28px;
    }
    .header-title h1 {
      font-size: 26px;
      font-weight: 900;
      color: #4f46e5;
    }
    .header-title p {
      font-size: 13px;
      color: #64748b;
      margin-top: 4px;
    }
    .header-total {
      text-align: left;
      background: #4f46e5;
      color: white;
      padding: 14px 22px;
      border-radius: 14px;
    }
    .header-total .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: .8; }
    .header-total .value { font-size: 24px; font-weight: 900; margin-top: 2px; }

    /* ── Summary grid ── */
    .summary {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 28px;
    }
    .summary-card {
      background: white;
      border-radius: 12px;
      padding: 16px 20px;
      border: 1px solid #e2e8f0;
    }
    .summary-card h3 {
      font-size: 12px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
      font-weight: 700;
    }
    .summary-card table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .summary-card td { padding: 4px 0; }
    .summary-card .amount { text-align: left; font-weight: 700; }
    .summary-card .pct { color: #94a3b8; font-size: 12px; padding-right: 8px; }

    /* ── Main table ── */
    .section-title {
      font-size: 15px;
      font-weight: 700;
      color: #334155;
      margin-bottom: 12px;
    }
    table.main { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.main thead tr {
      background: #4f46e5;
      color: white;
    }
    table.main thead th {
      padding: 10px 14px;
      font-weight: 700;
      text-align: right;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .5px;
    }
    table.main thead th:last-child { text-align: left; }
    table.main tbody tr { background: white; border-bottom: 1px solid #f1f5f9; }
    table.main tbody tr.even { background: #f8fafc; }
    table.main tbody td { padding: 10px 14px; }
    table.main tbody td.amount { text-align: left; font-weight: 700; color: #1e293b; }
    .badge {
      background: #e0e7ff;
      color: #4338ca;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 20px;
      white-space: nowrap;
    }
    table.main tfoot tr { background: #1e293b; color: white; }
    table.main tfoot td { padding: 12px 14px; font-weight: 700; font-size: 14px; }
    table.main tfoot td.amount { text-align: left; }

    /* ── Footer ── */
    .footer {
      margin-top: 28px;
      text-align: center;
      font-size: 11px;
      color: #94a3b8;
      border-top: 1px solid #e2e8f0;
      padding-top: 16px;
    }

    /* ── Print button (hidden when printing) ── */
    .print-btn {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #4f46e5;
      color: white;
      border: none;
      padding: 14px 36px;
      border-radius: 50px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      font-family: 'Heebo', Arial, sans-serif;
      box-shadow: 0 8px 30px rgba(79,70,229,.4);
      transition: transform .15s;
    }
    .print-btn:hover { transform: translateX(-50%) scale(1.04); }

    @media print {
      body { background: white; }
      .print-btn { display: none; }
      .page { padding: 20px; }
    }
  </style>
</head>
<body>
  <div class="page">

    <!-- Header -->
    <div class="header">
      <div class="header-title">
        <h1>דוח הוצאות ילדים</h1>
        <p>תקופה: ${start} עד ${end}</p>
        <p style="margin-top:4px">הופק: ${new Date().toLocaleDateString("he-IL")}</p>
      </div>
      <div class="header-total">
        <div class="label">סה״כ לתשלום</div>
        <div class="value">${fmt(total)}</div>
      </div>
    </div>

    <!-- Summary by category -->
    <div class="summary">
      <div class="summary-card">
        <h3>פירוט לפי קטגוריה</h3>
        <table>
          <tbody>${summaryRows}</tbody>
        </table>
      </div>
      <div class="summary-card" style="display:flex;flex-direction:column;justify-content:center;align-items:center;gap:8px">
        <div style="font-size:13px;color:#64748b">סה״כ חשבוניות</div>
        <div style="font-size:36px;font-weight:900;color:#4f46e5">${invoices.length}</div>
        <div style="font-size:13px;color:#64748b">ממוצע לחשבונית</div>
        <div style="font-size:22px;font-weight:700;color:#334155">${fmt(invoices.length ? total / invoices.length : 0)}</div>
      </div>
    </div>

    <!-- Invoice list -->
    <div class="section-title">פירוט מלא</div>
    ${
      invoices.length === 0
        ? '<p style="text-align:center;color:#94a3b8;padding:40px">לא נמצאו חשבוניות בטווח התאריכים הנבחר</p>'
        : `<table class="main">
        <thead>
          <tr>
            <th>תאריך</th>
            <th>קטגוריה</th>
            <th>תיאור</th>
            <th style="text-align:left">סכום</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="font-size:13px">סה״כ (${invoices.length} חשבוניות)</td>
            <td class="amount">${fmt(total)}</td>
          </tr>
        </tfoot>
      </table>`
    }

    <!-- Footer -->
    <div class="footer">
      דוח זה הופק אוטומטית על ידי מערכת סורק החשבוניות • ${new Date().toLocaleDateString("he-IL")}
    </div>
  </div>

  <button class="print-btn" onclick="window.print()">🖨️ &nbsp;הדפס / שמור כ-PDF</button>
</body>
</html>`;

    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pdf report] error:", message);
    return new NextResponse("Internal Server Error: " + message, { status: 500 });
  }
}
