/**
 * AIPF-008A: Batch Scan API Route Adapter
 *
 * Thin HTTP adapter that exposes the AIPF-008 batch scan handler over HTTP.
 * This file follows the Next.js App Router convention (named method exports
 * returning Web API Response objects) so it will work unchanged when
 * AIPF-009 scaffolds the Next.js application.
 *
 * Responsibilities of this file:
 *   1. Parse the incoming JSON request body.
 *   2. Forward the x-forwarded-for and x-real-ip headers for client IP
 *      extraction (A-AIPF008-03).
 *   3. Delegate everything else — scanning, validation, DNS, rate-limiting,
 *      concurrency, timeout, and result mapping — to handleBatchScan.
 *   4. Return handleBatchScan's response as a JSON HTTP response with the
 *      correct HTTP status code.
 *
 * This file contains NO scan logic, NO validation logic, NO rate-limit logic,
 * and NO result-mapping logic. It is purely an HTTP adapter.
 *
 * Safety guarantees:
 *   - No submitted URL, domain, resolved IP, scan result, response header,
 *     or response body is stored or logged here.
 *   - No console.log, console.error, analytics, telemetry, or error reporting
 *     is added in this ticket.
 *   - Invalid JSON is caught safely and returned as INVALID_JSON.
 *   - Unexpected errors from handleBatchScan are caught and returned as
 *     INTERNAL_ERROR with no stack trace or internal detail exposed.
 *
 * Assumption A-AIPF008A-01 — Next.js App Router convention:
 *   Named async function exports (POST, GET, etc.) are the route handler
 *   convention for Next.js App Router. Only POST is exported here because
 *   the scanner endpoint accepts only POST requests. Next.js automatically
 *   returns 405 for all other methods when no other named export exists.
 *   When AIPF-009 adds Next.js, this file requires no changes.
 *
 * Assumption A-AIPF008A-02 — Web API Request / Response:
 *   The route uses the standard WHATWG Request/Response types, which are
 *   stable globals in Node.js 20 (this project's runtime). No Next.js–
 *   specific NextRequest/NextResponse types are used, so the file is
 *   testable in isolation with jest + ts-jest without a Next.js install.
 *
 * Assumption A-AIPF008A-03 — JSON body parsing:
 *   req.json() reads and parses the body. If the body is missing, empty,
 *   or not valid JSON, it rejects and the adapter returns INVALID_JSON (400).
 *   No Content-Type check is added; any body that JSON.parses is accepted.
 *
 * Assumption A-AIPF008A-04 — Header forwarding:
 *   Only x-forwarded-for and x-real-ip are forwarded. No other headers
 *   (cookies, auth, user-agent, referer, etc.) are passed to handleBatchScan.
 *   This minimises the surface area of data flowing into the scanner.
 *
 * Assumption A-AIPF008A-05 — HTTP status codes:
 *   The status field set by handleBatchScan is used directly as the HTTP
 *   response status code. The mapping is defined in AIPF-008 and already
 *   matches the AIPF-008A guidance (200, 400, 405, 408, 429, 500).
 *   BATCH_TOO_LARGE returns 400 (not 413) because handleBatchScan uses 400.
 */

import { handleBatchScan } from "../../../../lib/api/batchScan";
import { DEFAULT_CONFIG } from "../../../../lib/security/rateLimiter";
import type { BatchScanErrorBody } from "../../../../lib/api/batchScan";

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * POST /api/tools/url-activity-scanner
 *
 * Accepts a JSON body `{ urls: string[] }` and returns the AIPF-008 batch
 * scan result. All enforcement (rate-limiting, SSRF protection, concurrency,
 * timeout, result mapping) is handled by handleBatchScan.
 *
 * Does not store or log submitted URLs, scan results, or any request metadata.
 */
export async function POST(req: Request): Promise<Response> {
  // ── Step 1: Parse JSON body ────────────────────────────────────────────────
  //
  // req.json() throws if the body is absent, empty, or not valid JSON.
  // All such cases are surfaced as INVALID_JSON (400) with no internal detail.
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
  //
  // Only x-forwarded-for and x-real-ip are forwarded (A-AIPF008A-04).
  // Both may be absent; handleBatchScan falls back to "unknown" in that case.
  const headers: Record<string, string | undefined> = {};
  const xff = req.headers.get("x-forwarded-for");
  const xri = req.headers.get("x-real-ip");
  if (xff !== null) headers["x-forwarded-for"] = xff;
  if (xri !== null) headers["x-real-ip"] = xri;

  // ── Step 3: Delegate to handleBatchScan ───────────────────────────────────
  //
  // The handler owns all business logic. The adapter forwards the method so
  // handleBatchScan can enforce POST-only if called outside Next.js routing.
  let result: Awaited<ReturnType<typeof handleBatchScan>>;
  try {
    result = await handleBatchScan({ method: req.method, headers, body });
  } catch {
    // handleBatchScan has its own internal try/catch and should never throw.
    // This outer catch is a last-resort safety net.
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
