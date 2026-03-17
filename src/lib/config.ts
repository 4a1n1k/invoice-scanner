/**
 * Central application configuration.
 * All external service URLs and tuneable constants live here.
 * Values are driven by environment variables — the app is fully portable.
 */

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// ─── External AI Services ────────────────────────────────────────────────────

export const AI_CONFIG = {
  /** OCR service endpoint — receives multipart/form-data with an "image" field */
  ocrUrl: requireEnv("OCR_API_URL", "http://116.203.149.15:5050/ocr/file"),

  /** Ollama-compatible LLM endpoint */
  llmUrl: requireEnv("LLM_API_URL", "http://116.203.149.15:11434/api/generate"),

  /** LLM model to use for invoice parsing */
  llmModel: requireEnv("LLM_MODEL", "gemma3:4b"),

  /** Maximum characters of OCR text sent to the LLM (cost / context control) */
  llmMaxChars: parseInt(process.env.LLM_MAX_CHARS ?? "4000", 10),

  /** Request timeout in milliseconds for external AI calls */
  timeoutMs: parseInt(process.env.AI_TIMEOUT_MS ?? "55000", 10),
} as const;

// ─── Storage ─────────────────────────────────────────────────────────────────

export const STORAGE_CONFIG = {
  /**
   * Root folder for uploaded files, relative to process.cwd().
   * Using a relative path makes the app portable across machines and Docker.
   */
  uploadRoot: requireEnv("STORAGE_ROOT", "storage/expenses"),
} as const;

// ─── Default categories (shown when a user has no custom ones yet) ────────────

export const DEFAULT_CATEGORIES = [
  "מזון",
  "ביגוד",
  "חוגים",
  "בריאות",
  "אחר",
] as const;

export type DefaultCategory = (typeof DEFAULT_CATEGORIES)[number];
