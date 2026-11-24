/**
 * DNS-rebinding / SSRF TOCTOU regression tests for HEAD and GET.
 *
 * Exercises the real http/https fetchers (no _fetcher seam) with jest-mocked
 * request constructors. Proves validation-time approved public IPs are the
 * only connect targets, Host/SNI keep the original hostname, redirect hops
 * get a fresh pin set, GET matches HEAD's security model, and empty/malformed
 * /unsafe approved sets fail closed.
 *
 * No live external network requests are made.
 */

import { EventEmitter } from "events";
import type * as http from "http";

const httpRequestMock = jest.fn();
const httpsRequestMock = jest.fn();

jest.mock("http", () => {
  const actual = jest.requireActual<typeof import("http")>("http");
  return {
    ...actual,
    request: (...args: unknown[]) => httpRequestMock(...args),
  };
});

jest.mock("https", () => {
  const actual = jest.requireActual<typeof import("https")>("https");
  return {
    ...actual,
    request: (...args: unknown[]) => httpsRequestMock(...args),
  };
});

jest.mock("../resolveDns");

import { sendHeadRequest } from "../headRequest";
import { runGetFallback } from "../getFallback";
import { validateUrl } from "../validateUrl";
import { resolveDns } from "../resolveDns";
import type { DnsCheckResult } from "../resolveDns";
import type { HeadRequestResult } from "../headRequest";
import { PIN_LOOKUP_ERROR_CODE } from "../pinnedLookup";

const mockResolveDns = resolveDns as jest.MockedFunction<typeof resolveDns>;

const PUBLIC_V4 = "93.184.216.34";
const REDIRECT_PUBLIC_V4 = "104.16.132.229";
const PRIVATE_V4 = "10.0.0.1";

type CapturedRequest = {
  options: http.RequestOptions;
  protocol: "http" | "https";
};

function makeDnsOk(
  url: string,
  resolvedIps: string[] = [PUBLIC_V4]
): DnsCheckResult {
  const v = validateUrl(url);
  return {
    allowed: true,
    originalInput: v.originalInput,
    normalizedUrl: v.normalizedUrl,
    hostname: v.hostname,
    scheme: v.scheme,
    resolvedIps,
    reason: "DNS resolved to safe public IP(s)",
    result: "DNS_OK",
  };
}

function installPinnedRequestMocks(args: {
  responses: Array<{
    statusCode: number;
    locationHeader?: string | null;
  }>;
}): {
  captured: CapturedRequest[];
  connectedAddresses: string[];
} {
  const captured: CapturedRequest[] = [];
  const connectedAddresses: string[] = [];
  let responseIdx = 0;

  function makeFakeRequest(
    protocol: "http" | "https",
    options: http.RequestOptions,
    resCb?: (res: http.IncomingMessage) => void
  ): http.ClientRequest {
    captured.push({ options, protocol });

    const req = new EventEmitter() as http.ClientRequest;
    (req as unknown as { destroy: () => void }).destroy = jest.fn();
    (req as unknown as { end: () => void }).end = jest.fn(() => {
      const lookup = options.lookup;
      if (typeof lookup === "function") {
        lookup(
          options.hostname as string,
          { family: 0 },
          (err, address) => {
            if (err) {
              process.nextTick(() => req.emit("error", err));
              return;
            }
            connectedAddresses.push(address as string);

            const planned = args.responses[responseIdx++] ?? {
              statusCode: 200,
              locationHeader: null,
            };
            const res = new EventEmitter() as http.IncomingMessage;
            (res as { statusCode: number }).statusCode = planned.statusCode;
            (res as { headers: http.IncomingHttpHeaders }).headers = {
              location: planned.locationHeader ?? undefined,
            };
            (res as unknown as { destroy: () => void }).destroy = jest.fn();
            process.nextTick(() => {
              if (resCb) resCb(res);
            });
          }
        );
      } else {
        process.nextTick(() =>
          req.emit(
            "error",
            Object.assign(new Error("lookup missing — pin not applied"), {
              code: PIN_LOOKUP_ERROR_CODE,
            })
          )
        );
      }
    });

    return req;
  }

  httpRequestMock.mockImplementation((
    options: http.RequestOptions,
    cb?: (res: http.IncomingMessage) => void
  ) => makeFakeRequest("http", options, cb));

  httpsRequestMock.mockImplementation((
    options: http.RequestOptions,
    cb?: (res: http.IncomingMessage) => void
  ) => makeFakeRequest("https", options, cb));

  return { captured, connectedAddresses };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveDns.mockReset();
  httpRequestMock.mockReset();
  httpsRequestMock.mockReset();
});

