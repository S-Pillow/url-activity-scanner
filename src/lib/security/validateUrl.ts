/**
 * AIPF-002: SSRF Protection & URL Validation Layer
 *
 * Server-side URL validation for the URL Activity Scanner.
 * Determines whether a submitted URL is safe to proceed with scanning.
 *
 * Safety guarantees enforced here:
 *   - Only http:// and https:// URLs are allowed.
 *   - Plain domains are normalized to https://.
 *   - Private, loopback, link-local, multicast, documentation, carrier-grade
 *     NAT, and reserved IPv4 and IPv6 ranges are blocked (via ipSafety.ts).
 *   - IPv4-mapped IPv6 addresses are checked against the IPv4 blocklists.
 *   - Known dangerous hostnames (localhost, cloud metadata) are blocked.
 *   - No network request is made.
 *   - No submitted URL is logged.
 *
 * IP safety logic lives in ipSafety.ts and is shared with the DNS resolution
 * layer (AIPF-003) to prevent parity gaps between the two safety gates.
 *
 * Placement note (assumption A-AIPF002-01):
 *   This module lives at src/lib/security/validateUrl.ts. When the Next.js
 *   app scaffold is created (AIPF-009), this path will slot directly into
 *   src/lib/security/ under the app root with no changes required.
 */

import * as net from "net";
import { checkIpSafety } from "./ipSafety";

// ─── Public types ────────────────────────────────────────────────────────────

export type ValidationResult = "VALID" | "BLOCKED" | "INVALID";

export interface UrlValidationResult {
  /** True only when result === "VALID". Safe to proceed to DNS/scan phase. */
  allowed: boolean;
  /** The raw string as submitted by the user — not logged, not stored. */
  originalInput: string;
  /**
   * The normalized URL that was validated.
   * Plain domains are prefixed with https://.
   * Null if the input was completely unparseable.
   * Never rendered as a hyperlink. Never logged.
   */
  normalizedUrl: string | null;
  /**
   * The extracted hostname (IPv4, IPv6 without brackets, or domain).
   * Null if extraction failed.
   * Never rendered as a hyperlink. Never logged.
   */
  hostname: string | null;
  /** The detected scheme. Null if not http or https. */
  scheme: "http" | "https" | null;
  /** Human-readable explanation of the validation outcome. */
  reason: string;
  /** Machine-readable result code. */
  result: ValidationResult;
}

// ─── Blocked hostnames ───────────────────────────────────────────────────────

const BLOCKED_HOSTNAME_EXACT = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

/**
 * Any hostname that ends with one of these suffixes is blocked.
 * E.g. "foo.localhost", "bar.local", "host.internal".
 */
const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".localdomain",
  ".local",    // mDNS / Bonjour — not publicly routable
  ".internal",
];

function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAME_EXACT.has(hostname)) return true;
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) return true;
  }
  return false;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function makeResult(
  partial: Omit<UrlValidationResult, "allowed">
): UrlValidationResult {
  return { ...partial, allowed: partial.result === "VALID" };
}

function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Validates a single raw URL string for SSRF safety and protocol correctness.
 *
 * Must be called server-side only.
 * Makes no outbound network requests.
 * Does not log the submitted URL at any point.
 *
 * @param rawInput - A single raw URL or domain string from user input.
 * @returns A structured UrlValidationResult.
 */
export function validateUrl(rawInput: string): UrlValidationResult {
  const originalInput = rawInput;

  // ── Step 1: Trim whitespace ──────────────────────────────────────────────
  const trimmed = rawInput.trim();

  // ── Step 2: Reject empty input ───────────────────────────────────────────
  if (!trimmed) {
    return makeResult({
      originalInput,
      normalizedUrl: null,
      hostname: null,
      scheme: null,
      reason: "Empty input",
      result: "INVALID",
    });
  }

  // ── Step 3: Parse the URL, adding https:// for plain domains ─────────────
  //
  // Strategy: try parsing as-is first (handles http://, https://, ftp://,
  // javascript:, data:, file://, etc.). If that fails, the input has no
  // recognizable scheme — try prefixing https:// to support plain domains
  // like "example.com" and "example.com/path".
  //
  // This order is intentional: it ensures that opaque-scheme inputs like
  // "javascript:alert(1)" are caught by the scheme check below rather than
  // accidentally parsed as https://javascript:alert(1).
  let parsed: URL;
  let urlStr = trimmed;

  const parsedRaw = tryParseUrl(trimmed);
  if (parsedRaw !== null) {
    parsed = parsedRaw;
  } else {
    const withScheme = "https://" + trimmed;
    const parsedPrefixed = tryParseUrl(withScheme);
    if (parsedPrefixed !== null) {
      urlStr = withScheme;
      parsed = parsedPrefixed;
    } else {
      return makeResult({
        originalInput,
        normalizedUrl: null,
        hostname: null,
        scheme: null,
        reason: "Invalid URL format",
        result: "INVALID",
      });
    }
  }

  // ── Step 4: Validate scheme ──────────────────────────────────────────────
  const proto = parsed.protocol; // includes trailing colon: "http:", "https:", etc.
  if (proto !== "http:" && proto !== "https:") {
    return makeResult({
      originalInput,
      normalizedUrl: urlStr,
      hostname: null,
      scheme: null,
      reason: "Unsupported protocol",
      result: "BLOCKED",
    });
  }
  const scheme: "http" | "https" = proto === "http:" ? "http" : "https";

  // ── Step 5: Extract and normalize hostname ───────────────────────────────
  //
  // WHATWG URL spec: .hostname includes brackets for IPv6 addresses: "[::1]".
  // We strip brackets here so that net.isIPv6() and the CIDR checks work on
  // the bare address string.
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  // Strip trailing dots (some inputs use fully-qualified domain notation).
  hostname = hostname.replace(/\.+$/, "");

  // ── Step 6: Reject missing hostname ─────────────────────────────────────
  if (!hostname) {
    return makeResult({
      originalInput,
      normalizedUrl: urlStr,
      hostname: null,
      scheme,
      reason: "Missing hostname",
      result: "INVALID",
    });
  }

  // ── Step 7: IP address range check (IPv4 and IPv6) ───────────────────────
  //
  // WHATWG URL normalizes IPv4 variants (hex, octal, decimal-encoded) to
  // dotted-decimal before we see parsed.hostname. E.g.:
  //   http://0x7f000001  → hostname "127.0.0.1"
  //   http://2130706433  → hostname "127.0.0.1"
  //   http://0177.0.0.1  → hostname "127.0.0.1"
  //
  // checkIpSafety() handles both IPv4 and IPv6 via the shared ipSafety module.
  if (net.isIPv4(hostname) || net.isIPv6(hostname)) {
    const reason = checkIpSafety(hostname);
    if (reason !== null) {
      return makeResult({
        originalInput,
        normalizedUrl: urlStr,
        hostname,
        scheme,
        reason,
        result: "BLOCKED",
      });
    }
    // IP passed all checks — fall through to VALID.
  }

  // ── Step 8: Blocked hostname check ──────────────────────────────────────
  else if (isBlockedHostname(hostname)) {
    return makeResult({
      originalInput,
      normalizedUrl: urlStr,
      hostname,
      scheme,
      reason: "Blocked hostname",
      result: "BLOCKED",
    });
  }

  // ── Step 9: All checks passed ────────────────────────────────────────────
  return makeResult({
    originalInput,
    normalizedUrl: parsed.href,
    hostname,
    scheme,
    reason: "URL is valid and allowed",
    result: "VALID",
  });
}
