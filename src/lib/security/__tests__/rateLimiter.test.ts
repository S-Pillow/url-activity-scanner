/**
 * AIPF-007: Rate Limiter — Unit Tests
 *
 * All tests use fresh RateLimiter instances so state does not bleed between
 * tests. Time is injected via the `now` field in the input object, so no
 * real timers, Date mocking, or network calls are needed.
 *
 * Base timestamp T = 1_000_000_000 ms (approx. 11.5 days after Unix epoch).
 * T - globalBucket.windowStart(0) >> WINDOW_MS, so the global bucket always
 * resets on the first call, giving clean initial state.
 *
 * Test count: 37 tests (≥ 25 required by AIPF-007 spec).
 */

import { RateLimiter, DEFAULT_CONFIG } from "../rateLimiter";
import type { RateLimitResult } from "../rateLimiter";

// Fixed base timestamp for all deterministic tests
const T = 1_000_000_000; // ms
const HOUR = 3_600_000;   // ms

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Calls limiter.check() n times using the same IP and urlCount.
 * Returns the last result. Useful for filling a bucket to the limit.
 */
function repeat(
  limiter: RateLimiter,
  n: number,
  ip: string,
  urlCount = 1,
  now = T
): RateLimitResult {
  let last!: RateLimitResult;
  for (let i = 0; i < n; i++) {
    last = limiter.check({ clientIp: ip, urlCount, now });
  }
  return last;
}

// ─── 1. Basic allow (test 1) ──────────────────────────────────────────────────

describe("1. Allows first request from IP (test 1)", () => {
  it("first request from an IP is allowed", () => {
    const limiter = new RateLimiter();
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });

    expect(result.allowed).toBe(true);
    expect(result.result).toBe("ALLOWED");
    expect(result.retryAfterSeconds).toBeNull();
  });
});

// ─── 2. Per-IP window — allow then block (tests 2–6) ─────────────────────────

describe("2. Per-IP rate limiting", () => {
  it("allows 10 batches from one IP within an hour (test 2)", () => {
    const limiter = new RateLimiter();
    const last = repeat(limiter, 10, "1.2.3.4");
    expect(last.allowed).toBe(true);
    expect(last.result).toBe("ALLOWED");
  });

  it("allows exactly 20 batches from one IP within an hour (test 3)", () => {
    const limiter = new RateLimiter();
    const last = repeat(limiter, 20, "1.2.3.4");
    expect(last.allowed).toBe(true);
    expect(last.result).toBe("ALLOWED");
  });

  it("blocks the 21st batch from the same IP (test 4)", () => {
    const limiter = new RateLimiter();
    repeat(limiter, 20, "1.2.3.4");
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });

    expect(result.allowed).toBe(false);
    expect(result.result).toBe("IP_RATE_LIMITED");
  });

  it("returns a positive retryAfterSeconds when IP is rate-limited (test 5)", () => {
    const limiter = new RateLimiter();
    repeat(limiter, 20, "1.2.3.4");
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });

    expect(result.retryAfterSeconds).not.toBeNull();
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    // At time T with windowStart = T, remaining = 1 hour = 3600 seconds
    expect(result.retryAfterSeconds).toBe(3600);
  });

  it("allows requests again after the IP window expires (test 6)", () => {
    const limiter = new RateLimiter();
    repeat(limiter, 20, "1.2.3.4");

    // Blocked within the window
    expect(limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T }).result).toBe(
      "IP_RATE_LIMITED"
    );

    // 1ms after the window expires → allowed again
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T + HOUR + 1 });
    expect(result.allowed).toBe(true);
    expect(result.result).toBe("ALLOWED");
  });

  it("does not share IP buckets between different IPs", () => {
    const limiter = new RateLimiter();
    repeat(limiter, 20, "1.2.3.4"); // fills 1.2.3.4

    // Different IP should still be allowed
    const result = limiter.check({ clientIp: "9.8.7.6", urlCount: 1, now: T });
    expect(result.allowed).toBe(true);
  });
});

// ─── 3. Batch size limits (tests 7–8) ────────────────────────────────────────

