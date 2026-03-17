"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type { InvoiceDTO, CategoryDTO } from "@/lib/types";

interface DashboardProps {
  initialInvoices: InvoiceDTO[];
  userName: string | null | undefined;
}

const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

export default function Dashboard({ initialInvoices, userName }: DashboardProps) {
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [invoices, setInvoices] = useState<InvoiceDTO[]>(initialInvoices);
  const [loading, setLoading] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<InvoiceDTO | null>(null);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);

  const fetchInvoices = useCallback(async (date: Date) => {
    setLoading(true);
    try {
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      const res = await fetch(`/api/reports/data?year=${year}&month=${month}`);
      if (res.ok) {
        const data: InvoiceDTO[] = await res.json();
        setInvoices(data);
      }
    } catch (err) {
      console.error("[Dashboard] fetchInvoices error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch("/api/categories");
      if (res.ok) {
        const data: CategoryDTO[] = await res.json();
        setCategories(data);
      }
    } catch (err) {
      console.error("[Dashboard] fetchCategories error:", err);
    }
  }, []);

  useEffect(() => {
    fetchInvoices(currentDate);
    fetchCategories();
  }, [currentDate, fetchInvoices, fetchCategories]);

  // ── RTL-aware navigation ─────────────────────────────────────────────────────
  // In RTL layout: right button → goes FORWARD (next month)
  //                left button  → goes BACKWARD (prev month)
  const handlePrevMonth = () =>
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const handleNextMonth = () =>
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));

  function monthRange() {
    const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1)
      .toISOString().split("T")[0];
    const end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0)
      .toISOString().split("T")[0];
    return { start, end };
  }

  const handleUpdateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingInvoice) return;
    try {
      const res = await fetch(`/api/invoices/${editingInvoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: editingInvoice.amount,
          expenseType: editingInvoice.expenseType,
          date: editingInvoice.date,
          description: editingInvoice.description,
        }),
      });
      if (res.ok) {
        setEditingInvoice(null);
        fetchInvoices(currentDate);
      } else {
        alert("שגיאה בעדכון החשבונית");
      }
    } catch (err) {
      console.error("[Dashboard] updateInvoice error:", err);
    }
  };

  const handleDeleteInvoice = async (id: string) => {
    if (!confirm("האם אתה בטוח שברצונך למחוק חשבונית זו?")) return;
    try {
      const res = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
      if (res.ok) fetchInvoices(currentDate);
    } catch (err) {
      console.error("[Dashboard] deleteInvoice error:", err);
    }
  };

  const totalAmount = invoices.reduce((sum, inv) => sum + inv.amount, 0);
  const { start, end } = monthRange();

  return (
    <div className="animate-in fade-in duration-500 space-y-8">

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h1 className="text-3xl font-black text-gray-900 tracking-tight">שלום, {userName}</h1>
          <p className="text-gray-500 mt-1 font-medium">
            סיכום הוצאות לחודש {MONTH_NAMES[currentDate.getMonth()]} {currentDate.getFullYear()}
          </p>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <Link
            href="/upload"
            className="flex-1 md:flex-none text-center bg-indigo-600 text-white px-6 py-3 rounded-2xl font-bold hover:bg-indigo-700 transition shadow-lg shadow-indigo-200"
          >
            + הוסף חשבונית
          </Link>
        </div>
      </div>

      {/* Month selector + Total */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 glass-card rounded-3xl p-6 flex items-center justify-between">
          {/*
            RTL layout: right side = visual "forward" = next month → chevron-left icon (‹)
                         left side  = visual "back"    = prev month → chevron-right icon (›)
          */}
          <button
            onClick={handleNextMonth}
            aria-label="חודש הבא"
            className="p-2 hover:bg-gray-100 rounded-full transition"
          >
            {/* Points LEFT — in RTL this means "go to next/newer month" */}
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <div className="text-xl font-bold text-gray-800">
            {MONTH_NAMES[currentDate.getMonth()]} {currentDate.getFullYear()}
          </div>

          <button
            onClick={handlePrevMonth}
            aria-label="חודש קודם"
            className="p-2 hover:bg-gray-100 rounded-full transition"
          >
            {/* Points RIGHT — in RTL this means "go to prev/older month" */}
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        <div className="bg-indigo-600 rounded-3xl p-6 text-white shadow-xl shadow-indigo-100 flex flex-col justify-center">
          <p className="text-indigo-100 text-sm font-bold uppercase tracking-wider">סה״כ הוצאות</p>
          <div className="text-3xl font-black mt-1">₪{totalAmount.toLocaleString("he-IL")}</div>
        </div>
      </div>

      {/* Invoice table */}
      <div className="glass-card rounded-3xl overflow-hidden">
        <div className="px-8 py-6 border-b border-gray-100 flex justify-between items-center flex-wrap gap-3">
          <h3 className="text-lg font-bold text-gray-800">פירוט חשבוניות</h3>
          <div className="flex gap-2">
            <a
              href={`/api/reports/export?start=${start}&end=${end}`}
              className="text-xs font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 px-3 py-1.5 rounded-lg hover:bg-emerald-100 transition flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Excel
            </a>
            <a
              href={`/api/reports/pdf?start=${start}&end=${end}`}
              className="text-xs font-bold bg-blue-50 border border-blue-200 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              PDF
            </a>
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center">
            <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-3" />
            <p className="text-gray-500 font-bold">טוען נתונים…</p>
          </div>
        ) : invoices.length === 0 ? (
          <div className="p-16 text-center">
            <div className="text-5xl mb-4">📄</div>
            <div className="text-gray-400 mb-4 font-medium">לא נמצאו חשבוניות לחודש זה</div>
            <Link href="/upload" className="text-indigo-600 font-bold hover:underline">
              העלה חשבונית עכשיו
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="bg-gray-50/50 text-gray-500 text-xs font-bold uppercase tracking-widest">
                  <th className="px-6 py-4">תאריך</th>
                  <th className="px-6 py-4">קטגוריה</th>
                  <th className="px-6 py-4">תיאור</th>
                  <th className="px-6 py-4 text-left">סכום</th>
                  <th className="px-4 py-4 w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-indigo-50/30 transition group">
                    <td className="px-6 py-4 text-sm font-medium text-gray-600 whitespace-nowrap">
                      {new Date(inv.date).toLocaleDateString("he-IL")}
                    </td>
                    <td className="px-6 py-4">
                      <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap">
                        {inv.expenseType}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600 font-medium max-w-xs">
                      <span className="block truncate">{inv.description}</span>
                    </td>
                    <td className="px-6 py-4 text-lg font-black text-gray-900 text-left whitespace-nowrap">
                      ₪{inv.amount.toFixed(2)}
                    </td>
                    <td className="px-4 py-4 text-left">
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
                        <button
                          onClick={() => setEditingInvoice(inv)}
                          aria-label="ערוך"
                          className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDeleteInvoice(inv.id)}
                          aria-label="מחק"
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editingInvoice && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold">עריכת חשבונית</h2>
              <button
                onClick={() => setEditingInvoice(null)}
                className="text-gray-400 hover:text-gray-600 transition p-1"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleUpdateInvoice} className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">סכום (₪)</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={editingInvoice.amount}
                  onChange={(e) =>
                    setEditingInvoice({ ...editingInvoice, amount: parseFloat(e.target.value) })
                  }
                  className="w-full rounded-xl border-gray-200 border p-3 focus:ring-2 focus:ring-indigo-500 outline-none text-right"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">קטגוריה</label>
                <select
                  value={editingInvoice.expenseType}
                  onChange={(e) =>
                    setEditingInvoice({ ...editingInvoice, expenseType: e.target.value })
                  }
                  className="w-full rounded-xl border-gray-200 border p-3 focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  {categories.length > 0
                    ? categories.map((c) => (
                        <option key={c.id} value={c.name}>{c.name}</option>
                      ))
                    : (
                      <>
                        <option value={editingInvoice.expenseType}>{editingInvoice.expenseType}</option>
                        <option value="אחר">אחר</option>
                      </>
                    )
                  }
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">תאריך</label>
                <input
                  type="date"
                  required
                  value={new Date(editingInvoice.date).toISOString().split("T")[0]}
                  onChange={(e) => setEditingInvoice({ ...editingInvoice, date: e.target.value })}
                  className="w-full rounded-xl border-gray-200 border p-3 focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">תיאור</label>
                <input
                  type="text"
                  value={editingInvoice.description ?? ""}
                  onChange={(e) =>
                    setEditingInvoice({ ...editingInvoice, description: e.target.value })
                  }
                  className="w-full rounded-xl border-gray-200 border p-3 focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="תיאור קצר"
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  className="flex-1 bg-indigo-600 text-white p-3 rounded-xl font-bold hover:bg-indigo-700 transition"
                >
                  שמור שינויים
                </button>
                <button
                  type="button"
                  onClick={() => setEditingInvoice(null)}
                  className="flex-1 bg-gray-100 text-gray-600 p-3 rounded-xl font-bold hover:bg-gray-200 transition"
                >
                  ביטול
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
