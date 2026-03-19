"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import type { CategoryDTO } from "@/lib/types";

type Mode = "scan" | "manual";

interface ManualFormState {
  amount: string;
  date: string;
  type: string;
  description: string;
}

interface ParseTimings {
  ocr: number;
  llm: number;
  total: number;
}

const TODAY = new Date().toISOString().split("T")[0];
const EMPTY_MANUAL: ManualFormState = { amount: "", date: TODAY, type: "", description: "" };

// Small timing badge component
function TimingBadge({ timings, pdfPath }: { timings: ParseTimings; pdfPath?: string }) {
  const fmt = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}ש` : `${ms}ms`;
  return (
    <div className="flex items-center gap-3 text-[10px] text-gray-400 font-mono pt-1">
      <span title="זמן OCR" className="flex items-center gap-0.5">
        <span className="text-gray-300">OCR</span> {timings.ocr > 0 ? fmt(timings.ocr) : "—"}
      </span>
      <span className="text-gray-200">·</span>
      <span title="זמן LLM" className="flex items-center gap-0.5">
        <span className="text-gray-300">LLM</span> {fmt(timings.llm)}
      </span>
      <span className="text-gray-200">·</span>
      <span title="זמן כולל" className="flex items-center gap-0.5">
        <span className="text-gray-300">סה״כ</span> {fmt(timings.total)}
      </span>
      {pdfPath && (
        <>
          <span className="text-gray-200">·</span>
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
            pdfPath === "ocr-fallback"
              ? "bg-amber-50 text-amber-500"
              : "bg-emerald-50 text-emerald-500"
          }`}>
            {pdfPath === "ocr-fallback" ? "PDF→OCR" : "PDF text"}
          </span>
        </>
      )}
    </div>
  );
}

