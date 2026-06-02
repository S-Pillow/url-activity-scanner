/**
 * AIPF-006: Final Result Mapper — Unit Tests
 *
 * The mapper is a pure function. No DNS, HTTP, or network mocks are needed.
 * Upstream result objects are constructed directly as plain TypeScript values.
 * A fixed clock (now: () => new Date(...)) is injected where deterministic
 * timestamps are required.
 *
 * Test count: 51 tests (≥ 45 required by AIPF-006 spec, tests 1–45).
 */

import { mapResult, RESULT_KEY, MEANINGS } from "../resultMapper";
import type { MapperInput, ScanResult } from "../resultMapper";
import type { UrlValidationResult } from "../validateUrl";
import type { DnsCheckResult } from "../resolveDns";
import type { HeadRequestResult } from "../headRequest";
import type { GetFallbackResult } from "../getFallback";

// ─── Fixed clock for deterministic checked_at tests ──────────────────────────

const FIXED_DATE = new Date("2026-06-02T06:00:00.000Z");
const fixedNow = () => FIXED_DATE;
const FIXED_ISO = FIXED_DATE.toISOString();

// ─── Fixture builders ─────────────────────────────────────────────────────────

function makeValidation(
  result: UrlValidationResult["result"],
  reason = "test reason"
): UrlValidationResult {
  return {
    allowed: result === "VALID",
    originalInput: "example.com",
    normalizedUrl: result === "INVALID" ? null : "https://example.com/",
    hostname: result === "INVALID" ? null : "example.com",
    scheme: result === "INVALID" ? null : "https",
    reason,
    result,
  };
}

function makeHead(
  result: HeadRequestResult["result"],
  statusCode: number | null = null,
  {
    finalUrl = "https://example.com/",
    redirected = false,
    reason = "test reason",
  }: {
    finalUrl?: string;
    redirected?: boolean;
    reason?: string;
  } = {}
): HeadRequestResult {
  return {
    allowed: result === "HEAD_OK" || result === "REDIRECTED",
    originalInput: "example.com",
    normalizedUrl: "https://example.com/",
    finalUrl,
    statusCode,
    redirected,
    redirectChain: redirected ? [finalUrl] : [],
    redirectCount: redirected ? 1 : 0,
    durationMs: 100,
    reason,
    result,
  };
}

function makeGetFallback(
  result: GetFallbackResult["result"],
  statusCode: number | null = null,
  {
    finalUrl = "https://example.com/",
    redirected = false,
    reason = "test reason",
    usedGetFallback = true,
  }: {
    finalUrl?: string;
    redirected?: boolean;
    reason?: string;
    usedGetFallback?: boolean;
  } = {}
): GetFallbackResult {
  return {
    allowed: result === "GET_FALLBACK_OK" || result === "REDIRECTED",
    originalInput: "example.com",
    normalizedUrl: "https://example.com/",
    finalUrl,
    statusCode,
    usedGetFallback,
    redirected,
    redirectChain: redirected ? [finalUrl] : [],
    redirectCount: redirected ? 1 : 0,
    durationMs: 150,
    reason,
    result,
  };
}

function makeDns(result: DnsCheckResult["result"], reason = "test reason"): DnsCheckResult {
  return {
    allowed: result === "DNS_OK",
    originalInput: "example.com",
    normalizedUrl: "https://example.com/",
    hostname: "example.com",
    scheme: "https",
    resolvedIps: result === "DNS_OK" ? ["93.184.216.34"] : [],
    reason,
    result,
  };
}

// ─── 1. HEAD layer — 2xx status codes → "200 OK" (tests 1–4) ─────────────────

describe("1. HEAD 2xx status codes → 200 OK", () => {
  it.each([[200], [201], [202], [204]])(
    "HEAD_OK %d → result: 200 OK, meaning: Content likely exists",
    (code) => {
      const r = mapResult({ headResult: makeHead("HEAD_OK", code) }, { now: fixedNow });
      expect(r.result).toBe(RESULT_KEY.OK);
      expect(r.meaning).toBe(MEANINGS[RESULT_KEY.OK]);
    }
  );
});

// ─── 2. HEAD layer — redirect status codes (tests 5–9) ──────────────────────

describe("2. HEAD status codes 3xx → 301/302 Redirect", () => {
  it.each([[301], [302], [303], [307], [308]])(
    "HEAD_OK %d → result: 301/302 Redirect",
    (code) => {
      const r = mapResult({ headResult: makeHead("HEAD_OK", code) }, { now: fixedNow });
      expect(r.result).toBe(RESULT_KEY.REDIRECT);
      expect(r.meaning).toBe(MEANINGS[RESULT_KEY.REDIRECT]);
    }
  );
});

