/**
 * AIPF-004: HEAD Request Engine — Unit Tests
 *
 * All HTTP traffic is intercepted through the _fetcher seam. No live network
 * requests are made. resolveDns is mocked at the module level so redirect
 * DNS checks are deterministic. validateUrl uses the real implementation
 * because it is pure (no I/O) and tests must exercise its blocking logic.
 *
 * Test count: 35 tests (≥ 30 required by AIPF-004).
 */

import { sendHeadRequest } from "../headRequest";
import type { HeadRequestResult, SingleHopFetcher } from "../headRequest";
import { validateUrl } from "../validateUrl";
import { resolveDns } from "../resolveDns";
import type { DnsCheckResult } from "../resolveDns";

// ─── Module-level mock for resolveDns ────────────────────────────────────────
//
// resolveDns is called inside sendHeadRequest only for redirect DNS re-checks.
// The initial DNS check is performed by the caller and passed as a parameter.
jest.mock("../resolveDns");
const mockResolveDns = resolveDns as jest.MockedFunction<typeof resolveDns>;

// ─── Test fixture helpers ─────────────────────────────────────────────────────

/** Builds a DNS_OK result for a public URL, simulating a successful AIPF-003 pass. */
function makeDnsOk(url = "https://example.com"): DnsCheckResult {
  const v = validateUrl(url);
  return {
    allowed: true,
    originalInput: v.originalInput,
    normalizedUrl: v.normalizedUrl,
    hostname: v.hostname,
    scheme: v.scheme,
    resolvedIps: ["93.184.216.34"],
    reason: "DNS resolved to safe public IP(s)",
    result: "DNS_OK",
  };
}

/** Builds a DNS_FAILURE result (domain did not resolve). */
function makeDnsFailure(url = "https://example.com"): DnsCheckResult {
  const v = validateUrl(url);
  return {
    allowed: false,
    originalInput: v.originalInput,
    normalizedUrl: v.normalizedUrl,
    hostname: v.hostname,
    scheme: v.scheme,
    resolvedIps: [],
    reason: "Domain does not resolve",
    result: "DNS_FAILURE",
  };
}

/** Builds a BLOCKED DNS result (resolved IP was private/reserved). */
function makeDnsBlocked(url = "https://example.com"): DnsCheckResult {
  const v = validateUrl(url);
  return {
    allowed: false,
    originalInput: v.originalInput,
    normalizedUrl: v.normalizedUrl,
    hostname: v.hostname,
    scheme: v.scheme,
    resolvedIps: ["10.0.0.1"],
    reason: "Resolved IP is private/internal/reserved",
    result: "BLOCKED",
  };
}

/** Builds an INVALID DNS result (prior validateUrl returned INVALID). */
function makeDnsInvalid(): DnsCheckResult {
  return {
    allowed: false,
    originalInput: "not a url",
    normalizedUrl: null,
    hostname: null,
    scheme: null,
    resolvedIps: [],
    reason: "Invalid URL format",
    result: "INVALID",
  };
}

/**
 * Builds a _fetcher mock that returns responses in sequence.
 * Each element in the array corresponds to one HEAD hop.
 */
function makeFetcher(
  responses: Array<
    | { ok: true; statusCode: number; locationHeader?: string | null }
    | { ok: false; result: "TIMEOUT" | "CONNECTION_REFUSED" | "NETWORK_ERROR"; reason?: string }
  >
): jest.MockedFunction<SingleHopFetcher> {
  let idx = 0;
  return jest.fn().mockImplementation(() => {
    const r = responses[idx++];
    if (!r) return Promise.resolve({ ok: true, statusCode: 200, locationHeader: null });
    if (!r.ok) {
      return Promise.resolve({
        ok: false,
        result: r.result,
        reason: r.reason ?? r.result,
      });
    }
    return Promise.resolve({
      ok: true,
      statusCode: r.statusCode,
      locationHeader: r.locationHeader ?? null,
    });
  });
}

beforeEach(() => {
  // resetAllMocks clears both call history AND mock implementations / return
  // values, preventing return values set in one describe block's beforeEach
  // from leaking into tests in a later describe block.
  jest.resetAllMocks();
});

// ─── 1. Prior gate failures ───────────────────────────────────────────────────
//
// If the DnsCheckResult passed in is not DNS_OK, no HEAD request must be made.

