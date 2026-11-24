/**
 * AIPF-008: Batch Scan API Endpoint
 *
 * A framework-agnostic handler that wires AIPF-002 through AIPF-007 into a
 * single server-side batch scan operation. It accepts a plain request
 * descriptor and returns a plain response descriptor, with no dependency on
 * any HTTP framework.
 *
 * When AIPF-009 creates the Next.js app scaffold, this handler will be
 * connected to a route with a thin adapter (typically 2–4 lines).
 *
 * Safety guarantees enforced here:
 *   - Rate limiting runs before any scan work begins.
 *   - SSRF validation (AIPF-002) runs before DNS (AIPF-003).
 *   - DNS (AIPF-003) runs before HEAD (AIPF-004).
 *   - GET fallback (AIPF-005) runs only when HEAD returned 405 or 501.
 *   - Batch concurrency is bounded by maxConcurrentUrlsPerBatch.
 *   - The entire batch is bounded by maxBatchRuntimeMs.
 *   - No submitted URL, normalized URL, domain, resolved IP, scan result,
 *     response header, or response body is stored or logged.
 *   - Results contain exactly the seven AIPF-001 user-facing fields.
 *
 * Assumption A-AIPF008-01 — Framework-agnostic handler:
 *   The project has no HTTP framework (no Next.js, Express, etc.) in this
 *   library package. The handler accepts/returns plain objects so it is
 *   testable with Jest and composable with any framework. AIPF-009 will add
 *   the framework adapter.
 *
 * Assumption A-AIPF008-02 — Pre-parsed body:
 *   The caller is responsible for parsing the JSON request body before
 *   invoking handleBatchScan(). The `body` field accepts `unknown` so that
 *   both framework-parsed objects and test fixtures are compatible.
 *
 * Assumption A-AIPF008-03 — Client IP extraction:
 *   IP is read from x-forwarded-for (first token only), then x-real-ip,
 *   then falls back to "unknown". The caller (framework adapter in AIPF-009)
 *   must ensure the correct headers are forwarded. No IP is logged.
 *
 * Assumption A-AIPF008-04 — Batch timeout behaviour:
 *   One batch-scoped AbortController enforces maxBatchRuntimeMs. Its signal is
 *   propagated through the worker queue, DNS, HEAD, redirects, and GET fallback.
 *   Timeout therefore stops scheduling and active outbound HTTP(S) work rather
 *   than merely stopping the caller-visible response.
 *
 * Assumption A-AIPF008-05 — Blank URL entries:
 *   URL entries that are blank after trimming are rejected with
 *   INVALID_URL_ENTRY. If the UI later needs to silently skip blank lines this
 *   behaviour can be relaxed in a single place here.
 *
 * Assumption A-AIPF008-06 — Per-URL error isolation:
 *   If an unexpected exception escapes the per-URL scan pipeline (e.g. an
 *   unhandled rejection from a dependency), scanUrl() catches it and returns a
 *   safe fallback ScanResult for that URL. The rest of the batch continues.
 *   If the exception escapes the outer handleBatchScan() boundary (e.g. from
 *   the rate-limiter or the concurrency pool itself), a 500 INTERNAL_ERROR
 *   response is returned for the whole batch.
 */

import { validateUrl } from "../security/validateUrl";
import { resolveDns } from "../security/resolveDns";
import { sendHeadRequest } from "../security/headRequest";
import { runGetFallback } from "../security/getFallback";
import { mapResult, RESULT_KEY, MEANINGS } from "../security/resultMapper";
import { rateLimiter as defaultRateLimiter } from "../security/rateLimiter";
import type { RateLimitResult, RateLimiterConfig } from "../security/rateLimiter";
import type { ScanResult } from "../security/resultMapper";
import type { GetFallbackResult } from "../security/getFallback";
import {
  isScanAbortError,
  ScanAbortError,
  throwIfAborted,
} from "../security/cancellation";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * HEAD status codes that authorise the GET fallback.
 * Mirrors the same constant in getFallback.ts (AIPF-005).
 */
const GET_TRIGGER_CODES = new Set([405, 501]);

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Framework-agnostic representation of an inbound HTTP request.
 * The framework adapter (AIPF-009) fills these fields from the real request.
 */