// ─── 1. Initial HEAD rebinding ────────────────────────────────────────────────

describe("1. Initial HEAD rebinding", () => {
  it("connects only to the validation-approved public IP; private rebind address is never used", async () => {
    const mocks = installPinnedRequestMocks({
      responses: [{ statusCode: 200 }],
    });

    const result = await sendHeadRequest(
      makeDnsOk("https://example.com", [PUBLIC_V4])
    );

    expect(result.result).toBe("HEAD_OK");
    expect(mocks.connectedAddresses).toEqual([PUBLIC_V4]);
    expect(mocks.connectedAddresses).not.toContain(PRIVATE_V4);

    const opts = mocks.captured[0].options;
    expect(opts.hostname).toBe("example.com");
    // Simulate connection-time rebinding preference — pin must ignore it.
    const rebound = await new Promise<string>((resolve, reject) => {
      opts.lookup!("example.com", {}, (err, addr) => {
        if (err) reject(err);
        else resolve(addr as string);
      });
    });
    expect(rebound).toBe(PUBLIC_V4);
    expect(rebound).not.toBe(PRIVATE_V4);
  });
});

// ─── 2. HEAD redirect rebinding ───────────────────────────────────────────────

describe("2. HEAD redirect rebinding", () => {
  it("pins each redirect hop to that hop's approved IPs only", async () => {
    mockResolveDns.mockResolvedValue(
      makeDnsOk("https://cdn.example.com/", [REDIRECT_PUBLIC_V4])
    );

    const mocks = installPinnedRequestMocks({
      responses: [
        {
          statusCode: 302,
          locationHeader: "https://cdn.example.com/",
        },
        { statusCode: 200 },
      ],
    });

    const result = await sendHeadRequest(
      makeDnsOk("https://example.com", [PUBLIC_V4])
    );

    expect(result.result).toBe("REDIRECTED");
    expect(mocks.connectedAddresses).toEqual([PUBLIC_V4, REDIRECT_PUBLIC_V4]);
    expect(mocks.connectedAddresses).not.toContain(PRIVATE_V4);

    expect(mocks.captured[0].options.hostname).toBe("example.com");
    expect(mocks.captured[1].options.hostname).toBe("cdn.example.com");

    const redirectLookupAddr = await new Promise<string>((resolve, reject) => {
      mocks.captured[1].options.lookup!("cdn.example.com", {}, (err, addr) => {
        if (err) reject(err);
        else resolve(addr as string);
      });
    });
    expect(redirectLookupAddr).toBe(REDIRECT_PUBLIC_V4);
    expect(redirectLookupAddr).not.toBe(PRIVATE_V4);
    // Must not reuse the first hop's address set for the redirect host.
    expect(redirectLookupAddr).not.toBe(PUBLIC_V4);
  });
});

// ─── 3. Initial GET fallback rebinding ────────────────────────────────────────

