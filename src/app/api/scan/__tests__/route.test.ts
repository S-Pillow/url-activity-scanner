/**
 * AIPF-008A: Route Adapter — Unit Tests
 *
 * handleBatchScan is mocked at the module level so no live scanner work,
 * DNS lookups, or HTTP requests occur. Tests exercise only the adapter's
 * responsibility: JSON parsing, header forwarding, method delegation, and
 * HTTP status / response body mapping.
 *
 * The Web API Request/Response globals are available natively in Node.js 20.
 *
 * Test count: 14 tests covering all required AIPF-008A test cases (1–11)
 * plus structural/shape checks.
 */

jest.mock("../../../../lib/api/batchScan");

import { POST } from "../route";
import { handleBatchScan } from "../../../../lib/api/batchScan";
import { DEFAULT_CONFIG } from "../../../../lib/security/rateLimiter";
import type { BatchScanSuccessBody, BatchScanErrorBody } from "../../../../lib/api/batchScan";

const mockHandleBatchScan = handleBatchScan as jest.Mock;

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUTE_URL = "http://localhost/tools/url-activity-scanner/api/scan";
const VALID_URLS = ["https://example.com", "https://example.org"];

// ─── Fixture builders ─────────────────────────────────────────────────────────

function makeSuccessResponse(urls = VALID_URLS): {
  status: number;
  body: BatchScanSuccessBody;
} {
  return {
    status: 200,
    body: {
      ok: true,
      results: urls.map((u) => ({
        original_input: u,
        normalized_url: u,
        result: "200 OK",
        meaning: "Content likely exists",
        redirected_to: null,
        checked_at: "2026-01-01T00:00:00.000Z",
        notes: null,
      })),
      limits: DEFAULT_CONFIG,
    },
  };
}

function makeErrorResponse(
  code: string,
  status = 400,
  retryAfterSeconds: number | null = null
): { status: number; body: BatchScanErrorBody } {
  return {
    status,
    body: {
      ok: false,
      error: { code, message: `Error: ${code}`, retryAfterSeconds },
      limits: DEFAULT_CONFIG,
    },
  };
}

/** Builds a POST Request with a JSON body. */
function makePostRequest(
  payload: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request(ROUTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.resetAllMocks();
  // Default: handler returns a clean 200 success.
  mockHandleBatchScan.mockResolvedValue(makeSuccessResponse());
});

// ─── 1. Delegation and body passing (tests 1–2) ───────────────────────────────

describe("1. Delegation", () => {
  it("calls handleBatchScan once for a valid POST request (test 1)", async () => {
    const req = makePostRequest({ urls: VALID_URLS });
    await POST(req);
    expect(mockHandleBatchScan).toHaveBeenCalledTimes(1);
  });

  it("passes the parsed body to handleBatchScan (test 2)", async () => {
    const payload = { urls: VALID_URLS };
    await POST(makePostRequest(payload));
    expect(mockHandleBatchScan).toHaveBeenCalledWith(
      expect.objectContaining({ body: payload })
    );
  });
});

// ─── 2. Header forwarding (tests 3–4) ────────────────────────────────────────

describe("2. Header forwarding", () => {
  it("forwards x-forwarded-for to handleBatchScan (test 3)", async () => {
    const req = makePostRequest(
      { urls: VALID_URLS },
      { "x-forwarded-for": "203.0.113.1, 10.0.0.1" }
    );
    await POST(req);
    expect(mockHandleBatchScan).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-forwarded-for": "203.0.113.1, 10.0.0.1",
        }),
      })
    );
  });

  it("forwards x-real-ip to handleBatchScan (test 4)", async () => {
    const req = makePostRequest(
      { urls: VALID_URLS },
      { "x-real-ip": "198.51.100.7" }
    );
    await POST(req);
    expect(mockHandleBatchScan).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-real-ip": "198.51.100.7",
        }),
      })
    );
  });

  it("does not forward unrelated headers to handleBatchScan", async () => {
    const req = makePostRequest(
      { urls: VALID_URLS },
      { cookie: "session=abc123", authorization: "Bearer secret" }
    );
    await POST(req);
    const forwarded = mockHandleBatchScan.mock.calls[0][0].headers as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("cookie");
    expect(forwarded).not.toHaveProperty("authorization");
  });
});

// ─── 3. Successful response (test 5) ─────────────────────────────────────────

describe("3. Successful response", () => {
  it("returns JSON with status 200 for a successful scan (test 5)", async () => {
    const req = makePostRequest({ urls: VALID_URLS });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);

    const body = await res.json() as BatchScanSuccessBody;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.limits).toBeDefined();
  });

  it("preserves all result fields from handleBatchScan without modification", async () => {
    const req = makePostRequest({ urls: ["https://example.com"] });
    const res = await POST(req);
    const body = await res.json() as BatchScanSuccessBody;

    // The adapter must not add, remove, or transform any result fields.
    expect(body).toEqual(makeSuccessResponse(["https://example.com", "https://example.org"]).body);
  });
});

// ─── 4. Invalid JSON (test 6) ────────────────────────────────────────────────

