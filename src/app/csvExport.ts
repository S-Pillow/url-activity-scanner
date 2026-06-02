/**
 * AIPF-011: Client-side CSV export utilities for the URL Activity Scanner.
 *
 * Pure functions — no network requests, no DOM interaction, no storage.
 * All logic is deterministic and fully testable without component mounting.
 *
 * Safety guarantees:
 *   - Only the seven AIPF-001 approved fields are ever included in the CSV.
 *   - No response body, headers, page metadata, DNS records, resolved IPs,
 *     client IP, rate-limit data, or internal validation objects are exported.
 *   - Values are RFC 4180 escaped.
 *   - The privacy notice reminds recipients to handle the file carefully.
 *
 * A-AIPF011-01: The privacy notice is a comment row with a '#' prefix.
 *   RFC 4180 does not define comment syntax, but '#' is the most widely
 *   recognised convention. Spreadsheet tools that do not understand '#'
 *   will treat it as a data row, which is harmless given its content.
 *
 * A-AIPF011-02: checked_at is exported as the raw ISO 8601 UTC string from
 *   the backend (e.g. "2026-06-02T04:33:16.000Z"). The formatted display
 *   string ("2026-06-02 04:33:16 UTC") is for on-page display only; the ISO
 *   form is more useful for programmatic consumers of the CSV file.
 *
 * A-AIPF011-03: Filename timestamp uses UTC field accessors to remain
 *   unambiguous across client timezones, consistent with formatCheckedAt()
 *   in page.tsx.
 *
 * A-AIPF011-04: ScanResult is re-declared here so that csvExport.ts has no
 *   runtime dependency on backend security modules. The shape is identical to
 *   the ScanResult interface in src/lib/security/resultMapper.ts and is
 *   governed by the AIPF-001 result contract.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** The seven AIPF-001 user-facing fields returned per scanned URL. */
export interface ScanResult {
  /** Raw string as submitted by the user. Plain text only. */
  original_input: string;
  /** Normalised URL used for scanning. Plain text only. Null on validation failure. */
  normalized_url: string | null;
  /** User-facing result string from the AIPF-001 result key (e.g. "200 OK"). */
  result: string;
  /** Human-readable meaning of the result. */
  meaning: string;
  /** Final URL after redirects, plain text only. Null when no redirect occurred. */
  redirected_to: string | null;
  /** ISO 8601 UTC timestamp generated at mapping time. */
  checked_at: string;
  /** Operational context notes. Null when no additional context exists. */
  notes: string | null;
}

// ─── CSV escaping (RFC 4180) ──────────────────────────────────────────────────

/**
 * Escapes a single CSV cell value per RFC 4180:
 *   - null/undefined → empty string (empty cell, no quotes)
 *   - Values containing comma, double-quote, newline (LF), or carriage return
 *     (CR) are wrapped in double quotes; internal double quotes are doubled.
 *
 * @example escapeCsvCell(null)         → ""
 * @example escapeCsvCell("hello")      → "hello"
 * @example escapeCsvCell("a,b")        → '"a,b"'
 * @example escapeCsvCell('say "hi"')   → '"say ""hi"""'
 * @example escapeCsvCell("a\nb")       → '"a\nb"'
 */
export function escapeCsvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PRIVACY_NOTICE =
  "# Privacy Notice: These results may contain sensitive URLs. Handle according to " +
  "your organization\u2019s data-handling policy. This file was generated client-side " +
  "from temporary in-browser results and was not saved by the server.";

/**
 * Exact CSV header row for the seven approved AIPF-001 fields.
 * Column order must match the data row mapping in buildCsv().
 */
export const CSV_HEADER =
  "original_input,normalized_url,result,meaning,redirected_to,checked_at,notes";

// ─── CSV builder ──────────────────────────────────────────────────────────────

/**
 * Builds a complete RFC 4180 CSV string from an array of scan results.
 *
 * Output structure (CRLF row separator per RFC 4180):
 *   1. Privacy notice comment row
 *   2. Column header row
 *   3. One data row per ScanResult — only the seven approved fields
 *
 * Only the seven AIPF-001 approved fields are included.
 * No response body, headers, DNS records, IPs, or metadata are exported.
 */
export function buildCsv(results: ScanResult[]): string {
  const dataRows = results.map((r) =>
    [
      r.original_input,
      r.normalized_url,
      r.result,
      r.meaning,
      r.redirected_to,
      r.checked_at,
      r.notes,
    ]
      .map(escapeCsvCell)
      .join(",")
  );
  return [PRIVACY_NOTICE, CSV_HEADER, ...dataRows].join("\r\n");
}

// ─── Filename builder ─────────────────────────────────────────────────────────

/**
 * Generates a UTC-timestamped filename for the CSV download.
 *
 * Format: url-activity-scan-results-YYYY-MM-DD-HH-mm-ss-UTC.csv
 *
 * @param now - Injectable Date for deterministic testing. Defaults to new Date().
 */
export function buildCsvFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}-${p(now.getUTCMinutes())}-${p(now.getUTCSeconds())}-UTC`;
  return `url-activity-scan-results-${ts}.csv`;
}