describe("1. Prior gate — no HEAD request made when DNS check did not pass", () => {
  it("forwards INVALID result without calling the fetcher", async () => {
    const fetcher = makeFetcher([]);
    const result = await sendHeadRequest(makeDnsInvalid(), { _fetcher: fetcher });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.result).toBe("INVALID");
    expect(result.allowed).toBe(false);
  });

  it("forwards BLOCKED result without calling the fetcher", async () => {
    const fetcher = makeFetcher([]);
    const result = await sendHeadRequest(makeDnsBlocked(), { _fetcher: fetcher });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
  });

  it("forwards DNS_FAILURE result without calling the fetcher", async () => {
    const fetcher = makeFetcher([]);
    const result = await sendHeadRequest(makeDnsFailure(), { _fetcher: fetcher });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.result).toBe("DNS_FAILURE");
    expect(result.allowed).toBe(false);
  });
});

// ─── 2. Direct (non-redirect) HEAD responses ─────────────────────────────────

describe("2. HEAD_OK — non-redirect responses", () => {
  it("HEAD 200 → HEAD_OK, allowed, correct statusCode", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("HEAD_OK");
    expect(result.statusCode).toBe(200);
    expect(result.allowed).toBe(true);
    expect(result.redirected).toBe(false);
    expect(result.redirectCount).toBe(0);
  });

  it("HEAD 204 → HEAD_OK", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 204 }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("HEAD_OK");
    expect(result.statusCode).toBe(204);
    expect(result.allowed).toBe(true);
  });

  it("HEAD 403 → HEAD_OK (server exists, access denied — not a security block)", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 403 }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("HEAD_OK");
    expect(result.statusCode).toBe(403);
    expect(result.allowed).toBe(true);
  });

  it("HEAD 404 → HEAD_OK", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 404 }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("HEAD_OK");
    expect(result.statusCode).toBe(404);
    expect(result.allowed).toBe(true);
  });

  it("HEAD 410 → HEAD_OK", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 410 }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("HEAD_OK");
    expect(result.statusCode).toBe(410);
    expect(result.allowed).toBe(true);
  });

  it("HEAD 500 → HEAD_OK (server error is still a valid response)", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 500 }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("HEAD_OK");
    expect(result.statusCode).toBe(500);
    expect(result.allowed).toBe(true);
  });
});

// ─── 3. Network error categories ─────────────────────────────────────────────

