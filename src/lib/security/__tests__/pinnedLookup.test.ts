/**
 * Unit tests for pinnedLookup — outbound address selection / pin helper.
 *
 * No live network or DNS. Demonstrates fail-closed behaviour and that
 * connection-time resolution cannot introduce an unapproved address.
 */

import {
  assertApprovedIps,
  buildPinnedRequestOptions,
  createPinnedLookup,
  PinLookupError,
  PIN_LOOKUP_ERROR_CODE,
  selectPinnedAddress,
} from "../pinnedLookup";
import type { LookupAddress, LookupOptions } from "dns";

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";
const PRIVATE_V4 = "10.0.0.1";
const LOOPBACK_V4 = "127.0.0.1";

function invokeLookup(
  lookup: ReturnType<typeof createPinnedLookup>,
  hostname: string,
  options: LookupOptions = {}
): Promise<{ address: string; family: number } | LookupAddress[]> {
  return new Promise((resolve, reject) => {
    if (options.all) {
      lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses as LookupAddress[]);
      });
      return;
    }
    lookup(hostname, options, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address: address as string, family: family as number });
    });
  });
}

describe("assertApprovedIps", () => {
  it("returns a copy of safe public addresses", () => {
    expect(assertApprovedIps([PUBLIC_V4, PUBLIC_V6])).toEqual([
      PUBLIC_V4,
      PUBLIC_V6,
    ]);
  });

  it("fails closed on empty set", () => {
    expect(() => assertApprovedIps([])).toThrow(PinLookupError);
    expect(() => assertApprovedIps([])).toThrow(/No approved addresses/);
  });

  it("fails closed on malformed address", () => {
    expect(() => assertApprovedIps(["not-an-ip"])).toThrow(PinLookupError);
    expect(() => assertApprovedIps(["not-an-ip"])).toThrow(/Malformed/);
  });

  it("fails closed when a private address is present (defence in depth)", () => {
    expect(() => assertApprovedIps([PUBLIC_V4, PRIVATE_V4])).toThrow(
      PinLookupError
    );
  });

  it("fails closed on loopback", () => {
    expect(() => assertApprovedIps([LOOPBACK_V4])).toThrow(PinLookupError);
  });
});

describe("selectPinnedAddress", () => {
  it("selects the first approved IPv4 when family is unrestricted", () => {
    expect(selectPinnedAddress([PUBLIC_V4, PUBLIC_V6])).toEqual({
      address: PUBLIC_V4,
      family: 4,
    });
  });

  it("selects IPv6 when family=6", () => {
    expect(selectPinnedAddress([PUBLIC_V4, PUBLIC_V6], 6)).toEqual({
      address: PUBLIC_V6,
      family: 6,
    });
  });

  it("fails closed when no address matches the requested family", () => {
    expect(() => selectPinnedAddress([PUBLIC_V4], 6)).toThrow(PinLookupError);
  });

  it("never returns an address outside the approved set", () => {
    const selected = selectPinnedAddress([PUBLIC_V4]);
    expect(selected.address).toBe(PUBLIC_V4);
    expect(selected.address).not.toBe(PRIVATE_V4);
  });
});