describe("4. Invalid JSON body", () => {
  it("returns 400 INVALID_JSON for a malformed body (test 6)", async () => {
    const req = new Request(ROUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not valid json }",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json() as BatchScanErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_JSON");
    // handleBatchScan must NOT have been called — the adapter short-circuits.
    expect(mockHandleBatchScan).not.toHaveBeenCalled();
  });

  it("includes limits in the INVALID_JSON error body", async () => {
    const req = new Request(ROUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "oops",
    });
    const res = await POST(req);
    const body = await res.json() as BatchScanErrorBody;
    expect(body.limits).toBeDefined();
    expect(body.limits.maxUrlsPerBatch).toBe(DEFAULT_CONFIG.maxUrlsPerBatch);
  });
});

// ─── 5. Method passthrough (test 7) ──────────────────────────────────────────

describe("5. Method passthrough", () => {
  it("passes req.method to handleBatchScan (test 7)", async () => {
    // In Next.js App Router, the POST() export is only invoked for POST
    // requests, so req.method is always "POST" in production. The adapter
    // forwards it unchanged so handleBatchScan can enforce the method rule.
    const req = makePostRequest({ urls: VALID_URLS });
    await POST(req);

    expect(mockHandleBatchScan).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST" })
    );
  });

  it("forwards a 405 status code from handleBatchScan to the HTTP response", async () => {
    // When handleBatchScan signals 405 (e.g. called outside Next.js routing),
    // the adapter maps it to the correct HTTP status without modification.
    mockHandleBatchScan.mockResolvedValue(makeErrorResponse("INVALID_REQUEST", 405));

    const res = await POST(makePostRequest({ urls: VALID_URLS }));
    expect(res.status).toBe(405);

    const body = await res.json() as BatchScanErrorBody;
    expect(body.error.code).toBe("INVALID_REQUEST");
  });
});

// ─── 6. Rate-limit response (test 8) ─────────────────────────────────────────

describe("6. Rate-limit error pass-through", () => {
  it("returns 429 when handleBatchScan returns IP_RATE_LIMITED (test 8)", async () => {
    mockHandleBatchScan.mockResolvedValue(
      makeErrorResponse("IP_RATE_LIMITED", 429, 3600)
    );

    const res = await POST(makePostRequest({ urls: VALID_URLS }));

    expect(res.status).toBe(429);
    const body = await res.json() as BatchScanErrorBody;
    expect(body.error.code).toBe("IP_RATE_LIMITED");
    expect(body.error.retryAfterSeconds).toBe(3600);
  });

  it("returns 429 when handleBatchScan returns GLOBAL_RATE_LIMITED", async () => {
    mockHandleBatchScan.mockResolvedValue(
      makeErrorResponse("GLOBAL_RATE_LIMITED", 429, 1200)
    );

    const res = await POST(makePostRequest({ urls: VALID_URLS }));

    expect(res.status).toBe(429);
    const body = await res.json() as BatchScanErrorBody;
    expect(body.error.code).toBe("GLOBAL_RATE_LIMITED");
  });
});

// ─── 7. Batch-too-large response (test 9) ────────────────────────────────────

describe("7. Batch-too-large pass-through", () => {
  it("returns the appropriate status for BATCH_TOO_LARGE (test 9)", async () => {
    mockHandleBatchScan.mockResolvedValue(
      makeErrorResponse("BATCH_TOO_LARGE", 400)
    );

    const urls = Array.from({ length: 101 }, (_, i) => `https://e${i}.com`);
    const res = await POST(makePostRequest({ urls }));

    // handleBatchScan uses 400 for BATCH_TOO_LARGE (A-AIPF008A-05).
    expect(res.status).toBe(400);
    const body = await res.json() as BatchScanErrorBody;
    expect(body.error.code).toBe("BATCH_TOO_LARGE");
  });
});

// ─── 8. Unexpected error (test 10) ───────────────────────────────────────────

describe("8. Unexpected error handling", () => {
  it("returns 500 INTERNAL_ERROR when handleBatchScan throws unexpectedly (test 10)", async () => {
    mockHandleBatchScan.mockRejectedValue(new Error("Something exploded"));

    const res = await POST(makePostRequest({ urls: VALID_URLS }));

    expect(res.status).toBe(500);
    const body = await res.json() as BatchScanErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // No stack trace or internal details in the error message.
    expect(body.error.message).not.toContain("Something exploded");
  });
});

// ─── 9. No logging of submitted URLs (test 11) ───────────────────────────────

describe("9. Data privacy — no submitted URL logging", () => {
  it("does not call console.log or console.error during normal operation (test 11)", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await POST(makePostRequest({ urls: VALID_URLS }));
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("does not expose submitted URL strings in the INTERNAL_ERROR response body", async () => {
    mockHandleBatchScan.mockRejectedValue(new Error("Something exploded"));

    const sensitiveUrl = "https://internal.corp.example.com/secret";
    const res = await POST(makePostRequest({ urls: [sensitiveUrl] }));
    const body = await res.json() as BatchScanErrorBody;

    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("internal.corp.example.com");
    expect(bodyStr).not.toContain("secret");
  });
});