// ─── 3. HEAD layer — REDIRECTED result (test 10) ─────────────────────────────

describe("3. HEAD REDIRECTED result", () => {
  it("REDIRECTED → 301/302 Redirect (test 10)", () => {
    const r = mapResult(
      {
        headResult: makeHead("REDIRECTED", 200, {
          finalUrl: "https://final.example.com/",
          redirected: true,
        }),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.REDIRECT);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.REDIRECT]);
  });
});

// ─── 4. HEAD layer — 4xx codes (tests 11–14) ─────────────────────────────────

describe("4. HEAD 4xx status codes", () => {
  it("HEAD 401 → 403 Forbidden (test 11)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 401) }, { now: fixedNow });
    expect(r.result).toBe(RESULT_KEY.FORBIDDEN);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.FORBIDDEN]);
  });

  it("HEAD 403 → 403 Forbidden (test 12)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 403) }, { now: fixedNow });
    expect(r.result).toBe(RESULT_KEY.FORBIDDEN);
  });

  it("HEAD 404 → 404 Not Found (test 13)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 404) }, { now: fixedNow });
    expect(r.result).toBe(RESULT_KEY.NOT_FOUND);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.NOT_FOUND]);
  });

  it("HEAD 410 → 410 Gone (test 14)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 410) }, { now: fixedNow });
    expect(r.result).toBe(RESULT_KEY.GONE);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.GONE]);
  });
});

// ─── 5. HEAD layer — 5xx codes (tests 15–16) ─────────────────────────────────

describe("5. HEAD 5xx status codes → Server error", () => {
  it("HEAD 500 → Server error (test 15)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 500) }, { now: fixedNow });
    expect(r.result).toBe(RESULT_KEY.SERVER_ERROR);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.SERVER_ERROR]);
    expect(r.notes).toContain("500");
  });

  it("HEAD 503 → Server error (test 16)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 503) }, { now: fixedNow });
    expect(r.result).toBe(RESULT_KEY.SERVER_ERROR);
    expect(r.notes).toContain("503");
  });
});

// ─── 6. HEAD layer — error result codes (tests 17–23) ───────────────────────

describe("6. HEAD error result codes", () => {
  it("HEAD TIMEOUT → Timeout (test 17)", () => {
    const r = mapResult(
      { headResult: makeHead("TIMEOUT", null, { reason: "Request timed out" }) },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.TIMEOUT);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.TIMEOUT]);
    expect(r.notes).toBe("Request timed out");
  });

  it("HEAD CONNECTION_REFUSED → Connection refused (test 18)", () => {
    const r = mapResult(
      { headResult: makeHead("CONNECTION_REFUSED", null, { reason: "Connection refused" }) },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.CONNECTION_REFUSED);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.CONNECTION_REFUSED]);
  });

  it("HEAD DNS_FAILURE → DNS failure (test 19)", () => {
    const r = mapResult(
      { headResult: makeHead("DNS_FAILURE", null, { reason: "Domain does not resolve" }) },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.DNS_FAILURE);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.DNS_FAILURE]);
  });

  it("HEAD BLOCKED → Blocked (test 20)", () => {
    const r = mapResult(
      {
        headResult: makeHead("BLOCKED", null, {
          reason: "Redirect destination blocked by URL validation: Blocked hostname",
        }),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.BLOCKED);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.BLOCKED]);
  });

  it("HEAD INVALID → Unknown (test 21)", () => {
    const r = mapResult(
      { headResult: makeHead("INVALID", null, { reason: "Malformed redirect URL" }) },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.UNKNOWN);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.UNKNOWN]);
  });

  it("HEAD TOO_MANY_REDIRECTS → 301/302 Redirect with note (test 22)", () => {
    const r = mapResult(
      { headResult: makeHead("TOO_MANY_REDIRECTS", null, { reason: "Redirect chain exceeded 3 hops" }) },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.REDIRECT);
    expect(r.notes).toContain("3-hop limit");
  });

  it("HEAD NETWORK_ERROR → Unknown (test 23)", () => {
    const r = mapResult(
      { headResult: makeHead("NETWORK_ERROR", null, { reason: "Network error: ECONNRESET" }) },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.UNKNOWN);
  });
});

// ─── 7. GET fallback layer (tests 24–32) ─────────────────────────────────────

