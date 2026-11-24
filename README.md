# URL Activity Scanner

A public prototype security utility that checks whether suspicious URLs appear active — without viewing, rendering, downloading, storing, or displaying website content.

**Live at:** [https://forgeforward.app/tools/url-activity-scanner](https://forgeforward.app/tools/url-activity-scanner)

---

## Table of Contents

1. [What This Tool Does](#what-this-tool-does)
2. [Using the Results Page](#using-the-results-page)
3. [What This Tool Does NOT Do](#what-this-tool-does-not-do)
4. [Data Handling and Privacy](#data-handling-and-privacy)
5. [Result Key](#result-key)
6. [Important Interpretation Notes](#important-interpretation-notes)
7. [Security Controls](#security-controls)
8. [Current Prototype Limits](#current-prototype-limits)
9. [Local Development](#local-development)
10. [Production Runtime](#production-runtime)
11. [Testing](#testing)
12. [Deployment Notes](#deployment-notes)
13. [Repository Safety](#repository-safety)
14. [License / Ownership](#license--ownership)

---

## What This Tool Does

The URL Activity Scanner performs a lightweight, server-side network check for each submitted URL or domain. The full pipeline for each URL is:

1. **Input normalization** — Plain domains (e.g. `example.com`) are prefixed with `https://` before processing.
2. **SSRF validation** — The URL is checked for scheme (only `http://` and `https://` are allowed), hostname safety (localhost and `.local`/`.internal` suffixes are blocked), and IP address safety. Private, loopback, link-local, cloud metadata, multicast, and reserved IPv4 and IPv6 ranges are blocked before any network request is made.
3. **DNS resolution** — The hostname is resolved using the server's system resolver. Every returned IP address (A and AAAA records) is independently checked against the SSRF blocklist. If any single resolved IP is unsafe, the URL is blocked. The addresses that pass become the only addresses the scanner may connect to for that hostname.
4. **HEAD request** — A single HTTP `HEAD` request is sent. The connection is pinned to the addresses approved in step 3 (see [DNS Pinning](#dns-pinning)). The response body is destroyed immediately and is never read or stored. Only the status code and redirect `Location` header are used.
5. **GET fallback** — If and only if the server responds with `405 Method Not Allowed` or `501 Not Implemented`, a controlled `GET` request is sent to the same URL, pinned to the same approved addresses. The response body is destroyed immediately — nothing is read. This is the only case where GET is used.
6. **Redirect handling** — Redirects are followed manually, up to a maximum of 3 hops. Each redirect destination is independently re-validated (SSRF check + DNS check) before the next request is sent, and that hop's connection is pinned to its own newly approved addresses.
7. **Result mapping** — The raw network outcome is mapped to one of the eleven user-facing result strings (see [Result Key](#result-key)) plus a human-readable meaning, notes, and a timestamp.
8. **Browser display** — Results are displayed temporarily in the browser (see [Using the Results Page](#using-the-results-page)). No result is saved to a database or server log.
9. **CSV export** — The user can export the currently visible results as a CSV file, generated entirely in the browser. The server never generates or stores the CSV.

Each batch has a server-side deadline (120 seconds). If the deadline is reached, the server stops the batch's remaining work and returns a timeout error (see [Batch Deadline Cancellation](#batch-deadline-cancellation)).

---

## Using the Results Page

The page is designed primarily for desktop use and remains usable on narrow and mobile screens.

- **Submitting a scan.** While a scan runs, the URL box and the Scan button are disabled, which also prevents duplicate submissions. Keyboard focus moves to a progress message stating how many URLs are being scanned, so it is not lost. There is no Cancel button: a running scan cannot be stopped from the page and ends when the server responds.
- **When results arrive,** focus moves to the "Results — N URLs" heading and the results scroll into view. If you moved focus elsewhere during the scan, focus and scroll position are left alone and a status message announces that results are available.
- **When a scan fails** (validation, rate limit, batch timeout, or a network error), the error message is shown and announced, and focus returns to the Scan button.
- **Classification counts.** A summary above the results shows how many URLs received each of the eleven results, including results with a count of zero.
- **Result rows.** On wider screens, each URL is one dense row: number, result and its check time ("Checked at", UTC), the submitted URL plus any normalized URL or redirect destination, and the result's meaning and notes. On narrow screens the same information is shown as stacked cards. Every result keeps its own timestamp. URLs are displayed as plain text and are never clickable.
- **Result key.** The complete, fully expanded result key is always shown. It sits below the form before a scan and after the results once results exist, and "Result key ↓" and "↑ Back to results" links move between the two.
- **CSV export.** The "Export CSV" button sits in the results toolbar next to the results heading and is reachable by keyboard. The toolbar stays visible while you scroll through the results. A note under the toolbar explains that the file is generated in your browser.
- **Visual accessibility.** Text and controls use accessible contrast, focus indicators are always visible for keyboard users, results are never conveyed by color alone, and smooth scrolling is disabled when the operating system requests reduced motion.

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

### DNS Pinning

Validation and connection use the same addresses, which closes the DNS-rebinding window between checking an address and connecting to it.

- Every outbound HEAD and GET connection uses a pinned lookup that returns only the addresses approved by the DNS safety check. Node.js does not resolve the hostname again at connect time, so a different (for example, private) answer served later cannot be used.
- The original hostname is still used for the `Host` header, TLS SNI and certificate verification. Only the network peer is pinned.
- Pinning fails closed. If the approved set is empty or malformed, or no approved address matches the requested address family, no connection is made. Each approved address is checked against the SSRF blocklist again before use.
- Approved addresses are never reused across hostnames. The initial GET fallback reuses the HEAD request's final approved set, and every redirect hop uses its own newly resolved and approved set.

### Redirect Safety

- Redirects are followed manually (automatic redirect following is disabled).
- Every redirect destination is independently re-validated (scheme, hostname, IP) and re-resolved (DNS) before the next request is sent, and the connection for that hop is pinned to its own approved addresses.
- Maximum redirect chain length: **3 hops**.
- A redirect to a private or blocked destination immediately terminates the chain.

### Batch Deadline Cancellation

This is **server-side cancellation when the batch deadline is reached**. It is not user-initiated: the page has no Cancel button, and users cannot stop a scan that is running.

- Each batch runs under one server-side deadline (`maxBatchRuntimeMs`, 120 seconds). When the deadline is reached, a single batch-wide cancellation signal is raised.
- Queued URLs that have not started are not started.
- In-flight HEAD and GET requests have their sockets destroyed.
- DNS lookups that are still pending stop being awaited. Node.js cannot cancel an in-flight DNS query, so a late answer is ignored and never leads to IP checks or a connection.
- The API responds with `408` and error code `BATCH_TIMEOUT`. No partial results from the timed-out batch are returned, and the page shows the timeout message.
- The 10-second timeout per request hop (see [Current Prototype Limits](#current-prototype-limits)) still applies within the batch deadline.

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
| Per-hop timeout | The 10-second timeout applies per individual request hop, not to the entire redirect chain. A chain with 3 redirects could theoretically run up to 40 seconds for one URL. The 120-second batch deadline bounds the batch as a whole. |
| No user-initiated cancellation | Only the server-side batch deadline cancels work. The page has no Cancel button; closing or leaving the page does not stop a batch that is already running on the server. |
| No partial results on timeout | When the batch deadline is reached, the response is a `BATCH_TIMEOUT` error. Results already completed in that batch are discarded. Smaller batches avoid this. |
| DNS query cancellation | Node.js cannot cancel an in-flight DNS query. After the deadline the application stops waiting for it and ignores the late answer, but the query itself completes in the background. |
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
npm ci
```

`npm ci` installs the exact versions recorded in `package-lock.json`.

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

### Run tests, type check and build

```bash
npm test            # or: npx jest --ci
npx tsc --noEmit
npm run build
```

> **Lint:** `npm run lint` currently fails. The script calls `next lint`, which Next.js 16 no longer provides, so the command exits with an "Invalid project directory" error instead of linting. This is known technical debt; do not treat the lint script as a passing check.

---

## Production Runtime

| Setting | Value |
|---|---|
| Framework | Next.js (App Router) |
| Node.js version | 20+ |
| Bind address | `127.0.0.1` (loopback only) |
| Port | `3002` |
| Start command | `npm run start -- -p 3002` (the `start` script is `next start --hostname 127.0.0.1`) |
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

Tests mock all network and DNS access; the suite never contacts external hosts. Type checking (`npx tsc --noEmit`) and the production build (`npm run build`) are the other required checks. The lint script is not currently usable (see [Local Development](#run-tests-type-check-and-build)).

Tests cover:

| Area | What is tested |
|---|---|
| URL validation (`validateUrl.ts`) | Scheme enforcement, private IP ranges, IPv4/IPv6/mapped formats, hostname blocklist |
| DNS resolution (`resolveDns.ts`) | Gate behavior, every-IP checking, DNS failure, blocked resolved IPs, cancellation and ignored late answers |
| DNS pinning (`pinnedLookup.ts`) | Only approved addresses returned, no fallback to unrestricted DNS, fail-closed on empty, malformed or family-mismatched sets |
| DNS rebinding (`dnsRebindingPinning.test.ts`) | Initial and redirect-hop rebinding for HEAD and GET; private rebind addresses never used; redirect cap retained |
| Cancellation (`cancellation.ts`) | Abort error identity, abort checks, ignoring late completion after abort |
| HEAD request engine (`headRequest.ts`) | Method enforcement, redirect cap, re-validation at each hop, timeout, body non-consumption, socket destruction on cancellation |
| GET fallback (`getFallback.ts`) | Trigger only on 405/501, body non-consumption, redirect safety, pinned connections |
| Result mapper (`resultMapper.ts`) | All 11 result codes, 503 CDN note, no overclaiming wording |
| Rate limiter (`rateLimiter.ts`) | Per-IP limit, global limit, batch size limit, window behavior |
| Batch handler (`batchScan.ts`) | Pipeline ordering, concurrency, deadline cancellation (no queued starts after the deadline, no HEAD or GET after a late DNS answer), error isolation |
| API route (`route.ts`) | Method gate, JSON parsing, IP forwarding, error shapes |
| UI page (`page.test.tsx`) | Form behavior, result display, result key, no clickable URLs, no storage, CSV export |
| Results experience (`pageResultsExperience.test.tsx`) | Classification counts, result rows and timestamps, result-key navigation, loading focus, completion and error focus recovery, announcements, duplicate-submission prevention, reduced motion |
| Result presentation (`scanPresentation.ts`) | Classification count summaries, retry-wait formatting, API error messages |
| CSV export (`csvExport.ts`) | Privacy notice, 7-field output, RFC 4180 escaping, filename format |
| Privacy notices | Wording accuracy, absence of overclaiming phrases |

**Current test count:** 508 passing, 0 failing (14 suites), with `npx tsc --noEmit` and `npm run build` succeeding.

---

## Deployment Notes

### Existing deployment configuration

These facts describe the current production setup:

- Production runs `next start` from the production checkout's own `.next` build directory, managed by PM2 under the process name `url-activity-scanner`. PM2 file watching is not enabled.
- There is no CI/CD pipeline. The repository has no GitHub Actions workflow, webhook, deploy key or deployment environment that builds or restarts production. The intended path to production is a build in the production checkout followed by a PM2 restart. Before relying on "push does not deploy", also check the installed GitHub Apps and any agent automations connected to the repository; repository settings alone do not show those.
- The previous instructions were to run `npm run build` in the production directory and then `pm2 restart url-activity-scanner`. That works, but it rebuilds `.next` underneath the running server. Until the restart, the running process can serve mismatched or missing assets, and a failed build can leave no usable build behind. Avoid it unless there is a backup and a planned window.
- A Next.js build records its absolute project path (for example in `.next/required-server-files.json`). A build created in another directory has not been verified to run from the production directory, so do not copy `.next` between checkouts.
- Restarting resets the in-memory rate-limit counters.

### Proposed safer release procedure (not yet exercised in production)

The procedure below is recommended for the next release. It has **not yet been carried out against production**. Each production step needs the owner's explicit authorization and should be verified as it is performed.

**Staged verification (no production impact):**

1. In a separate clone at the release commit, run `npm ci`, `npm test`, `npx tsc --noEmit` and `npm run build`.
2. Run `npm start -- -p <free port>` on `127.0.0.1` only, and check the UI in a browser with the scan API mocked. Never run real scans as part of verification.

**Production steps (require authorization):**

1. **Back up** the current build and source state: copy `.next` to a dated rollback directory, archive any uncommitted source files, and record `git rev-parse HEAD` and the PM2 process description.
2. **Update the source** with a fast-forward only (`git fetch` then `git merge --ff-only origin/main`). If uncommitted local changes block the update, confirm they are already in the release commit and that the backup has them, then resolve them deliberately. Never stash or discard them blindly.
3. **Install dependencies** with `npm ci`, but only if `package-lock.json` changed.
4. **Build** with `npm run build` during a quiet period. If the build fails, restore the backed-up `.next` before doing anything else.
5. **Restart** with `pm2 restart url-activity-scanner`. Run `pm2 save` only if the process definition changed.
6. **Verify:**
   - the loopback binding (below);
   - `pm2 status`;
   - HTTP 200 on the public page and its static assets;
   - a new build ID in `.next/BUILD_ID`;
   - a browser check against the live page with the scan API mocked;
   - `pm2 logs url-activity-scanner` for errors.

**Rollback (require authorization):**

1. Restore the backed-up `.next` directory and the previous source state (`git checkout <previous HEAD>`, then restore any archived uncommitted files).
2. Run `pm2 restart url-activity-scanner`.
3. Confirm that `.next/BUILD_ID` matches the backed-up build and that the checks above pass.

### Verifying the loopback binding

```bash
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
