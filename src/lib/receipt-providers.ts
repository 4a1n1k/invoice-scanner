/**
 * receipt-providers.ts
 *
 * Adapters for Israeli digital receipt platforms.
 * Each provider fetches structured JSON directly from the platform API
 * — no OCR, no LLM needed for data extraction.
 *
 * Supported:
 *   - Weezmo  (wee.ai → receipts.weezmo.com)  — סופרפארם, רמי לוי, מקדונלד'ס ועוד
 *   - Pairzon (*.pairzon.com)                  — Carrefour, יינות ביתן, מגה ועוד
 *   - KSP     (dsdoc.ksp.co.il/notification)   — קספ
 *   - Shilav  (wee.ai → receipts.weezmo.com)   — שילב (uses Weezmo platform)
 *
 * Adding a new provider:
 *   1. Add URL pattern to detectProvider()
 *   2. Implement fetch{ProviderName}Receipt(url) returning ReceiptData
 *   3. Add dispatch case in fetchReceiptByUrl()
 */

export interface ReceiptItem {
  name: string;
  price: number;
  quantity?: number;
  category?: string;
}

export interface ReceiptData {
  provider: "weezmo" | "pairzon" | "ksp" | "unknown";
  total: number;
  date: string;           // ISO YYYY-MM-DD
  storeName: string;
  storeAddress?: string;
  items: ReceiptItem[];
  rawJson?: unknown;       // original API response for debugging
}

// ── URL pattern matching ──────────────────────────────────────────────────────