export interface BatchScanRequest {
  /** HTTP method string, e.g. "POST" or "GET". Case-insensitive in handler. */
  method: string;
  /** Request headers keyed by lower-case header name. */
  headers: Record<string, string | string[] | undefined>;
  /** Pre-parsed request body. Null/undefined when no body was sent. */
  body: unknown;
}

/** Successful batch scan response body. */
export interface BatchScanSuccessBody {
  ok: true;
  /** One ScanResult per URL in the input batch, in the same order. */
  results: ScanResult[];
  /** Effective rate-limit config at time of the request. */
  limits: Readonly<RateLimiterConfig>;
}

/** Error response body for any non-200 outcome. */
export interface BatchScanErrorBody {
  ok: false;
  error: {
    /** Machine-readable error code. */
    code: string;
    /** Human-readable explanation. */
    message: string;
    /**
     * Seconds until the client may retry. Present only for rate-limit errors;
     * null for all other error types.
     */
    retryAfterSeconds: number | null;
  };
  /** Effective rate-limit config at time of the request. */
  limits: Readonly<RateLimiterConfig>;
}

/** Framework-agnostic HTTP response descriptor. */
export interface BatchScanResponse {
  /** HTTP status code (200, 400, 405, 408, 429, 500). */
  status: number;
  body: BatchScanSuccessBody | BatchScanErrorBody;
}

// ─── Minimal rate-limiter interface ──────────────────────────────────────────

/**
 * The subset of RateLimiter that handleBatchScan() requires.
 * Using an interface rather than the concrete class allows tests to inject
 * mock or custom limiters without importing the full implementation.
 */
interface RateLimiterLike {
  check: (input: unknown) => RateLimitResult;
  readonly limits: Readonly<RateLimiterConfig>;
}

// ─── Internal sentinel error ──────────────────────────────────────────────────

class BatchTimeoutError extends Error {
  constructor() {
    super("BATCH_TIMEOUT");
    this.name = "BatchTimeoutError";
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Extracts the client IP address from request headers using a conservative
 * order. Never trusts a private/internal IP as a bypass — it is simply used
 * as the rate-limit key like any other IP.
 *
 * The IP is passed to the rate limiter and never logged or included in any
 * response.
 */
function extractClientIp(
  headers: Record<string, string | string[] | undefined>
): string {
  // x-forwarded-for may contain a comma-separated list; take only the first.
  const xff = headers["x-forwarded-for"];
  if (xff) {
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }

  // x-real-ip is a single IP set by many reverse proxies.
  const xri = headers["x-real-ip"];
  if (xri) {
    const raw = Array.isArray(xri) ? xri[0] : xri;
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return "unknown";
}

/**
 * Runs an array of async tasks with bounded parallelism.
 *
 * Spawns `concurrency` workers (or fewer if tasks.length < concurrency).
 * Each worker picks the next available task index when it finishes its current
 * one. Results are placed at the original index position, preserving order.
 *
 * This is purely in-memory — no I/O is performed here.
 */
async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
  signal: AbortSignal
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Stop before claiming a queued task. nextIndex remains the count of
      // tasks actually claimed, so unstarted work is not consumed on abort.
      if (signal.aborted) return;

      const index = nextIndex;
      if (index >= tasks.length) break;
      nextIndex++;

      // Close the narrow abort boundary between claim and invocation.
      if (signal.aborted) return;

      try {
        results[index] = await tasks[index]();
      } catch (error) {
        if (signal.aborted || isScanAbortError(error)) return;
        throw error;
      }
    }
  }

  const numWorkers = Math.max(1, Math.min(concurrency, tasks.length));
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < numWorkers; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Executes the worker pool under a real cancellation deadline.
 *
 * Promise.race remains only to preserve prompt caller-visible timeout semantics
 * if an underlying platform primitive cannot stop synchronously. The timer also
 * aborts the shared controller, which is the actual execution boundary.
 */
async function runWithDeadline<T>(
  pool: Promise<T>,
  controller: AbortController,
  ms: number
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const deadline = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(new BatchTimeoutError());
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () =>
      controller.signal.removeEventListener("abort", onAbort);

    handle = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new BatchTimeoutError());
      }
    }, ms);
  });

  try {
    const result = await Promise.race([pool, deadline]);
    if (controller.signal.aborted) throw new BatchTimeoutError();
    return result;
  } finally {
    if (handle) clearTimeout(handle);
    removeAbortListener?.();
    // Promise.race installs rejection handlers on pool. Keep an explicit
    // handler as documentation/defence against late non-cooperative failures.
    void pool.catch(() => {});
  }
}

