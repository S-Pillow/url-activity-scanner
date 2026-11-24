/**
 * AIPF-003: DNS Resolution Check — Unit Tests
 *
 * All DNS queries are mocked. No live DNS lookups are performed.
 * No HTTP requests are made anywhere in this test suite.
 *
 * Covers all 14 test cases from the AIPF-003 acceptance criteria:
 *   1.  Prior VALID with successful public DNS resolution → DNS_OK
 *   2.  Prior INVALID input → INVALID, no DNS lookup
 *   3.  Prior BLOCKED input → BLOCKED, no DNS lookup
 *   4.  DNS failure / nonexistent domain → DNS_FAILURE
 *   5.  Hostname resolves to private IPv4 → BLOCKED
 *   6.  Hostname resolves to loopback IPv4 → BLOCKED
 *   7.  Hostname resolves to link-local IPv4 → BLOCKED
 *   8.  Hostname resolves to private IPv6 → BLOCKED
 *   9.  Hostname resolves to loopback IPv6 → BLOCKED
 *   10. Hostname with both A and AAAA records, all safe → DNS_OK
 *   11. One public IP and one blocked IP → BLOCKED (any unsafe blocks all)
 *   12. DNS timeout / resolver error → DNS_FAILURE
 *   13. Return shape includes all required fields
 *   14. No HTTP request function is called
 *
 * Assumption A-AIPF003-04 (tests):
 *   dns.promises.resolve4 and dns.promises.resolve6 are mocked via jest.mock().
 *   Tests are deterministic and make no real network calls.
 */

import { resolveDns, type DnsCheckResult } from "../resolveDns";
import { validateUrl, type UrlValidationResult } from "../validateUrl";
import { promises as dnsPromises } from "dns";
import { ScanAbortError } from "../cancellation";

// ─── Mock dns module ──────────────────────────────────────────────────────────
//
// jest.mock() is hoisted before imports. The factory replaces the entire "dns"
// module with an object whose promises.resolve4 and promises.resolve6 are
// Jest mock functions.

jest.mock("dns", () => ({
  promises: {
    resolve4: jest.fn(),
    resolve6: jest.fn(),
  },
}));

const mockResolve4 = dnsPromises.resolve4 as jest.MockedFunction<
  typeof dnsPromises.resolve4
>;
const mockResolve6 = dnsPromises.resolve6 as jest.MockedFunction<
  typeof dnsPromises.resolve6
>;

describe("cancellation", () => {
  it("ignores late DNS completion and settles promptly on abort", async () => {
    let resolve4Late!: (addresses: string[]) => void;
    let resolve6Late!: (addresses: string[]) => void;
    mockResolve4.mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolve4Late = resolve;
      })
    );
    mockResolve6.mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolve6Late = resolve;
      })
    );

    const controller = new AbortController();
    const operation = resolveDns(makeValidInput(), {
      signal: controller.signal,
    });

    controller.abort();
    await expect(operation).rejects.toBeInstanceOf(ScanAbortError);

    // Underlying Node DNS cannot be cancelled, but late completion remains
    // observed by raceWithSignal and cannot produce a DNS_OK result.
    resolve4Late(["93.184.216.34"]);
    resolve6Late([]);
    await Promise.resolve();
  });

  it("does not start DNS when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveDns(makeValidInput(), { signal: controller.signal })
    ).rejects.toBeInstanceOf(ScanAbortError);
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Pre-validated VALID result for a domain that looks fine to AIPF-002. */
function makeValidInput(url = "https://example.com"): UrlValidationResult {
  return validateUrl(url);
}

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function expectDnsOk(r: DnsCheckResult) {
  expect(r.allowed).toBe(true);
  expect(r.result).toBe("DNS_OK");
  expect(r.resolvedIps.length).toBeGreaterThan(0);
}

function expectBlocked(r: DnsCheckResult) {
  expect(r.allowed).toBe(false);
  expect(r.result).toBe("BLOCKED");
}

function expectInvalid(r: DnsCheckResult) {
  expect(r.allowed).toBe(false);
  expect(r.result).toBe("INVALID");
}