export function detectProvider(url: string): "weezmo" | "pairzon" | "ksp" | null {
  if (/wee\.ai|weezmo\.com/i.test(url)) return "weezmo";
  if (/pairzon\.com/i.test(url)) return "pairzon";
  if (/dsdoc\.ksp\.co\.il/i.test(url)) return "ksp";
  return null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json, text/html, */*",
        "Accept-Language": "he-IL,he;q=0.9",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function fetchFinalUrl(url: string, timeoutMs = 10_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "he-IL,he;q=0.9" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    return res.url; // final URL after all redirects
  } finally {
    clearTimeout(t);
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseIsoDate(raw: string | null | undefined): string {
  const today = new Date().toISOString().split("T")[0];
  if (!raw) return today;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return today;
    return d.toISOString().split("T")[0];
  } catch {
    return today;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEZMO adapter
// Flow: wee.ai/r/XXX → redirect → receipts.weezmo.com/cms.html?q={ID}&b={BIZ_ID}
//       → GET /api/receipts/{ID}?withTemplate=true
// ─────────────────────────────────────────────────────────────────────────────

interface WeezmoItem {
  name: string;
  price: number;
  quantity?: number;
  total?: number;
}

interface WeezmoAdditionalData {
  key: string;
  value: string;
}

interface WeezmoReceipt {
  id: string;
  total: number;
  createdDate?: string;
  uploadedDate?: string;
  items?: WeezmoItem[];
  flatItems?: WeezmoItem[];
  additionalData?: WeezmoAdditionalData[];
}

interface WeezmoResponse {
  receipt?: WeezmoReceipt;
}

export async function fetchWeezmoReceipt(url: string): Promise<ReceiptData> {
  // 1. Follow redirect to get final URL with q= and b= params
  const finalUrl = await fetchFinalUrl(url);

  const qMatch = finalUrl.match(/[?&]q=([^&]+)/);
  const bMatch = finalUrl.match(/[?&]b=([^&]+)/);

  if (!qMatch) throw new Error("לא ניתן לחלץ receipt ID מ-weezmo");

  const receiptId = qMatch[1];
  const bizId = bMatch?.[1] ?? "";

  // 2. Fetch API
  const apiUrl = `https://receipts.weezmo.com/api/receipts/${receiptId}?withTemplate=true`;
  const data = await fetchJson<WeezmoResponse>(apiUrl);

  const r = data.receipt;
  if (!r) throw new Error("Weezmo API לא החזיר receipt");

  // 3. Extract store name from additionalData
  const additionalData = r.additionalData ?? [];
  const branchName =
    additionalData.find(d => d.key === "BranchName")?.value ??
    additionalData.find(d => d.key === "StoreName")?.value ??
    "";
  const branchAddress =
    additionalData.find(d => d.key === "BranchAddress")?.value;

  // Store name fallback: use bizId domain heuristic
  let storeName = branchName || "סופרפארם";
  if (!branchName && bizId) {
    // Try to get it from receipt template fonts endpoint
    try {
      const fontData = await fetchJson<{ businessName?: string }>(
        `https://receipts.weezmo.com/api/Receipts/fonts/infoByBusinessId?businessId=${bizId}`
      );
      if (fontData.businessName) storeName = fontData.businessName;
    } catch { /* ignore */ }
  }

  // 4. Items
  const rawItems: WeezmoItem[] = r.items ?? r.flatItems ?? [];
  const items: ReceiptItem[] = rawItems.map(i => ({
    name: i.name,
    price: i.price,
    quantity: i.quantity,
  }));

  return {
    provider: "weezmo",
    total: r.total,
    date: parseIsoDate(r.createdDate ?? r.uploadedDate),
    storeName,
    storeAddress: branchAddress,
    items,
    rawJson: data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAIRZON adapter
// Flow: {brand}.pairzon.com/{PARTNER}/{TOKEN}
//       → redirect → ?id={RECEIPT_ID}&p={PARTNER_ID}
//       → GET /v1.0/documents/{RECEIPT_ID}?p={PARTNER_ID}
// ─────────────────────────────────────────────────────────────────────────────

interface PairzonItem {
  name: string;
  price: number;
  qty?: number;
  quantity?: number;
  category?: string[];
  code?: string;
}

interface PairzonStore {
  alias?: string;
  address?: string;
  business?: { englishName?: string };
}

interface PairzonDocument {
  total: number;
  createdDate?: string;
  uploadedDate?: string;
  items?: PairzonItem[];
  store?: PairzonStore;
  storeID?: string;
  businessID?: string;
}

export async function fetchPairzonReceipt(url: string): Promise<ReceiptData> {
  // 1. Follow redirect to get id= and p= params
  const finalUrl = await fetchFinalUrl(url);

  const idMatch = finalUrl.match(/[?&]id=([^&]+)/);
  const pMatch = finalUrl.match(/[?&]p=([^&]+)/);

  // Also try: pairzon.com/{PARTNER}/{TOKEN} pattern — partner is in path
  const pathMatch = url.match(/pairzon\.com\/(\d+)\//);

  const receiptId = idMatch?.[1];
  const partnerId = pMatch?.[1] ?? pathMatch?.[1];

  if (!receiptId) throw new Error("לא ניתן לחלץ receipt ID מ-pairzon");
  if (!partnerId) throw new Error("לא ניתן לחלץ partner ID מ-pairzon");

  // 2. Extract brand domain
  const brandMatch = url.match(/https?:\/\/([^.]+)\.pairzon\.com/);
  const brand = brandMatch?.[1] ?? "carrefour";

  // 3. Fetch API
  const apiUrl = `https://${brand}.pairzon.com/v1.0/documents/${receiptId}?p=${partnerId}`;
  const data = await fetchJson<PairzonDocument>(apiUrl);

  // 4. Store name
  const storeName =
    data.store?.alias ||
    data.store?.business?.englishName ||
    brand.charAt(0).toUpperCase() + brand.slice(1);

  // 5. Items
  const rawItems: PairzonItem[] = data.items ?? [];
  const items: ReceiptItem[] = rawItems.map(i => ({
    name: i.name,
    price: i.price,
    quantity: i.qty ?? i.quantity,
    category: i.category?.[0],
  }));

  return {
    provider: "pairzon",
    total: data.total,
    date: parseIsoDate(data.createdDate ?? data.uploadedDate),
    storeName,
    storeAddress: data.store?.address,
    items,
    rawJson: data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// KSP adapter
// Flow: dsdoc.ksp.co.il/notification/{TOKEN}
//       → HTML page with embedded JSON or structured data
//       → Parse total + items from HTML
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchKspReceipt(url: string): Promise<ReceiptData> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  let html = "";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from KSP`);
    html = await res.text();
  } finally {
    clearTimeout(t);
  }

  // Try to extract embedded JSON (KSP embeds receipt JSON in <script> tags)
  const jsonMatch = html.match(/window\.__(?:RECEIPT|DATA|receipt|data)__\s*=\s*(\{[\s\S]*?\});/) ||
                    html.match(/var\s+receiptData\s*=\s*(\{[\s\S]*?\});/) ||
                    html.match(/<script[^>]*>\s*(\{"(?:total|amount|סכום)[^}]*\})\s*<\/script>/i);

  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const total = parseFloat(data.total ?? data.amount ?? data.totalAmount ?? "0");
      return {
        provider: "ksp",
        total,
        date: parseIsoDate(data.date ?? data.createdDate),
        storeName: data.storeName ?? data.store ?? "KSP",
        storeAddress: data.storeAddress,
        items: (data.items ?? []).map((i: { name: string; price: number; quantity?: number }) => ({
          name: i.name, price: i.price, quantity: i.quantity,
        })),
        rawJson: data,
      };
    } catch { /* fall through to HTML parse */ }
  }

  // HTML parse fallback — extract total from visible text
  const totalMatch = html.match(/סה[״"]כ[^₪\d]*₪?\s*([\d,]+\.?\d*)/i) ||
                     html.match(/(?:total|סכום)[^₪\d]*₪?\s*([\d,]+\.?\d*)/i) ||
                     html.match(/₪\s*([\d,]+\.?\d*)/);
  const total = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, "")) : 0;

  const dateMatch = html.match(/(\d{2}[./\-]\d{2}[./\-]\d{2,4})/);
  let dateStr = new Date().toISOString().split("T")[0];
  if (dateMatch) {
    try {
      const parts = dateMatch[1].split(/[./\-]/);
      // DD/MM/YYYY or DD/MM/YY
      if (parts.length === 3) {
        const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
        dateStr = `${year}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
      }
    } catch { /* keep today */ }
  }

  if (total === 0) throw new Error("לא ניתן לחלץ סכום מחשבונית KSP");

  return {
    provider: "ksp",
    total,
    date: dateStr,
    storeName: "KSP",
    items: [],
    rawJson: { htmlLength: html.length },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry: dispatch to correct provider
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchReceiptByUrl(url: string): Promise<ReceiptData> {
  const provider = detectProvider(url);
  if (provider === "weezmo") return fetchWeezmoReceipt(url);
  if (provider === "pairzon") return fetchPairzonReceipt(url);
  if (provider === "ksp") return fetchKspReceipt(url);
  throw new Error(`ספק לא מזוהה: ${url}`);
}