describe("3. Batch size enforcement", () => {
  it("blocks a batch of 101 URLs (test 7)", () => {
    const limiter = new RateLimiter();
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 101, now: T });

    expect(result.allowed).toBe(false);
    expect(result.result).toBe("BATCH_TOO_LARGE");
    expect(result.retryAfterSeconds).toBeNull(); // not a rate limit, no retry info
  });

  it("allows a batch of exactly 100 URLs (test 8)", () => {
    const limiter = new RateLimiter();
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 100, now: T });

    expect(result.allowed).toBe(true);
    expect(result.result).toBe("ALLOWED");
  });

  it("BATCH_TOO_LARGE does not consume IP or global quota", () => {
    const limiter = new RateLimiter({ maxBatchesPerIpPerHour: 1 });
    // An oversized batch is rejected before quota is touched
    limiter.check({ clientIp: "1.2.3.4", urlCount: 999, now: T });
    // The single allowed quota should still be available
    expect(limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T }).allowed).toBe(true);
    expect(limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T }).result).toBe("IP_RATE_LIMITED");
  });
});

// ─── 4. urlCount validation (tests 9–12) ──────────────────────────────────────

describe("4. urlCount input validation", () => {
  it("blocks urlCount of 0 (test 9)", () => {
    const limiter = new RateLimiter();
    expect(limiter.check({ clientIp: "1.2.3.4", urlCount: 0, now: T }).result).toBe(
      "INVALID_INPUT"
    );
  });

  it("blocks negative urlCount (test 10)", () => {
    const limiter = new RateLimiter();
    expect(limiter.check({ clientIp: "1.2.3.4", urlCount: -1, now: T }).result).toBe(
      "INVALID_INPUT"
    );
  });

  it("blocks missing urlCount (test 11)", () => {
    const limiter = new RateLimiter();
    expect(limiter.check({ clientIp: "1.2.3.4", now: T }).result).toBe("INVALID_INPUT");
  });

  it("blocks non-numeric urlCount string (test 12)", () => {
    const limiter = new RateLimiter();
    expect(
      limiter.check({ clientIp: "1.2.3.4", urlCount: "50", now: T }).result
    ).toBe("INVALID_INPUT");
  });

  it("blocks float urlCount (e.g. 1.5)", () => {
    const limiter = new RateLimiter();
    expect(limiter.check({ clientIp: "1.2.3.4", urlCount: 1.5, now: T }).result).toBe(
      "INVALID_INPUT"
    );
  });

  it("blocks NaN urlCount", () => {
    const limiter = new RateLimiter();
    expect(limiter.check({ clientIp: "1.2.3.4", urlCount: NaN, now: T }).result).toBe(
      "INVALID_INPUT"
    );
  });

  it("blocks non-object input entirely", () => {
    const limiter = new RateLimiter();
    expect(limiter.check("bad input").result).toBe("INVALID_INPUT");
    expect(limiter.check(null).result).toBe("INVALID_INPUT");
    expect(limiter.check(42).result).toBe("INVALID_INPUT");
  });
});

// ─── 5. Global limit (tests 13–17) ────────────────────────────────────────────

describe("5. Global rate limiting", () => {
  // Use a high per-IP limit so global limit is reached without hitting IP limit first.
  function makeLimiter() {
    return new RateLimiter({ maxBatchesPerIpPerHour: 1_000 });
  }

  it("tracks global batch count across all requests (test 13)", () => {
    const limiter = makeLimiter();
    repeat(limiter, 199, "1.2.3.4");
    // 199 requests allowed; 200th should still be allowed
    const r200 = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });
    expect(r200.result).toBe("ALLOWED");
    // 201st should be blocked globally
    const r201 = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });
    expect(r201.result).toBe("GLOBAL_RATE_LIMITED");
  });

  it("allows exactly 200 global batches per hour (test 14)", () => {
    const limiter = makeLimiter();
    const last = repeat(limiter, 200, "1.2.3.4");
    expect(last.allowed).toBe(true);
    expect(last.result).toBe("ALLOWED");
  });

  it("blocks the 201st global batch (test 15)", () => {
    const limiter = makeLimiter();
    repeat(limiter, 200, "1.2.3.4");
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });

    expect(result.allowed).toBe(false);
    expect(result.result).toBe("GLOBAL_RATE_LIMITED");
  });

  it("returns a positive retryAfterSeconds for global limit (test 16)", () => {
    const limiter = makeLimiter();
    repeat(limiter, 200, "1.2.3.4");
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });

    expect(result.retryAfterSeconds).not.toBeNull();
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows global requests again after the window expires (test 17)", () => {
    const limiter = makeLimiter();
    repeat(limiter, 200, "1.2.3.4");

    // Blocked within the window
    expect(
      limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T }).result
    ).toBe("GLOBAL_RATE_LIMITED");

    // After the window expires
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T + HOUR + 1 });
    expect(result.allowed).toBe(true);
    expect(result.result).toBe("ALLOWED");
  });
});