describe("3. Network error categories", () => {
  it("timeout → TIMEOUT, not allowed", async () => {
    const fetcher = makeFetcher([{ ok: false, result: "TIMEOUT", reason: "Request timed out" }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("TIMEOUT");
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBeNull();
  });

  it("connection refused → CONNECTION_REFUSED, not allowed", async () => {
    const fetcher = makeFetcher([{ ok: false, result: "CONNECTION_REFUSED", reason: "Connection refused" }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("CONNECTION_REFUSED");
    expect(result.allowed).toBe(false);
  });

  it("generic network error → NETWORK_ERROR, not allowed", async () => {
    const fetcher = makeFetcher([{ ok: false, result: "NETWORK_ERROR", reason: "Network error: ECONNRESET" }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("NETWORK_ERROR");
    expect(result.allowed).toBe(false);
  });
});

// ─── 4. Redirect codes ────────────────────────────────────────────────────────
//
// 301, 302, 303, 307, 308 are all redirect codes. The engine must follow each
// one and validate the destination before the next request.

describe("4. Redirect codes — each supported code is followed once to a safe destination", () => {
  const redirectTests: Array<[number]> = [[301], [302], [303], [307], [308]];

  beforeEach(() => {
    // Simulate DNS passing for the redirect destination
    mockResolveDns.mockResolvedValue(makeDnsOk("https://redirect-destination.com"));
  });

  it.each(redirectTests)("single %d redirect to safe destination → REDIRECTED", async (code) => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: code, locationHeader: "https://redirect-destination.com" },
      { ok: true, statusCode: 200 },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("REDIRECTED");
    expect(result.allowed).toBe(true);
    expect(result.redirected).toBe(true);
    expect(result.redirectCount).toBe(1);
    expect(result.redirectChain).toEqual(["https://redirect-destination.com/"]);
    expect(result.statusCode).toBe(200);
    // Fetcher must have been called twice: once for the original URL, once for the destination
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// ─── 5. Redirect Location handling ───────────────────────────────────────────

describe("5. Redirect Location handling", () => {
  it("relative Location is resolved against the current URL", async () => {
    // DNS must succeed for the redirect destination so the engine can follow it.
    mockResolveDns.mockResolvedValue(makeDnsOk("https://example.com"));

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "/new-path" },
      { ok: true, statusCode: 200 },
    ]);
    const result = await sendHeadRequest(makeDnsOk("https://example.com"), { _fetcher: fetcher });

    expect(result.result).toBe("REDIRECTED");
    // Relative /new-path resolved against https://example.com = https://example.com/new-path
    expect(result.redirectChain[0]).toBe("https://example.com/new-path");
  });

  it("missing Location header → NETWORK_ERROR", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: null },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("NETWORK_ERROR");
    expect(result.allowed).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Location that resolves to a URL with no hostname → INVALID (validateUrl rejects it)", async () => {
    // "http://" is an absolute URL with empty hostname. The WHATWG URL parser
    // accepts it, but validateUrl() rejects it as INVALID (missing hostname).
    // No DNS check or second HTTP request should be made.
    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "http://" },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("INVALID");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── 6. Blocked redirect destinations ────────────────────────────────────────
//
// The engine must not follow redirects to unsafe destinations.
// validateUrl() catches scheme, hostname, and IP violations before DNS.

describe("6. Blocked redirect destinations", () => {
  it("redirect to unsupported scheme (ftp://) is blocked, no second request", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "ftp://files.example.com/data" },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    // resolveDns must NOT be called — validateUrl blocks it before DNS
    expect(mockResolveDns).not.toHaveBeenCalled();
    // Fetcher must NOT be called a second time
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redirect to localhost is blocked", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "http://localhost/admin" },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redirect to private IPv4 (10.0.0.1) is blocked by validateUrl", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "http://10.0.0.1/" },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redirect to private IPv6 (::1) is blocked by validateUrl", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "http://[::1]/secret" },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── 7. Redirect DNS failure ──────────────────────────────────────────────────

describe("7. Redirect destination DNS failure", () => {
  it("DNS_FAILURE on redirect destination → DNS_FAILURE result, no second request", async () => {
    // validateUrl passes (it's a syntactically valid public-looking domain)
    // but resolveDns fails (domain doesn't resolve)
    mockResolveDns.mockResolvedValue(makeDnsFailure("https://does-not-exist-xyz123.example"));

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://does-not-exist-xyz123.example" },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("DNS_FAILURE");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).toHaveBeenCalledTimes(1);
    // No second HTTP request should have been made
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("BLOCKED on redirect destination DNS → BLOCKED result", async () => {
    mockResolveDns.mockResolvedValue(makeDnsBlocked("https://split-horizon.example.com"));

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://split-horizon.example.com" },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── 8. Redirect cap ─────────────────────────────────────────────────────────

describe("8. Redirect cap enforcement", () => {
  it("exactly 3 hops → REDIRECTED (within limit)", async () => {
    // The engine must allow up to 3 redirects.
    mockResolveDns.mockResolvedValue(makeDnsOk("https://hop.example.com"));

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://hop1.example.com" },
      { ok: true, statusCode: 302, locationHeader: "https://hop2.example.com" },
      { ok: true, statusCode: 307, locationHeader: "https://hop3.example.com" },
      { ok: true, statusCode: 200 },
    ]);
    const result = await sendHeadRequest(makeDnsOk("https://example.com"), { _fetcher: fetcher });

    expect(result.result).toBe("REDIRECTED");
    expect(result.allowed).toBe(true);
    expect(result.redirectCount).toBe(3);
    expect(result.redirectChain).toHaveLength(3);
    expect(result.statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(4); // 1 original + 3 hops
  });

  it("4 redirects (> 3 cap) → TOO_MANY_REDIRECTS, engine stops", async () => {
    mockResolveDns.mockResolvedValue(makeDnsOk("https://hop.example.com"));

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://hop1.example.com" },
      { ok: true, statusCode: 302, locationHeader: "https://hop2.example.com" },
      { ok: true, statusCode: 307, locationHeader: "https://hop3.example.com" },
      // 4th redirect response — the engine must stop here
      { ok: true, statusCode: 308, locationHeader: "https://hop4.example.com" },
    ]);
    const result = await sendHeadRequest(makeDnsOk("https://example.com"), { _fetcher: fetcher });

    expect(result.result).toBe("TOO_MANY_REDIRECTS");
    expect(result.allowed).toBe(false);
    expect(result.redirectCount).toBe(3);
    // The 4th hop was detected but not followed
    expect(fetcher).toHaveBeenCalledTimes(4);
    // resolveDns was called for hops 1-3 but not hop 4
    expect(mockResolveDns).toHaveBeenCalledTimes(3);
  });
});

// ─── 9. Contract and shape verification ──────────────────────────────────────

describe("9. Return shape and contract", () => {
  it("result shape includes all required fields", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await sendHeadRequest(makeDnsOk("https://example.com"), { _fetcher: fetcher });

    const requiredFields: Array<keyof HeadRequestResult> = [
      "allowed",
      "originalInput",
      "normalizedUrl",
      "finalUrl",
      "statusCode",
      "redirected",
      "redirectChain",
      "redirectCount",
      "durationMs",
      "reason",
      "result",
    ];
    for (const field of requiredFields) {
      expect(result).toHaveProperty(field);
    }
  });

  it("durationMs is a non-negative number", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("redirectChain contains only plain strings (no objects, no hyperlinks)", async () => {
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://destination.example.com/path" },
      { ok: true, statusCode: 200 },
    ]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(Array.isArray(result.redirectChain)).toBe(true);
    for (const entry of result.redirectChain) {
      expect(typeof entry).toBe("string");
    }
  });

  it("no automatic redirect following — fetcher is called once per hop manually", async () => {
    // If automatic redirect following were enabled, the fetcher would be called
    // once and the redirect would be transparent. Manual handling requires
    // two fetcher calls: one for the original URL and one for the destination.
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://destination.example.com" },
      { ok: true, statusCode: 200 },
    ]);
    await sendHeadRequest(makeDnsOk("https://example.com"), { _fetcher: fetcher });

    // Exactly 2 calls: one for the original URL, one for the redirect destination
    expect(fetcher).toHaveBeenCalledTimes(2);
    // And resolveDns was called once for the redirect destination re-check
    expect(mockResolveDns).toHaveBeenCalledTimes(1);
  });

  it("no response body is read — result fields contain no body content", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    // The result must not expose any body-derived fields
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("html");
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("contentType");
    expect(result).not.toHaveProperty("title");
  });

  it("no GET fallback — only the _fetcher is invoked (no separate GET code path)", async () => {
    // For a non-redirect response there must be exactly 1 fetcher call and
    // no secondary mechanism to retrieve page content.
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("originalInput is preserved from the DnsCheckResult", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const dnsResult = makeDnsOk("https://example.com/path?q=1");
    const result = await sendHeadRequest(dnsResult, { _fetcher: fetcher });

    expect(result.originalInput).toBe(dnsResult.originalInput);
  });

  it("normalizedUrl is preserved from the DnsCheckResult", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const dnsResult = makeDnsOk("https://example.com");
    const result = await sendHeadRequest(dnsResult, { _fetcher: fetcher });

    expect(result.normalizedUrl).toBe(dnsResult.normalizedUrl);
  });

  it("finalUrl for a non-redirect response is the normalizedUrl", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const dnsResult = makeDnsOk("https://example.com");
    const result = await sendHeadRequest(dnsResult, { _fetcher: fetcher });

    expect(result.finalUrl).toBe(dnsResult.normalizedUrl);
  });

  it("finalUrl for a redirect response is the last redirect destination", async () => {
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://final.example.com/landing" },
      { ok: true, statusCode: 200 },
    ]);
    const result = await sendHeadRequest(makeDnsOk("https://example.com"), { _fetcher: fetcher });

    expect(result.finalUrl).toBe("https://final.example.com/landing");
  });

  it("redirected is false for a direct (no-redirect) response", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await sendHeadRequest(makeDnsOk(), { _fetcher: fetcher });

    expect(result.redirected).toBe(false);
    expect(result.redirectCount).toBe(0);
    expect(result.redirectChain).toHaveLength(0);
  });

  it("redirected is true and redirectCount is correct after following redirects", async () => {
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "https://b.example.com" },
      { ok: true, statusCode: 302, locationHeader: "https://c.example.com" },
      { ok: true, statusCode: 200 },
    ]);

    const result = await sendHeadRequest(makeDnsOk("https://a.example.com"), { _fetcher: fetcher });

    expect(result.redirected).toBe(true);
    expect(result.redirectCount).toBe(2);
    expect(result.redirectChain).toHaveLength(2);
  });
});
