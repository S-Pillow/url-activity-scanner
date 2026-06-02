/**
 * AIPF-004: HEAD Request Engine
 *
 * Sends an HTTP HEAD request to a URL that has already been validated by
 * AIPF-002 (validateUrl) and AIPF-003 (resolveDns). Redirects are followed
 * manually so every hop can be re-validated before the next request is sent.
 *
 * Safety guarantees enforced here:
 *   - Input must be a DNS_OK result from resolveDns(). Any other result is
 *     forwarded immediately — no HTTP request is made.
 *   - Only HEAD requests are sent. GET, POST, and all other methods are forbidden.
 *   - Response bodies are never read, buffered, or stored.
 *   - Redirects are handled manually (automatic following is disabled).
 *   - Every redirect destination is re-validated with AIPF-002 and AIPF-003
 *     before the next request is sent. A blocked destination terminates the chain.
 *   - Maximum 3 redirects. Further redirects return TOO_MANY_REDIRECTS.
 *   - Per-request timeout defaults to 10 seconds (AIPF-001 recommendation).
 *   - Submitted URLs, redirect destinations, hostnames, and resolved IPs are
 *     never logged.
 *   - No content, metadata, title, favicon, or body of any kind is collected.
 *   - No GET fallback is implemented in this module (deferred to AIPF-005).
 *
 * Assumption A-AIPF004-01:
 *   Node.js runtime ≥ 18 is available (required by Next.js 16). The native
 *   http/https modules are used for all outbound requests.
 *
 * Assumption A-AIPF004-02:
 *   The _fetcher option is an internal testing seam. It is not part of the
 *   stable public API and must not be used in production code outside tests.
 *   The underscore prefix signals this intent.
 *
 * Assumption A-AIPF004-03:
 *   The timeout applies per individual HEAD request hop, not to the entire
 *   redirect chain. The total chain duration could theoretically be up to
 *   (MAX_REDIRECTS + 1) × timeoutMs. A global chain timeout is deferred.
 *
 * Assumption A-AIPF004-04:
 *   The User-Agent "URL-Activity-Scanner/1.0" is a non-identifying generic
 *   string. It does not contain platform version, OS, or operator identity.
 */

import * as http from "http";
import * as https from "https";
import { validateUrl } from "./validateUrl";
import { resolveDns } from "./resolveDns";
import type { DnsCheckResult } from "./resolveDns";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "URL-Activity-Scanner/1.0";

/** HTTP status codes that indicate a redirect requiring manual handling. */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// ─── Public types ─────────────────────────────────────────────────────────────

export type HeadResult =
  | "HEAD_OK"           // Non-redirect response received (any 2xx/4xx/5xx)
  | "REDIRECTED"        // Followed ≥ 1 redirect and reached a non-redirect response
  | "BLOCKED"           // URL or a redirect destination failed validation / DNS
  | "TIMEOUT"           // Request exceeded the configured timeout
  | "CONNECTION_REFUSED"// Host refused the TCP connection
  | "NETWORK_ERROR"     // Any other network-level error
  | "INVALID"           // Prior validation result was INVALID or redirect was malformed
  | "DNS_FAILURE"       // DNS resolution failed for the URL or a redirect destination
  | "TOO_MANY_REDIRECTS"; // Redirect chain exceeded MAX_REDIRECTS

export interface HeadRequestResult {
  /** True only when result is HEAD_OK or REDIRECTED. */
  allowed: boolean;
  /** The raw string as submitted by the user — not logged, not stored. */
  originalInput: string;
  /** The normalised URL from the AIPF-002 validation result. */
  normalizedUrl: string | null;
  /** The final URL where the non-redirect response was received. */
  finalUrl: string | null;
  /** HTTP status code of the final response, or null if no response was received. */
  statusCode: number | null;
  /** True if the engine followed one or more redirects. */
  redirected: boolean;
  /** Plain-text list of redirect destination URLs in traversal order. Never logged. */
  redirectChain: string[];
  /** Number of redirects followed (0 for a direct response). */
  redirectCount: number;
  /** Total wall-clock time for the engine call in milliseconds. */
  durationMs: number;
  /** Human-readable explanation of the result. */
  reason: string;
  /** Machine-readable result code. */
  result: HeadResult;
}