describe("7. GET fallback layer", () => {
  it("GET 200 after HEAD 405 → 200 OK with fallback note (test 24)", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 405),
        getFallbackResult: makeGetFallback("GET_FALLBACK_OK", 200),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.OK);
    expect(r.notes).toContain("HEAD returned 405");
    expect(r.notes).toContain("GET fallback used");
  });

  it("GET 403 after HEAD 405 → 403 Forbidden (test 25)", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 405),
        getFallbackResult: makeGetFallback("GET_FALLBACK_OK", 403),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.FORBIDDEN);
  });

  it("GET 404 after HEAD 405 → 404 Not Found (test 26)", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 405),
        getFallbackResult: makeGetFallback("GET_FALLBACK_OK", 404),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.NOT_FOUND);
  });

  it("GET 410 after HEAD 405 → 410 Gone (test 27)", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 405),
        getFallbackResult: makeGetFallback("GET_FALLBACK_OK", 410),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.GONE);
  });

  it("GET 500 after HEAD 405 → Server error (test 28)", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 405),
        getFallbackResult: makeGetFallback("GET_FALLBACK_OK", 500),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.SERVER_ERROR);
    expect(r.notes).toContain("HEAD returned 405");
    expect(r.notes).toContain("500");
  });

  it("GET TIMEOUT after HEAD 501 → Timeout (test 29)", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 501),
        getFallbackResult: makeGetFallback("TIMEOUT", null, { reason: "Request timed out" }),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.TIMEOUT);
    expect(r.notes).toContain("HEAD returned 501");
    expect(r.notes).toContain("Request timed out");
  });

  it("GET CONNECTION_REFUSED → Connection refused (test 30)", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 405),
        getFallbackResult: makeGetFallback("CONNECTION_REFUSED", null, { reason: "Connection refused" }),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.CONNECTION_REFUSED);
  });

  it("GET REDIRECTED after HEAD 405 → 301/302 Redirect (test 31)", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 405),
        getFallbackResult: makeGetFallback("REDIRECTED", 200, {
          finalUrl: "https://final.example.com/",
          redirected: true,
        }),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.REDIRECT);
    expect(r.notes).toContain("GET fallback used");
  });

  it("GET NOT_APPLICABLE → falls back to HEAD result (test 32)", () => {
    // HEAD returned 200 (not 405/501), so GET was NOT_APPLICABLE.
    // The mapper must use the HEAD result instead.
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 200),
        getFallbackResult: makeGetFallback("NOT_APPLICABLE", null, {
          usedGetFallback: false,
          reason: "GET fallback is not applicable: HEAD returned 200, not 405 or 501",
        }),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.OK);
    // notes should be null — no GET fallback note since usedGetFallback is false
    expect(r.notes).toBeNull();
  });
});

// ─── 8. Validation layer (tests 33–36) ────────────────────────────────────────

describe("8. Validation layer", () => {
  it("Unsupported protocol (BLOCKED) → Blocked (test 33)", () => {
    const r = mapResult(
      { validationResult: makeValidation("BLOCKED", "Unsupported protocol") },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.BLOCKED);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.BLOCKED]);
    expect(r.notes).toContain("Unsupported protocol");
  });

  it("Blocked hostname (BLOCKED) → Blocked (test 34)", () => {
    const r = mapResult(
      { validationResult: makeValidation("BLOCKED", "Blocked hostname") },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.BLOCKED);
    expect(r.notes).toContain("Blocked hostname");
  });

  it("Blocked private IP range (BLOCKED) → Blocked (test 35)", () => {
    const r = mapResult(
      {
        validationResult: makeValidation("BLOCKED", "Loopback address (127.0.0.0/8)"),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.BLOCKED);
  });

  it("Malformed URL (INVALID) → Unknown (test 36)", () => {
    const r = mapResult(
      { validationResult: makeValidation("INVALID", "Invalid URL format") },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.UNKNOWN);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.UNKNOWN]);
  });
});

// ─── 9. DNS layer (tests 37–38) ───────────────────────────────────────────────

describe("9. DNS layer", () => {
  it("DNS_FAILURE → DNS failure (test 37)", () => {
    const r = mapResult(
      { dnsResult: makeDns("DNS_FAILURE", "Domain does not resolve") },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.DNS_FAILURE);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.DNS_FAILURE]);
  });

  it("DNS BLOCKED (resolved to private IP) → Blocked (test 38)", () => {
    const r = mapResult(
      {
        dnsResult: makeDns("BLOCKED", "Resolved IP is private/internal/reserved"),
      },
      { now: fixedNow }
    );
    expect(r.result).toBe(RESULT_KEY.BLOCKED);
    expect(r.meaning).toBe(MEANINGS[RESULT_KEY.BLOCKED]);
  });
});

// ─── 10. redirected_to field (tests 39–40) ────────────────────────────────────