describe("3. Initial GET fallback rebinding", () => {
  it("GET uses only HEAD finalResolvedIps — private rebind address never used", async () => {
    const headResult: HeadRequestResult = {
      allowed: true,
      originalInput: "https://example.com",
      normalizedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      statusCode: 405,
      redirected: false,
      redirectChain: [],
      redirectCount: 0,
      durationMs: 10,
      reason: "HEAD request completed",
      result: "HEAD_OK",
      finalResolvedIps: [PUBLIC_V4],
    };

    const mocks = installPinnedRequestMocks({
      responses: [{ statusCode: 200 }],
    });

    const result = await runGetFallback(headResult);

    expect(result.result).toBe("GET_FALLBACK_OK");
    expect(result.usedGetFallback).toBe(true);
    expect(mocks.connectedAddresses).toEqual([PUBLIC_V4]);
    expect(mocks.connectedAddresses).not.toContain(PRIVATE_V4);

    const addr = await new Promise<string>((resolve, reject) => {
      mocks.captured[0].options.lookup!("example.com", {}, (err, a) => {
        if (err) reject(err);
        else resolve(a as string);
      });
    });
    expect(addr).toBe(PUBLIC_V4);
    expect(addr).not.toBe(PRIVATE_V4);
  });
});

// ─── 4. GET redirect rebinding ────────────────────────────────────────────────

describe("4. GET redirect rebinding", () => {
  it("each redirected GET destination uses only IPs approved for that hop", async () => {
    mockResolveDns.mockResolvedValue(
      makeDnsOk("https://cdn.example.com/", [REDIRECT_PUBLIC_V4])
    );

    const headResult: HeadRequestResult = {
      allowed: true,
      originalInput: "https://example.com",
      normalizedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      statusCode: 405,
      redirected: false,
      redirectChain: [],
      redirectCount: 0,
      durationMs: 10,
      reason: "HEAD request completed",
      result: "HEAD_OK",
      finalResolvedIps: [PUBLIC_V4],
    };

    const mocks = installPinnedRequestMocks({
      responses: [
        {
          statusCode: 302,
          locationHeader: "https://cdn.example.com/",
        },
        { statusCode: 200 },
      ],
    });

    const result = await runGetFallback(headResult);

    expect(result.result).toBe("REDIRECTED");
    expect(mocks.connectedAddresses).toEqual([PUBLIC_V4, REDIRECT_PUBLIC_V4]);
    expect(mocks.connectedAddresses).not.toContain(PRIVATE_V4);
    expect(mocks.captured[1].options.hostname).toBe("cdn.example.com");
  });
});

// ─── 5. Fail-closed behaviour ─────────────────────────────────────────────────

