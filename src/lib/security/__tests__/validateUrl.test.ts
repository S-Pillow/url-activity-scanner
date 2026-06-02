/**
 * AIPF-002: SSRF Protection & URL Validation Layer — Unit Tests
 *
 * Covers every case listed in the AIPF-002 acceptance criteria:
 *   - Valid URLs (plain domain, https, http with path, subdomain + query)
 *   - Invalid inputs (empty, unparseable)
 *   - Blocked schemes (ftp, file, javascript, data)
 *   - Blocked hostnames (localhost, localhost.localdomain, metadata.google.internal)
 *   - Blocked IPv4 ranges (loopback, private, link-local, metadata IP, multicast)
 *   - Blocked IPv6 ranges (loopback, link-local, unique local, documentation)
 *   - Edge cases (whitespace, trailing dot, IPv6 bracket notation, WHATWG normalization)
 *
 * No network requests are made anywhere in this test suite.
 */

import { validateUrl, type UrlValidationResult } from "../validateUrl";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expectValid(result: UrlValidationResult) {
  expect(result.allowed).toBe(true);
  expect(result.result).toBe("VALID");
  expect(result.normalizedUrl).not.toBeNull();
  expect(result.hostname).not.toBeNull();
}

function expectBlocked(result: UrlValidationResult) {
  expect(result.allowed).toBe(false);
  expect(result.result).toBe("BLOCKED");
}

function expectInvalid(result: UrlValidationResult) {
  expect(result.allowed).toBe(false);
  expect(result.result).toBe("INVALID");
}

// ─── Valid URLs ───────────────────────────────────────────────────────────────

describe("Valid URLs", () => {
  it("normalizes a plain domain to https://", () => {
    const r = validateUrl("example.com");
    expectValid(r);
    expect(r.scheme).toBe("https");
    expect(r.hostname).toBe("example.com");
    expect(r.normalizedUrl).toContain("https://example.com");
  });

  it("accepts https:// URL", () => {
    const r = validateUrl("https://example.com");
    expectValid(r);
    expect(r.scheme).toBe("https");
    expect(r.hostname).toBe("example.com");
  });

  it("accepts http:// URL with path", () => {
    const r = validateUrl("http://example.com/path");
    expectValid(r);
    expect(r.scheme).toBe("http");
    expect(r.hostname).toBe("example.com");
    expect(r.normalizedUrl).toBe("http://example.com/path");
  });

  it("accepts https subdomain with path and query string", () => {
    const r = validateUrl("https://sub.example.com/path?x=1");
    expectValid(r);
    expect(r.scheme).toBe("https");
    expect(r.hostname).toBe("sub.example.com");
  });

  it("preserves originalInput unchanged", () => {
    const r = validateUrl("https://example.com/path");
    expect(r.originalInput).toBe("https://example.com/path");
  });

  it("strips leading/trailing whitespace before validating", () => {
    const r = validateUrl("  https://example.com  ");
    expectValid(r);
    expect(r.hostname).toBe("example.com");
  });

  it("strips trailing dot from FQDN and accepts the URL", () => {
    const r = validateUrl("https://example.com.");
    expectValid(r);
    expect(r.hostname).toBe("example.com");
  });

  it("accepts a public IPv4 address", () => {
    const r = validateUrl("http://93.184.216.34");
    expectValid(r);
    expect(r.hostname).toBe("93.184.216.34");
  });
});

// ─── Invalid inputs ───────────────────────────────────────────────────────────

describe("Invalid inputs", () => {
  it("rejects empty string", () => {
    const r = validateUrl("");
    expectInvalid(r);
    expect(r.reason).toBe("Empty input");
    expect(r.hostname).toBeNull();
    expect(r.scheme).toBeNull();
    expect(r.normalizedUrl).toBeNull();
  });

  it("rejects whitespace-only input", () => {
    const r = validateUrl("   ");
    expectInvalid(r);
    expect(r.reason).toBe("Empty input");
  });

  it("rejects completely unparseable string", () => {
    const r = validateUrl("not a url");
    expectInvalid(r);
    expect(r.reason).toBe("Invalid URL format");
    expect(r.normalizedUrl).toBeNull();
  });
});

// ─── Blocked — unsupported scheme ─────────────────────────────────────────────

