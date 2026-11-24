/**
 * AIPF-008: Batch Scan API Endpoint — Unit Tests
 *
 * All scanner modules (validateUrl, resolveDns, sendHeadRequest,
 * runGetFallback, mapResult) are replaced with jest.fn() mocks so no live
 * DNS lookups or HTTP requests are made.
 *
 * The rate limiter is injected via opts._rateLimiter to keep tests isolated
 * from the module-level singleton.
 *
 * Test count: 36 tests covering all required AIPF-008 test cases (1–36).
 * Tests 37–42 (existing module tests still pass) are verified by running the
 * full Jest suite.
 */

import {
  handleBatchScan,
  BatchScanRequest,
  BatchScanSuccessBody,
  BatchScanErrorBody,
} from "../batchScan";
import { RateLimiter, DEFAULT_CONFIG, RateLimitResult } from "../../security/rateLimiter";
import type { RateLimiterConfig } from "../../security/rateLimiter";

// ─── Mock all scanner pipeline modules ────────────────────────────────────────

jest.mock("../../security/validateUrl");
jest.mock("../../security/resolveDns");
jest.mock("../../security/headRequest");
jest.mock("../../security/getFallback");
jest.mock("../../security/resultMapper");

import { validateUrl } from "../../security/validateUrl";
import { resolveDns } from "../../security/resolveDns";
import { sendHeadRequest } from "../../security/headRequest";
import { runGetFallback } from "../../security/getFallback";
import { mapResult } from "../../security/resultMapper";
import type { UrlValidationResult } from "../../security/validateUrl";
import type { DnsCheckResult } from "../../security/resolveDns";
import type { HeadRequestResult } from "../../security/headRequest";
import type { GetFallbackResult } from "../../security/getFallback";
import type { ScanResult } from "../../security/resultMapper";

// ─── Typed mock references ────────────────────────────────────────────────────

const mockValidateUrl   = validateUrl      as jest.Mock;
const mockResolveDns    = resolveDns       as jest.Mock;
const mockHeadRequest   = sendHeadRequest  as jest.Mock;
const mockGetFallback   = runGetFallback   as jest.Mock;
const mockMapResult     = mapResult        as jest.Mock;

// ─── Fixture builders ─────────────────────────────────────────────────────────

function makeValidValidation(input = "https://example.com"): UrlValidationResult {
  return {
    allowed: true,
    originalInput: input,
    normalizedUrl: input,
    hostname: "example.com",
    scheme: "https",
    reason: "URL is valid and allowed",
    result: "VALID",
  };
}

function makeInvalidValidation(input = "bad"): UrlValidationResult {
  return {
    allowed: false,
    originalInput: input,
    normalizedUrl: null,
    hostname: null,
    scheme: null,
    reason: "Invalid URL format",
    result: "INVALID",
  };
}

function makeDnsOk(input = "https://example.com"): DnsCheckResult {
  return {
    allowed: true,
    originalInput: input,
    normalizedUrl: input,
    hostname: "example.com",
    scheme: "https",
    resolvedIps: ["93.184.216.34"],
    reason: "DNS resolved to safe public IP(s)",
    result: "DNS_OK",
  };
}

function makeDnsFailed(input = "https://bad.example"): DnsCheckResult {
  return {
    allowed: false,
    originalInput: input,
    normalizedUrl: input,
    hostname: "bad.example",
    scheme: "https",
    resolvedIps: [],
    reason: "Domain does not resolve",
    result: "DNS_FAILURE",
  };
}

function makeHeadOk(
  input = "https://example.com",
  statusCode = 200
): HeadRequestResult {
  return {
    allowed: true,
    originalInput: input,
    normalizedUrl: input,
    finalUrl: input,
    statusCode,
    redirected: false,
    redirectChain: [],
    redirectCount: 0,
    durationMs: 100,
    reason: "HEAD request completed",
    result: "HEAD_OK",
    finalResolvedIps: ["93.184.216.34"],
  };
}

function makeHeadTimeout(input = "https://example.com"): HeadRequestResult {
  return {
    allowed: false,
    originalInput: input,
    normalizedUrl: input,
    finalUrl: input,
    statusCode: null,
    redirected: false,
    redirectChain: [],
    redirectCount: 0,
    durationMs: 10000,
    reason: "Request timed out",
    result: "TIMEOUT",
    finalResolvedIps: [],
  };
}

