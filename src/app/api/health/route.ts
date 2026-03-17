import { NextResponse } from "next/server";

/**
 * GET /api/health
 * Used by Docker health-check and load-balancers.
 * Returns 200 + JSON — no auth required.
 */
export async function GET() {
  return NextResponse.json({ status: "ok", ts: Date.now() });
}