// ─── Internal types ──────────────────────────────────────────────────────────

/**
 * Result returned by a single HEAD request hop.
 * The ok variant carries only the minimum metadata needed to determine outcome.
 * No response body, no page metadata, no content headers.
 */
type SingleHopResult =
  | { ok: true; statusCode: number; locationHeader: string | null }
  | {
      ok: false;
      result: Extract<HeadResult, "TIMEOUT" | "CONNECTION_REFUSED" | "NETWORK_ERROR">;
      reason: string;
    };

/**
 * Function signature for a single HEAD request hop.
 * The default implementation uses Node.js http/https.
 * Tests inject a mock via the _fetcher option in sendHeadRequest().
 */
export type SingleHopFetcher = (
  url: string,
  opts: { timeoutMs: number }
) => Promise<SingleHopResult>;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Results that indicate the HEAD engine call was safe and successful. */
const ALLOWED_RESULTS = new Set<HeadResult>(["HEAD_OK", "REDIRECTED"]);

function makeHeadResult(
  partial: Omit<HeadRequestResult, "allowed">
): HeadRequestResult {
  return { ...partial, allowed: ALLOWED_RESULTS.has(partial.result) };
}

/**
 * Maps a DnsResult that is not DNS_OK to the corresponding HeadResult.
 * Used when the initial DNS gate rejects the input.
 */
function mapDnsResultToHeadResult(
  dnsResult: DnsCheckResult["result"]
): HeadResult {
  switch (dnsResult) {
    case "DNS_FAILURE": return "DNS_FAILURE";
    case "BLOCKED":     return "BLOCKED";
    case "INVALID":     return "INVALID";
    default:            return "NETWORK_ERROR";
  }
}

// ─── Real HTTP fetcher ────────────────────────────────────────────────────────

/**
 * Sends a single HEAD request using Node.js http/https.
 *
 * Safety:
 *   - Only HEAD is sent (method is hardcoded).
 *   - The response body is immediately destroyed — nothing is read.
 *   - A per-request wall-clock timeout is enforced via setTimeout.
 *   - No redirect following occurs here; the caller handles Location manually.
 *   - Nothing is logged.
 */