function makeGetNotApplicable(input = "https://example.com"): GetFallbackResult {
  return {
    allowed: false,
    originalInput: input,
    normalizedUrl: input,
    finalUrl: input,
    statusCode: 200,
    usedGetFallback: false,
    redirected: false,
    redirectChain: [],
    redirectCount: 0,
    durationMs: 0,
    reason: "GET fallback is not applicable: HEAD returned 200, not 405 or 501",
    result: "NOT_APPLICABLE",
  };
}

function makeGetFallbackOk(input = "https://example.com"): GetFallbackResult {
  return {
    allowed: true,
    originalInput: input,
    normalizedUrl: input,
    finalUrl: input,
    statusCode: 200,
    usedGetFallback: true,
    redirected: false,
    redirectChain: [],
    redirectCount: 0,
    durationMs: 100,
    reason: "GET fallback completed after HEAD returned 405",
    result: "GET_FALLBACK_OK",
  };
}

function makeScanResult(input = "https://example.com"): ScanResult {
  return {
    original_input: input,
    normalized_url: input,
    result: "200 OK",
    meaning: "Content likely exists",
    redirected_to: null,
    checked_at: "2026-01-01T00:00:00.000Z",
    notes: null,
  };
}

/** Builds a minimal BatchScanRequest. */
function makeRequest(
  urls: unknown[],
  headers: Record<string, string | undefined> = {},
  method = "POST"
): BatchScanRequest {
  return { method, headers, body: { urls } };
}

/** Returns a fresh RateLimiter instance that allows all requests. */
function makeAllowingLimiter(config?: Partial<RateLimiterConfig>): RateLimiter {
  return new RateLimiter(config);
}

/** Returns a minimal rate-limiter-like that immediately returns a blocked result. */
function makeBlockedLimiter(
  result: RateLimitResult["result"],
  retryAfterSeconds: number | null = null
): { check: jest.Mock; limits: Readonly<RateLimiterConfig> } {
  return {
    check: jest.fn().mockReturnValue({
      allowed: false,
      result,
      reason: `Blocked: ${result}`,
      retryAfterSeconds,
      limits: DEFAULT_CONFIG,
    }),
    limits: DEFAULT_CONFIG,
  };
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.resetAllMocks();
  jest.useRealTimers();

  // Default happy-path mocks — all pipeline stages pass.
  mockValidateUrl.mockReturnValue(makeValidValidation());
  mockResolveDns.mockResolvedValue(makeDnsOk());
  mockHeadRequest.mockResolvedValue(makeHeadOk());
  mockGetFallback.mockResolvedValue(makeGetNotApplicable());
  mockMapResult.mockReturnValue(makeScanResult());
});

// ─── 1. HTTP method check (test 1) ────────────────────────────────────────────

