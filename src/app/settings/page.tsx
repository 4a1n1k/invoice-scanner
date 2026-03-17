"use client";

import { useState, useEffect } from "react";
import Navbar from "@/components/Navbar";

export default function SettingsPage() {
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [newCategory, setNewCategory] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/categories");
      if (res.ok) {
        setCategories(await res.json());
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCategory.trim()) return;

    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCategory }),
      });
      if (res.ok) {
        setNewCategory("");
        fetchCategories();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteCategory = async (id: string) => {
    if (!confirm("האם אתה בטוח שברצונך למחוק קטגוריה זו?")) return;

    try {
      const res = await fetch(`/api/categories?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        fetchCategories();
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8 animate-in fade-in duration-500">
        <div className="glass-card rounded-3xl overflow-hidden">
          <div className="px-8 py-6 border-b border-gray-100 bg-gray-50/30">
            <h1 className="text-2xl font-black text-gray-900">הגדרות מערכת</h1>
            <p className="text-gray-500 text-sm mt-1">נהל את קטגוריות ההוצאות שלך</p>
          </div>

          <div className="p-8 space-y-8">
            {/* Add Category */}
            <section>
              <h3 className="text-lg font-bold text-gray-800 mb-4">הוסף קטגוריה חדשה</h3>
              <form onSubmit={handleAddCategory} className="flex gap-3">
                <input
                  type="text"
                  placeholder="שם הקטגוריה (למשל: גן, חוגים, בריאות)"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="flex-1 rounded-2xl border-gray-200 border p-4 focus:ring-2 focus:ring-indigo-500 outline-none font-medium"
                />
                <button
                  type="submit"
                  className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-bold hover:bg-indigo-700 transition shadow-lg shadow-indigo-100"
                >
                  הוסף
                </button>
              </form>
            </section>

            {/* List Categories */}
            <section>
              <h3 className="text-lg font-bold text-gray-800 mb-4">קטגוריות קיימות</h3>
              {loading ? (
                <div className="py-8 text-center text-gray-400 font-bold">טוען קטגוריות...</div>
              ) : categories.length === 0 ? (
                <div className="py-12 bg-gray-50 rounded-2xl text-center text-gray-400 border-2 border-dashed border-gray-100">
                  טרם הוספת קטגוריות
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {categories.map((cat) => (
                    <div key={cat.id} className="bg-white border border-gray-100 rounded-2xl p-5 flex justify-between items-center group hover:border-indigo-200 transition">
                      <span className="font-bold text-gray-700">{cat.name}</span>
                      <button
                        onClick={() => handleDeleteCategory(cat.id)}
                        className="text-gray-300 hover:text-red-500 transition p-2"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