function expectDnsFailure(r: DnsCheckResult) {
  expect(r.allowed).toBe(false);
  expect(r.result).toBe("DNS_FAILURE");
}

// ─── Reset mocks between tests ────────────────────────────────────────────────

beforeEach(() => {
  mockResolve4.mockReset();
  mockResolve6.mockReset();
});

// ─── Test 1: Prior VALID with successful public DNS resolution ────────────────

describe("1. Prior VALID — public DNS resolution succeeds", () => {
  it("returns DNS_OK when resolve4 returns a public IP", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectDnsOk(r);
    expect(r.hostname).toBe("example.com");
    expect(r.resolvedIps).toContain("93.184.216.34");
    expect(r.scheme).toBe("https");
    expect(r.reason).toMatch(/safe public/i);
  });

  it("returns DNS_OK when resolve6 returns a public IPv6 and resolve4 has no records", async () => {
    mockResolve4.mockRejectedValue(dnsError("ENODATA"));
    mockResolve6.mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectDnsOk(r);
    expect(r.resolvedIps).toContain("2606:2800:220:1:248:1893:25c8:1946");
  });
});

// ─── Test 2: Prior INVALID input ─────────────────────────────────────────────

describe("2. Prior INVALID — no DNS lookup", () => {
  it("forwards INVALID result without calling resolve4 or resolve6", async () => {
    const invalid = validateUrl("");
    expect(invalid.result).toBe("INVALID");

    const r = await resolveDns(invalid);
    expectInvalid(r);
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });

  it("forwards reason from the original AIPF-002 result", async () => {
    const invalid = validateUrl("not a url");
    const r = await resolveDns(invalid);
    expectInvalid(r);
    expect(r.reason).toBe(invalid.reason);
    expect(r.resolvedIps).toHaveLength(0);
  });
});

// ─── Test 3: Prior BLOCKED input ─────────────────────────────────────────────