const realFetcher: SingleHopFetcher = (
  url: string,
  { timeoutMs }: { timeoutMs: number }
): Promise<SingleHopResult> => {
  return new Promise((resolve) => {
    let settled = false;

    function settle(result: SingleHopResult): void {
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
        method: "HEAD",
        hostname: parsed.hostname,
        // parsed.port is a string; undefined means "use protocol default"
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

        // Immediately destroy the response — never buffer any body.
        // HEAD responses should have no body, but some buggy servers send one.
        res.destroy();

        settle({ ok: true, statusCode, locationHeader });
      }
    );

    req.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return; // timeout already resolved the promise

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
 * Sends an HTTP HEAD request to a URL that has already been validated by
 * AIPF-002 and AIPF-003. Redirects are followed manually up to MAX_REDIRECTS.
 *
 * Must be called server-side only.
 * Only HEAD requests are sent — GET fallback is not implemented here.
 * Does not log submitted URLs, hostnames, redirect destinations, or resolved IPs.
 * Does not read, buffer, or expose any response body.
 *
 * @param dnsResult  - The structured result from resolveDns(). Must be DNS_OK.
 * @param options    - Optional configuration.
 * @param options.timeoutMs - Per-hop timeout in ms (default: 10 000).
 * @param options._fetcher  - Internal: inject a mock HTTP fetcher in tests only.
 * @returns A structured HeadRequestResult.
 */
export async function sendHeadRequest(
  dnsResult: DnsCheckResult,
  options?: {
    timeoutMs?: number;
    /** @internal — test seam only, not part of the stable public API. */
    _fetcher?: SingleHopFetcher;
  }
): Promise<HeadRequestResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options?._fetcher ?? realFetcher;
  const startTime = Date.now();
  const elapsed = (): number => Date.now() - startTime;

  const { originalInput, normalizedUrl } = dnsResult;

  // ── Step 1: Gate — do not proceed unless AIPF-003 returned DNS_OK ─────────
  //
  // Any prior DNS failure, blocked result, or invalid input is forwarded
  // immediately. No HTTP request is attempted.
  if (dnsResult.result !== "DNS_OK") {
    return makeHeadResult({
      originalInput,
      normalizedUrl,
      finalUrl: null,
      statusCode: null,
      redirected: false,
      redirectChain: [],
      redirectCount: 0,
      durationMs: elapsed(),
      reason: dnsResult.reason,
      result: mapDnsResultToHeadResult(dnsResult.result),
    });
  }

  // Invariant: DNS_OK always has a non-null normalizedUrl.
  // Guard defensively for future API changes.
  if (!normalizedUrl) {
    return makeHeadResult({
      originalInput,
      normalizedUrl: null,
      finalUrl: null,
      statusCode: null,
      redirected: false,
      redirectChain: [],
      redirectCount: 0,
      durationMs: elapsed(),
      reason: "Normalised URL missing from DNS result",
      result: "INVALID",
    });
  }

  // ── Step 2: HEAD request loop with manual redirect handling ───────────────

  let currentUrl = normalizedUrl;
  const redirectChain: string[] = [];
  let redirectCount = 0;

  // The loop always terminates because:
  //   a) A non-redirect response exits immediately.
  //   b) An error exits immediately.
  //   c) The redirect cap (redirectCount >= MAX_REDIRECTS) exits when exceeded.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── 2a: Send a single HEAD request ──────────────────────────────────────
    const hopResult = await fetcher(currentUrl, { timeoutMs });

    if (!hopResult.ok) {
      return makeHeadResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode: null,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: hopResult.reason,
        result: hopResult.result,
      });
    }

    const { statusCode, locationHeader } = hopResult;

    // ── 2b: Non-redirect response — return final result ──────────────────────
    if (!REDIRECT_CODES.has(statusCode)) {
      return makeHeadResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason:
          redirectCount > 0
            ? "HEAD request completed after redirect(s)"
            : "HEAD request completed",
        result: redirectCount > 0 ? "REDIRECTED" : "HEAD_OK",
      });
    }

    // ── 2c: Redirect response — check the cap before following ──────────────
    if (redirectCount >= MAX_REDIRECTS) {
      return makeHeadResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        redirected: true,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: `Redirect chain exceeded the maximum of ${MAX_REDIRECTS} hops`,
        result: "TOO_MANY_REDIRECTS",
      });
    }

    // ── 2d: Extract the redirect destination ─────────────────────────────────
    if (!locationHeader) {
      return makeHeadResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
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
      return makeHeadResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: "Redirect destination URL is malformed",
        result: "INVALID",
      });
    }

    // ── 2e: AIPF-002 re-validation of redirect destination ──────────────────
    //
    // The redirect URL is treated as new, untrusted input. validateUrl() checks
    // scheme, hostname, and IP ranges. Any BLOCKED or INVALID result terminates
    // the chain immediately — no DNS lookup or HTTP request is made.
    const nextValidation = validateUrl(nextUrl);
    if (nextValidation.result !== "VALID") {
      return makeHeadResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: `Redirect destination blocked by URL validation: ${nextValidation.reason}`,
        result: nextValidation.result === "INVALID" ? "INVALID" : "BLOCKED",
      });
    }

    // ── 2f: AIPF-003 DNS re-check of redirect destination ───────────────────
    //
    // Re-resolving DNS ensures that a redirect to a domain that resolves to a
    // private IP is caught even if the domain passes the URL validation step.
    const nextDns = await resolveDns(nextValidation);
    if (nextDns.result !== "DNS_OK") {
      return makeHeadResult({
        originalInput,
        normalizedUrl,
        finalUrl: currentUrl,
        statusCode,
        redirected: redirectCount > 0,
        redirectChain,
        redirectCount,
        durationMs: elapsed(),
        reason: `Redirect destination DNS check failed: ${nextDns.reason}`,
        result: nextDns.result === "DNS_FAILURE" ? "DNS_FAILURE" : "BLOCKED",
      });
    }

    // ── 2g: Safe to follow — record and continue ─────────────────────────────
    redirectChain.push(nextUrl);
    currentUrl = nextUrl;
    redirectCount++;
  }
}