describe("Blocked: unsupported scheme", () => {
  it("blocks ftp://", () => {
    const r = validateUrl("ftp://example.com");
    expectBlocked(r);
    expect(r.reason).toBe("Unsupported protocol");
  });

  it("blocks file://", () => {
    const r = validateUrl("file:///etc/passwd");
    expectBlocked(r);
    expect(r.reason).toBe("Unsupported protocol");
  });

  it("blocks javascript:", () => {
    const r = validateUrl("javascript:alert(1)");
    expectBlocked(r);
    expect(r.reason).toBe("Unsupported protocol");
  });

  it("blocks data:", () => {
    const r = validateUrl("data:text/html;base64,test");
    expectBlocked(r);
    expect(r.reason).toBe("Unsupported protocol");
  });

  it("blocks gopher://", () => {
    const r = validateUrl("gopher://example.com");
    expectBlocked(r);
    expect(r.reason).toBe("Unsupported protocol");
  });
});

// ─── Blocked — hostname ───────────────────────────────────────────────────────

describe("Blocked: hostname", () => {
  it("blocks http://localhost", () => {
    const r = validateUrl("http://localhost");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked hostname");
    expect(r.hostname).toBe("localhost");
  });

  it("blocks http://localhost.localdomain", () => {
    const r = validateUrl("http://localhost.localdomain");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked hostname");
  });

  it("blocks http://metadata.google.internal", () => {
    const r = validateUrl("http://metadata.google.internal");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked hostname");
  });

  it("blocks a subdomain of .localhost (e.g. foo.localhost)", () => {
    const r = validateUrl("http://foo.localhost");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked hostname");
  });

  it("blocks a .local hostname (mDNS)", () => {
    const r = validateUrl("http://mydevice.local");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked hostname");
  });

  it("blocks a .internal hostname", () => {
    const r = validateUrl("http://api.internal");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked hostname");
  });
});

// ─── Blocked — IPv4 private / reserved ranges ─────────────────────────────────

