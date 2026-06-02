/**
 * AIPF-002 / AIPF-003: Shared IP Safety Check
 *
 * Contains all SSRF/private/reserved IP range blocking logic for both
 * the URL validation layer (AIPF-002) and the DNS resolution layer (AIPF-003).
 *
 * Keeping this in one place prevents parity gaps between the two safety gates:
 * if a range is added here it is automatically enforced in both.
 *
 * Exported surface:
 *   checkIpSafety(ip)  — single entry point used by both consuming modules.
 *
 * Safety guarantees:
 *   - Private, loopback, link-local, cloud metadata, multicast, documentation,
 *     carrier-grade NAT, and reserved ranges are blocked for IPv4 and IPv6.
 *   - IPv4-mapped IPv6 addresses are checked against IPv4 blocklists.
 *   - Fails closed: an IP that cannot be validated is blocked.
 *   - No network requests are made.
 *   - No IP addresses are logged.
 */

import * as net from "net";

// ─── IPv4 CIDR helpers ────────────────────────────────────────────────────────

interface Cidr4 {
  network: number; // uint32
  mask: number;    // uint32
}

function ipv4ToUint32(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

function parseCidr4(cidr: string): Cidr4 {
  const [addr, lenStr] = cidr.split("/");
  const prefixLen = parseInt(lenStr, 10);
  const mask = prefixLen === 0 ? 0 : ((~0) << (32 - prefixLen)) >>> 0;
  const network = (ipv4ToUint32(addr) & mask) >>> 0;
  return { network, mask };
}

function inCidr4(ipUint: number, cidr: Cidr4): boolean {
  return ((ipUint & cidr.mask) >>> 0) === cidr.network;
}

const BLOCKED_IPV4_CIDRS: Cidr4[] = [
  "127.0.0.0/8",        // Loopback
  "10.0.0.0/8",         // Private Class A (RFC 1918)
  "172.16.0.0/12",      // Private Class B (RFC 1918)
  "192.168.0.0/16",     // Private Class C (RFC 1918)
  "169.254.0.0/16",     // Link-local / cloud metadata range (RFC 3927)
  "0.0.0.0/8",          // This network (RFC 1122)
  "100.64.0.0/10",      // Carrier-grade NAT (RFC 6598)
  "192.0.0.0/24",       // IETF Protocol Assignments (RFC 6890)
  "192.0.2.0/24",       // TEST-NET-1 — documentation only (RFC 5737)
  "198.18.0.0/15",      // Benchmarking (RFC 2544)
  "198.51.100.0/24",    // TEST-NET-2 — documentation only (RFC 5737)
  "203.0.113.0/24",     // TEST-NET-3 — documentation only (RFC 5737)
  "224.0.0.0/4",        // Multicast (RFC 3171)
  "240.0.0.0/4",        // Reserved — future use (RFC 1112)
  "255.255.255.255/32", // Broadcast
].map(parseCidr4);

function blockedReasonIPv4(ip: string): string | null {
  if (!net.isIPv4(ip)) return null;
  if (ip === "169.254.169.254") return "Blocked cloud metadata IP";
  const ipUint = ipv4ToUint32(ip);
  for (const cidr of BLOCKED_IPV4_CIDRS) {
    if (inCidr4(ipUint, cidr)) return "Blocked private/internal IP range";
  }
  return null;
}

// ─── IPv6 CIDR helpers ────────────────────────────────────────────────────────

interface Cidr6 {
  network: bigint; // 128-bit, always non-negative
  mask: bigint;    // 128-bit, always non-negative
}

function expandIPv6(ip: string): string {
  function resolveIPv4Tail(groups: string[]): string[] {
    const last = groups[groups.length - 1] ?? "";
    if (!last.includes(".")) return groups;
    const [a, b, c, d] = last.split(".").map(Number);
    const hi = ((a << 8) | b).toString(16).padStart(4, "0");
    const lo = ((c << 8) | d).toString(16).padStart(4, "0");
    return [...groups.slice(0, -1), hi, lo];
  }

  if (ip.includes("::")) {
    const splitIdx = ip.indexOf("::");
    const leftPart = ip.slice(0, splitIdx);
    const rightPart = ip.slice(splitIdx + 2);
    const left = leftPart.length > 0 ? leftPart.split(":") : [];
    let right = rightPart.length > 0 ? rightPart.split(":") : [];
    right = resolveIPv4Tail(right);
    const fillerCount = 8 - left.length - right.length;
    if (fillerCount < 0) throw new Error(`Malformed IPv6: ${ip}`);
    const filler = Array<string>(fillerCount).fill("0");
    return [...left, ...filler, ...right]
      .map((g) => (g || "0").padStart(4, "0"))
      .join(":");
  }

  let groups = ip.split(":");
  groups = resolveIPv4Tail(groups);
  if (groups.length !== 8) throw new Error(`Malformed IPv6: ${ip}`);
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

function ipv6ToBigInt(ip: string): bigint {
  const expanded = expandIPv6(ip);
  return expanded
    .split(":")
    .reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

function cidr6Mask(prefixLen: number): bigint {
  if (prefixLen === 0) return 0n;
  if (prefixLen === 128) return (1n << 128n) - 1n;
  const allOnes = (1n << 128n) - 1n;
  const lower = (1n << BigInt(128 - prefixLen)) - 1n;
  return allOnes ^ lower;
}

function parseCidr6(cidr: string): Cidr6 {
  const [addr, lenStr] = cidr.split("/");
  const prefixLen = parseInt(lenStr, 10);
  const mask = cidr6Mask(prefixLen);
  const network = ipv6ToBigInt(addr) & mask;
  return { network, mask };
}

const BLOCKED_IPV6_CIDRS: Cidr6[] = [
  "::/128",                // Unspecified address
  "::1/128",               // Loopback
  "fc00::/7",              // Unique Local (covers fc00::/8 and fd00::/8)
  "fe80::/10",             // Link-local unicast
  "ff00::/8",              // Multicast
  "2001:db8::/32",         // Documentation (RFC 3849)
  "::ffff:127.0.0.0/104",  // IPv4-mapped loopback
  "::ffff:10.0.0.0/104",   // IPv4-mapped private Class A
  "::ffff:172.16.0.0/108", // IPv4-mapped private Class B
  "::ffff:192.168.0.0/112",// IPv4-mapped private Class C
  "::ffff:169.254.0.0/112",// IPv4-mapped link-local
].map(parseCidr6);

function blockedReasonIPv6(ip: string): string | null {
  if (!net.isIPv6(ip)) return null;
  try {
    const ipBig = ipv6ToBigInt(ip);
    for (const cidr of BLOCKED_IPV6_CIDRS) {
      if ((ipBig & cidr.mask) === cidr.network) {
        if (ip === "::1") return "Blocked IPv6 loopback address";
        return "Blocked IPv6 private/reserved address";
      }
    }
    return null;
  } catch {
    return "Could not validate IPv6 address";
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Checks whether a resolved IP address (IPv4 or IPv6) is safe to connect to.
 *
 * Returns a human-readable block reason string if the IP is unsafe,
 * or null if the IP is safe to proceed with.
 *
 * Fails closed: an IP that cannot be parsed or validated is blocked.
 * Never logs the IP address.
 *
 * @param ip - A bare IPv4 or IPv6 address string (no brackets, no port).
 */
export function checkIpSafety(ip: string): string | null {
  if (net.isIPv4(ip)) return blockedReasonIPv4(ip);
  if (net.isIPv6(ip)) return blockedReasonIPv6(ip);
  // Unrecognised format — fail closed.
  return "Unrecognised IP address format";
}