/**
 * Safe fallback ScanResult returned when an unexpected exception escapes
 * the per-URL scan pipeline (A-AIPF008-06). No URL data or error details
 * are included in the output.
 */
function makeFallbackScanResult(rawInput: string): ScanResult {
  return {
    original_input: rawInput,
    normalized_url: null,
    result: RESULT_KEY.UNKNOWN,
    meaning: MEANINGS[RESULT_KEY.UNKNOWN],
    redirected_to: null,
    checked_at: new Date().toISOString(),
    notes: null,
  };
}

/**
 * Runs one URL through the full AIPF-002 → 003 → 004 → 005 → 006 pipeline.
 *
 * Unexpected exceptions are caught and replaced with a safe fallback result
 * so that one URL's failure does not abort the rest of the batch.
 *
 * No submitted URL, domain, resolved IP, response header, or response body is
 * stored, logged, or included in the returned ScanResult.
 */
async function scanUrl(
  rawInput: string,
  signal: AbortSignal
): Promise<ScanResult> {
  try {
    throwIfAborted(signal);

    // ── AIPF-002: URL validation (SSRF gate) ──────────────────────────────────
    const validationResult = validateUrl(rawInput);
    if (!validationResult.allowed) {
      return mapResult({ validationResult });
    }

    // ── AIPF-003: DNS resolution ───────────────────────────────────────────────
    const dnsResult = await resolveDns(validationResult, { signal });
    throwIfAborted(signal);
    if (!dnsResult.allowed) {
      return mapResult({ validationResult, dnsResult });
    }

    // ── AIPF-004: HEAD request ────────────────────────────────────────────────
    const headResult = await sendHeadRequest(dnsResult, { signal });
    throwIfAborted(signal);

    // ── AIPF-005: GET fallback (only after HEAD 405 or 501) ───────────────────
    let getFallbackResult: GetFallbackResult | undefined;
    if (
      !signal.aborted &&
      headResult.statusCode !== null &&
      GET_TRIGGER_CODES.has(headResult.statusCode)
    ) {
      getFallbackResult = await runGetFallback(headResult, { signal });
      throwIfAborted(signal);
    }

    // ── AIPF-006: Final result mapping ────────────────────────────────────────
    return mapResult({ validationResult, dnsResult, headResult, getFallbackResult });

  } catch (error) {
    if (signal.aborted || isScanAbortError(error)) {
      throw new ScanAbortError();
    }
    // Unexpected error in the scan pipeline — return safe fallback (A-AIPF008-06).
    return makeFallbackScanResult(rawInput);
  }
}