describe("Blocked: IPv4 private and reserved ranges", () => {
  it("blocks loopback 127.0.0.1", () => {
    const r = validateUrl("http://127.0.0.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
    expect(r.hostname).toBe("127.0.0.1");
  });

  it("blocks loopback 127.0.0.2 (still in 127/8)", () => {
    const r = validateUrl("http://127.0.0.2");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks RFC 1918 Class A: 10.0.0.1", () => {
    const r = validateUrl("http://10.0.0.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks RFC 1918 Class B: 172.16.0.1", () => {
    const r = validateUrl("http://172.16.0.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks RFC 1918 Class B boundary: 172.31.255.255", () => {
    const r = validateUrl("http://172.31.255.255");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("does NOT block 172.32.0.1 (just outside RFC 1918 Class B)", () => {
    const r = validateUrl("http://172.32.0.1");
    expectValid(r);
  });

  it("blocks RFC 1918 Class C: 192.168.1.1", () => {
    const r = validateUrl("http://192.168.1.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks cloud metadata IP 169.254.169.254 with specific reason", () => {
    const r = validateUrl("http://169.254.169.254");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked cloud metadata IP");
    expect(r.hostname).toBe("169.254.169.254");
  });

  it("blocks link-local 169.254.0.1 (same /16 as metadata IP)", () => {
    const r = validateUrl("http://169.254.0.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks unspecified 0.0.0.0", () => {
    const r = validateUrl("http://0.0.0.0");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks multicast 224.0.0.1", () => {
    const r = validateUrl("http://224.0.0.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks carrier-grade NAT 100.64.0.1", () => {
    const r = validateUrl("http://100.64.0.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks documentation TEST-NET-1 192.0.2.1", () => {
    const r = validateUrl("http://192.0.2.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks documentation TEST-NET-2 198.51.100.1", () => {
    const r = validateUrl("http://198.51.100.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks documentation TEST-NET-3 203.0.113.1", () => {
    const r = validateUrl("http://203.0.113.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks reserved 240.0.0.1", () => {
    const r = validateUrl("http://240.0.0.1");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });

  it("blocks broadcast 255.255.255.255", () => {
    const r = validateUrl("http://255.255.255.255");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked private/internal IP range");
  });
});

// ─── Blocked — WHATWG IPv4 normalization (bypass attempts) ───────────────────

describe("Blocked: WHATWG IPv4 normalization prevents bypass", () => {
  it("blocks hex-encoded loopback http://0x7f000001", () => {
    const r = validateUrl("http://0x7f000001");
    expectBlocked(r);
    expect(r.hostname).toBe("127.0.0.1");
  });

  it("blocks decimal-encoded loopback http://2130706433", () => {
    const r = validateUrl("http://2130706433");
    expectBlocked(r);
    expect(r.hostname).toBe("127.0.0.1");
  });

  it("blocks octal-encoded loopback http://0177.0.0.1", () => {
    const r = validateUrl("http://0177.0.0.1");
    expectBlocked(r);
    expect(r.hostname).toBe("127.0.0.1");
  });
});

// ─── Blocked — IPv6 private / reserved ranges ─────────────────────────────────

describe("Blocked: IPv6 private and reserved ranges", () => {
  it("blocks IPv6 loopback ::1 with specific reason", () => {
    const r = validateUrl("http://[::1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 loopback address");
    expect(r.hostname).toBe("::1");
  });

  it("blocks IPv6 link-local fe80::1", () => {
    const r = validateUrl("http://[fe80::1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });

  it("blocks unique local fc00::1 (fc00::/7)", () => {
    const r = validateUrl("http://[fc00::1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });

  it("blocks unique local fd00::1 (also in fc00::/7)", () => {
    const r = validateUrl("http://[fd00::1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });

  it("blocks documentation prefix 2001:db8::1", () => {
    const r = validateUrl("http://[2001:db8::1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });

  it("blocks multicast ff02::1", () => {
    const r = validateUrl("http://[ff02::1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });

  it("blocks unspecified :: (::/128)", () => {
    const r = validateUrl("http://[::]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });
});

// ─── Blocked — IPv4-mapped IPv6 bypass attempts ───────────────────────────────

describe("Blocked: IPv4-mapped IPv6 addresses (bypass prevention)", () => {
  it("blocks ::ffff:127.0.0.1 (loopback mapped)", () => {
    const r = validateUrl("http://[::ffff:127.0.0.1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });

  it("blocks ::ffff:10.0.0.1 (private Class A mapped)", () => {
    const r = validateUrl("http://[::ffff:10.0.0.1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });

  it("blocks ::ffff:172.16.0.1 (private Class B mapped)", () => {
    const r = validateUrl("http://[::ffff:172.16.0.1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });

  it("blocks ::ffff:192.168.0.1 (private Class C mapped)", () => {
    const r = validateUrl("http://[::ffff:192.168.0.1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });

  it("blocks ::ffff:169.254.0.1 (link-local mapped)", () => {
    const r = validateUrl("http://[::ffff:169.254.0.1]");
    expectBlocked(r);
    expect(r.reason).toBe("Blocked IPv6 private/reserved address");
  });
});

// ─── Return shape validation ──────────────────────────────────────────────────

describe("Return shape", () => {
  it("always includes all seven fields", () => {
    const fields: Array<keyof ReturnType<typeof validateUrl>> = [
      "allowed",
      "originalInput",
      "normalizedUrl",
      "hostname",
      "scheme",
      "reason",
      "result",
    ];
    for (const input of [
      "example.com",
      "",
      "not a url",
      "http://127.0.0.1",
      "ftp://example.com",
    ]) {
      const r = validateUrl(input);
      for (const field of fields) {
        expect(r).toHaveProperty(field);
      }
    }
  });

  it("originalInput is always the raw unmodified string", () => {
    const raw = "  example.com  ";
    const r = validateUrl(raw);
    expect(r.originalInput).toBe(raw);
  });

  it("allowed is true only when result is VALID", () => {
    const inputs = [
      "https://example.com",
      "http://127.0.0.1",
      "ftp://example.com",
      "",
      "not a url",
      "http://[::1]",
    ];
    for (const input of inputs) {
      const r = validateUrl(input);
      expect(r.allowed).toBe(r.result === "VALID");
    }
  });

  it("scheme is null for blocked scheme inputs", () => {
    expect(validateUrl("ftp://example.com").scheme).toBeNull();
    expect(validateUrl("javascript:alert(1)").scheme).toBeNull();
  });

  it("scheme is null for invalid inputs", () => {
    expect(validateUrl("").scheme).toBeNull();
    expect(validateUrl("not a url").scheme).toBeNull();
  });

  it("hostname is null for scheme-level blocks", () => {
    expect(validateUrl("ftp://example.com").hostname).toBeNull();
  });

  it("normalizedUrl is null only for completely unparseable inputs", () => {
    expect(validateUrl("").normalizedUrl).toBeNull();
    expect(validateUrl("not a url").normalizedUrl).toBeNull();
    // scheme-blocked inputs do have a normalizedUrl
    expect(validateUrl("ftp://example.com").normalizedUrl).not.toBeNull();
  });
});
