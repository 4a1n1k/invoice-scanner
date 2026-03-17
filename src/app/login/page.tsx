"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Navbar from "@/components/Navbar";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await signIn("credentials", {
        redirect: false,
        email,
        password,
      });

      if (res?.error) {
        setError("אימייל או סיסמה שגויים");
        setLoading(false);
      } else {
        router.push("/");
        router.refresh();
      }
    } catch (err) {
      setError("אירעה שגיאה לא צפויה, אנא נסה שוב.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navbar />
      <div className="flex-1 flex flex-col justify-center items-center px-4 sm:px-6 lg:px-8">
        <div className="bg-white w-full max-w-md rounded-2xl shadow-xl border border-gray-100 p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-extrabold text-gray-900 mb-2">ברוך שובך</h1>
            <p className="text-gray-500">התחבר לחשבונך כדי לנהל את החשבוניות</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm font-semibold text-center border border-red-200 animate-in shake">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-bold text-gray-700 mb-1">אימייל</label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition shadow-sm bg-gray-50 text-gray-900 text-right"
                placeholder="name@example.com"
                dir="ltr"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-bold text-gray-700 mb-1">סיסמה</label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition shadow-sm bg-gray-50 text-gray-900 text-right"
                placeholder="••••••••"
                dir="ltr"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-bold shadow-md hover:shadow-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed mt-2"
            >
              {loading ? "מתחבר..." : "התחבר"}
            </button>
          </form>

          <p className="mt-8 text-center text-sm text-gray-600 font-medium">
            עדיין אין לך חשבון?{" "}
            <Link href="/register" className="text-blue-600 hover:text-blue-800 transition">
              הירשם כאן
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
