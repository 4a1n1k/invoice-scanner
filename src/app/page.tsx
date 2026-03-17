import { auth } from "@/auth";
import Navbar from "@/components/Navbar";
import { prisma } from "@/lib/prisma";
import Dashboard from "@/components/Dashboard";
import type { InvoiceDTO } from "@/lib/types";

export default async function Home() {
  const session = await auth();

  let initialInvoices: InvoiceDTO[] = [];

  if (session?.user?.id) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const rows = await prisma.invoice.findMany({
      where: {
        userId: session.user.id,
        date: { gte: startOfMonth, lte: endOfMonth },
      },
      orderBy: { date: "desc" },
      select: {
        id: true,
        amount: true,
        expenseType: true,
        date: true,
        description: true,
        filePath: true,
        originalName: true,
      },
    });

    // Serialize Date → ISO string for safe JSON / React prop passing
    initialInvoices = rows.map((inv) => ({
      ...inv,
      date: inv.date.toISOString(),
    }));
  }

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
        {!session ? (
          <div className="text-center py-24 glass-card rounded-3xl relative overflow-hidden flex flex-col items-center">
            <div className="absolute top-0 left-0 w-full h-2 bg-indigo-600" />
            <h1 className="text-4xl md:text-6xl font-black text-gray-900 mb-6 drop-shadow-sm px-4">
              סורק החשבוניות
            </h1>
            <p className="text-lg md:text-xl text-gray-600 mb-10 max-w-2xl leading-relaxed px-6">
              הכלי החכם לניהול ומעקב אחר הוצאות ילדים באמצעות בינה מלאכותית.
            </p>
            <div className="flex gap-4">
              <a
                href="/login"
                className="bg-indigo-600 text-white px-8 py-3 rounded-2xl font-bold shadow-lg shadow-indigo-100 hover:scale-105 transition"
              >
                התחל עכשיו
              </a>
            </div>
          </div>
        ) : (
          <Dashboard
            initialInvoices={initialInvoices}
            userName={session.user?.name}
          />
        )}
      </main>
    </div>
  );
}
