/**
 * AIPF-005: GET Fallback Handler
 *
 * Sends a narrowly controlled GET request when the HEAD request engine
 * (AIPF-004) received HTTP 405 Method Not Allowed or 501 Not Implemented
 * from the server. In all other cases the module returns NOT_APPLICABLE.
 *
 * Safety guarantees enforced here:
 *   - GET fallback only runs after HEAD returned 405 or 501. Any other HEAD
 *     outcome returns NOT_APPLICABLE without making any HTTP request.
 *   - Only GET requests are sent. POST, PUT, PATCH, DELETE, OPTIONS, and all
 *     other methods are never used.
 *   - Response bodies are destroyed immediately after status/headers are
 *     captured. Nothing is read, buffered, stored, parsed, or exposed.
 *   - Redirects are handled manually (automatic following is disabled).
 *   - Every redirect destination is re-validated with AIPF-002 (validateUrl)
 *     and AIPF-003 (resolveDns) before the next request is sent.
 *   - Maximum 3 redirects. Further redirects return TOO_MANY_REDIRECTS.
 *   - Per-request timeout defaults to 10 seconds (AIPF-001 recommendation).
 *   - Submitted URLs, redirect destinations, hostnames, and resolved IPs are
 *     never logged.
 *   - No cookies, authentication headers, referrer, or fingerprinting headers
 *     are sent.
 *   - No content, metadata, title, favicon, or body of any kind is collected.
 *
 * Assumption A-AIPF005-01 — Architecture:
 *   GET fallback is implemented as a separate module (getFallback.ts) rather
 *   than being merged into headRequest.ts. This makes it straightforward for
 *   tests to confirm it only activates after HEAD 405/501. The two modules
 *   share the SingleHopFetcher type signature from headRequest.ts.
 *
 * Assumption A-AIPF005-02 — HTTP library:
 *   Node.js built-in http/https modules are used, consistent with AIPF-004.
 *   No third-party HTTP library is added.
 *
 * Assumption A-AIPF005-03 — Timeout scope:
 *   The configured timeout applies per individual GET request hop, not to the
 *   entire redirect chain. A global chain timeout is deferred (same as AIPF-004).
 *
 * Assumption A-AIPF005-04 — Redirect count:
 *   The GET fallback redirect counter starts at 0 independently of any
 *   redirects already followed during HEAD. Each AIPF module enforces its own
 *   3-hop cap.
 *
 * Assumption A-AIPF005-05 — Starting URL:
 *   GET is sent to headResult.finalUrl — the URL that actually returned 405 or
 *   501 (which may differ from normalizedUrl if HEAD followed redirects). This
 *   URL was already validated by AIPF-002 and AIPF-003 during AIPF-004 and
 *   does not require re-validation for the initial GET request.
 *
 * Assumption A-AIPF005-06 — Test seam:
 *   The _fetcher option is an internal testing seam. It is not part of the
 *   stable public API. The underscore prefix signals this intent.
 */

import * as http from "http";
import * as https from "https";
import { validateUrl } from "./validateUrl";
import { resolveDns } from "./resolveDns";
import type { HeadRequestResult, SingleHopFetcher } from "./headRequest";

// ─── Constants ────────────────────────────────────────────────────────────────
//
// These must match the equivalent constants in headRequest.ts (AIPF-004).
// If either file's values change, update the other identically.

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "URL-Activity-Scanner/1.0";

/** HTTP status codes that indicate a redirect requiring manual handling. */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * HEAD status codes that authorise the GET fallback.
 * The GET fallback must NOT run for any other HEAD outcome.
 */
const GET_TRIGGER_CODES = new Set([405, 501]);

// ─── Public types ─────────────────────────────────────────────────────────────

export type GetResult =
  | "GET_FALLBACK_OK"       // Non-redirect GET response received (any 2xx/4xx/5xx)
  | "REDIRECTED"            // Followed ≥1 safe redirect and reached a non-redirect response
  | "BLOCKED"               // URL or redirect destination failed safety checks
  | "TIMEOUT"               // GET request exceeded the timeout
  | "CONNECTION_REFUSED"    // Host refused the TCP connection
  | "NETWORK_ERROR"         // Any other unclassified network-level error
  | "INVALID"               // Input or redirect URL was malformed/invalid
  | "DNS_FAILURE"           // DNS resolution failed for GET URL or redirect destination
  | "TOO_MANY_REDIRECTS"    // Redirect chain exceeded MAX_REDIRECTS
  | "NOT_APPLICABLE";       // HEAD did not return 405 or 501 — fallback must not run

