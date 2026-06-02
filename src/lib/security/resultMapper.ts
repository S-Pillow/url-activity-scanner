/**
 * AIPF-006: Final Result Mapper
 *
 * A pure, stateless mapping layer that converts structured outputs from
 * AIPF-002 (validateUrl), AIPF-003 (resolveDns), AIPF-004 (sendHeadRequest),
 * and AIPF-005 (runGetFallback) into the seven user-facing fields required by
 * the AIPF-001 result key.
 *
 * Safety guarantees enforced here:
 *   - No network requests of any kind are made. This is a pure function.
 *   - No response body, headers, page metadata, page title, favicon,
 *     Content-Type, Content-Length, HTML, JavaScript, or image/video metadata
 *     is ever included in the output.
 *   - No submitted URLs, redirect destinations, hostnames, or resolved IPs
 *     are logged. The redirected_to field is plain text only, never clickable.
 *   - checked_at is generated as an ISO 8601 UTC timestamp at mapping time.
 *     A clock injector is supported for deterministic testing.
 *   - All seven output fields have a defined purpose per AIPF-001.
 *   - notes contains only operational context; never content-derived data.
 *
 * Assumption A-AIPF006-01 — Single mapper function:
 *   A single mapResult() function accepts all four upstream result objects as
 *   optional inputs. The caller is responsible for providing the correct set
 *   for each scan path (validation-only, DNS-failed, full HEAD+GET, etc.).
 *
 * Assumption A-AIPF006-02 — Priority order:
 *   When multiple result objects are provided, the mapper uses the most
 *   complete / latest-in-chain result: GET fallback (if it ran) > HEAD >
 *   DNS > validation. The GET fallback result is used only when
 *   usedGetFallback === true and result !== "NOT_APPLICABLE".
 *
 * Assumption A-AIPF006-03 — redirected_to:
 *   redirected_to is set to finalUrl whenever finalUrl differs from
 *   normalizedUrl. "Different" means non-null and non-equal string comparison.
 *   The field is plain text only and must never be rendered as a hyperlink.
 *
 * Assumption A-AIPF006-04 — Status codes not in the result key:
 *   HTTP status codes not explicitly listed in the AIPF-001 result key
 *   (e.g. 201, 202, 206, 401, 405, 501) are mapped by range:
 *   2xx → "200 OK", 4xx (except 404, 410) → "403 Forbidden" only for 401/403
 *   otherwise → "Unknown", 5xx → "Server error".
 *
 * Assumption A-AIPF006-05 — checked_at:
 *   The timestamp is generated at call time using the injected now() or
 *   Date constructor. No caching or rounding is applied.
 */

import type { UrlValidationResult } from "./validateUrl";
import type { DnsCheckResult } from "./resolveDns";
import type { HeadRequestResult } from "./headRequest";
import type { GetFallbackResult } from "./getFallback";

// ─── User-facing result key ───────────────────────────────────────────────────

/**
 * The complete set of user-facing result strings defined in AIPF-001.
 * Used internally for consistency; also exported for the UI layer.
 */
export const RESULT_KEY = {
  OK:                "200 OK",
  REDIRECT:          "301/302 Redirect",
  FORBIDDEN:         "403 Forbidden",
  NOT_FOUND:         "404 Not Found",
  GONE:              "410 Gone",
  TIMEOUT:           "Timeout",
  DNS_FAILURE:       "DNS failure",
  CONNECTION_REFUSED:"Connection refused",
  BLOCKED:           "Blocked",
  SERVER_ERROR:      "Server error",
  UNKNOWN:           "Unknown",
} as const;

/** Maps each user-facing result string to its AIPF-001 human-readable meaning. */
export const MEANINGS: Readonly<Record<string, string>> = {
  [RESULT_KEY.OK]:                "Content likely exists",
  [RESULT_KEY.REDIRECT]:          "URL redirects somewhere active",
  [RESULT_KEY.FORBIDDEN]:         "Server exists, but access is blocked",
  [RESULT_KEY.NOT_FOUND]:         "No content at that path",
  [RESULT_KEY.GONE]:              "Content used to exist but is gone",
  [RESULT_KEY.TIMEOUT]:           "Server did not respond",
  [RESULT_KEY.DNS_FAILURE]:       "Domain does not resolve",
  [RESULT_KEY.CONNECTION_REFUSED]:"Host exists but service may be down",
  [RESULT_KEY.BLOCKED]:           "URL points to a private, internal, unsupported, or unsafe destination",
  [RESULT_KEY.SERVER_ERROR]:      "Server responded but failed to process the request",
  [RESULT_KEY.UNKNOWN]:           "The URL responded in an unexpected way",
};

