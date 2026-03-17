"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";

export default function ReportsPage() {
  const currentDate = new Date();
  const firstDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const lastDay = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

  const [startDate, setStartDate] = useState(firstDay.toISOString().split("T")[0]);
  const [endDate, setEndDate] = useState(lastDay.toISOString().split("T")[0]);
  const [loading, setLoading] = useState(false);

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      // Direct navigation to trigger file download
      window.location.href = `/api/reports/export?start=${startDate}&end=${endDate}`;
    } catch (err) {
      console.error(err);
      alert("שגיאה בהורדת הקובץ");
    } finally {
      setTimeout(() => setLoading(false), 2000); // UI visual timeout
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navbar />
      <main className="flex-1 w-full max-w-2xl mx-auto py-6 px-4 sm:py-12 sm:px-6 lg:px-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50 px-6 py-4 sm:px-8 sm:py-6">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">הפקת דוחות לחשבוניות</h1>
            <p className="mt-1 text-xs sm:text-sm text-gray-500">בחר טווח התאריכים (ברירת מחדל: מתחילת החודש ועד סופו) והורד לאקסל.</p>
          </div>

          <form onSubmit={handleExport} className="p-6 sm:p-8 space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
              <div>
                <label htmlFor="startDate" className="block text-sm font-bold text-gray-700">מתאריך</label>
                <input 
                  type="date" 
                  id="startDate"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="mt-2 block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 py-3 px-4 border text-gray-900 text-right text-sm sm:text-base"
                />
              </div>
              <div>
                <label htmlFor="endDate" className="block text-sm font-bold text-gray-700">עד תאריך</label>
                <input 
                  type="date" 
                  id="endDate"
                  required
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="mt-2 block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 py-3 px-4 border text-gray-900 text-right text-sm sm:text-base"
                />
              </div>
            </div>

            <div className="pt-4 sm:pt-6 flex flex-col sm:flex-row gap-4">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 bg-gradient-to-l from-green-500 to-emerald-600 text-white py-3.5 rounded-xl font-bold text-base sm:text-lg shadow-md hover:shadow-lg hover:from-green-600 hover:to-emerald-700 transition disabled:opacity-50 disabled:cursor-wait"
              >
                {loading ? "מכין קובץ..." : "הורד Excel (XLSX)"}
              </button>
              <button
                type="button"
                onClick={() => {
                  window.location.href = `/api/reports/pdf?start=${startDate}&end=${endDate}`;
                }}
                disabled={loading}
                className="flex-1 bg-gradient-to-l from-blue-500 to-indigo-600 text-white py-3.5 rounded-xl font-bold text-base sm:text-lg shadow-md hover:shadow-lg hover:from-blue-600 hover:to-indigo-700 transition disabled:opacity-50 disabled:cursor-wait"
              >
                {loading ? "מכין קובץ..." : "הורד PDF"}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
