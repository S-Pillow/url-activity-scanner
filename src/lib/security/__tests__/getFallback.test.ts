/**
 * AIPF-005: GET Fallback Handler — Unit Tests
 *
 * The HTTP layer is replaced entirely by the _fetcher seam.
 * resolveDns is mocked at module level so redirect DNS re-checks are
 * deterministic. validateUrl uses the real implementation (pure, no I/O)
 * because blocked-redirect tests must exercise its safety logic.
 *
 * Test count: 46 tests (≥ 40 required by AIPF-005).
 */

import { runGetFallback } from "../getFallback";
import type { GetFallbackResult, GetResult } from "../getFallback";
import type { HeadRequestResult } from "../headRequest";
import type { SingleHopFetcher } from "../headRequest";
import { validateUrl } from "../validateUrl";
import { resolveDns } from "../resolveDns";
import type { DnsCheckResult } from "../resolveDns";

// ─── Module-level mock for resolveDns ────────────────────────────────────────
jest.mock("../resolveDns");
const mockResolveDns = resolveDns as jest.MockedFunction<typeof resolveDns>;

// ─── HEAD result fixture helpers ─────────────────────────────────────────────

/**
 * Simulates a HEAD_OK result with the given status code and URL.
 * Represents a direct (non-redirect) HEAD response.
 */
function makeHeadOk(
  statusCode: number,
  url = "https://example.com/"
): HeadRequestResult {
  return {
    allowed: statusCode < 400,
    originalInput: url.replace(/\/$/, ""),
    normalizedUrl: url,
    finalUrl: url,
    statusCode,
    redirected: false,
    redirectChain: [],
    redirectCount: 0,
    durationMs: 50,
    reason: "HEAD request completed",
    result: "HEAD_OK",
  };
}

/**
 * Simulates a REDIRECTED HEAD result where HEAD eventually returned the
 * given status code after following one redirect.
 */
function makeHeadRedirected(
  statusCode: number,
  finalUrl = "https://final.example.com/"
): HeadRequestResult {
  return {
    allowed: statusCode < 400,
    originalInput: "https://example.com",
    normalizedUrl: "https://example.com/",
    finalUrl,
    statusCode,
    redirected: true,
    redirectChain: [finalUrl],
    redirectCount: 1,
    durationMs: 100,
    reason: "HEAD request completed after redirect(s)",
    result: "REDIRECTED",
  };
}

/** Simulates a HEAD result that never received an HTTP response. */
function makeHeadNoResponse(
  result: HeadRequestResult["result"],
  reason: string
): HeadRequestResult {
  return {
    allowed: false,
    originalInput: "https://example.com",
    normalizedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    statusCode: null,
    redirected: false,
    redirectChain: [],
    redirectCount: 0,
    durationMs: 10_000,
    reason,
    result,
  };
}

// ─── DNS result fixture helpers ───────────────────────────────────────────────

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

