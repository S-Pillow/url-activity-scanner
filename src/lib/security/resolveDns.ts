/**
 * AIPF-003: DNS Resolution Check
 *
 * Resolves a hostname to public IP addresses using the server/system DNS
 * resolver and validates every returned IP against the SSRF blocklist from
 * ipSafety.ts.
 *
 * Call order enforced by this module:
 *   validateUrl()   →   resolveDns()   →   (AIPF-004: HEAD request)
 *
 * Safety guarantees:
 *   - Input must be a VALID result from AIPF-002 validateUrl(). Any other
 *     result (BLOCKED or INVALID) is forwarded immediately — no DNS lookup.
 *   - A and AAAA records are both attempted; any usable record is sufficient.
 *   - Every resolved IP is checked against the SSRF blocklist in ipSafety.ts.
 *     If any single resolved IP is blocked, the entire URL is blocked.
 *   - If no A or AAAA record resolves, DNS_FAILURE is returned.
 *   - Uses Node.js dns.promises (system/server resolver). No third-party API.
 *   - No HTTP, HTTPS, HEAD, GET, or any other network request is made.
 *   - No content is fetched, rendered, previewed, cached, or stored.
 *   - Submitted hostnames and resolved IPs are not logged.
 *
 * Assumption A-AIPF003-01:
 *   DNS resolution uses the server's system resolver as configured in the
 *   host OS (e.g. /etc/resolv.conf on Linux). No custom resolver is injected.
 *   This matches A-03 from the AIPF-001 discovery package.
 *
 * Assumption A-AIPF003-02:
 *   DNS timeout is governed by the system resolver configuration. Node's
 *   dns.promises API cannot cancel an in-flight query, so the request-scoped
 *   AbortSignal makes this function stop awaiting it; late completion is
 *   observed and ignored and cannot proceed to IP checks or socket creation.
 *
 * Assumption A-AIPF003-03:
 *   No DNS result caching is performed in this module. If the platform later
 *   introduces response-level caching (e.g. edge caching), that must be
 *   reviewed to ensure cached resolved IPs are not reused across requests,
 *   as stale IPs could allow DNS-rebinding attacks.
 */

import { promises as dnsPromises } from "dns";
import { checkIpSafety } from "./ipSafety";
import type { UrlValidationResult } from "./validateUrl";
import { raceWithSignal, throwIfAborted } from "./cancellation";

// ─── Public types ─────────────────────────────────────────────────────────────

export type DnsResult = "DNS_OK" | "DNS_FAILURE" | "BLOCKED" | "INVALID";

