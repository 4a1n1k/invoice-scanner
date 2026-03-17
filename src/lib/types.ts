/**
 * Shared TypeScript types used across the application.
 * Single source of truth — no more scattered `any` types.
 */

// ─── Invoice ─────────────────────────────────────────────────────────────────

/** Raw shape returned from Prisma (dates as Date objects) */
export interface InvoiceRow {
  id: string;
  userId: string;
  amount: number;
  expenseType: string;
  date: Date;
  description: string | null;
  filePath: string;
  originalName: string | null;
  ocrText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Serialized shape safe for JSON / React props (dates as ISO strings) */
export interface InvoiceDTO {
  id: string;
  amount: number;
  expenseType: string;
  date: string; // ISO 8601
  description: string | null;
  filePath: string;
  originalName: string | null;
}

/** Fields the user can edit after parsing */
export interface InvoiceEditFields {
  amount: number;
  expenseType: string;
  date: string; // ISO 8601 or YYYY-MM-DD
  description: string | null;
}

// ─── Categories ───────────────────────────────────────────────────────────────

export interface CategoryDTO {
  id: string;
  name: string;
}

// ─── Parse pipeline ───────────────────────────────────────────────────────────

/** The structured result returned by the LLM after parsing an invoice */
export interface ParsedInvoice {
  amount: number;
  date: string; // YYYY-MM-DD
  type: string; // matches a category name
  description: string;
}

/** Full response from the /api/parse endpoint */
export interface ParseApiResponse {
  data: ParsedInvoice;
  ocrText: string;
  debug: {
    prompt: string;
    llmPayload: Record<string, unknown>;
    ocrResponse: string;
  };
}

/** Error response from the /api/parse endpoint */
export interface ParseApiError {
  error: string;
  rawResponse?: string;
}