export interface GetFallbackResult {
  /** True only when result is GET_FALLBACK_OK or REDIRECTED. */
  allowed: boolean;
  /** Raw user input, forwarded from the HEAD result. Never logged. */
  originalInput: string;
  /** AIPF-002 normalised URL, forwarded from the HEAD result. Never logged. */
  normalizedUrl: string | null;
  /** URL where the final GET response was received, or null if no response. */
  finalUrl: string | null;
  /** HTTP status code of the final GET response, or null if no response. */
  statusCode: number | null;
  /** True if the GET fallback actually ran. False when result is NOT_APPLICABLE. */
  usedGetFallback: boolean;
  /** True if GET followed one or more redirects. */
  redirected: boolean;
  /** Plain-text list of redirect destinations in traversal order. Never logged. */
  redirectChain: string[];
  /** Number of redirects followed during GET (0 for a direct response). */
  redirectCount: number;
  /** Total wall-clock time for the GET fallback call in milliseconds. */
  durationMs: number;
  /** Human-readable explanation of the result. */
  reason: string;
  /** Machine-readable result code. */
  result: GetResult;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const ALLOWED_GET_RESULTS = new Set<GetResult>(["GET_FALLBACK_OK", "REDIRECTED"]);

function makeGetResult(
  partial: Omit<GetFallbackResult, "allowed">
): GetFallbackResult {
  return { ...partial, allowed: ALLOWED_GET_RESULTS.has(partial.result) };
}

// ─── Real GET fetcher ─────────────────────────────────────────────────────────

/**
 * Sends a single GET request using Node.js http/https.
 *
 * Safety:
 *   - Method is hardcoded to GET.
 *   - The response body is destroyed immediately — nothing is buffered.
 *   - A "error" listener is attached to the response before destroy to suppress
 *     the expected ECONNRESET that fires when a response with a body is closed
 *     before it is drained. This prevents unhandled error events.
 *   - A per-request wall-clock timeout is enforced via setTimeout.
 *   - No redirect following occurs here; the caller handles Location manually.
 *   - Nothing is logged.
 */
const realGetFetcher: SingleHopFetcher = (
  url: string,
  { timeoutMs }: { timeoutMs: number }
): Promise<Awaited<ReturnType<SingleHopFetcher>>> => {
  return new Promise((resolve) => {
    let settled = false;

    function settle(result: Parameters<typeof resolve>[0]): void {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      settle({ ok: false, result: "NETWORK_ERROR", reason: "Malformed URL passed to fetcher" });
      return;
    }

    const mod = parsed.protocol === "https:" ? https : http;

    const timer = setTimeout(() => {
      req.destroy();
      settle({ ok: false, result: "TIMEOUT", reason: "Request timed out" });
    }, timeoutMs);

    const req = mod.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        headers: { "User-Agent": USER_AGENT },
      },
      (res) => {
        clearTimeout(timer);

        const statusCode = res.statusCode ?? 0;
        const rawLocation = res.headers["location"];
        const locationHeader: string | null = Array.isArray(rawLocation)
          ? (rawLocation[0] ?? null)
          : (rawLocation ?? null);

        // Absorb any error that fires after destroy (expected for GET responses
        // that have a body in-flight when the connection is closed).
        res.on("error", () => {});

        // Immediately destroy — never read, buffer, or expose body content.
        res.destroy();

        settle({ ok: true, statusCode, locationHeader });
      }
    );

    req.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return; // timeout already settled

      const code = err.code ?? "";
      if (code === "ECONNREFUSED") {
        settle({ ok: false, result: "CONNECTION_REFUSED", reason: "Connection refused" });
      } else {
        settle({ ok: false, result: "NETWORK_ERROR", reason: `Network error: ${err.message}` });
      }
    });

    req.end();
  });
};

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Runs the GET fallback after the HEAD engine returned 405 or 501.
 *
 * Must be called server-side only, after sendHeadRequest().
 * Returns NOT_APPLICABLE immediately for any other HEAD outcome.
 * Only GET requests are sent — no other HTTP methods.
 * Does not read, buffer, or expose any response body.
 * Does not log submitted URLs, redirect destinations, resolved IPs, or headers.
 *
 * @param headResult - The structured result from sendHeadRequest().
 * @param options    - Optional configuration.
 * @param options.timeoutMs - Per-hop timeout in ms (default: 10 000).
 * @param options._fetcher  - Internal: inject a mock GET fetcher in tests only.
 * @returns A structured GetFallbackResult.
 */