export interface DnsCheckResult {
  /** True only when result === "DNS_OK". Safe to proceed to scan phase. */
  allowed: boolean;
  /** Forwarded from the AIPF-002 validation result — not logged. */
  originalInput: string;
  /** Forwarded from the AIPF-002 validation result — not logged. */
  normalizedUrl: string | null;
  /** Forwarded from the AIPF-002 validation result — not logged. */
  hostname: string | null;
  /** Forwarded from the AIPF-002 validation result. */
  scheme: "http" | "https" | null;
  /**
   * All IP addresses returned by the system resolver (A and AAAA combined).
   * Empty if DNS resolution failed or if the input was already blocked.
   * Never logged. Never stored. Never rendered as hyperlinks.
   */
  resolvedIps: string[];
  /** Human-readable explanation of the DNS check outcome. */
  reason: string;
  /** Machine-readable result code. */
  result: DnsResult;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function makeDnsResult(
  partial: Omit<DnsCheckResult, "allowed">
): DnsCheckResult {
  return { ...partial, allowed: partial.result === "DNS_OK" };
}

/**
 * Attempts to resolve A records for the given hostname.
 * Returns an empty array on any error (ENODATA, ENOTFOUND, ETIMEOUT, etc.).
 * Errors are not propagated — callers treat an empty array as "no A records".
 */
async function tryResolveA(hostname: string): Promise<string[]> {
  try {
    return await dnsPromises.resolve4(hostname);
  } catch {
    return [];
  }
}

/**
 * Attempts to resolve AAAA records for the given hostname.
 * Returns an empty array on any error.
 */
async function tryResolveAAAA(hostname: string): Promise<string[]> {
  try {
    return await dnsPromises.resolve6(hostname);
  } catch {
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Performs a safe DNS resolution check for a URL already validated by AIPF-002.
 *
 * Must be called server-side only, after validateUrl().
 * Makes only DNS queries — no HTTP/HTTPS requests.
 * Does not log hostnames, resolved IPs, or any part of the URL.
 *
 * @param validationResult - The structured result from validateUrl().
 * @param options.signal - Request-scoped cancellation signal.
 * @returns A structured DnsCheckResult.
 */
export async function resolveDns(
  validationResult: UrlValidationResult,
  options?: { signal?: AbortSignal }
): Promise<DnsCheckResult> {
  const signal = options?.signal;
  throwIfAborted(signal);

  const { originalInput, normalizedUrl, hostname, scheme } = validationResult;

  // ── Step 1: Gate — do not proceed if AIPF-002 did not pass ───────────────
  //
  // BLOCKED inputs are forwarded as BLOCKED (not re-evaluated as INVALID).
  // INVALID inputs are forwarded as INVALID.
  // No DNS lookup is attempted for either case.
  if (validationResult.result !== "VALID") {
    const forwardedResult: DnsResult =
      validationResult.result === "INVALID" ? "INVALID" : "BLOCKED";
    return makeDnsResult({
      originalInput,
      normalizedUrl,
      hostname,
      scheme,
      resolvedIps: [],
      reason: validationResult.reason,
      result: forwardedResult,
    });
  }

  // Invariant: if AIPF-002 returned VALID, hostname must be non-null.
  // Guard defensively in case of future API misuse.
  if (!hostname) {
    return makeDnsResult({
      originalInput,
      normalizedUrl,
      hostname: null,
      scheme,
      resolvedIps: [],
      reason: "Hostname missing from validation result",
      result: "INVALID",
    });
  }

  // ── Step 2: Resolve A and AAAA records concurrently ──────────────────────
  //
  // Both are attempted in parallel. Errors from either resolver (ENODATA,
  // ENOTFOUND, ETIMEOUT, ESERVFAIL, etc.) are silently swallowed by
  // tryResolveA / tryResolveAAAA — an empty array signals "no records".
  // This is intentional: we care about what resolved, not why something failed.
  const [ipv4s, ipv6s] = await raceWithSignal(
    Promise.all([
      tryResolveA(hostname),
      tryResolveAAAA(hostname),
    ]),
    signal
  );

  // Node's dns.promises resolver has no AbortSignal support. A late completion
  // must never proceed into IP policy checks or socket creation.
  throwIfAborted(signal);

  const resolvedIps: string[] = [...ipv4s, ...ipv6s];

  // ── Step 3: DNS failure if nothing resolved ───────────────────────────────
  if (resolvedIps.length === 0) {
    return makeDnsResult({
      originalInput,
      normalizedUrl,
      hostname,
      scheme,
      resolvedIps: [],
      reason: "Domain does not resolve",
      result: "DNS_FAILURE",
    });
  }

  // ── Step 4: Validate every resolved IP against the SSRF blocklist ─────────
  //
  // All IPs must be safe. If any single IP is unsafe, the entire URL is blocked.
  // This prevents split-horizon DNS attacks where one of several resolved IPs
  // points to an internal address.
  for (const ip of resolvedIps) {
    throwIfAborted(signal);
    const blockReason = checkIpSafety(ip);
    if (blockReason !== null) {
      return makeDnsResult({
        originalInput,
        normalizedUrl,
        hostname,
        scheme,
        resolvedIps,
        reason: "Resolved IP is private/internal/reserved",
        result: "BLOCKED",
      });
    }
  }

  // ── Step 5: All resolved IPs passed — allow ───────────────────────────────
  return makeDnsResult({
    originalInput,
    normalizedUrl,
    hostname,
    scheme,
    resolvedIps,
    reason: "DNS resolved to safe public IP(s)",
    result: "DNS_OK",
  });
}