/** Builds a BatchScanErrorBody-shaped response object. */
function errorResponse(
  status: number,
  code: string,
  message: string,
  retryAfterSeconds: number | null,
  limits: Readonly<RateLimiterConfig>
): BatchScanResponse {
  return {
    status,
    body: { ok: false, error: { code, message, retryAfterSeconds }, limits },
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Framework-agnostic handler for the URL Activity Scanner batch scan endpoint.
 *
 * Must be called server-side only.
 * Stores nothing. Logs nothing related to submitted URLs or scan results.
 * Returns only the seven AIPF-001 user-facing fields per URL.
 *
 * @param req  - The inbound request descriptor (method, headers, pre-parsed body).
 * @param opts - Optional injection points used by tests:
 *   - `_rateLimiter`: substitute a fresh or mock rate limiter for isolation.
 *   - `_timeoutMs`:   override maxBatchRuntimeMs for deterministic timeout tests.
 * @returns A BatchScanResponse with HTTP status and structured JSON body.
 */
export async function handleBatchScan(
  req: BatchScanRequest,
  opts?: {
    /** @internal — inject a rate limiter instance in tests. */
    _rateLimiter?: RateLimiterLike;
    /** @internal — override maxBatchRuntimeMs in tests. */
    _timeoutMs?: number;
    /** @internal — inject per-URL work for scheduler cancellation tests. */
    _scanUrl?: (url: string, signal: AbortSignal) => Promise<ScanResult>;
  }
): Promise<BatchScanResponse> {
  const limiter: RateLimiterLike = opts?._rateLimiter ?? defaultRateLimiter;
  const limits = limiter.limits;

  try {
    // ── Step 1: Method gate ───────────────────────────────────────────────────
    if (req.method.toUpperCase() !== "POST") {
      return errorResponse(
        405, "INVALID_REQUEST", "Only POST requests are accepted.", null, limits
      );
    }

    // ── Step 2: Body presence check ───────────────────────────────────────────
    const body = req.body;
    if (body === null || body === undefined) {
      return errorResponse(400, "INVALID_REQUEST", "Request body is required.", null, limits);
    }
    if (typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(400, "INVALID_REQUEST", "Request body must be a JSON object.", null, limits);
    }
    const bodyObj = body as Record<string, unknown>;

    // ── Step 3: urls field validation ─────────────────────────────────────────
    if (!("urls" in bodyObj)) {
      return errorResponse(400, "MISSING_URLS", "The 'urls' field is required.", null, limits);
    }
    if (!Array.isArray(bodyObj["urls"])) {
      return errorResponse(400, "URLS_NOT_ARRAY", "The 'urls' field must be an array.", null, limits);
    }

    const rawUrls = bodyObj["urls"] as unknown[];

    if (rawUrls.length === 0) {
      return errorResponse(400, "EMPTY_BATCH", "The 'urls' array must not be empty.", null, limits);
    }

    // ── Step 4: URL entry type check ──────────────────────────────────────────
    //
    // Blank entries are rejected per A-AIPF008-05.
    for (const entry of rawUrls) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        return errorResponse(
          400,
          "INVALID_URL_ENTRY",
          "Every entry in 'urls' must be a non-empty string.",
          null,
          limits
        );
      }
    }

    const urls = (rawUrls as string[]).map((u) => u.trim());

    // ── Step 5: Batch size check (before consuming rate-limit quota) ──────────
    if (urls.length > limits.maxUrlsPerBatch) {
      return errorResponse(
        400,
        "BATCH_TOO_LARGE",
        `Batch of ${urls.length} exceeds the limit of ${limits.maxUrlsPerBatch} URLs.`,
        null,
        limits
      );
    }

    // ── Step 6: Rate limiting ─────────────────────────────────────────────────
    //
    // The rate limiter is the authoritative gate. If it allows the request, it
    // atomically records the batch count. No scan work is done before this.
    const clientIp = extractClientIp(req.headers);
    const rlResult = limiter.check({ clientIp, urlCount: urls.length });

    if (!rlResult.allowed) {
      const status =
        rlResult.result === "BATCH_TOO_LARGE" || rlResult.result === "INVALID_INPUT"
          ? 400
          : 429;
      return errorResponse(
        status,
        rlResult.result,
        rlResult.reason,
        rlResult.retryAfterSeconds,
        rlResult.limits
      );
    }

    // ── Step 7: Batch scan with concurrency pool + wall-clock timeout ─────────
    const { maxConcurrentUrlsPerBatch } = rlResult.limits;
    const timeoutMs = opts?._timeoutMs ?? rlResult.limits.maxBatchRuntimeMs;
    const controller = new AbortController();
    const scanOne = opts?._scanUrl ?? scanUrl;

    const tasks = urls.map(
      (url) => () => scanOne(url, controller.signal)
    );
    const pool = runWithConcurrency(
      tasks,
      maxConcurrentUrlsPerBatch,
      controller.signal
    );
    const results = await runWithDeadline(
      pool,
      controller,
      timeoutMs
    );

    return {
      status: 200,
      body: { ok: true, results, limits: rlResult.limits },
    };

  } catch (err) {
    if (err instanceof BatchTimeoutError) {
      return errorResponse(
        408,
        "BATCH_TIMEOUT",
        "The batch did not complete within the allowed time. Please try a smaller batch.",
        null,
        limits
      );
    }
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "An unexpected error occurred. Please try again.",
      null,
      limits
    );
  }
}
