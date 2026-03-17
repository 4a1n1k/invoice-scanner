"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import type { CategoryDTO, ParsedInvoice, ParseApiResponse } from "@/lib/types";

// ─── Local form state type ────────────────────────────────────────────────────

interface InvoiceFormState {
  amount: string;
  date: string;
  type: string;
  description: string;
}

const EMPTY_FORM: InvoiceFormState = {
  amount: "",
  date: new Date().toISOString().split("T")[0],
  type: "",
  description: "",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [parseStatus, setParseStatus] = useState("");
  const [parsedData, setParsedData] = useState<ParsedInvoice | null>(null);
  const [debugData, setDebugData] = useState<ParseApiResponse["debug"] | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [newCatName, setNewCatName] = useState("");
  const [isManagingCats, setIsManagingCats] = useState(false);

  const [formData, setFormData] = useState<InvoiceFormState>(EMPTY_FORM);

  // ── Categories ──────────────────────────────────────────────────────────────

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch("/api/categories");
      if (res.ok) {
        const data: CategoryDTO[] = await res.json();
        setCategories(data);
      }
    } catch (err) {
      console.error("[Upload] fetchCategories:", err);
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const handleAddCategory = async () => {
    if (!newCatName.trim()) return;
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCatName.trim() }),
      });
      if (res.ok) {
        setNewCatName("");
        fetchCategories();
      }
    } catch (err) {
      console.error("[Upload] addCategory:", err);
      alert("שגיאה בהוספת קטגוריה");
    }
  };

  const handleDeleteCategory = async (id: string) => {
    if (!confirm("בטוח שברצונך למחוק קטגוריה זו?")) return;
    try {
      await fetch(`/api/categories?id=${id}`, { method: "DELETE" });
      fetchCategories();
    } catch (err) {
      console.error("[Upload] deleteCategory:", err);
      alert("שגיאה במחיקת קטגוריה");
    }
  };

  // ── File selection ──────────────────────────────────────────────────────────

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    if (selected) {
      setParsedData(null);
      setDebugData(null);
    }
  };

  // ── Parse ───────────────────────────────────────────────────────────────────

  const handleParse = async () => {
    if (!file) return;
    setLoading(true);
    setParseStatus("מעלה קובץ וקורא טקסט (OCR)… ייתכן שייקח עד חצי דקה.");

    try {
      const fd = new FormData();
      fd.append("file", file);

      const res = await fetch("/api/parse", { method: "POST", body: fd });
      const result: ParseApiResponse | { error: string } = await res.json();

      if (!res.ok || "error" in result) {
        throw new Error(("error" in result ? result.error : null) ?? "שגיאה בפענוח");
      }

      const { data, debug } = result as ParseApiResponse;

      setParseStatus("פענוח הצליח! אנא אשר את הנתונים:");
      setParsedData(data);
      setDebugData(debug);
      setFormData({
        amount: data.amount?.toString() ?? "",
        date: data.date ?? new Date().toISOString().split("T")[0],
        type: data.type ?? categories[0]?.name ?? "",
        description: data.description ?? "",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      alert("שגיאה בפענוח החשבונית: " + message);
      setParseStatus("הפענוח נכשל. ניתן להזין את הנתונים ידנית.");
    } finally {
      setLoading(false);
    }
  };

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setParseStatus("שומר את החשבונית במסד הנתונים…");

    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("invoiceData", JSON.stringify(formData));

      const res = await fetch("/api/invoices", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "שגיאה בשמירה" }));
        throw new Error(err.error ?? "שגיאה בשמירה");
      }

      router.push("/");
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      alert("שגיאה בשמירת החשבונית: " + message);
      setLoading(false);
    }
  };

  // ── Reset ───────────────────────────────────────────────────────────────────

  const handleReset = () => {
    setParsedData(null);
    setFile(null);
    setDebugData(null);
    setFormData(EMPTY_FORM);
    setParseStatus("");
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navbar />
      <main className="flex-1 w-full max-w-3xl mx-auto py-6 px-4 sm:py-12 sm:px-6 lg:px-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          {/* Header */}
          <div className="border-b border-gray-100 bg-gray-50 px-6 py-4 sm:px-8 sm:py-6">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">העלאת חשבונית חדשה</h1>
            <p className="mt-1 text-xs sm:text-sm text-gray-500">
              צלם או בחר קובץ, והבינה המלאכותית תפענח עבורך.
            </p>
          </div>

          <div className="p-6 sm:p-8">
            {/* ── Step 1: File picker ── */}
            {!parsedData && (
              <div className="space-y-6">
                <div className="border-2 border-dashed border-gray-300 rounded-xl p-6 sm:p-10 flex flex-col items-center justify-center bg-gray-50 hover:bg-gray-100 transition">
                  <svg
                    className="w-10 h-10 sm:w-12 sm:h-12 text-gray-400 mb-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                  <label className="cursor-pointer bg-white border border-gray-300 rounded-lg px-4 py-2 text-sm font-medium hover:bg-gray-50 transition text-gray-700 shadow-sm text-center">
                    בחר קובץ (PDF, תמונה) או הפעל מצלמה
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*,application/pdf"
                      onChange={handleFileSelect}
                    />
                  </label>
                  {file && (
                    <p className="mt-4 text-xs sm:text-sm font-semibold text-blue-600 break-all text-center">
                      קובץ נבחר: {file.name}
                    </p>
                  )}
                </div>

                {file && (
                  <button
                    onClick={handleParse}
                    disabled={loading}
                    className="w-full bg-gradient-to-l from-blue-600 to-indigo-600 text-white py-3 rounded-xl font-bold shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 transition disabled:opacity-50 disabled:cursor-wait text-sm sm:text-base"
                  >
                    {loading ? parseStatus : "התחל סריקה ופענוח אוטומטי"}
                  </button>
                )}

                {loading && (
                  <div className="flex flex-col items-center justify-center mt-4 space-y-3">
                    <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
                    <p className="text-xs sm:text-sm text-gray-600 font-medium text-center">
                      {parseStatus}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── Step 2: Confirm parsed data ── */}
            {parsedData && (
              <form
                onSubmit={handleSave}
                className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500"
              >
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-green-800 text-xs sm:text-sm font-medium">
                  {parseStatus}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                  {/* Amount */}
                  <div>
                    <label className="block text-sm font-bold text-gray-700">סכום (₪)</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={formData.amount}
                      onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                      className="mt-1 block w-full rounded-md border border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 py-2 px-3 text-gray-900 text-right text-sm sm:text-base"
                    />
                  </div>

                  {/* Date */}
                  <div>
                    <label className="block text-sm font-bold text-gray-700">תאריך</label>
                    <input
                      type="date"
                      required
                      value={formData.date}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="mt-1 block w-full rounded-md border border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 py-2 px-3 text-gray-900 text-right text-sm sm:text-base"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                  {/* Category */}
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="block text-sm font-bold text-gray-700">סוג הוצאה</label>
                      <button
                        type="button"
                        onClick={() => setIsManagingCats(!isManagingCats)}
                        className="text-xs text-blue-600 font-bold hover:underline"
                      >
                        {isManagingCats ? "סגור ניהול" : "נהל קטגוריות"}
                      </button>
                    </div>

                    {isManagingCats ? (
                      <div className="space-y-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
                        <div className="flex gap-2">
                          <input
                            type="text"
                            placeholder="קטגוריה חדשה…"
                            value={newCatName}
                            onChange={(e) => setNewCatName(e.target.value)}
                            className="flex-1 text-xs border border-gray-300 rounded px-2 py-1"
                          />
                          <button
                            type="button"
                            onClick={handleAddCategory}
                            className="bg-blue-600 text-white text-xs px-2 py-1 rounded"
                          >
                            הוסף
                          </button>
                        </div>
                        <ul className="max-h-32 overflow-y-auto space-y-1">
                          {categories.map((cat) => (
                            <li
                              key={cat.id}
                              className="flex justify-between items-center text-xs bg-white border border-gray-100 p-1.5 rounded"
                            >
                              <span>{cat.name}</span>
                              <button
                                type="button"
                                onClick={() => handleDeleteCategory(cat.id)}
                                className="text-red-500"
                                aria-label="מחק קטגוריה"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <select
                        value={formData.type}
                        onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                        className="mt-1 block w-full rounded-md border border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 py-2 px-3 text-gray-900 text-right text-sm sm:text-base"
                      >
                        {categories.length === 0 ? (
                          <>
                            <option value="מזון">מזון</option>
                            <option value="ביגוד">ביגוד</option>
                            <option value="חוגים">חוגים</option>
                            <option value="בריאות">בריאות</option>
                            <option value="אחר">אחר</option>
                          </>
                        ) : (
                          categories.map((cat) => (
                            <option key={cat.id} value={cat.name}>
                              {cat.name}
                            </option>
                          ))
                        )}
                      </select>
                    )}
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-sm font-bold text-gray-700">תיאור קצר</label>
                    <input
                      type="text"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      className="mt-1 block w-full rounded-md border border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 py-2 px-3 text-gray-900 text-right text-sm sm:text-base"
                      placeholder="לדוגמה: נעליים לדני"
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="pt-6 border-t border-gray-100 flex flex-col sm:flex-row gap-4">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 bg-green-600 text-white py-3 rounded-xl font-bold shadow-sm hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-wait text-sm sm:text-base order-1 sm:order-2"
                  >
                    {loading ? "שומר…" : "שמור בחשבון שלי"}
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={loading}
                    className="px-6 bg-white border border-gray-300 text-gray-700 py-3 rounded-xl font-bold shadow-sm hover:bg-gray-50 transition text-sm sm:text-base order-2 sm:order-1"
                  >
                    ביטול
                  </button>
                </div>

                {/* Debug panel */}
                {debugData && (
                  <div className="mt-8 pt-8 border-t border-gray-100">
                    <button
                      type="button"
                      onClick={() => setShowDebug(!showDebug)}
                      className="text-xs text-gray-500 flex items-center gap-2 hover:text-gray-800 transition"
                    >
                      <svg
                        className={`w-4 h-4 transition ${showDebug ? "rotate-180" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                      {showDebug
                        ? "הסתר נתוני שאילתה (Debug)"
                        : "הצג את השאילתה שנשלחה לשרת (Transparency)"}
                    </button>

                    {showDebug && (
                      <div className="mt-4 space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                        <div className="p-4 bg-gray-900 rounded-lg overflow-x-auto">
                          <p className="text-blue-400 text-xs font-bold mb-2">LLM Prompt:</p>
                          <pre className="text-gray-300 text-[10px] leading-relaxed whitespace-pre-wrap">
                            {debugData.prompt}
                          </pre>
                        </div>
                        <div className="p-4 bg-gray-900 rounded-lg overflow-x-auto">
                          <p className="text-green-400 text-xs font-bold mb-2">
                            OCR Output (500 chars):
                          </p>
                          <pre className="text-gray-300 text-[10px] leading-relaxed whitespace-pre-wrap">
                            {debugData.ocrResponse}
                          </pre>
                        </div>
                        <div className="p-4 bg-gray-900 rounded-lg overflow-x-auto">
                          <p className="text-purple-400 text-xs font-bold mb-2">
                            LLM Response JSON:
                          </p>
                          <pre className="text-gray-300 text-[10px] whitespace-pre-wrap">
                            {JSON.stringify(parsedData, null, 2)}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
