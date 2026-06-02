/**
 * URL Activity Scanner — Batch Scan API Route
 *
 * Route: /api/scan  (basePath: /tools/url-activity-scanner)
 * Served at: POST https://forgeforward.app/tools/url-activity-scanner/api/scan
 *
 * This is the AIPF-008A route adapter relocated to src/app/api/scan/route.ts
 * so that all routes (page, API, and static assets) share the basePath prefix
 * /tools/url-activity-scanner and are captured by a single nginx location block.
 *
 * The original file was src/app/api/tools/url-activity-scanner/route.ts.
 * Only the import paths and the route comment have been updated. No logic
 * has changed.
 *
 * See the original AIPF-008A assumptions for full documentation:
 *   A-AIPF008A-01 — Next.js App Router convention
 *   A-AIPF008A-02 — Web API Request / Response
 *   A-AIPF008A-03 — JSON body parsing
 *   A-AIPF008A-04 — Header forwarding
 *   A-AIPF008A-05 — HTTP status codes
 *
 * This file contains NO scan logic, NO validation logic, NO rate-limit logic,
 * and NO result-mapping logic. It is purely an HTTP adapter.
 *
 * Safety guarantees:
 *   - No submitted URL, domain, resolved IP, scan result, response header,
 *     or response body is stored or logged here.
 *   - No console.log, analytics, telemetry, or error reporting is added.
 *   - Invalid JSON is caught safely and returned as INVALID_JSON (400).
 *   - Unexpected errors are caught and returned as INTERNAL_ERROR (500)
 *     with no stack trace or internal detail exposed.
 */

import { handleBatchScan } from "../../../lib/api/batchScan";
import { DEFAULT_CONFIG } from "../../../lib/security/rateLimiter";
import type { BatchScanErrorBody } from "../../../lib/api/batchScan";

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * POST /tools/url-activity-scanner/api/scan
 *
 * Accepts a JSON body `{ urls: string[] }` and returns the AIPF-008 batch
 * scan result. All enforcement (rate-limiting, SSRF, concurrency, timeout,
 * result mapping) is handled by handleBatchScan.
 *
 * Does not store or log submitted URLs, scan results, or any request metadata.
 */
export async function POST(req: Request): Promise<Response> {
  // ── Step 1: Parse JSON body ────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const errBody: BatchScanErrorBody = {
      ok: false,
      error: {
        code: "INVALID_JSON",
        message: "Invalid JSON request body.",
        retryAfterSeconds: null,
      },
      limits: DEFAULT_CONFIG,
    };
    return Response.json(errBody, { status: 400 });
  }

  // ── Step 2: Forward IP-extraction headers ──────────────────────────────────
  const headers: Record<string, string | undefined> = {};
  const xff = req.headers.get("x-forwarded-for");
  const xri = req.headers.get("x-real-ip");
  if (xff !== null) headers["x-forwarded-for"] = xff;
  if (xri !== null) headers["x-real-ip"] = xri;

  // ── Step 3: Delegate to handleBatchScan ───────────────────────────────────
  let result: Awaited<ReturnType<typeof handleBatchScan>>;
  try {
    result = await handleBatchScan({ method: req.method, headers, body });
  } catch {
    const errBody: BatchScanErrorBody = {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred. Please try again.",
        retryAfterSeconds: null,
      },
      limits: DEFAULT_CONFIG,
    };
    return Response.json(errBody, { status: 500 });
  }

  // ── Step 4: Return JSON response with handler's status code ───────────────
  return Response.json(result.body, { status: result.status });
}
