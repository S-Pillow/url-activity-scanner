# URL Activity Scanner

A public prototype security utility that checks whether suspicious URLs appear active — without viewing, rendering, downloading, storing, or displaying website content.

**Live at:** [https://forgeforward.app/tools/url-activity-scanner](https://forgeforward.app/tools/url-activity-scanner)

---

## Table of Contents

1. [What This Tool Does](#what-this-tool-does)
2. [What This Tool Does NOT Do](#what-this-tool-does-not-do)
3. [Data Handling and Privacy](#data-handling-and-privacy)
4. [Result Key](#result-key)
5. [Important Interpretation Notes](#important-interpretation-notes)
6. [Security Controls](#security-controls)
7. [Current Prototype Limits](#current-prototype-limits)
8. [Local Development](#local-development)
9. [Production Runtime](#production-runtime)
10. [Testing](#testing)
11. [Deployment Notes](#deployment-notes)
12. [Repository Safety](#repository-safety)
13. [License / Ownership](#license--ownership)

---

## What This Tool Does

The URL Activity Scanner performs a lightweight, server-side network check for each submitted URL or domain. The full pipeline for each URL is:

1. **Input normalization** — Plain domains (e.g. `example.com`) are prefixed with `https://` before processing.
2. **SSRF validation** — The URL is checked for scheme (only `http://` and `https://` are allowed), hostname safety (localhost and `.local`/`.internal` suffixes are blocked), and IP address safety. Private, loopback, link-local, cloud metadata, multicast, and reserved IPv4 and IPv6 ranges are blocked before any network request is made.
3. **DNS resolution** — The hostname is resolved using the server's system resolver. Every returned IP address (A and AAAA records) is independently checked against the SSRF blocklist. If any single resolved IP is unsafe, the URL is blocked.
4. **HEAD request** — A single HTTP `HEAD` request is sent. The response body is destroyed immediately and is never read or stored. Only the status code and redirect `Location` header are used.
5. **GET fallback** — If and only if the server responds with `405 Method Not Allowed` or `501 Not Implemented`, a controlled `GET` request is sent to the same URL. The response body is destroyed immediately — nothing is read. This is the only case where GET is used.
6. **Redirect handling** — Redirects are followed manually, up to a maximum of 3 hops. Each redirect destination is independently re-validated (SSRF check + DNS check) before the next request is sent.
7. **Result mapping** — The raw network outcome is mapped to one of the eleven user-facing result strings (see [Result Key](#result-key)) plus a human-readable meaning, notes, and a timestamp.
8. **Browser display** — Results are displayed temporarily in the browser. No result is saved to a database or server log.
9. **CSV export** — The user can export the currently visible results as a CSV file, generated entirely in the browser. The server never generates or stores the CSV.

---

## What This Tool Does NOT Do

This tool deliberately omits all functionality that could expose content or make safety/legality determinations:

- Does **not** render webpages or use a browser engine
- Does **not** execute JavaScript
- Does **not** take screenshots
- Does **not** preview content
- Does **not** read, buffer, or display response bodies
- Does **not** fetch favicons, page titles, or thumbnails
- Does **not** follow `<meta>` redirects or JavaScript-driven navigation
- Does **not** classify content
- Does **not** determine whether a URL is malicious or safe
- Does **not** determine whether a URL contains illegal content
- Does **not** use threat intelligence APIs or reputation services
- Does **not** send submitted URLs to any third-party service
- Does **not** save scan history
- Does **not** store submitted URLs or scan results in a database
- Does **not** make submitted URLs, normalized URLs, or redirect destinations clickable

---

## Data Handling and Privacy

**Temporary results only.** Scan results are stored only in the browser component's in-memory state. Refreshing the page or navigating away permanently clears all visible results from the browser.

**No server-side storage.** The application is designed not to intentionally store submitted URLs or scan results in any database, file, or persistent log.

**CSV export is client-side.** When you click "Export CSV," the file is assembled in your browser from the results currently shown on the page. The server does not generate, receive, or save the CSV file.

**Infrastructure logging.** Infrastructure components (nginx, PM2, the operating system) may record standard request metadata such as request paths (`POST /api/scan`), IP addresses, status codes, and timestamps in their own logs. These are standard operational logs that do not contain the POST body (submitted URLs are in the POST body, which nginx does not log by default). The application itself does not log submitted URLs, scan results, or response content.

**No overclaim.** This documentation does not claim that "nothing is ever logged anywhere." Standard infrastructure access logs exist. If your use case requires verifying the full logging posture of the hosting infrastructure (nginx config, PM2 log rotation, OS-level logging), that review is a separate operational task.

---

## Result Key

| Result | Meaning |
|---|---|
| **200 OK** | Content likely exists |
| **301/302 Redirect** | URL redirects somewhere active |
| **403 Forbidden** | Server exists, but access is blocked |
| **404 Not Found** | No content at that path |
| **410 Gone** | Content used to exist but is gone |
| **Timeout** | Server did not respond to the scanner request |
| **DNS failure** | Domain does not resolve |
| **Connection refused** | Host exists but service may be down |
| **Blocked** | URL points to a private, internal, unsupported, or unsafe destination |
| **Server error** | Server or CDN responded with an error to this scanner request |
| **Unknown** | The URL responded in an unexpected way |

---

## Important Interpretation Notes

- **A browser loading a site does not guarantee the scanner will receive `200 OK`.** Sites that work normally in a browser may return `403`, `503`, or `Timeout` to a non-browser scanner request. This does not mean the site is broken.

- **CDN and bot-protection systems may reject scanner requests.** A `503` or `Server error` result for a major website (such as Netflix) may mean the CDN or bot-protection system rejected the non-browser request — not that the site is offline.

- **HEAD and GET scanner requests are not equivalent to browser requests.** The scanner sends minimal headers and does not send cookies, session tokens, JavaScript, or browser fingerprinting signals. Sites that require these to function may return unexpected results.

- **Scanner results are not safety or legality determinations.** A `200 OK` does not mean a URL is safe, and a `Blocked` result does not mean the URL contains illegal content. This tool reports network activity only.

- **`Blocked` means the destination is not scannable.** A `Blocked` result means the URL targets a private, loopback, internal, link-local, reserved, or unsupported-protocol address. It does not mean the user did anything wrong.

---

## Security Controls

The following controls are enforced server-side, before any network request reaches an external host:

### SSRF Protection

- Only `http://` and `https://` URLs are accepted. All other schemes (`ftp://`, `javascript:`, `data:`, `file://`, etc.) are rejected.
- Blocked IPv4 ranges: `127.0.0.0/8` (loopback), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918 private), `169.254.0.0/16` (link-local / cloud metadata), `0.0.0.0/8`, `100.64.0.0/10` (CGNAT), `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24` (documentation), `224.0.0.0/4` (multicast), `240.0.0.0/4` (reserved), `255.255.255.255/32` (broadcast).
- Blocked IPv6 ranges: `::/128`, `::1/128` (loopback), `fc00::/7` (unique local), `fe80::/10` (link-local), `ff00::/8` (multicast), `2001:db8::/32` (documentation), and IPv4-mapped equivalents of all blocked IPv4 ranges (`::ffff:127.0.0.0/104`, `::ffff:10.0.0.0/104`, `::ffff:172.16.0.0/108`, `::ffff:192.168.0.0/112`, `::ffff:169.254.0.0/112`).
- The cloud metadata endpoint `169.254.169.254` is explicitly blocked by exact match as well as CIDR.
- Non-standard IPv4 formats (hex `0x7f000001`, octal `0177.0.0.1`, integer `2130706433`) are normalized by the WHATWG URL parser to dotted-decimal before the IP check runs.
- Blocked hostnames: `localhost`, `localhost.localdomain`, `metadata.google.internal`, and any hostname ending in `.localhost`, `.localdomain`, `.local`, or `.internal`.
- IP safety logic is shared between the URL validation layer (pre-DNS) and the DNS resolution layer (post-DNS), preventing parity gaps.

### DNS Safety

- Both A (IPv4) and AAAA (IPv6) records are resolved concurrently.
- Every resolved IP address is checked against the full SSRF blocklist.
- If any single resolved IP is unsafe, the entire URL is blocked — split-horizon DNS attacks are mitigated.
- The system resolver (`dns.promises`) is used. No third-party DNS service is queried.
- DNS results are not cached by the application.

### Redirect Safety

- Redirects are followed manually (automatic redirect following is disabled).
- Every redirect destination is independently re-validated (scheme, hostname, IP) and re-resolved (DNS) before the next request is sent.
- Maximum redirect chain length: **3 hops**.
- A redirect to a private or blocked destination immediately terminates the chain.

### Request Safety

- **HEAD first.** Only `HEAD` requests are sent in the initial pass.
- **GET fallback only on 405/501.** A `GET` request is sent only when `HEAD` receives `405 Method Not Allowed` or `501 Not Implemented`. Any other HEAD outcome (200, 301, 403, 404, 5xx, timeout, etc.) does not trigger GET.
- **No response body is ever read.** The `res.destroy()` call is invoked immediately upon receiving the response headers. The body stream is never consumed.
- **No cookies, auth headers, referrer, or fingerprinting headers** are sent.

### Rate Limiting

- Per-IP limit: **20 batch requests per hour** (fixed window).
- Global limit: **200 batch requests per hour** across all IPs combined.
- Batch size limit: **100 URLs per batch**.
- Concurrency: **5 URLs scanned simultaneously** within a batch.
- Batch timeout: **120 seconds** per batch request.

### Infrastructure

- The Next.js application binds to `127.0.0.1:3002` only — not accessible externally.
- All public traffic is proxied through nginx over HTTPS.
- nginx enforces HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `Permissions-Policy`.

---

## Current Prototype Limits

This tool is a **public unauthenticated prototype**. The following known limitations apply:

| Limitation | Detail |
|---|---|
| In-memory rate limiter | Rate-limit counters reset when the PM2 process restarts (e.g. on deploy). |
| Not shared across instances | The rate limiter lives in process memory — multiple server processes or serverless deployments would not share state. A Redis-backed limiter would be required for multi-instance use. |
| Fixed-window boundary burst | At the 1-hour window boundary, a burst of up to 2× the per-hour limit is briefly possible. A sliding-window or token-bucket design would prevent this. |
| Per-hop timeout | The 10-second timeout applies per individual request hop, not to the entire redirect chain. A chain with 3 redirects could theoretically run up to 40 seconds. |
| No AbortController cancellation | If a batch exceeds the 120-second timeout, the handler returns immediately but the underlying per-URL promises continue running in the Node.js event loop until they settle naturally. |
| Platform-wide CSP | The Content Security Policy is set server-wide by nginx and includes `'unsafe-eval'`, which is broader than strictly necessary for this tool. This is a platform-level concern. |
| No authentication | Any user can submit URLs. Rate limiting is the only access control. Future internal-only deployment behind authentication is possible. |

---

## Local Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
git clone https://github.com/S-Pillow/url-activity-scanner.git
cd url-activity-scanner
npm install
```

### Run in development mode

```bash
npm run dev
```

The app will be available at `http://localhost:3000`.

> **Note:** In development mode, `basePath` is still set to `/tools/url-activity-scanner` in `next.config.ts`. The app will be served at `http://localhost:3000/tools/url-activity-scanner`. If you need to run without the path prefix during development, temporarily comment out the `basePath` setting — but restore it before deploying.

### Build for production

```bash
npm run build
```

### Run production build locally

```bash
npm start
```

### Run tests

```bash
npm test
# or
npx jest --ci
```

---

## Production Runtime

| Setting | Value |
|---|---|
| Framework | Next.js (App Router) |
| Node.js version | 20+ |
| Bind address | `127.0.0.1` (loopback only) |
| Port | `3002` |
| Start command | `next start --hostname 127.0.0.1` |
| Process manager | PM2 |
| PM2 process name | `url-activity-scanner` |
| Reverse proxy | nginx |
| Public base path | `/tools/url-activity-scanner` |
| Public API path | `/tools/url-activity-scanner/api/scan` |

The `basePath` in `next.config.ts` must match the nginx `location` block prefix for routing to work correctly.

### PM2 management

```bash
# Check status
pm2 status

# Restart after a deploy
pm2 restart url-activity-scanner

# View logs
pm2 logs url-activity-scanner

# Save process list (persists across reboots)
pm2 save
```

---

## Testing

The test suite uses **Jest** with `ts-jest` and `@testing-library/react`.

```bash
npx jest --ci
```

Tests cover:

| Area | What is tested |
|---|---|
| URL validation (`validateUrl.ts`) | Scheme enforcement, private IP ranges, IPv4/IPv6/mapped formats, hostname blocklist |
| DNS resolution (`resolveDns.ts`) | Gate behavior, every-IP checking, DNS failure, blocked resolved IPs |
| HEAD request engine (`headRequest.ts`) | Method enforcement, redirect cap, re-validation at each hop, timeout, body non-consumption |
| GET fallback (`getFallback.ts`) | Trigger only on 405/501, body non-consumption, redirect safety |
| Result mapper (`resultMapper.ts`) | All 11 result codes, 503 CDN note, no overclaiming wording |
| Rate limiter (`rateLimiter.ts`) | Per-IP limit, global limit, batch size limit, window behavior |
| Batch handler (`batchScan.ts`) | Pipeline ordering, concurrency, timeout, error isolation |
| API route (`route.ts`) | Method gate, JSON parsing, IP forwarding, error shapes |
| UI page (`page.test.tsx`) | Form behavior, result display, result key, no clickable URLs, no storage, CSV export |
| CSV export (`csvExport.ts`) | Privacy notice, 7-field output, RFC 4180 escaping, filename format |
| Privacy notices | Wording accuracy, absence of overclaiming phrases |

**Current test count:** 411 passing, 0 failing.

---

## Deployment Notes

### After any source code change

```bash
# 1. Build
npm run build

# 2. Restart the PM2 process
pm2 restart url-activity-scanner

# 3. Verify the port is still bound to loopback only
ss -tlnp | grep 3002
```

Expected output of `ss -tlnp | grep 3002`:

```
LISTEN  0  511  127.0.0.1:3002  0.0.0.0:*
```

If you see `*:3002` or `0.0.0.0:3002`, the `--hostname 127.0.0.1` flag was not applied. Check the `start` script in `package.json`.

### nginx

nginx only needs to be reloaded if the proxy `location` blocks or SSL configuration change:

```bash
nginx -t && systemctl reload nginx
```

No nginx changes are required for routine scanner updates.

---

## Repository Safety

The following must **never** be committed to this repository:

| Category | Examples |
|---|---|
| Environment secrets | `.env`, `.env.local`, API keys, tokens, passwords |
| Build outputs | `.next/`, `dist/`, `out/` |
| Dependencies | `node_modules/` |
| Test coverage | `coverage/` |
| Logs | `*.log`, PM2 log files |
| CSV exports | `*.csv` — may contain sensitive submitted URLs |
| PM2 runtime files | `.pm2/`, `dump.pm2`, `ecosystem.config.js.bak` |
| Server configuration | nginx private configs, SSL certificates, private keys |
| Scan data | Real suspicious URL lists, scan result dumps |
| Temporary directories | `tmp/`, `temp/` |

All of the above are excluded by `.gitignore`. Before any commit, verify with:

```bash
git status
git diff --staged --name-only
```

---

## License / Ownership

**License:** TBD

**Owner:** Steven Pillow / [S-Pillow](https://github.com/S-Pillow)

**GitHub repository:** [https://github.com/S-Pillow/url-activity-scanner](https://github.com/S-Pillow/url-activity-scanner)