export async function runGetFallback(
  headResult: HeadRequestResult,
  options?: {
    timeoutMs?: number;
    /** @internal — test seam only, not part of the stable public API. */
    _fetcher?: SingleHopFetcher;
  }
): Promise<GetFallbackResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options?._fetcher ?? realGetFetcher;
  const startTime = Date.now();
  const elapsed = (): number => Date.now() - startTime;

  const { originalInput, normalizedUrl } = headResult;

  // ── Step 1: Gate — only run when HEAD returned 405 or 501 ─────────────────
  //
  // All other HEAD outcomes (200, 301–308, 403, 404, 4xx, 5xx except 501,
  // timeout, connection refused, network error, DNS failure, blocked, invalid)
  // must not trigger the GET fallback.
  if (
    headResult.statusCode === null ||
    !GET_TRIGGER_CODES.has(headResult.statusCode)
  ) {
    return makeGetResult({
      originalInput,
      normalizedUrl,
      finalUrl: headResult.finalUrl,
      statusCode: headResult.statusCode,
      usedGetFallback: false,
      redirected: false,
      redirectChain: [],
      redirectCount: 0,
      durationMs: elapsed(),
      reason:
        headResult.statusCode === null
          ? "GET fallback is not applicable: HEAD did not receive a response"
          : `GET fallback is not applicable: HEAD returned ${headResult.statusCode}, not 405 or 501`,
      result: "NOT_APPLICABLE",
    });
  }

  // headResult.finalUrl is always set when statusCode is a non-null HTTP code.
  // Guard defensively in case of future API changes.
  if (!headResult.finalUrl) {
    return makeGetResult({
      originalInput,
      normalizedUrl,
      finalUrl: null,
      statusCode: null,
      usedGetFallback: false,
      redirected: false,
      redirectChain: [],
      redirectCount: 0,
      durationMs: elapsed(),
      reason: "GET fallback skipped: finalUrl missing from HEAD result",
      result: "NOT_APPLICABLE",
    });
  }

  // ── Step 2: GET request loop with manual redirect handling ────────────────
  //
  // Start from headResult.finalUrl — the URL where HEAD received 405/501.
  // This URL was validated by AIPF-002 and AIPF-003 during AIPF-004 and
  // does not need re-validation for the initial GET request.
  // Only new redirect destinations (from GET responses) require re-validation.

  let currentUrl = headResult.finalUrl;
  const redirectChain: string[] = [];
  let redirectCount = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── 2a: Send a single GET request ────────────────────────────────────────
    const hopResult = await fetcher(currentUrl, { timeoutMs });

    if (!hopResult.ok) {
      return makeGetResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode: null,
        usedGetFallback: true,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: hopResult.reason,
        result: hopResult.result,
      });
    }

    const { statusCode, locationHeader } = hopResult;

    // ── 2b: Non-redirect response — return final result ───────────────────────
    if (!REDIRECT_CODES.has(statusCode)) {
      return makeGetResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        usedGetFallback: true,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason:
          redirectCount > 0
            ? `GET fallback completed after ${redirectCount} redirect(s)`
            : `GET fallback completed after HEAD returned ${headResult.statusCode}`,
        result: redirectCount > 0 ? "REDIRECTED" : "GET_FALLBACK_OK",
      });
    }

    // ── 2c: Redirect response — enforce the cap before following ───────────────
    if (redirectCount >= MAX_REDIRECTS) {
      return makeGetResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        usedGetFallback: true,
        redirected: true,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: `Redirect chain exceeded the maximum of ${MAX_REDIRECTS} hops`,
        result: "TOO_MANY_REDIRECTS",
      });
    }

    // ── 2d: Extract the redirect destination ──────────────────────────────────
    if (!locationHeader) {
      return makeGetResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        usedGetFallback: true,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: "Redirect response is missing a Location header",
        result: "NETWORK_ERROR",
      });
    }

    // Resolve relative Location values against the current URL.
    let nextUrl: string;
    try {
      nextUrl = new URL(locationHeader, currentUrl).href;
    } catch {
      return makeGetResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        usedGetFallback: true,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: "Redirect destination URL is malformed",
        result: "INVALID",
      });
    }

    // ── 2e: AIPF-002 re-validation of redirect destination ────────────────────
    //
    // The redirect URL is treated as new, untrusted input. Any BLOCKED or
    // INVALID result terminates the chain immediately — no DNS lookup or
    // further HTTP request is made.
    const nextValidation = validateUrl(nextUrl);
    if (nextValidation.result !== "VALID") {
      return makeGetResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        usedGetFallback: true,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: `Redirect destination blocked by URL validation: ${nextValidation.reason}`,
        result: nextValidation.result === "INVALID" ? "INVALID" : "BLOCKED",
      });
    }

    // ── 2f: AIPF-003 DNS re-check of redirect destination ────────────────────
    //
    // Re-resolving DNS ensures that a redirect to a domain that resolves to a
    // private IP is caught even if the domain passes the URL validation step.
    const nextDns = await resolveDns(nextValidation);
    if (nextDns.result !== "DNS_OK") {
      return makeGetResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        usedGetFallback: true,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: `Redirect destination DNS check failed: ${nextDns.reason}`,
        result: nextDns.result === "DNS_FAILURE" ? "DNS_FAILURE" : "BLOCKED",
      });
    }

    // ── 2g: Safe to follow — record and continue ──────────────────────────────
    redirectChain.push(nextUrl);
    currentUrl = nextUrl;
    redirectCount++;
  }
}
