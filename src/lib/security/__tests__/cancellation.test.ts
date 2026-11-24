/**
 * Request-layer cancellation regressions.
 *
 * Node http/https constructors are mocked; no real network is used.
 */

import { EventEmitter } from "events";
import type * as http from "http";
import type { DnsCheckResult } from "../resolveDns";
import type { HeadRequestResult, SingleHopFetcher } from "../headRequest";

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

import { resolveDns } from "../resolveDns";
import { sendHeadRequest } from "../headRequest";
import { runGetFallback } from "../getFallback";

const mockResolveDns = resolveDns as jest.MockedFunction<typeof resolveDns>;
const PUBLIC_IP = "93.184.216.34";

function makeDnsOk(url = "https://example.com/"): DnsCheckResult {
  const parsed = new URL(url);
  return {
    allowed: true,
    originalInput: url,
    normalizedUrl: parsed.href,
    hostname: parsed.hostname,
    scheme: parsed.protocol === "https:" ? "https" : "http",
    resolvedIps: [PUBLIC_IP],
    reason: "DNS resolved to safe public IP(s)",
    result: "DNS_OK",
  };
}

function makeHead405(url = "https://example.com/"): HeadRequestResult {
  return {
    allowed: true,
    originalInput: url,
    normalizedUrl: url,
    finalUrl: url,
    statusCode: 405,
    redirected: false,
    redirectChain: [],
    redirectCount: 0,
    durationMs: 1,
    reason: "HEAD request completed",
    result: "HEAD_OK",
    finalResolvedIps: [PUBLIC_IP],
  };
}

function installHangingRequest(): {
  destroy: jest.Mock;
  request: jest.Mock;
} {
  const destroy = jest.fn();
  const request = jest.fn(
    (
      _options: http.RequestOptions,
      _callback?: (response: http.IncomingMessage) => void
    ): http.ClientRequest => {
      const req = new EventEmitter() as http.ClientRequest;
      (req as unknown as { destroy: jest.Mock }).destroy = destroy;
      (req as unknown as { end: jest.Mock }).end = jest.fn();
      return req;
    }
  );
  httpRequestMock.mockImplementation(request);
  httpsRequestMock.mockImplementation(request);
  return { destroy, request };
}

beforeEach(() => {
  jest.clearAllMocks();
  httpRequestMock.mockReset();
  httpsRequestMock.mockReset();
  mockResolveDns.mockReset();
});

describe("active socket cancellation", () => {
  it("destroys an active HEAD and settles as ABORTED", async () => {
    const network = installHangingRequest();
    const controller = new AbortController();

    const operation = sendHeadRequest(makeDnsOk(), {
      signal: controller.signal,
    });
    expect(network.request).toHaveBeenCalledTimes(1);

    controller.abort();
    const result = await operation;

    expect(network.destroy).toHaveBeenCalledTimes(1);
    expect(result.result).toBe("ABORTED");
    expect(result.statusCode).toBeNull();
    expect(mockResolveDns).not.toHaveBeenCalled();
  });

  it("destroys an active GET and starts no subsequent request", async () => {
    const network = installHangingRequest();
    const controller = new AbortController();

    const operation = runGetFallback(makeHead405(), {
      signal: controller.signal,
    });
    expect(network.request).toHaveBeenCalledTimes(1);

    controller.abort();
    const result = await operation;

    expect(network.destroy).toHaveBeenCalledTimes(1);
    expect(network.request).toHaveBeenCalledTimes(1);
    expect(result.result).toBe("ABORTED");
    expect(result.statusCode).toBeNull();
  });

  it("does not create GET when already aborted after a 405 HEAD", async () => {
    const network = installHangingRequest();
    const controller = new AbortController();
    controller.abort();

    const result = await runGetFallback(makeHead405(), {
      signal: controller.signal,
    });

    expect(result.result).toBe("ABORTED");
    expect(network.request).not.toHaveBeenCalled();
  });
});

describe("redirect cancellation", () => {
  it("stops HEAD before resolving or requesting the next redirect hop", async () => {
    const controller = new AbortController();
    const fetcher = jest.fn<
      ReturnType<SingleHopFetcher>,
      Parameters<SingleHopFetcher>
    >(
      async (_url, _options) => {
        controller.abort();
        return {
          ok: true as const,
          statusCode: 302,
          locationHeader: "https://redirect.example/",
        };
      }
    );

    const result = await sendHeadRequest(makeDnsOk(), {
      signal: controller.signal,
      _fetcher: fetcher,
    });

    expect(result.result).toBe("ABORTED");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mockResolveDns).not.toHaveBeenCalled();
  });

  it("stops GET before resolving or requesting the next redirect hop", async () => {
    const controller = new AbortController();
    const fetcher = jest.fn<
      ReturnType<SingleHopFetcher>,
      Parameters<SingleHopFetcher>
    >(
      async (_url, _options) => {
        controller.abort();
        return {
          ok: true as const,
          statusCode: 302,
          locationHeader: "https://redirect.example/",
        };
      }
    );

    const result = await runGetFallback(makeHead405(), {
      signal: controller.signal,
      _fetcher: fetcher,
    });

    expect(result.result).toBe("ABORTED");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mockResolveDns).not.toHaveBeenCalled();
  });
});
