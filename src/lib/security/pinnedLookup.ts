/**
 * Outbound connection pinning (DNS-rebinding / SSRF TOCTOU defence).
 *
 * After resolveDns() has approved a set of IPs via checkIpSafety(), every
 * outbound HTTP(S) socket MUST connect only to an address from that set.
 * Node's default DNS lookup at connect time is never used for these requests.
 *
 * Design:
 *   - createPinnedLookup(approvedIps) returns a net.LookupFunction that
 *     never calls dns.lookup / dns.resolve* — it only yields from the
 *     pre-approved set (fail closed if empty / malformed / family mismatch).
 *   - buildPinnedRequestOptions() centralises request option construction so
 *     HEAD and GET cannot diverge: hostname stays the original name (Host /
 *     SNI / cert verification), while lookup pins the TCP peer.
 *
 * Approved addresses from one hostname or redirect hop must never be reused
 * for another hostname — callers pass a fresh set per hop.
 */

import * as net from "net";
import type { LookupFunction } from "net";
import type { LookupAddress, LookupOptions } from "dns";
import type { RequestOptions as HttpRequestOptions } from "http";
import { checkIpSafety } from "./ipSafety";

/** Errno-style code used when pinned lookup cannot produce a safe address. */
export const PIN_LOOKUP_ERROR_CODE = "ERR_PINNED_LOOKUP_FAILED";

export class PinLookupError extends Error {
  readonly code = PIN_LOOKUP_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "PinLookupError";
  }
}

/**
 * Validates the approved address set before any socket is opened.
 * Re-applies checkIpSafety() as defence-in-depth at the request boundary.
 *
 * @throws {PinLookupError} when the set is empty, malformed, or unsafe.
 */
export function assertApprovedIps(approvedIps: readonly string[]): string[] {
  if (!approvedIps || approvedIps.length === 0) {
    throw new PinLookupError(
      "No approved addresses available for outbound connection"
    );
  }

  const normalised: string[] = [];
  for (const ip of approvedIps) {
    if (typeof ip !== "string" || net.isIP(ip) === 0) {
      throw new PinLookupError("Malformed approved address in pin set");
    }
    // Defence in depth: never pin to an address that fails the SSRF policy,
    // even if a caller passed it through from a stale/buggy DnsCheckResult.
    if (checkIpSafety(ip) !== null) {
      throw new PinLookupError(
        "Approved address failed IP safety re-check at pin boundary"
      );
    }
    normalised.push(ip);
  }
  return normalised;
}

/**
 * Selects a single address from the approved set for socket creation.
 * Never performs DNS. Never returns an address outside the approved set.
 *
 * @param family - 0 (any), 4, or 6 — matches Node's lookup options.
 * @throws {PinLookupError} on empty set / family mismatch / unsafe addresses.
 */
export function selectPinnedAddress(
  approvedIps: readonly string[],
  family: number = 0
): LookupAddress {
  const pinned = assertApprovedIps(approvedIps);
  const candidates = pinned
    .map((address) => ({
      address,
      family: net.isIP(address) as 4 | 6,
    }))
    .filter((c) => family === 0 || c.family === family);

  if (candidates.length === 0) {
    throw new PinLookupError(
      "No approved address matches the requested address family"
    );
  }

  return candidates[0];
}

/**
 * Builds a Node `lookup` callback that returns ONLY pre-approved addresses.
 * Deliberately does not call dns.lookup — fail closed instead of falling back.
 */
export function createPinnedLookup(
  approvedIps: readonly string[]
): LookupFunction {
  // Eager validation so request setup fails before connect when the set is bad.
  const pinned = assertApprovedIps(approvedIps);

  const pinnedLookup: LookupFunction = ((
    _hostname: string,
    options: LookupOptions | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
    callback?: (
      err: NodeJS.ErrnoException | null,
      address: string,
      family: number
    ) => void
  ) => {
    let opts: LookupOptions = {};
    let cb:
      | ((
          err: NodeJS.ErrnoException | null,
          address: string,
          family: number
        ) => void)
      | ((
          err: NodeJS.ErrnoException | null,
          addresses: LookupAddress[]
        ) => void);

    if (typeof options === "function") {
      cb = options;
    } else {
      opts = options ?? {};
      cb = callback!;
    }

    const familyOpt =
      typeof opts.family === "number"
        ? opts.family
        : typeof opts.family === "string"
          ? parseInt(opts.family, 10) || 0
          : 0;

    try {
      if (opts.all) {
        const results = pinned
          .map((address) => ({
            address,
            family: net.isIP(address) as 4 | 6,
          }))
          .filter((c) => familyOpt === 0 || c.family === familyOpt);

        if (results.length === 0) {
          const err = new PinLookupError(
            "No approved address matches the requested address family"
          ) as NodeJS.ErrnoException;
          (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
            err,
            "",
            0
          );
          return;
        }

        (cb as unknown as (
          err: NodeJS.ErrnoException | null,
          addresses: LookupAddress[]
        ) => void)(null, results);
        return;
      }

      const selected = selectPinnedAddress(pinned, familyOpt);
      (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
        null,
        selected.address,
        selected.family
      );
    } catch (e) {
      const err =
        e instanceof PinLookupError
          ? (e as NodeJS.ErrnoException)
          : (new PinLookupError(
              e instanceof Error ? e.message : "Pinned lookup failed"
            ) as NodeJS.ErrnoException);
      (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
        err,
        "",
        0
      );
    }
  }) as LookupFunction;

  return pinnedLookup;
}

export type PinnedRequestMethod = "HEAD" | "GET";

/**
 * Builds http/https.request options that:
 *   - keep the original hostname for Host / TLS SNI / certificate checks
 *   - pin TCP connect via createPinnedLookup(approvedIps)
 *   - never disable TLS certificate validation
 *
 * Prefer this helper over hand-rolling request options in HEAD/GET fetchers.
 */
export function buildPinnedRequestOptions(args: {
  url: URL;
  method: PinnedRequestMethod;
  approvedIps: readonly string[];
  headers: HttpRequestOptions["headers"];
}): HttpRequestOptions {
  const lookup = createPinnedLookup(args.approvedIps);
  const isHttps = args.url.protocol === "https:";

  const options: HttpRequestOptions = {
    method: args.method,
    // Original hostname — drives Host header and (by default) TLS identity.
    hostname: args.url.hostname,
    port: args.url.port || undefined,
    path: `${args.url.pathname}${args.url.search}`,
    headers: args.headers,
    lookup,
  };

  // Explicit SNI: connect to the pinned IP while presenting the real hostname.
  // Certificate verification remains enabled (rejectUnauthorized defaults true).
  if (isHttps) {
    (options as HttpRequestOptions & { servername?: string }).servername =
      args.url.hostname;
  }

  return options;
}