describe("10. redirected_to field", () => {
  it("redirected_to is null when no redirect occurred (test 39)", () => {
    // finalUrl === normalizedUrl → no redirect to report
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 200, { finalUrl: "https://example.com/" }),
      },
      { now: fixedNow }
    );
    expect(r.redirected_to).toBeNull();
  });

  it("redirected_to is finalUrl when a redirect occurred (test 40)", () => {
    const r = mapResult(
      {
        headResult: makeHead("REDIRECTED", 200, {
          finalUrl: "https://final.example.com/landing",
          redirected: true,
        }),
      },
      { now: fixedNow }
    );
    // normalizedUrl = "https://example.com/", finalUrl = "https://final.example.com/landing"
    expect(r.redirected_to).toBe("https://final.example.com/landing");
  });

  it("redirected_to is null when finalUrl equals normalizedUrl (edge case)", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 200, { finalUrl: "https://example.com/" }),
      },
      { now: fixedNow }
    );
    expect(r.redirected_to).toBeNull();
  });

  it("redirected_to from GET fallback finalUrl when GET redirected", () => {
    const r = mapResult(
      {
        headResult: makeHead("HEAD_OK", 405),
        getFallbackResult: makeGetFallback("REDIRECTED", 200, {
          finalUrl: "https://redirected-final.example.com/",
          redirected: true,
        }),
      },
      { now: fixedNow }
    );
    expect(r.redirected_to).toBe("https://redirected-final.example.com/");
  });
});

// ─── 11. checked_at field (test 41) ──────────────────────────────────────────

describe("11. checked_at field", () => {
  it("checked_at is deterministic when a fixed clock is injected (test 41)", () => {
    const r = mapResult(
      { headResult: makeHead("HEAD_OK", 200) },
      { now: fixedNow }
    );
    expect(r.checked_at).toBe(FIXED_ISO);
  });

  it("checked_at is a valid ISO 8601 UTC string when no clock is injected", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 200) });
    // Should be a valid ISO string ending in Z
    expect(r.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ─── 12. Shape verification (tests 42–45) ────────────────────────────────────

describe("12. Shape and contract verification", () => {
  it("all seven required fields are returned (test 42)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 200) }, { now: fixedNow });
    const requiredFields: Array<keyof ScanResult> = [
      "original_input",
      "normalized_url",
      "result",
      "meaning",
      "redirected_to",
      "checked_at",
      "notes",
    ];
    for (const field of requiredFields) {
      expect(r).toHaveProperty(field);
    }
    // Exactly seven fields — no extras
    expect(Object.keys(r)).toHaveLength(7);
  });

  it("no response body field exists (test 43)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 200) }, { now: fixedNow });
    expect(r).not.toHaveProperty("body");
    expect(r).not.toHaveProperty("html");
    expect(r).not.toHaveProperty("text");
    expect(r).not.toHaveProperty("content");
  });

  it("no response header fields exist (test 44)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 200) }, { now: fixedNow });
    expect(r).not.toHaveProperty("headers");
    expect(r).not.toHaveProperty("content_type");
    expect(r).not.toHaveProperty("content_length");
    expect(r).not.toHaveProperty("responseHeaders");
  });

  it("no page metadata fields exist (test 45)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 200) }, { now: fixedNow });
    expect(r).not.toHaveProperty("title");
    expect(r).not.toHaveProperty("favicon");
    expect(r).not.toHaveProperty("metadata");
    expect(r).not.toHaveProperty("screenshot");
    expect(r).not.toHaveProperty("preview");
  });

  it("original_input is forwarded from the upstream result", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 200) }, { now: fixedNow });
    expect(r.original_input).toBe("example.com");
  });

  it("normalized_url is forwarded from the upstream result", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 200) }, { now: fixedNow });
    expect(r.normalized_url).toBe("https://example.com/");
  });

  it("notes is null for a clean 200 OK response (no fallback, no redirect issues)", () => {
    const r = mapResult({ headResult: makeHead("HEAD_OK", 200) }, { now: fixedNow });
    expect(r.notes).toBeNull();
  });

  it("mapper with no input returns Unknown result", () => {
    const r = mapResult({}, { now: fixedNow });
    expect(r.result).toBe(RESULT_KEY.UNKNOWN);
    expect(r.original_input).toBe("");
    expect(r.normalized_url).toBeNull();
  });

  it("RESULT_KEY and MEANINGS cover all eleven required result strings", () => {
    const expectedKeys = [
      "200 OK",
      "301/302 Redirect",
      "403 Forbidden",
      "404 Not Found",
      "410 Gone",
      "Timeout",
      "DNS failure",
      "Connection refused",
      "Blocked",
      "Server error",
      "Unknown",
    ];
    for (const key of expectedKeys) {
      expect(Object.values(RESULT_KEY)).toContain(key);
      expect(MEANINGS).toHaveProperty(key);
      expect(MEANINGS[key]).toBeTruthy();
    }
  });
});