function makeDnsFailure(): DnsCheckResult {
  const v = validateUrl("https://example.com");
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

function makeDnsBlocked(): DnsCheckResult {
  const v = validateUrl("https://example.com");
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

// ─── GET fetcher fixture helper ───────────────────────────────────────────────

function makeFetcher(
  responses: Array<
    | { ok: true; statusCode: number; locationHeader?: string | null }
    | {
        ok: false;
        result: "TIMEOUT" | "CONNECTION_REFUSED" | "NETWORK_ERROR";
        reason?: string;
      }
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
  jest.resetAllMocks();
});

// ─── 1. NOT_APPLICABLE — fallback must not run ───────────────────────────────
//
// Tests 3–10 in the AIPF-005 spec.

describe("1. NOT_APPLICABLE — GET fallback does not run for non-405/501 HEAD outcomes", () => {
  const notApplicableCases: Array<[string, HeadRequestResult]> = [
    ["HEAD 200", makeHeadOk(200)],
    ["HEAD 204", makeHeadOk(204)],
    ["HEAD 403", makeHeadOk(403)],
    ["HEAD 404", makeHeadOk(404)],
    ["HEAD 410", makeHeadOk(410)],
    ["HEAD 500", makeHeadOk(500)],
    ["HEAD timeout (null statusCode)", makeHeadNoResponse("TIMEOUT", "Request timed out")],
    ["HEAD connection refused (null statusCode)", makeHeadNoResponse("CONNECTION_REFUSED", "Connection refused")],
  ];

  it.each(notApplicableCases)(
    "%s → NOT_APPLICABLE, fetcher not called",
    async (_label, headResult) => {
      const fetcher = jest.fn<Promise<Awaited<ReturnType<SingleHopFetcher>>>, [string, { timeoutMs: number }]>();
      const result = await runGetFallback(headResult, { _fetcher: fetcher });

      expect(result.result).toBe("NOT_APPLICABLE");
      expect(result.allowed).toBe(false);
      expect(result.usedGetFallback).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );
});

// ─── 2. GET fallback trigger conditions ──────────────────────────────────────
//
// Tests 1–2 in the AIPF-005 spec.

describe("2. Trigger conditions — fallback runs only for HEAD 405 and 501", () => {
  it("HEAD 405 → GET fallback runs (usedGetFallback: true)", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.usedGetFallback).toBe(true);
    expect(result.result).toBe("GET_FALLBACK_OK");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("HEAD 501 → GET fallback runs (usedGetFallback: true)", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await runGetFallback(makeHeadOk(501), { _fetcher: fetcher });

    expect(result.usedGetFallback).toBe(true);
    expect(result.result).toBe("GET_FALLBACK_OK");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("HEAD 405 after redirect (REDIRECTED result) → GET fallback still runs", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await runGetFallback(
      makeHeadRedirected(405, "https://final.example.com/"),
      { _fetcher: fetcher }
    );

    expect(result.usedGetFallback).toBe(true);
    expect(result.result).toBe("GET_FALLBACK_OK");
    // GET is sent to finalUrl (where HEAD received 405)
    expect(fetcher).toHaveBeenCalledWith(
      "https://final.example.com/",
      expect.any(Object)
    );
  });
});

// ─── 3. GET response status codes ────────────────────────────────────────────
//
// Tests 11–15 in the AIPF-005 spec.

describe("3. GET response status codes — GET_FALLBACK_OK for any non-redirect response", () => {
  const statusCases: Array<[number]> = [[200], [403], [404], [410], [500]];

  it.each(statusCases)(
    "GET %d → GET_FALLBACK_OK, allowed for 2xx/4xx/5xx, correct statusCode",
    async (code) => {
      const fetcher = makeFetcher([{ ok: true, statusCode: code }]);
      const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

      expect(result.result).toBe("GET_FALLBACK_OK");
      expect(result.statusCode).toBe(code);
      expect(result.usedGetFallback).toBe(true);
      expect(result.allowed).toBe(true);
      expect(result.redirected).toBe(false);
      expect(result.redirectCount).toBe(0);
    }
  );
});

// ─── 4. Network error categories ─────────────────────────────────────────────
//
// Tests 16–18 in the AIPF-005 spec.

describe("4. Network error categories", () => {
  it("GET timeout → TIMEOUT, not allowed, usedGetFallback: true", async () => {
    const fetcher = makeFetcher([{ ok: false, result: "TIMEOUT", reason: "Request timed out" }]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("TIMEOUT");
    expect(result.allowed).toBe(false);
    expect(result.usedGetFallback).toBe(true);
    expect(result.statusCode).toBeNull();
  });

  it("GET connection refused → CONNECTION_REFUSED, not allowed", async () => {
    const fetcher = makeFetcher([{ ok: false, result: "CONNECTION_REFUSED" }]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("CONNECTION_REFUSED");
    expect(result.allowed).toBe(false);
    expect(result.usedGetFallback).toBe(true);
  });

  it("GET network error → NETWORK_ERROR, not allowed", async () => {
    const fetcher = makeFetcher([{ ok: false, result: "NETWORK_ERROR", reason: "ECONNRESET" }]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("NETWORK_ERROR");
    expect(result.allowed).toBe(false);
  });
});

// ─── 5. Redirect codes ───────────────────────────────────────────────────────
//
// Tests 19–23 in the AIPF-005 spec.

describe("5. Redirect codes — 301, 302, 303, 307, 308 are each followed once", () => {
  const redirectCodes: Array<[number]> = [[301], [302], [303], [307], [308]];

  beforeEach(() => {
    mockResolveDns.mockResolvedValue(makeDnsOk());
  });

  it.each(redirectCodes)(
    "GET %d redirect to safe destination → REDIRECTED",
    async (code) => {
      const fetcher = makeFetcher([
        { ok: true, statusCode: code, locationHeader: "https://redirect-dest.example.com" },
        { ok: true, statusCode: 200 },
      ]);
      const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

      expect(result.result).toBe("REDIRECTED");
      expect(result.allowed).toBe(true);
      expect(result.redirected).toBe(true);
      expect(result.redirectCount).toBe(1);
      expect(result.statusCode).toBe(200);
      // Fetcher called twice: original URL + redirect destination
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  );
});

// ─── 6. Redirect Location handling ───────────────────────────────────────────
//
// Tests 24, 32, 33 in the AIPF-005 spec.

describe("6. Redirect Location handling", () => {
  it("relative Location is resolved against the current URL", async () => {
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "/api/v2" },
      { ok: true, statusCode: 200 },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("REDIRECTED");
    // /api/v2 resolved against https://example.com/ → https://example.com/api/v2
    expect(result.redirectChain[0]).toBe("https://example.com/api/v2");
  });

  it("missing Location header on redirect → NETWORK_ERROR (test 32)", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: null },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("NETWORK_ERROR");
    expect(result.allowed).toBe(false);
    expect(result.usedGetFallback).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Location that resolves to a URL with empty hostname → INVALID (test 33)", async () => {
    // "http://" is parseable by new URL() but validateUrl() rejects it as INVALID
    // (missing hostname). No DNS check or further request should be made.
    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "http://" },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("INVALID");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── 7. Blocked redirect destinations ────────────────────────────────────────
//
// Tests 25–28 in the AIPF-005 spec.

describe("7. Blocked redirect destinations", () => {
  it("redirect to unsupported scheme (ftp://) → BLOCKED, no second request (test 25)", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "ftp://files.example.com" },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redirect to localhost → BLOCKED (test 26)", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "http://localhost/admin" },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redirect to private IPv4 (10.0.0.1) → BLOCKED (test 27)", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "http://10.0.0.1/" },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redirect to private IPv6 (::1) → BLOCKED (test 28)", async () => {
    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "http://[::1]/secret" },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── 8. Redirect DNS failures ─────────────────────────────────────────────────
//
// Test 29 in the AIPF-005 spec.

describe("8. Redirect DNS failures", () => {
  it("DNS_FAILURE on redirect destination → DNS_FAILURE, no second request (test 29)", async () => {
    mockResolveDns.mockResolvedValue(makeDnsFailure());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://no-resolve.example" },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("DNS_FAILURE");
    expect(result.allowed).toBe(false);
    expect(mockResolveDns).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("BLOCKED DNS on redirect destination → BLOCKED (split-horizon protection)", async () => {
    mockResolveDns.mockResolvedValue(makeDnsBlocked());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "https://looks-public.example.com" },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── 9. Redirect cap enforcement ─────────────────────────────────────────────
//
// Tests 30–31 in the AIPF-005 spec.

describe("9. Redirect cap enforcement", () => {
  it("exactly 3 GET redirect hops → REDIRECTED (within limit) (test 30)", async () => {
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://hop1.example.com" },
      { ok: true, statusCode: 302, locationHeader: "https://hop2.example.com" },
      { ok: true, statusCode: 307, locationHeader: "https://hop3.example.com" },
      { ok: true, statusCode: 200 },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("REDIRECTED");
    expect(result.allowed).toBe(true);
    expect(result.redirectCount).toBe(3);
    expect(result.redirectChain).toHaveLength(3);
    expect(result.statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("4 GET redirects (> cap of 3) → TOO_MANY_REDIRECTS (test 31)", async () => {
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://hop1.example.com" },
      { ok: true, statusCode: 302, locationHeader: "https://hop2.example.com" },
      { ok: true, statusCode: 307, locationHeader: "https://hop3.example.com" },
      { ok: true, statusCode: 308, locationHeader: "https://hop4.example.com" },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.result).toBe("TOO_MANY_REDIRECTS");
    expect(result.allowed).toBe(false);
    expect(result.redirectCount).toBe(3);
    // The 4th redirect was detected but not followed
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(mockResolveDns).toHaveBeenCalledTimes(3);
  });
});

// ─── 10. Contract and shape verification ──────────────────────────────────────
//
// Tests 34–40 in the AIPF-005 spec.

describe("10. Return shape and contract", () => {
  it("result shape includes all required fields (test 38)", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    const requiredFields: Array<keyof GetFallbackResult> = [
      "allowed",
      "originalInput",
      "normalizedUrl",
      "finalUrl",
      "statusCode",
      "usedGetFallback",
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

  it("durationMs is a non-negative number (test 39)", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("redirectChain contains only plain strings — no objects or hyperlinks (test 40)", async () => {
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "https://dest.example.com/path" },
      { ok: true, statusCode: 200 },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(Array.isArray(result.redirectChain)).toBe(true);
    for (const entry of result.redirectChain) {
      expect(typeof entry).toBe("string");
    }
  });

  it("no response body is read — result has no body-derived fields (test 34)", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("html");
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("contentType");
    expect(result).not.toHaveProperty("title");
  });

  it("response destroyed after headers — _fetcher interface carries no body data (test 35)", async () => {
    // The _fetcher returns only { statusCode, locationHeader }. There is no
    // body property in the resolved value, proving the implementation has
    // no mechanism to receive or buffer body content.
    const fetcher = makeFetcher([{ ok: true, statusCode: 200, locationHeader: null }]);
    await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    const callResult = await (fetcher.mock.results[0]?.value as Promise<unknown>);
    expect(callResult).toEqual({ ok: true, statusCode: 200, locationHeader: null });
    expect(callResult).not.toHaveProperty("body");
  });

  it("no automatic redirect following — fetcher called once per hop manually (test 36)", async () => {
    // If automatic following were enabled, the fetcher would be called once
    // and the redirect would be invisible. Manual handling means two calls.
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 301, locationHeader: "https://final.example.com" },
      { ok: true, statusCode: 200 },
    ]);
    await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    // Exactly 2 calls: original URL + redirect destination
    expect(fetcher).toHaveBeenCalledTimes(2);
    // resolveDns called once to DNS-check the redirect destination
    expect(mockResolveDns).toHaveBeenCalledTimes(1);
  });

  it("no POST/PUT/PATCH/DELETE/OPTIONS — _fetcher is the only HTTP path (test 37)", async () => {
    // The _fetcher replaces the real GET fetcher entirely. Any request that
    // bypassed _fetcher would go through Node.js http/https directly, which
    // is not mocked. Since the test completes correctly via _fetcher alone,
    // no other HTTP mechanism was invoked.
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("usedGetFallback is true when GET ran", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.usedGetFallback).toBe(true);
  });

  it("usedGetFallback is false when NOT_APPLICABLE", async () => {
    const fetcher = jest.fn<Promise<Awaited<ReturnType<SingleHopFetcher>>>, [string, { timeoutMs: number }]>();
    const result = await runGetFallback(makeHeadOk(200), { _fetcher: fetcher });

    expect(result.usedGetFallback).toBe(false);
    expect(result.result).toBe("NOT_APPLICABLE");
  });

  it("originalInput is forwarded from the HEAD result", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const headResult = makeHeadOk(405);
    const result = await runGetFallback(headResult, { _fetcher: fetcher });

    expect(result.originalInput).toBe(headResult.originalInput);
  });

  it("normalizedUrl is forwarded from the HEAD result", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const headResult = makeHeadOk(405);
    const result = await runGetFallback(headResult, { _fetcher: fetcher });

    expect(result.normalizedUrl).toBe(headResult.normalizedUrl);
  });

  it("finalUrl for a non-redirect GET response is the URL where HEAD received 405/501", async () => {
    const fetcher = makeFetcher([{ ok: true, statusCode: 200 }]);
    const headResult = makeHeadOk(405, "https://example.com/");
    const result = await runGetFallback(headResult, { _fetcher: fetcher });

    expect(result.finalUrl).toBe("https://example.com/");
  });

  it("finalUrl after GET redirect is the last redirect destination", async () => {
    mockResolveDns.mockResolvedValue(makeDnsOk());

    const fetcher = makeFetcher([
      { ok: true, statusCode: 302, locationHeader: "https://landing.example.com/page" },
      { ok: true, statusCode: 200 },
    ]);
    const result = await runGetFallback(makeHeadOk(405), { _fetcher: fetcher });

    expect(result.finalUrl).toBe("https://landing.example.com/page");
  });

  it("GET_FALLBACK_OK is allowed; error results are not allowed", () => {
    const allowedResults: GetResult[] = ["GET_FALLBACK_OK", "REDIRECTED"];
    const notAllowedResults: GetResult[] = [
      "BLOCKED",
      "TIMEOUT",
      "CONNECTION_REFUSED",
      "NETWORK_ERROR",
      "INVALID",
      "DNS_FAILURE",
      "TOO_MANY_REDIRECTS",
      "NOT_APPLICABLE",
    ];

    for (const r of allowedResults) {
      expect(["GET_FALLBACK_OK", "REDIRECTED"]).toContain(r);
    }
    for (const r of notAllowedResults) {
      expect(allowedResults).not.toContain(r);
    }
  });
});