describe("createPinnedLookup — rebinding resistance", () => {
  it("returns only the validation-time approved public IP", async () => {
    const lookup = createPinnedLookup([PUBLIC_V4]);
    const result = (await invokeLookup(lookup, "evil-rebinder.example")) as {
      address: string;
      family: number;
    };
    expect(result.address).toBe(PUBLIC_V4);
    expect(result.family).toBe(4);
  });

  it("ignores hostname entirely — simulated connection-time private IP cannot be selected", async () => {
    const lookup = createPinnedLookup([PUBLIC_V4]);
    // Even if the "attacker" hostname would rebind to 10.0.0.1 at connect time,
    // the pinned lookup has no path to return that address.
    const result = (await invokeLookup(lookup, "rebind-to-10.0.0.1.example")) as {
      address: string;
      family: number;
    };
    expect(result.address).toBe(PUBLIC_V4);
    expect(result.address).not.toBe(PRIVATE_V4);
  });

  it("does not fall back to unrestricted DNS — only approved addresses are returned", async () => {
    // createPinnedLookup never imports or calls dns.*; a rebinding hostname
    // still yields only the pre-approved public IP.
    const lookup = createPinnedLookup([PUBLIC_V4]);
    const result = (await invokeLookup(
      lookup,
      "would-have-rebound-to-10.0.0.1.example"
    )) as { address: string; family: number };
    expect(result.address).toBe(PUBLIC_V4);
    expect(result.address).not.toBe(PRIVATE_V4);
  });

  it("fails closed when the approved set is empty", () => {
    expect(() => createPinnedLookup([])).toThrow(PinLookupError);
  });

  it("fails closed for malformed approved addresses", () => {
    expect(() => createPinnedLookup(["%%%"])).toThrow(PinLookupError);
  });

  it("callback fails when requested family has no approved address", async () => {
    const lookup = createPinnedLookup([PUBLIC_V4]);
    await expect(invokeLookup(lookup, "example.com", { family: 6 })).rejects.toMatchObject({
      code: PIN_LOOKUP_ERROR_CODE,
    });
  });

  it("opts.all returns only approved addresses", async () => {
    const lookup = createPinnedLookup([PUBLIC_V4, PUBLIC_V6]);
    const results = (await invokeLookup(lookup, "example.com", {
      all: true,
    })) as LookupAddress[];
    expect(results.map((r) => r.address).sort()).toEqual(
      [PUBLIC_V4, PUBLIC_V6].sort()
    );
    expect(results.every((r) => r.address !== PRIVATE_V4)).toBe(true);
  });

  it("PinLookupError exposes stable error code", () => {
    const err = new PinLookupError("test");
    expect(err.code).toBe(PIN_LOOKUP_ERROR_CODE);
  });
});

describe("buildPinnedRequestOptions", () => {
  it("preserves original hostname for Host/SNI while attaching pinned lookup", () => {
    const url = new URL("https://example.com/path?q=1");
    const opts = buildPinnedRequestOptions({
      url,
      method: "HEAD",
      approvedIps: [PUBLIC_V4],
      headers: { "User-Agent": "test" },
    });

    expect(opts.hostname).toBe("example.com");
    expect((opts as { servername?: string }).servername).toBe("example.com");
    expect(opts.method).toBe("HEAD");
    expect(opts.path).toBe("/path?q=1");
    expect(typeof opts.lookup).toBe("function");
    // Certificate validation must remain enabled (default).
    expect(
      (opts as { rejectUnauthorized?: boolean }).rejectUnauthorized
    ).toBeUndefined();
  });

  it("does not set servername for http (SNI is TLS-only)", () => {
    const url = new URL("http://example.com/");
    const opts = buildPinnedRequestOptions({
      url,
      method: "GET",
      approvedIps: [PUBLIC_V4],
      headers: {},
    });
    expect(opts.hostname).toBe("example.com");
    expect((opts as { servername?: string }).servername).toBeUndefined();
  });

  it("pinned lookup on built options cannot yield a private rebinding address", async () => {
    const url = new URL("https://rebind.example/");
    const opts = buildPinnedRequestOptions({
      url,
      method: "GET",
      approvedIps: [PUBLIC_V4],
      headers: {},
    });

    const address = await new Promise<string>((resolve, reject) => {
      opts.lookup!("rebind.example", {}, (err, addr) => {
        if (err) reject(err);
        else resolve(addr as string);
      });
    });

    expect(address).toBe(PUBLIC_V4);
    expect(address).not.toBe(PRIVATE_V4);
  });

  it("fails closed when building options with no approved IPs", () => {
    expect(() =>
      buildPinnedRequestOptions({
        url: new URL("https://example.com/"),
        method: "HEAD",
        approvedIps: [],
        headers: {},
      })
    ).toThrow(PinLookupError);
  });
});