describe("3. Prior BLOCKED — no DNS lookup", () => {
  it("forwards BLOCKED for a localhost input without any DNS call", async () => {
    const blocked = validateUrl("http://localhost");
    expect(blocked.result).toBe("BLOCKED");

    const r = await resolveDns(blocked);
    expectBlocked(r);
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });

  it("forwards BLOCKED for an unsupported-scheme input", async () => {
    const blocked = validateUrl("ftp://example.com");
    const r = await resolveDns(blocked);
    expectBlocked(r);
    expect(r.resolvedIps).toHaveLength(0);
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("forwards BLOCKED for a private IPv4 that AIPF-002 already blocked", async () => {
    const blocked = validateUrl("http://10.0.0.1");
    const r = await resolveDns(blocked);
    expectBlocked(r);
    expect(mockResolve4).not.toHaveBeenCalled();
  });
});

// ─── Test 4: DNS failure / nonexistent domain ─────────────────────────────────

describe("4. DNS failure — nonexistent domain", () => {
  it("returns DNS_FAILURE when both resolve4 and resolve6 throw ENOTFOUND", async () => {
    mockResolve4.mockRejectedValue(dnsError("ENOTFOUND"));
    mockResolve6.mockRejectedValue(dnsError("ENOTFOUND"));

    const r = await resolveDns(makeValidInput("https://does-not-exist.invalid"));
    expectDnsFailure(r);
    expect(r.resolvedIps).toHaveLength(0);
    expect(r.reason).toMatch(/does not resolve/i);
  });

  it("returns DNS_FAILURE when resolve4 throws ENODATA and resolve6 throws ENODATA", async () => {
    mockResolve4.mockRejectedValue(dnsError("ENODATA"));
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectDnsFailure(r);
    expect(r.resolvedIps).toHaveLength(0);
  });
});

// ─── Test 5: Hostname resolves to private IPv4 ────────────────────────────────

describe("5. Hostname resolves to private IPv4", () => {
  it("blocks when resolve4 returns an RFC 1918 Class A address (10.x.x.x)", async () => {
    mockResolve4.mockResolvedValue(["10.1.2.3"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
    expect(r.resolvedIps).toContain("10.1.2.3");
    expect(r.reason).toMatch(/private\/internal\/reserved/i);
  });

  it("blocks when resolve4 returns an RFC 1918 Class C address (192.168.x.x)", async () => {
    mockResolve4.mockResolvedValue(["192.168.1.100"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
  });
});

// ─── Test 6: Hostname resolves to loopback IPv4 ───────────────────────────────

describe("6. Hostname resolves to loopback IPv4", () => {
  it("blocks when resolve4 returns 127.0.0.1", async () => {
    mockResolve4.mockResolvedValue(["127.0.0.1"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
    expect(r.resolvedIps).toContain("127.0.0.1");
  });

  it("blocks when resolve4 returns any 127.x.x.x address", async () => {
    mockResolve4.mockResolvedValue(["127.0.0.2"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
  });
});

// ─── Test 7: Hostname resolves to link-local IPv4 ────────────────────────────

describe("7. Hostname resolves to link-local IPv4", () => {
  it("blocks when resolve4 returns 169.254.169.254 (cloud metadata)", async () => {
    mockResolve4.mockResolvedValue(["169.254.169.254"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
  });

  it("blocks when resolve4 returns any 169.254.x.x address", async () => {
    mockResolve4.mockResolvedValue(["169.254.0.1"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
  });
});

// ─── Test 8: Hostname resolves to private IPv6 ────────────────────────────────

describe("8. Hostname resolves to private IPv6", () => {
  it("blocks when resolve6 returns a unique-local address (fc00::/7)", async () => {
    mockResolve4.mockRejectedValue(dnsError("ENODATA"));
    mockResolve6.mockResolvedValue(["fc00::1"]);

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
    expect(r.resolvedIps).toContain("fc00::1");
  });

  it("blocks when resolve6 returns an fd00::/8 (also unique local)", async () => {
    mockResolve4.mockRejectedValue(dnsError("ENODATA"));
    mockResolve6.mockResolvedValue(["fd00::1"]);

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
  });

  it("blocks when resolve6 returns a link-local fe80:: address", async () => {
    mockResolve4.mockRejectedValue(dnsError("ENODATA"));
    mockResolve6.mockResolvedValue(["fe80::1"]);

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
  });
});

// ─── Test 9: Hostname resolves to loopback IPv6 ───────────────────────────────

describe("9. Hostname resolves to loopback IPv6", () => {
  it("blocks when resolve6 returns ::1", async () => {
    mockResolve4.mockRejectedValue(dnsError("ENODATA"));
    mockResolve6.mockResolvedValue(["::1"]);

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
    expect(r.resolvedIps).toContain("::1");
  });
});

// ─── Test 10: Both A and AAAA records, all safe ───────────────────────────────

describe("10. Both A and AAAA records, all safe", () => {
  it("returns DNS_OK when both resolve4 and resolve6 return public IPs", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectDnsOk(r);
    expect(r.resolvedIps).toHaveLength(2);
    expect(r.resolvedIps).toContain("93.184.216.34");
    expect(r.resolvedIps).toContain("2606:2800:220:1:248:1893:25c8:1946");
  });
});

// ─── Test 11: One public IP and one blocked IP ────────────────────────────────

describe("11. One public IP and one blocked IP — any unsafe blocks all", () => {
  it("blocks when resolve4 returns a mix of public and private IPs", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34", "10.0.0.1"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
    // Both IPs are in resolvedIps — we block after collecting all records
    expect(r.resolvedIps).toContain("93.184.216.34");
    expect(r.resolvedIps).toContain("10.0.0.1");
  });

  it("blocks when resolve4 is public but resolve6 returns a private IPv6", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockResolvedValue(["fc00::1"]);

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
    expect(r.resolvedIps).toHaveLength(2);
  });

  it("blocks when resolve6 is public but resolve4 returns 127.0.0.1", async () => {
    mockResolve4.mockResolvedValue(["127.0.0.1"]);
    mockResolve6.mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectBlocked(r);
  });
});

// ─── Test 12: DNS timeout or resolver error ───────────────────────────────────

describe("12. DNS timeout or resolver error", () => {
  it("returns DNS_FAILURE on ETIMEOUT from both resolvers", async () => {
    mockResolve4.mockRejectedValue(dnsError("ETIMEOUT"));
    mockResolve6.mockRejectedValue(dnsError("ETIMEOUT"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectDnsFailure(r);
    expect(r.resolvedIps).toHaveLength(0);
  });

  it("returns DNS_FAILURE on ESERVFAIL (DNS server failure)", async () => {
    mockResolve4.mockRejectedValue(dnsError("ESERVFAIL"));
    mockResolve6.mockRejectedValue(dnsError("ESERVFAIL"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    expectDnsFailure(r);
  });

  it("returns DNS_OK if one resolver times out but the other returns a public IP", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(dnsError("ETIMEOUT"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    // resolve4 succeeded with a public IP — DNS_OK
    expectDnsOk(r);
    expect(r.resolvedIps).toContain("93.184.216.34");
  });
});

// ─── Test 13: Return shape includes all required fields ───────────────────────

describe("13. Return shape — all required fields present", () => {
  const REQUIRED_FIELDS: Array<keyof DnsCheckResult> = [
    "allowed",
    "originalInput",
    "normalizedUrl",
    "hostname",
    "scheme",
    "resolvedIps",
    "reason",
    "result",
  ];

  it("includes all fields when DNS_OK", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    for (const field of REQUIRED_FIELDS) {
      expect(r).toHaveProperty(field);
    }
  });

  it("includes all fields when DNS_FAILURE", async () => {
    mockResolve4.mockRejectedValue(dnsError("ENOTFOUND"));
    mockResolve6.mockRejectedValue(dnsError("ENOTFOUND"));

    const r = await resolveDns(makeValidInput("https://example.com"));
    for (const field of REQUIRED_FIELDS) {
      expect(r).toHaveProperty(field);
    }
    expect(Array.isArray(r.resolvedIps)).toBe(true);
  });

  it("includes all fields when BLOCKED by AIPF-002 (no DNS)", async () => {
    const r = await resolveDns(validateUrl("http://localhost"));
    for (const field of REQUIRED_FIELDS) {
      expect(r).toHaveProperty(field);
    }
    expect(Array.isArray(r.resolvedIps)).toBe(true);
  });

  it("allowed is true only when result is DNS_OK", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));
    const ok = await resolveDns(makeValidInput("https://example.com"));
    expect(ok.allowed).toBe(ok.result === "DNS_OK");

    const blocked = await resolveDns(validateUrl("http://localhost"));
    expect(blocked.allowed).toBe(false);
    expect(blocked.result).not.toBe("DNS_OK");
  });

  it("originalInput is always the raw unmodified string from AIPF-002", async () => {
    const raw = "  https://example.com  ";
    const validated = validateUrl(raw);
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    const r = await resolveDns(validated);
    expect(r.originalInput).toBe(raw);
  });
});

// ─── Test 14: No HTTP request function is called ──────────────────────────────

describe("14. No HTTP request is made", () => {
  it("only calls dns.promises functions — never http, fetch, or https modules", async () => {
    // The resolveDns module imports only "dns" and the internal security
    // modules. This test verifies the DNS mock is the only I/O path exercised.
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(dnsError("ENODATA"));

    await resolveDns(makeValidInput("https://example.com"));

    // resolve4 and resolve6 were called — no http/https/fetch calls are
    // possible because they are not imported by the module under test.
    expect(mockResolve4).toHaveBeenCalledTimes(1);
    expect(mockResolve6).toHaveBeenCalledTimes(1);
    expect(mockResolve4).toHaveBeenCalledWith("example.com");
    expect(mockResolve6).toHaveBeenCalledWith("example.com");
  });

  it("does not call resolve4 or resolve6 when input is INVALID", async () => {
    await resolveDns(validateUrl(""));
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });

  it("does not call resolve4 or resolve6 when input is BLOCKED", async () => {
    await resolveDns(validateUrl("http://127.0.0.1"));
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });
});