// ─── 6. clientIp handling (tests 18–20) ───────────────────────────────────────

describe("6. clientIp handling", () => {
  it("handles missing clientIp safely — treated as 'unknown' (test 18)", () => {
    const limiter = new RateLimiter();
    const result = limiter.check({ urlCount: 1, now: T });

    expect(result.result).toBe("ALLOWED");
    expect(result.allowed).toBe(true);
  });

  it("handles empty-string clientIp safely — treated as 'unknown' (test 19)", () => {
    const limiter = new RateLimiter();
    const result = limiter.check({ clientIp: "", urlCount: 1, now: T });

    expect(result.result).toBe("ALLOWED");
  });

  it("'unknown' IP is subject to the same per-IP rate limit as any other IP", () => {
    const limiter = new RateLimiter();
    // Fill the unknown-IP bucket
    repeat(limiter, 20, "unknown");
    // Both missing-IP and empty-IP map to 'unknown' and are therefore limited
    expect(limiter.check({ urlCount: 1, now: T }).result).toBe("IP_RATE_LIMITED");
    expect(limiter.check({ clientIp: "", urlCount: 1, now: T }).result).toBe("IP_RATE_LIMITED");
  });

  it("does not treat private/internal client IP as a trusted bypass (test 20)", () => {
    const limiter = new RateLimiter();
    repeat(limiter, 20, "192.168.1.1"); // private IP
    const result = limiter.check({ clientIp: "192.168.1.1", urlCount: 1, now: T });

    expect(result.result).toBe("IP_RATE_LIMITED");
    expect(result.allowed).toBe(false);
  });
});

// ─── 7. Output shape and data safety (tests 21–25) ────────────────────────────

