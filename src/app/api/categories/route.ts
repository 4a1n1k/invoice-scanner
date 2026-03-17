/**
 * /api/categories — CRUD for user-defined expense categories.
 *
 * DELETE accepts BOTH:
 *   - query param:  DELETE /api/categories?id=xxx  (used by Settings page)
 *   - JSON body:    DELETE /api/categories  { "id": "xxx" }  (used by Upload page)
 * This keeps both call sites working without changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { CategoryDTO } from "@/lib/types";

// ── Auth helper ────────────────────────────────────────────────────────────────

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session.user.id;
}

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse<CategoryDTO[] | { error: string }>> {
  const userId = await requireAuth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const categories = await prisma.category.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return NextResponse.json(categories);
}

// ── POST ───────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse<CategoryDTO | { error: string }>> {
  const userId = await requireAuth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  try {
    const category = await prisma.category.create({
      data: { name, userId },
      select: { id: true, name: true },
    });
    return NextResponse.json(category, { status: 201 });
  } catch {
    // Prisma unique constraint violation
    return NextResponse.json({ error: "Category already exists" }, { status: 409 });
  }
}

// ── DELETE ─────────────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest): Promise<NextResponse<{ success: true } | { error: string }>> {
  const userId = await requireAuth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Support both ?id=xxx query param AND { "id": "xxx" } JSON body
  const { searchParams } = new URL(req.url);
  let id = searchParams.get("id") ?? "";

  if (!id) {
    const body = await req.json().catch(() => ({}));
    id = typeof body.id === "string" ? body.id : "";
  }

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  try {
    await prisma.category.delete({
      where: { id, userId },
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Category not found" }, { status: 404 });
  }
}

// ── PUT ────────────────────────────────────────────────────────────────────────

export async function PUT(req: NextRequest): Promise<NextResponse<CategoryDTO | { error: string }>> {
  const userId = await requireAuth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!id || !name) {
    return NextResponse.json({ error: "ID and name are required" }, { status: 400 });
  }

  try {
    const category = await prisma.category.update({
      where: { id, userId },
      data: { name },
      select: { id: true, name: true },
    });
    return NextResponse.json(category);
  } catch {
    return NextResponse.json({ error: "Category not found" }, { status: 404 });
  }
}