export default function UploadPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("scan");

  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);

  const [parseStatus, setParseStatus] = useState("");
  const [parsedData, setParsedData] = useState<Record<string, unknown> | null>(null);
  const [debugData, setDebugData] = useState<Record<string, unknown> | null>(null);
  const [timings, setTimings] = useState<ParseTimings | null>(null);
  const [pdfPath, setPdfPath] = useState<string | undefined>(undefined);
  const [showDebug, setShowDebug] = useState(false);
  const [scanForm, setScanForm] = useState<ManualFormState>(EMPTY_MANUAL);
  const [manualForm, setManualForm] = useState<ManualFormState>(EMPTY_MANUAL);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch("/api/categories");
      if (res.ok) setCategories(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  const firstCategory = categories[0]?.name ?? "אחר";

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f) { setParsedData(null); setDebugData(null); setParseStatus(""); setTimings(null); setPdfPath(undefined); }
  };

  const handleParse = async () => {
    if (!file) return;
    setLoading(true);
    setParseStatus("מעלה קובץ וקורא טקסט (OCR)… ייתכן שייקח עד חצי דקה.");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/parse", { method: "POST", body: fd });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "שגיאה בפענוח");

      setParseStatus("פענוח הצליח! אנא אשר את הנתונים:");
      setParsedData(result.data);
      setDebugData(result.debug);
      setTimings(result.timings ?? null);
      setPdfPath(result.debug?.pdfPath);
      setScanForm({
        amount: result.data?.amount?.toString() ?? "",
        date: result.data?.date ?? TODAY,
        type: result.data?.type ?? firstCategory,
        description: result.data?.description ?? "",
      });
    } catch (err) {
      alert("שגיאה בפענוח: " + (err instanceof Error ? err.message : String(err)));
      setParseStatus("הפענוח נכשל. ניתן להזין ידנית.");
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent, form: ManualFormState) => {
    e.preventDefault();
    if (!file && mode === "scan") return;
    setLoading(true);
    try {
      const fd = new FormData();
      if (file) fd.append("file", file);
      fd.append("invoiceData", JSON.stringify(form));
      const res = await fetch("/api/invoices", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "שגיאה בשמירה" }));
        throw new Error(err.error);
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      alert("שגיאה בשמירה: " + (err instanceof Error ? err.message : String(err)));
      setLoading(false);
    }
  };

  const handleReset = () => {
    setFile(null); setParsedData(null); setDebugData(null);
    setScanForm(EMPTY_MANUAL); setParseStatus(""); setTimings(null); setPdfPath(undefined);
  };

  const renderFormFields = (form: ManualFormState, setForm: (f: ManualFormState) => void) => (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-bold text-gray-700 mb-1">סכום (₪)</label>
          <input type="number" step="0.01" required value={form.amount}
            onChange={e => setForm({ ...form, amount: e.target.value })}
            className="w-full rounded-xl border border-gray-200 p-3 focus:ring-2 focus:ring-indigo-500 outline-none text-right"
            placeholder="0.00" />
        </div>
        <div>
          <label className="block text-sm font-bold text-gray-700 mb-1">תאריך</label>
          <input type="date" required value={form.date}
            onChange={e => setForm({ ...form, date: e.target.value })}
            className="w-full rounded-xl border border-gray-200 p-3 focus:ring-2 focus:ring-indigo-500 outline-none" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-bold text-gray-700 mb-1">קטגוריה</label>
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}
            className="w-full rounded-xl border border-gray-200 p-3 focus:ring-2 focus:ring-indigo-500 outline-none">
            {categories.length > 0
              ? categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)
              : <><option value="מזון">מזון</option><option value="ביגוד">ביגוד</option>
                  <option value="חוגים">חוגים</option><option value="בריאות">בריאות</option>
                  <option value="אחר">אחר</option></>
            }
          </select>
        </div>
        <div>
          <label className="block text-sm font-bold text-gray-700 mb-1">תיאור</label>
          <input type="text" value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            className="w-full rounded-xl border border-gray-200 p-3 focus:ring-2 focus:ring-indigo-500 outline-none"
            placeholder="לדוגמה: נעליים לדני" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-bold text-gray-700 mb-1">צרף קובץ (אופציונלי)</label>
        <label className="flex items-center gap-3 cursor-pointer border border-dashed border-gray-300 rounded-xl p-4 hover:bg-gray-50 transition">
          <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
          <span className="text-sm text-gray-500 truncate">{file ? file.name : "בחר קובץ (PDF, תמונה)"}</span>
          <input type="file" className="hidden" accept="image/*,application/pdf" onChange={handleFileSelect} />
        </label>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navbar />
      <main className="flex-1 w-full max-w-2xl mx-auto py-6 px-4 sm:py-10">

        {/* Mode toggle */}
        <div className="flex rounded-2xl overflow-hidden border border-gray-200 mb-6 bg-white shadow-sm">
          <button onClick={() => { setMode("scan"); handleReset(); }}
            className={`flex-1 py-3 font-bold text-sm transition flex items-center justify-center gap-2 ${mode === "scan" ? "bg-indigo-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            סריקה אוטומטית
          </button>
          <button onClick={() => { setMode("manual"); handleReset(); setManualForm({ ...EMPTY_MANUAL, type: firstCategory }); }}
            className={`flex-1 py-3 font-bold text-sm transition flex items-center justify-center gap-2 ${mode === "manual" ? "bg-indigo-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            הזנה ידנית
          </button>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50 px-6 py-4">
            <h1 className="text-lg font-bold text-gray-900">
              {mode === "scan" ? "סריקה ופענוח חשבונית" : "הוספת הוצאה ידנית"}
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {mode === "scan" ? "העלה קובץ והבינה המלאכותית תפענח עבורך." : "הזן את הפרטים ידנית, קובץ אופציונלי."}
            </p>
          </div>

          <div className="p-6 space-y-5">

            {/* ── SCAN MODE ── */}
            {mode === "scan" && (
              <>
                {!parsedData ? (
                  <>
                    <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 flex flex-col items-center gap-4 bg-gray-50 hover:bg-gray-100 transition">
                      <svg className="w-10 h-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      <label className="cursor-pointer bg-white border border-gray-300 rounded-xl px-5 py-2.5 text-sm font-semibold hover:bg-gray-50 transition text-gray-700 shadow-sm text-center">
                        בחר קובץ — PDF, תמונה, או צלם עם המצלמה
                        <input type="file" className="hidden" accept="image/*,application/pdf" onChange={handleFileSelect} />
                      </label>
                      {file && <p className="text-sm font-semibold text-indigo-600 text-center break-all">{file.name}</p>}
                    </div>

                    {file && (
                      <button onClick={handleParse} disabled={loading}
                        className="w-full bg-gradient-to-l from-blue-600 to-indigo-600 text-white py-3.5 rounded-xl font-bold shadow-md hover:shadow-lg transition disabled:opacity-50">
                        {loading ? parseStatus : "🔍 התחל סריקה ופענוח אוטומטי"}
                      </button>
                    )}

                    {loading && (
                      <div className="flex flex-col items-center gap-3 py-2">
                        <div className="w-7 h-7 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
                        <p className="text-sm text-gray-500 text-center">{parseStatus}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <form onSubmit={e => handleSave(e, scanForm)} className="space-y-5 animate-in fade-in duration-300">
                    <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-green-800 text-sm font-medium flex items-center justify-between gap-2 flex-wrap">
                      <span>✅ {parseStatus}</span>
                      {/* ── Timing badge — subtle, right-aligned ── */}
                      {timings && <TimingBadge timings={timings} pdfPath={pdfPath} />}
                    </div>

                    {renderFormFields(scanForm, setScanForm)}

                    <div className="flex gap-3 pt-2">
                      <button type="submit" disabled={loading}
                        className="flex-1 bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 transition disabled:opacity-50">
                        {loading ? "שומר…" : "שמור"}
                      </button>
                      <button type="button" onClick={handleReset} disabled={loading}
                        className="px-5 bg-gray-100 text-gray-600 py-3 rounded-xl font-bold hover:bg-gray-200 transition">
                        ביטול
                      </button>
                    </div>

                    {/* Debug panel */}
                    {debugData && (
                      <div className="pt-4 border-t border-gray-100">
                        <button type="button" onClick={() => setShowDebug(!showDebug)}
                          className="text-xs text-gray-400 flex items-center gap-1 hover:text-gray-600">
                          <svg className={`w-3.5 h-3.5 transition ${showDebug ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                          {showDebug ? "הסתר Debug" : "הצג Debug"}
                        </button>
                        {showDebug && (
                          <div className="mt-3 space-y-3 animate-in fade-in duration-200">
                            {["prompt", "ocrResponse"].map(k => (
                              <div key={k} className="p-3 bg-gray-900 rounded-lg overflow-x-auto">
                                <p className="text-blue-400 text-xs font-bold mb-1">{k}:</p>
                                <pre className="text-gray-300 text-[10px] whitespace-pre-wrap">{String((debugData as Record<string, unknown>)[k] ?? "")}</pre>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </form>
                )}
              </>
            )}

            {/* ── MANUAL MODE ── */}
            {mode === "manual" && (
              <form onSubmit={e => handleSave(e, manualForm)} className="space-y-5">
                {renderFormFields(manualForm, setManualForm)}
                <div className="flex gap-3 pt-2">
                  <button type="submit" disabled={loading}
                    className="flex-1 bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition disabled:opacity-50">
                    {loading ? "שומר…" : "הוסף הוצאה"}
                  </button>
                  <button type="button" onClick={() => router.push("/")}
                    className="px-5 bg-gray-100 text-gray-600 py-3 rounded-xl font-bold hover:bg-gray-200 transition">
                    ביטול
                  </button>
                </div>
              </form>
            )}

          </div>
        </div>
      </main>
    </div>
  );
}