describe("5. Fail-closed behaviour", () => {
  it("HEAD fails closed when DNS_OK has an empty approved IP set", async () => {
    const mocks = installPinnedRequestMocks({ responses: [] });
    const result = await sendHeadRequest(makeDnsOk("https://example.com", []));
    expect(result.result).toBe("NETWORK_ERROR");
    expect(result.allowed).toBe(false);
    expect(mocks.captured).toHaveLength(0);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("HEAD real fetcher fails closed on malformed approved address", async () => {
    const mocks = installPinnedRequestMocks({ responses: [] });
    const result = await sendHeadRequest(
      makeDnsOk("https://example.com", ["not-an-ip"])
    );
    expect(result.result).toBe("NETWORK_ERROR");
    expect(result.reason).toMatch(/Malformed|approved/i);
    expect(mocks.connectedAddresses).toHaveLength(0);
  });

  it("HEAD real fetcher fails closed when approved set contains a private IP", async () => {
    const mocks = installPinnedRequestMocks({ responses: [] });
    const result = await sendHeadRequest(
      makeDnsOk("https://example.com", [PRIVATE_V4])
    );
    expect(result.result).toBe("NETWORK_ERROR");
    expect(mocks.connectedAddresses).not.toContain(PRIVATE_V4);
    expect(mocks.connectedAddresses).toHaveLength(0);
  });

  it("GET fails closed when finalResolvedIps is empty", async () => {
    const headResult: HeadRequestResult = {
      allowed: true,
      originalInput: "https://example.com",
      normalizedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      statusCode: 405,
      redirected: false,
      redirectChain: [],
      redirectCount: 0,
      durationMs: 10,
      reason: "HEAD request completed",
      result: "HEAD_OK",
      finalResolvedIps: [],
    };

    const mocks = installPinnedRequestMocks({ responses: [] });
    const result = await runGetFallback(headResult);
    expect(result.usedGetFallback).toBe(true);
    expect(result.result).toBe("NETWORK_ERROR");
    expect(mocks.captured).toHaveLength(0);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});

// ─── 6. HTTPS Host / SNI / certificate semantics ──────────────────────────────

describe("6. HTTPS Host/SNI/certificate semantics under pinning", () => {
  it("keeps original hostname for SNI and does not disable certificate validation", async () => {
    const mocks = installPinnedRequestMocks({
      responses: [{ statusCode: 200 }],
    });

    await sendHeadRequest(makeDnsOk("https://example.com", [PUBLIC_V4]));

    expect(mocks.captured).toHaveLength(1);
    expect(mocks.captured[0].protocol).toBe("https");
    const opts = mocks.captured[0].options as http.RequestOptions & {
      servername?: string;
      rejectUnauthorized?: boolean;
    };
    expect(opts.hostname).toBe("example.com");
    expect(opts.servername).toBe("example.com");
    expect(opts.rejectUnauthorized).toBeUndefined();
    expect(mocks.connectedAddresses).toEqual([PUBLIC_V4]);
  });

  it("GET https fallback also preserves hostname SNI while pinning TCP peer", async () => {
    const headResult: HeadRequestResult = {
      allowed: true,
      originalInput: "https://example.com",
      normalizedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      statusCode: 501,
      redirected: false,
      redirectChain: [],
      redirectCount: 0,
      durationMs: 10,
      reason: "HEAD request completed",
      result: "HEAD_OK",
      finalResolvedIps: [PUBLIC_V4],
    };

    const mocks = installPinnedRequestMocks({
      responses: [{ statusCode: 200 }],
    });

    const result = await runGetFallback(headResult);
    expect(result.result).toBe("GET_FALLBACK_OK");
    const opts = mocks.captured[0].options as http.RequestOptions & {
      servername?: string;
      rejectUnauthorized?: boolean;
    };
    expect(opts.hostname).toBe("example.com");
    expect(opts.servername).toBe("example.com");
    expect(opts.rejectUnauthorized).toBeUndefined();
    expect(mocks.connectedAddresses).toEqual([PUBLIC_V4]);
  });
});

// ─── 7. HEAD still-first / redirect limits unchanged ──────────────────────────

describe("7. Behaviour invariants retained", () => {
  it("HEAD-first path still reports HEAD_OK without GET", async () => {
    const mocks = installPinnedRequestMocks({
      responses: [{ statusCode: 200 }],
    });
    const result = await sendHeadRequest(
      makeDnsOk("https://example.com", [PUBLIC_V4])
    );
    expect(result.result).toBe("HEAD_OK");
    expect(result.finalResolvedIps).toEqual([PUBLIC_V4]);
    expect(mocks.connectedAddresses).toEqual([PUBLIC_V4]);
  });

  it("redirect cap of 3 remains intact under pinning", async () => {
    mockResolveDns.mockImplementation(async (v) =>
      makeDnsOk(v.normalizedUrl ?? "https://hop.example/", [REDIRECT_PUBLIC_V4])
    );

    const mocks = installPinnedRequestMocks({
      responses: [
        { statusCode: 302, locationHeader: "https://h1.example/" },
        { statusCode: 302, locationHeader: "https://h2.example/" },
        { statusCode: 302, locationHeader: "https://h3.example/" },
        { statusCode: 302, locationHeader: "https://h4.example/" },
      ],
    });

    const result = await sendHeadRequest(
      makeDnsOk("https://example.com", [PUBLIC_V4])
    );
    expect(result.result).toBe("TOO_MANY_REDIRECTS");
    expect(result.redirectCount).toBe(3);
    expect(mocks.connectedAddresses).toHaveLength(4);
    expect(mocks.connectedAddresses.every((a) => a !== PRIVATE_V4)).toBe(true);
  });
});