describe("1. HTTP method enforcement", () => {
  it("rejects GET requests with 405 (test 1)", async () => {
    const res = await handleBatchScan(
      makeRequest(["https://example.com"], {}, "GET"),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(res.status).toBe(405);
    expect((res.body as BatchScanErrorBody).error.code).toBe("INVALID_REQUEST");
    expect(mockValidateUrl).not.toHaveBeenCalled(); // no scan work started
  });
});

// ─── 2. Request body validation (tests 2–8) ───────────────────────────────────

describe("2. Request body validation", () => {
  it("rejects missing body (test 2)", async () => {
    const res = await handleBatchScan(
      { method: "POST", headers: {}, body: undefined },
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(res.status).toBe(400);
    expect((res.body as BatchScanErrorBody).error.code).toBe("INVALID_REQUEST");
  });

  it("rejects null body", async () => {
    const res = await handleBatchScan(
      { method: "POST", headers: {}, body: null },
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(res.status).toBe(400);
    expect((res.body as BatchScanErrorBody).error.code).toBe("INVALID_REQUEST");
  });

  it("rejects missing urls field (test 3)", async () => {
    const res = await handleBatchScan(
      { method: "POST", headers: {}, body: {} },
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(res.status).toBe(400);
    expect((res.body as BatchScanErrorBody).error.code).toBe("MISSING_URLS");
  });

  it("rejects urls that is not an array (test 4)", async () => {
    const res = await handleBatchScan(
      { method: "POST", headers: {}, body: { urls: "https://example.com" } },
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(res.status).toBe(400);
    expect((res.body as BatchScanErrorBody).error.code).toBe("URLS_NOT_ARRAY");
  });

  it("rejects empty urls array (test 5)", async () => {
    const res = await handleBatchScan(
      makeRequest([]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(res.status).toBe(400);
    expect((res.body as BatchScanErrorBody).error.code).toBe("EMPTY_BATCH");
  });

  it("rejects more than maxUrlsPerBatch (test 6)", async () => {
    const urls = Array.from({ length: 101 }, (_, i) => `https://example${i}.com`);
    const res = await handleBatchScan(
      makeRequest(urls),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(res.status).toBe(400);
    expect((res.body as BatchScanErrorBody).error.code).toBe("BATCH_TOO_LARGE");
    expect(mockValidateUrl).not.toHaveBeenCalled(); // no scan work
  });

  it("rejects non-string URL entry (test 7)", async () => {
    const res = await handleBatchScan(
      { method: "POST", headers: {}, body: { urls: ["https://ok.com", 42] } },
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(res.status).toBe(400);
    expect((res.body as BatchScanErrorBody).error.code).toBe("INVALID_URL_ENTRY");
  });

  it("allows exactly maxUrlsPerBatch (100) URLs (test 8)", async () => {
    const urls = Array.from({ length: 100 }, (_, i) => `https://example${i}.com`);
    // Each URL gets its own valid validation result.
    mockValidateUrl.mockReturnValue(makeValidValidation());
    const res = await handleBatchScan(
      makeRequest(urls),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(res.status).toBe(200);
    expect((res.body as BatchScanSuccessBody).results).toHaveLength(100);
  });
});

// ─── 3. Rate limiting (tests 9–12) ───────────────────────────────────────────

describe("3. Rate limiting", () => {
  it("applies rate limiter before scanning — scan not started when blocked (test 9)", async () => {
    const limiter = makeBlockedLimiter("IP_RATE_LIMITED", 3600);
    await handleBatchScan(makeRequest(["https://example.com"]), { _rateLimiter: limiter });
    expect(mockValidateUrl).not.toHaveBeenCalled();
    expect(limiter.check).toHaveBeenCalledTimes(1);
  });

  it("returns IP_RATE_LIMITED with 429 when IP limit is exceeded (test 10)", async () => {
    const limiter = makeBlockedLimiter("IP_RATE_LIMITED", 3600);
    const res = await handleBatchScan(makeRequest(["https://example.com"]), { _rateLimiter: limiter });
    expect(res.status).toBe(429);
    expect((res.body as BatchScanErrorBody).error.code).toBe("IP_RATE_LIMITED");
  });

  it("returns GLOBAL_RATE_LIMITED with 429 when global limit is exceeded (test 11)", async () => {
    const limiter = makeBlockedLimiter("GLOBAL_RATE_LIMITED", 1800);
    const res = await handleBatchScan(makeRequest(["https://example.com"]), { _rateLimiter: limiter });
    expect(res.status).toBe(429);
    expect((res.body as BatchScanErrorBody).error.code).toBe("GLOBAL_RATE_LIMITED");
  });

  it("forwards retryAfterSeconds from the rate limiter into the error body (test 12)", async () => {
    const limiter = makeBlockedLimiter("IP_RATE_LIMITED", 1234);
    const res = await handleBatchScan(makeRequest(["https://example.com"]), { _rateLimiter: limiter });
    expect((res.body as BatchScanErrorBody).error.retryAfterSeconds).toBe(1234);
  });
});

// ─── 4. Client IP extraction (tests 13–16) ───────────────────────────────────

describe("4. Client IP extraction", () => {
  it("extracts client IP from x-forwarded-for first value (test 13)", async () => {
    const limiter = { check: jest.fn().mockReturnValue({
      allowed: true, result: "ALLOWED", reason: "", retryAfterSeconds: null, limits: DEFAULT_CONFIG
    }), limits: DEFAULT_CONFIG };

    await handleBatchScan(
      { method: "POST", headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" }, body: { urls: ["https://example.com"] } },
      { _rateLimiter: limiter }
    );

    expect(limiter.check).toHaveBeenCalledWith(
      expect.objectContaining({ clientIp: "203.0.113.5" })
    );
  });

  it("falls back to x-real-ip when x-forwarded-for is absent (test 14)", async () => {
    const limiter = { check: jest.fn().mockReturnValue({
      allowed: true, result: "ALLOWED", reason: "", retryAfterSeconds: null, limits: DEFAULT_CONFIG
    }), limits: DEFAULT_CONFIG };

    await handleBatchScan(
      { method: "POST", headers: { "x-real-ip": "198.51.100.7" }, body: { urls: ["https://example.com"] } },
      { _rateLimiter: limiter }
    );

    expect(limiter.check).toHaveBeenCalledWith(
      expect.objectContaining({ clientIp: "198.51.100.7" })
    );
  });

  it("uses 'unknown' when no IP header is present (test 15)", async () => {
    const limiter = { check: jest.fn().mockReturnValue({
      allowed: true, result: "ALLOWED", reason: "", retryAfterSeconds: null, limits: DEFAULT_CONFIG
    }), limits: DEFAULT_CONFIG };

    await handleBatchScan(
      { method: "POST", headers: {}, body: { urls: ["https://example.com"] } },
      { _rateLimiter: limiter }
    );

    expect(limiter.check).toHaveBeenCalledWith(
      expect.objectContaining({ clientIp: "unknown" })
    );
  });

  it("does not bypass rate limit for private/internal client IP (test 16)", async () => {
    // Private IP is treated exactly like any other IP — no bypass.
    const limiter = makeAllowingLimiter();
    // Fill private IP bucket to the limit.
    for (let i = 0; i < DEFAULT_CONFIG.maxBatchesPerIpPerHour; i++) {
      limiter.check({ clientIp: "192.168.1.1", urlCount: 1 });
    }
    // 21st request should be blocked.
    const res = await handleBatchScan(
      { method: "POST", headers: { "x-forwarded-for": "192.168.1.1" }, body: { urls: ["https://example.com"] } },
      { _rateLimiter: limiter }
    );
    expect(res.status).toBe(429);
    expect((res.body as BatchScanErrorBody).error.code).toBe("IP_RATE_LIMITED");
  });
});

// ─── 5. Scan pipeline order (tests 17–26) ────────────────────────────────────

describe("5. Scan pipeline order", () => {
  it("processes URLs through validateUrl first (test 17)", async () => {
    await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockValidateUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("does not call resolveDns when validateUrl returns invalid (test 18)", async () => {
    mockValidateUrl.mockReturnValue(makeInvalidValidation());
    await handleBatchScan(
      makeRequest(["bad"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockResolveDns).not.toHaveBeenCalled();
  });

  it("does not call sendHeadRequest when DNS fails (test 19)", async () => {
    mockResolveDns.mockResolvedValue(makeDnsFailed());
    await handleBatchScan(
      makeRequest(["https://bad.example"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockHeadRequest).not.toHaveBeenCalled();
  });

  it("calls sendHeadRequest after validation and DNS both pass (test 20)", async () => {
    await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockHeadRequest).toHaveBeenCalledTimes(1);
  });

  it("calls runGetFallback only after HEAD 405 (test 21)", async () => {
    mockHeadRequest.mockResolvedValue(makeHeadOk("https://example.com", 405));
    await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockGetFallback).toHaveBeenCalledTimes(1);
  });

  it("calls runGetFallback only after HEAD 501 (test 22)", async () => {
    mockHeadRequest.mockResolvedValue(makeHeadOk("https://example.com", 501));
    await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockGetFallback).toHaveBeenCalledTimes(1);
  });

  it("does not call runGetFallback after HEAD 200 (test 23)", async () => {
    mockHeadRequest.mockResolvedValue(makeHeadOk("https://example.com", 200));
    await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockGetFallback).not.toHaveBeenCalled();
  });

  it("does not call runGetFallback after HEAD 403 (test 24)", async () => {
    mockHeadRequest.mockResolvedValue(makeHeadOk("https://example.com", 403));
    await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockGetFallback).not.toHaveBeenCalled();
  });

  it("does not call runGetFallback after HEAD 404 (test 25)", async () => {
    mockHeadRequest.mockResolvedValue(makeHeadOk("https://example.com", 404));
    await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockGetFallback).not.toHaveBeenCalled();
  });

  it("does not call runGetFallback after HEAD timeout (statusCode null) (test 26)", async () => {
    mockHeadRequest.mockResolvedValue(makeHeadTimeout());
    await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockGetFallback).not.toHaveBeenCalled();
  });
});

// ─── 6. Response shape (tests 27–29, 34–36) ───────────────────────────────────

describe("6. Response shape", () => {
  it("calls mapResult for each URL in the batch (test 27)", async () => {
    await handleBatchScan(
      makeRequest(["https://one.com", "https://two.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect(mockMapResult).toHaveBeenCalledTimes(2);
  });

  it("returns only seven-field ScanResult objects (test 28)", async () => {
    const res = await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    const result = (res.body as BatchScanSuccessBody).results[0];
    const keys = Object.keys(result);
    expect(keys).toHaveLength(7);
    expect(keys).toContain("original_input");
    expect(keys).toContain("normalized_url");
    expect(keys).toContain("result");
    expect(keys).toContain("meaning");
    expect(keys).toContain("redirected_to");
    expect(keys).toContain("checked_at");
    expect(keys).toContain("notes");
  });

  it("does not return raw validation, DNS, HEAD, or GET objects (test 29)", async () => {
    const result = (
      (await handleBatchScan(
        makeRequest(["https://example.com"]),
        { _rateLimiter: makeAllowingLimiter() }
      )).body as BatchScanSuccessBody
    ).results[0];

    // Fields that belong to internal module result types — must not be present.
    expect(result).not.toHaveProperty("allowed");
    expect(result).not.toHaveProperty("hostname");
    expect(result).not.toHaveProperty("scheme");
    expect(result).not.toHaveProperty("resolvedIps");
    expect(result).not.toHaveProperty("statusCode");
    expect(result).not.toHaveProperty("redirectChain");
    expect(result).not.toHaveProperty("usedGetFallback");
    expect(result).not.toHaveProperty("durationMs");
  });

  it("does not include response body fields (test 34)", async () => {
    const result = (
      (await handleBatchScan(
        makeRequest(["https://example.com"]),
        { _rateLimiter: makeAllowingLimiter() }
      )).body as BatchScanSuccessBody
    ).results[0];

    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("html");
    expect(result).not.toHaveProperty("text");
  });

  it("does not include response header fields (test 35)", async () => {
    const result = (
      (await handleBatchScan(
        makeRequest(["https://example.com"]),
        { _rateLimiter: makeAllowingLimiter() }
      )).body as BatchScanSuccessBody
    ).results[0];

    expect(result).not.toHaveProperty("headers");
    expect(result).not.toHaveProperty("responseHeaders");
    expect(result).not.toHaveProperty("contentType");
    expect(result).not.toHaveProperty("location");
  });

  it("does not include page metadata fields (test 36)", async () => {
    const result = (
      (await handleBatchScan(
        makeRequest(["https://example.com"]),
        { _rateLimiter: makeAllowingLimiter() }
      )).body as BatchScanSuccessBody
    ).results[0];

    expect(result).not.toHaveProperty("title");
    expect(result).not.toHaveProperty("favicon");
    expect(result).not.toHaveProperty("screenshot");
    expect(result).not.toHaveProperty("description");
    expect(result).not.toHaveProperty("metadata");
  });
});

// ─── 7. Concurrency (test 30) ─────────────────────────────────────────────────

describe("7. Concurrency enforcement", () => {
  it("respects maxConcurrentUrlsPerBatch — never exceeds concurrency ceiling (test 30)", async () => {
    const concurrency = 2;
    let activeDns = 0;
    let peakDns = 0;

    // Mock resolveDns to track peak simultaneous calls.
    // Resolves after one microtask tick so workers stay in flight long enough
    // for the peak to be observable.
    mockResolveDns.mockImplementation(() => {
      activeDns++;
      peakDns = Math.max(peakDns, activeDns);
      return Promise.resolve().then(() => {
        activeDns--;
        return makeDnsOk();
      });
    });

    const limiter = makeAllowingLimiter({ maxConcurrentUrlsPerBatch: concurrency });
    await handleBatchScan(
      makeRequest(["u1", "u2", "u3", "u4"]),
      { _rateLimiter: limiter }
    );

    // Peak simultaneous DNS calls must not exceed the configured concurrency.
    expect(peakDns).toBeLessThanOrEqual(concurrency);
    // Sanity: all 4 URLs were processed.
    expect(mockResolveDns).toHaveBeenCalledTimes(4);
  });

  it("processes URLs sequentially when maxConcurrentUrlsPerBatch is 1", async () => {
    const callOrder: number[] = [];
    let counter = 0;

    mockResolveDns.mockImplementation(() => {
      const n = counter++;
      callOrder.push(n);
      return Promise.resolve().then(() => makeDnsOk());
    });

    const limiter = makeAllowingLimiter({ maxConcurrentUrlsPerBatch: 1 });
    await handleBatchScan(
      makeRequest(["u1", "u2", "u3"]),
      { _rateLimiter: limiter }
    );

    // With concurrency = 1, calls are serial; order must be preserved.
    expect(callOrder).toEqual([0, 1, 2]);
  });
});

// ─── 8. Batch timeout (test 31) ───────────────────────────────────────────────

describe("8. Batch timeout", () => {
  it("returns BATCH_TIMEOUT when the batch exceeds maxBatchRuntimeMs (test 31)", async () => {
    jest.useFakeTimers();

    // Make resolveDns hang indefinitely.
    mockResolveDns.mockReturnValue(new Promise(() => { /* never resolves */ }));

    const timeoutMs = 5_000;
    const batchPromise = handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter(), _timeoutMs: timeoutMs }
    );

    // Advance fake timers past the timeout → fires the BatchTimeoutError.
    jest.advanceTimersByTime(timeoutMs + 1);

    const res = await batchPromise;

    expect(res.status).toBe(408);
    expect((res.body as BatchScanErrorBody).error.code).toBe("BATCH_TIMEOUT");
    expect((res.body as BatchScanErrorBody).error.retryAfterSeconds).toBeNull();
  });
});

// ─── 9. Batch cancellation boundary ──────────────────────────────────────────

describe("9. Batch cancellation boundary", () => {
  it("does not start queued URLs after the deadline", async () => {
    jest.useFakeTimers();

    const started: string[] = [];
    const settled: string[] = [];
    const scan = jest.fn(
      (url: string, signal: AbortSignal): Promise<ScanResult> => {
        started.push(url);
        return new Promise((_, reject) => {
          const onAbort = () => {
            settled.push(url);
            reject(new Error("cancelled"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    );

    const limiter = makeAllowingLimiter({
      maxConcurrentUrlsPerBatch: 2,
    });
    const responsePromise = handleBatchScan(
      makeRequest(["u1", "u2", "u3", "u4", "u5"]),
      {
        _rateLimiter: limiter,
        _timeoutMs: 100,
        _scanUrl: scan,
      }
    );

    await Promise.resolve();
    expect(started).toEqual(["u1", "u2"]);

    await jest.advanceTimersByTimeAsync(100);
    const response = await responsePromise;

    expect(response.status).toBe(408);
    expect((response.body as BatchScanErrorBody).error.code).toBe(
      "BATCH_TIMEOUT"
    );
    expect(started).toEqual(["u1", "u2"]);
    expect(settled.sort()).toEqual(["u1", "u2"]);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("late DNS completion after timeout never starts HEAD or GET", async () => {
    jest.useFakeTimers();

    let resolveLateDns!: (value: DnsCheckResult) => void;
    mockResolveDns.mockReturnValue(
      new Promise<DnsCheckResult>((resolve) => {
        resolveLateDns = resolve;
      })
    );

    const responsePromise = handleBatchScan(
      makeRequest(["https://late-dns.example"]),
      {
        _rateLimiter: makeAllowingLimiter(),
        _timeoutMs: 100,
      }
    );

    await Promise.resolve();
    expect(mockResolveDns).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(100);
    const response = await responsePromise;
    expect(response.status).toBe(408);

    resolveLateDns(makeDnsOk("https://late-dns.example"));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockHeadRequest).not.toHaveBeenCalled();
    expect(mockGetFallback).not.toHaveBeenCalled();
  });

  it("does not launch GET when HEAD completes with 405 after abort", async () => {
    jest.useFakeTimers();

    let resolveLateHead!: (value: HeadRequestResult) => void;
    mockHeadRequest.mockReturnValue(
      new Promise<HeadRequestResult>((resolve) => {
        resolveLateHead = resolve;
      })
    );

    const responsePromise = handleBatchScan(
      makeRequest(["https://head-get-race.example"]),
      {
        _rateLimiter: makeAllowingLimiter(),
        _timeoutMs: 100,
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(mockHeadRequest).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(100);
    const response = await responsePromise;
    expect(response.status).toBe(408);

    resolveLateHead(makeHeadOk("https://head-get-race.example", 405));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGetFallback).not.toHaveBeenCalled();
  });

  it("normal completion before deadline remains unchanged", async () => {
    jest.useFakeTimers();

    const responsePromise = handleBatchScan(
      makeRequest(["https://example.com"]),
      {
        _rateLimiter: makeAllowingLimiter(),
        _timeoutMs: 120_000,
      }
    );

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect((response.body as BatchScanSuccessBody).results).toHaveLength(1);
    expect(mockResolveDns).toHaveBeenCalledTimes(1);
    expect(mockHeadRequest).toHaveBeenCalledTimes(1);
    expect(mockGetFallback).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("propagates one shared AbortSignal through DNS, HEAD, and GET", async () => {
    let dnsSignal: AbortSignal | undefined;
    let headSignal: AbortSignal | undefined;
    let getSignal: AbortSignal | undefined;

    mockResolveDns.mockImplementation(async (_validation, options) => {
      dnsSignal = options?.signal;
      return makeDnsOk();
    });
    mockHeadRequest.mockImplementation(async (_dns, options) => {
      headSignal = options?.signal;
      return makeHeadOk("https://example.com", 405);
    });
    mockGetFallback.mockImplementation(async (_head, options) => {
      getSignal = options?.signal;
      return makeGetFallbackOk();
    });

    const response = await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );

    expect(response.status).toBe(200);
    expect(dnsSignal).toBeInstanceOf(AbortSignal);
    expect(headSignal).toBe(dnsSignal);
    expect(getSignal).toBe(dnsSignal);
    expect(dnsSignal?.aborted).toBe(false);
  });
});

// ─── 9. Error isolation (tests 32–33) ────────────────────────────────────────

describe("9. Error isolation", () => {
  it("handles one URL scan failure without aborting the rest of the batch (test 32)", async () => {
    // URL 1 succeeds, URL 2 throws, URL 3 succeeds.
    mockResolveDns
      .mockResolvedValueOnce(makeDnsOk("https://ok1.com"))
      .mockRejectedValueOnce(new Error("Unexpected DNS error for url2"))
      .mockResolvedValueOnce(makeDnsOk("https://ok3.com"));

    const res = await handleBatchScan(
      makeRequest(["https://ok1.com", "https://fail.com", "https://ok3.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );

    // Batch completed (not 500); three results returned.
    expect(res.status).toBe(200);
    expect((res.body as BatchScanSuccessBody).results).toHaveLength(3);
  });

  it("returns INTERNAL_ERROR when an unexpected error escapes the outer boundary (test 33)", async () => {
    // Simulate a bug in the rate limiter itself.
    const buggyLimiter = {
      check: jest.fn().mockImplementation(() => { throw new Error("Limiter exploded"); }),
      limits: DEFAULT_CONFIG,
    };

    const res = await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: buggyLimiter }
    );

    expect(res.status).toBe(500);
    expect((res.body as BatchScanErrorBody).error.code).toBe("INTERNAL_ERROR");
  });
});

// ─── 10. Success response structure ──────────────────────────────────────────

describe("10. Success response structure", () => {
  it("returns ok:true with results and limits on success", async () => {
    const res = await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    const body = res.body as BatchScanSuccessBody;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.limits).toEqual(expect.objectContaining({ maxUrlsPerBatch: 100 }));
  });

  it("all seven response limits fields are present", async () => {
    const res = await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    const { limits } = res.body as BatchScanSuccessBody;

    expect(limits).toHaveProperty("maxUrlsPerBatch");
    expect(limits).toHaveProperty("maxBatchesPerIpPerHour");
    expect(limits).toHaveProperty("maxGlobalBatchesPerHour");
    expect(limits).toHaveProperty("maxConcurrentUrlsPerBatch");
    expect(limits).toHaveProperty("maxBatchRuntimeMs");
  });

  it("limits field is present in error responses too", async () => {
    const res = await handleBatchScan(
      makeRequest([]),
      { _rateLimiter: makeAllowingLimiter() }
    );
    expect((res.body as BatchScanErrorBody).limits).toBeDefined();
    expect((res.body as BatchScanErrorBody).limits).toHaveProperty("maxUrlsPerBatch");
  });

  it("GET fallback result is passed to mapResult when HEAD returns 405", async () => {
    const getFallbackResult = makeGetFallbackOk();
    mockHeadRequest.mockResolvedValue(makeHeadOk("https://example.com", 405));
    mockGetFallback.mockResolvedValue(getFallbackResult);

    await handleBatchScan(
      makeRequest(["https://example.com"]),
      { _rateLimiter: makeAllowingLimiter() }
    );

    expect(mockMapResult).toHaveBeenCalledWith(
      expect.objectContaining({ getFallbackResult })
    );
  });
});