describe("7. Output shape and data safety", () => {
  it("stores no submitted URL fields in the result (test 21)", () => {
    const limiter = new RateLimiter();
    const result = limiter.check({ clientIp: "1.2.3.4", urlCount: 5, now: T });

    expect(result).not.toHaveProperty("url");
    expect(result).not.toHaveProperty("urls");
    expect(result).not.toHaveProperty("normalizedUrl");
    expect(result).not.toHaveProperty("domain");
    expect(result).not.toHaveProperty("redirectedTo");
    expect(result).not.toHaveProperty("scanResult");
    expect(result).not.toHaveProperty("responseHeaders");
    expect(result).not.toHaveProperty("body");
  });

  it("result shape includes allowed, result, reason, retryAfterSeconds, and limits (test 22)", () => {
    const limiter = new RateLimiter();
    const r = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });

    expect(r).toHaveProperty("allowed");
    expect(r).toHaveProperty("result");
    expect(r).toHaveProperty("reason");
    expect(r).toHaveProperty("retryAfterSeconds");
    expect(r).toHaveProperty("limits");
  });

  it("defaults are configurable via constructor (test 23)", () => {
    const custom = new RateLimiter({
      maxUrlsPerBatch: 50,
      maxBatchesPerIpPerHour: 5,
      maxGlobalBatchesPerHour: 50,
    });
    const r = custom.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });

    expect(r.limits.maxUrlsPerBatch).toBe(50);
    expect(r.limits.maxBatchesPerIpPerHour).toBe(5);
    expect(r.limits.maxGlobalBatchesPerHour).toBe(50);
    // Unspecified fields keep their defaults
    expect(r.limits.maxConcurrentUrlsPerBatch).toBe(DEFAULT_CONFIG.maxConcurrentUrlsPerBatch);
    expect(r.limits.maxBatchRuntimeMs).toBe(DEFAULT_CONFIG.maxBatchRuntimeMs);
  });

  it("maxConcurrentUrlsPerBatch is exposed in limits (test 24)", () => {
    const limiter = new RateLimiter();
    const r = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });

    expect(r.limits).toHaveProperty("maxConcurrentUrlsPerBatch");
    expect(typeof r.limits.maxConcurrentUrlsPerBatch).toBe("number");
    expect(r.limits.maxConcurrentUrlsPerBatch).toBe(DEFAULT_CONFIG.maxConcurrentUrlsPerBatch);
  });

  it("maxBatchRuntimeMs is exposed in limits (test 25)", () => {
    const limiter = new RateLimiter();
    const r = limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T });

    expect(r.limits).toHaveProperty("maxBatchRuntimeMs");
    expect(typeof r.limits.maxBatchRuntimeMs).toBe("number");
    expect(r.limits.maxBatchRuntimeMs).toBe(DEFAULT_CONFIG.maxBatchRuntimeMs);
  });

  it("DEFAULT_CONFIG reflects the AIPF-001 prototype defaults", () => {
    expect(DEFAULT_CONFIG.maxUrlsPerBatch).toBe(100);
    expect(DEFAULT_CONFIG.maxBatchesPerIpPerHour).toBe(20);
    expect(DEFAULT_CONFIG.maxGlobalBatchesPerHour).toBe(200);
    expect(DEFAULT_CONFIG.maxConcurrentUrlsPerBatch).toBe(5);
    expect(DEFAULT_CONFIG.maxBatchRuntimeMs).toBe(120_000);
  });
});

// ─── 8. Edge cases ────────────────────────────────────────────────────────────

describe("8. Edge cases", () => {
  it("BATCH_TOO_LARGE includes the custom limit value when config overrides default", () => {
    const limiter = new RateLimiter({ maxUrlsPerBatch: 10 });
    const r = limiter.check({ clientIp: "1.2.3.4", urlCount: 11, now: T });

    expect(r.result).toBe("BATCH_TOO_LARGE");
    expect(r.reason).toContain("10");
  });

  it("IP bucket window resets exactly at window boundary", () => {
    const limiter = new RateLimiter();
    repeat(limiter, 20, "1.2.3.4", 1, T);

    // Still blocked 1ms before window ends
    expect(
      limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T + HOUR - 1 }).result
    ).toBe("IP_RATE_LIMITED");

    // Allowed exactly at window boundary (HOUR ms elapsed = expired)
    expect(
      limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T + HOUR }).result
    ).toBe("ALLOWED");
  });

  it("IP_RATE_LIMITED does not increment the global counter", () => {
    // Fill the per-IP limit (20 requests) — these 20 count toward global
    const limiter = new RateLimiter({ maxGlobalBatchesPerHour: 25 });
    repeat(limiter, 20, "1.2.3.4", 1, T);

    // These are IP-limited — must NOT increment global counter
    repeat(limiter, 5, "1.2.3.4", 1, T);

    // 5 requests from a fresh IP should still be allowed (global = 20, not 25)
    for (let i = 0; i < 5; i++) {
      expect(
        limiter.check({ clientIp: "9.9.9.9", urlCount: 1, now: T }).result
      ).toBe("ALLOWED");
    }
  });

  it("INVALID_INPUT does not consume any quota", () => {
    const limiter = new RateLimiter({ maxBatchesPerIpPerHour: 1 });
    limiter.check({ clientIp: "1.2.3.4", urlCount: 0, now: T }); // INVALID
    limiter.check({ clientIp: "1.2.3.4", urlCount: "bad", now: T }); // INVALID

    // Quota still available
    expect(limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T }).result).toBe("ALLOWED");
    expect(limiter.check({ clientIp: "1.2.3.4", urlCount: 1, now: T }).result).toBe("IP_RATE_LIMITED");
  });
});
