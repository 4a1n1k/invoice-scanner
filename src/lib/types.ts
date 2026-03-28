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

/** A single line item from an invoice */
export interface InvoiceItem {
  barcode?: string;       // ברקוד
  name: string;           // שם הפריט
  quantity: number;       // כמות
  unitPrice: number;      // מחיר ליחידה
  total: number;          // סה"כ לפני הנחה
  discount?: number;      // הנחה (₪)
  finalPrice: number;     // מחיר סופי לאחר הנחה
}

/** The structured result returned by Gemini after parsing an invoice */
export interface ParsedInvoice {
  amount: number;          // סה"כ לתשלום
  date: string;            // YYYY-MM-DD
  type: string;            // קטגוריה
  description: string;     // שם העסק
  items: InvoiceItem[];    // פריטים מפורטים
  vat?: number;            // מע"מ
  paymentMethod?: string;  // אמצעי תשלום
  storeAddress?: string;   // כתובת העסק
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
