/**
 * PATCH /api/invoices/:id  — update an invoice's editable fields
 * DELETE /api/invoices/:id — delete an invoice (ownership-checked)
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { InvoiceEditFields } from "@/lib/types";

// ── Shared ownership check ────────────────────────────────────────────────────

async function getOwnedInvoice(id: string, userId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice || invoice.userId !== userId) return null;
  return invoice;
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body: Partial<InvoiceEditFields> = await req.json();

    const existing = await getOwnedInvoice(id, session.user.id);
    if (!existing) {
      return NextResponse.json({ error: "Invoice not found or access denied" }, { status: 404 });
    }

    const updated = await prisma.invoice.update({
      where: { id },
      data: {
        ...(body.amount !== undefined && { amount: Number(body.amount) }),
        ...(body.expenseType && { expenseType: body.expenseType }),
        ...(body.date && { date: new Date(body.date) }),
        ...(body.description !== undefined && { description: body.description }),
      },
    });

    // Serialize dates for JSON response
    return NextResponse.json({ ...updated, date: updated.date.toISOString() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[invoices PATCH] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const existing = await getOwnedInvoice(id, session.user.id);
    if (!existing) {
      return NextResponse.json({ error: "Invoice not found or access denied" }, { status: 404 });
    }

    await prisma.invoice.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[invoices DELETE] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