// ─── Public types ─────────────────────────────────────────────────────────────

/** All upstream result objects are optional — only provide what ran for each scan path. */
export interface MapperInput {
  validationResult?: UrlValidationResult;
  dnsResult?: DnsCheckResult;
  headResult?: HeadRequestResult;
  getFallbackResult?: GetFallbackResult;
}

/** The seven user-facing fields returned by the scanner per AIPF-001. */
export interface ScanResult {
  /** The raw string as submitted by the user. Shown only in the temporary UI result. */
  original_input: string;
  /** The normalised URL used for scanning. Shown as plain text only. Never a hyperlink. */
  normalized_url: string | null;
  /** The user-facing result string from the AIPF-001 result key. */
  result: string;
  /** The human-readable meaning of the result. */
  meaning: string;
  /**
   * The final URL after any redirects, shown as plain text only. Null when no
   * redirect occurred. Never rendered as a hyperlink. Never logged.
   */
  redirected_to: string | null;
  /** ISO 8601 UTC timestamp generated at mapping time. */
  checked_at: string;
  /** Operational context notes. Null when no additional context is needed. */
  notes: string | null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Internal intermediate result before notes composition. */
interface IntermediateResult {
  result: string;
  meaning: string;
  notes: string | null;
}

/** Shorthand to build an IntermediateResult from a RESULT_KEY value. */
function mk(key: string, notes: string | null = null): IntermediateResult {
  return { result: key, meaning: MEANINGS[key] ?? key, notes };
}

/** Joins non-empty note parts with "; ". Returns null if nothing to note. */
function joinNotes(...parts: Array<string | null | undefined>): string | null {
  const filled = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  return filled.length > 0 ? filled.join("; ") : null;
}

/**
 * Maps an HTTP status code to its user-facing result and meaning.
 * Status codes outside the explicit AIPF-001 result key are mapped by range.
 */
function mapStatusCode(code: number): IntermediateResult {
  if (code >= 200 && code < 300) return mk(RESULT_KEY.OK);
  if (code >= 300 && code < 400) return mk(RESULT_KEY.REDIRECT);
  if (code === 401 || code === 403) return mk(RESULT_KEY.FORBIDDEN);
  if (code === 404) return mk(RESULT_KEY.NOT_FOUND);
  if (code === 410) return mk(RESULT_KEY.GONE);
  if (code >= 500 && code < 600) return mk(RESULT_KEY.SERVER_ERROR, `Server returned ${code}`);
  return mk(RESULT_KEY.UNKNOWN);
}

/**
 * Maps a result code from the HEAD or GET fallback layer to an
 * IntermediateResult. The logic is identical for both layers because they
 * share the same result code vocabulary (except NOT_APPLICABLE, handled by
 * the caller).
 */
function mapEngineResult(
  resultCode: string,
  statusCode: number | null,
  reason: string
): IntermediateResult {
  switch (resultCode) {
    case "HEAD_OK":
    case "GET_FALLBACK_OK":
      return statusCode !== null
        ? mapStatusCode(statusCode)
        : mk(RESULT_KEY.UNKNOWN);

    case "REDIRECTED":
      return mk(RESULT_KEY.REDIRECT);

    case "TOO_MANY_REDIRECTS":
      return mk(RESULT_KEY.REDIRECT, "Redirect chain exceeded 3-hop limit");

    case "TIMEOUT":
      return mk(RESULT_KEY.TIMEOUT, "Request timed out");

    case "CONNECTION_REFUSED":
      return mk(RESULT_KEY.CONNECTION_REFUSED, "Connection refused");

    case "DNS_FAILURE":
      return mk(RESULT_KEY.DNS_FAILURE, "DNS lookup failed");

    case "BLOCKED":
      return mk(RESULT_KEY.BLOCKED, reason || null);

    case "INVALID":
      return mk(RESULT_KEY.UNKNOWN, reason || null);

    case "NETWORK_ERROR":
      return mk(RESULT_KEY.UNKNOWN, reason || null);

    default:
      return mk(RESULT_KEY.UNKNOWN);
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Maps structured outputs from the URL Activity Scanner security modules
 * into the final seven user-facing fields defined by AIPF-001.
 *
 * Pure function — makes no network, DNS, storage, or logging calls.
 * Must be called server-side only.
 * The result contains no response body, headers, or page metadata.
 *
 * @param input   - Upstream result objects. Only provide what actually ran.
 * @param options - Optional configuration.
 * @param options.now - Injectable clock for deterministic timestamps in tests.
 * @returns A ScanResult with exactly the seven AIPF-001 user-facing fields.
 */
export function mapResult(
  input: MapperInput,
  options?: { now?: () => Date }
): ScanResult {
  const now = options?.now ?? (() => new Date());
  const checkedAt = now().toISOString();

  // ── Step 1: Identify the best available source for URL fields ─────────────
  //
  // All modules forward originalInput and normalizedUrl from AIPF-002, so
  // any non-null source is equivalent. Prefer the deepest module in the chain.
  const urlSource =
    input.getFallbackResult ??
    input.headResult ??
    input.dnsResult ??
    input.validationResult;

  const originalInput = urlSource?.originalInput ?? "";
  const normalizedUrl = urlSource?.normalizedUrl ?? null;

  // ── Step 2: Choose the active result layer ────────────────────────────────
  //
  // Priority: GET fallback (if it ran) > HEAD > DNS > validation.
  // GET fallback is "active" only when it actually sent a request
  // (usedGetFallback === true). NOT_APPLICABLE means HEAD result is used.

  const useGetFallback =
    input.getFallbackResult !== undefined &&
    input.getFallbackResult.usedGetFallback === true &&
    input.getFallbackResult.result !== "NOT_APPLICABLE";

  let intermediate: IntermediateResult;
  let finalUrlForRedirect: string | null | undefined;

  if (useGetFallback) {
    // ── 2a: Map GET fallback result ─────────────────────────────────────────
    const gf = input.getFallbackResult!;
    const base = mapEngineResult(gf.result, gf.statusCode, gf.reason);
    const getFallbackNote =
      input.headResult?.statusCode != null
        ? `HEAD returned ${input.headResult.statusCode}; GET fallback used`
        : "HEAD not supported; GET fallback used";
    intermediate = { ...base, notes: joinNotes(getFallbackNote, base.notes) };
    finalUrlForRedirect = gf.finalUrl;

  } else if (input.headResult !== undefined) {
    // ── 2b: Map HEAD result ──────────────────────────────────────────────────
    const h = input.headResult;
    intermediate = mapEngineResult(h.result, h.statusCode, h.reason);
    finalUrlForRedirect = h.finalUrl;

  } else if (input.dnsResult !== undefined) {
    // ── 2c: Map DNS result ───────────────────────────────────────────────────
    //
    // DNS_OK without a HEAD or GET result means scanning was not attempted.
    // Map it as Unknown since there is no HTTP response to report.
    const d = input.dnsResult;
    switch (d.result) {
      case "DNS_FAILURE":
        intermediate = mk(RESULT_KEY.DNS_FAILURE, "DNS lookup failed");
        break;
      case "BLOCKED":
        intermediate = mk(RESULT_KEY.BLOCKED, d.reason || null);
        break;
      case "INVALID":
        intermediate = mk(RESULT_KEY.UNKNOWN, d.reason || null);
        break;
      default:
        intermediate = mk(RESULT_KEY.UNKNOWN);
    }
    finalUrlForRedirect = null;

  } else if (input.validationResult !== undefined) {
    // ── 2d: Map validation result ────────────────────────────────────────────
    //
    // validateUrl returns BLOCKED for scheme, hostname, and IP violations.
    // It returns INVALID for empty input, malformed URLs, and missing hostname.
    const v = input.validationResult;
    switch (v.result) {
      case "BLOCKED":
        intermediate = mk(RESULT_KEY.BLOCKED, v.reason || null);
        break;
      case "INVALID":
        intermediate = mk(RESULT_KEY.UNKNOWN, v.reason || null);
        break;
      default:
        // VALID without any higher-layer result — no HTTP result to report.
        intermediate = mk(RESULT_KEY.UNKNOWN);
    }
    finalUrlForRedirect = null;

  } else {
    // ── 2e: No result objects provided ──────────────────────────────────────
    intermediate = mk(RESULT_KEY.UNKNOWN);
    finalUrlForRedirect = null;
  }

  // ── Step 3: Determine redirected_to ──────────────────────────────────────
  //
  // Set redirected_to when finalUrl is non-null and differs from normalizedUrl.
  // Plain text only. Must not be rendered as a hyperlink.
  const redirectedTo =
    typeof finalUrlForRedirect === "string" &&
    finalUrlForRedirect !== null &&
    finalUrlForRedirect !== normalizedUrl
      ? finalUrlForRedirect
      : null;

  // ── Step 4: Assemble final output ─────────────────────────────────────────
  return {
    original_input: originalInput,
    normalized_url: normalizedUrl,
    result: intermediate.result,
    meaning: intermediate.meaning,
    redirected_to: redirectedTo,
    checked_at: checkedAt,
    notes: intermediate.notes,
  };
}
