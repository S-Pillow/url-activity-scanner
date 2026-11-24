/**
 * URL Activity Scanner — UI Page
 *
 * Route: /  (basePath: /tools/url-activity-scanner)
 * Served at: https://forgeforward.app/tools/url-activity-scanner
 *
 * This file is the root page of the standalone Next.js scanner app.
 * It replaces the former tools-directory home page (AIPF-009) which is
 * now handled by the ForgeForward Vite/React app at /var/www/dns-tool/.
 *
 * Integration notes:
 *   - basePath '/tools/url-activity-scanner' is set in next.config.ts so
 *     all routes, API paths, and static assets resolve under that prefix.
 *   - The "All tools" back link uses a plain <a> (not Next.js <Link>) to
 *     navigate outside this app to https://forgeforward.app/tools.
 *   - The API endpoint is /tools/url-activity-scanner/api/scan which nginx
 *     proxies to port 3002; Next.js then strips the basePath and routes to
 *     src/app/api/scan/route.ts.
 *
 * Assumption A-AIPF009-02 — Client component:
 *   The page is a React Client Component because it manages interactive
 *   form state, loading state, and API response state.
 *
 * Assumption A-AIPF009-03 — Frontend batch limit:
 *   MAX_URLS_PER_BATCH (100) must match backend maxUrlsPerBatch (AIPF-007).
 *   Backend enforcement is authoritative.
 *
 * Assumption A-AIPF009-04 — Blank lines:
 *   Blank lines are silently filtered before submission.
 *
 * Assumption A-AIPF009-05 — Result display:
 *   Results are plain text; no anchor tags. AIPF-010 owns the final table.
 *
 * Safety guarantee:
 *   No submitted URL or result is written to localStorage, sessionStorage,
 *   cookies, IndexedDB, or any database.
 */
"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import styles from "./page.module.css";
import { buildCsv, buildCsvFilename } from "./csvExport";
import type { ScanResult } from "./csvExport";
import { formatApiError, summarizeResults } from "./scanPresentation";

// ─── Result key entries ───────────────────────────────────────────────────────

/**
 * The canonical AIPF-001 result key.
 * Must stay in sync with RESULT_KEY / MEANINGS in resultMapper.ts.
 * Used to render the result legend on the page (client-side only).
 *
 * A-AIPF010-01: Color is not the sole indicator of result type.
 *   Every badge also shows the result text.
 */
// AIPF-006B/010B: Server error and Timeout meanings updated to reflect that
// results describe the scanner's interaction, not the site's overall health.
const RESULT_KEY_ENTRIES = [
  { result: "200 OK",             meaning: "Content likely exists"                                                  },
  { result: "301/302 Redirect",   meaning: "URL redirects somewhere active"                                         },
  { result: "403 Forbidden",      meaning: "Server exists, but access is blocked"                                   },
  { result: "404 Not Found",      meaning: "No content at that path"                                                },
  { result: "410 Gone",           meaning: "Content used to exist but is gone"                                      },
  { result: "Timeout",            meaning: "Server did not respond to the scanner request"                          },
  { result: "DNS failure",        meaning: "Domain does not resolve"                                                 },
  { result: "Connection refused", meaning: "Host exists but service may be down"                                    },
  { result: "Blocked",            meaning: "URL points to a private, internal, unsupported, or unsafe destination" },
  { result: "Server error",       meaning: "Server or CDN responded with an error to this scanner request"          },
  { result: "Unknown",            meaning: "The URL responded in an unexpected way"                                  },
] as const;

const CLASSIFICATIONS: ReadonlyArray<string> = RESULT_KEY_ENTRIES.map((e) => e.result);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function bringIntoView(focusTarget: HTMLElement | null, scrollTarget: HTMLElement | null) {
  if (!focusTarget) return;
  focusTarget.focus({ preventScroll: true });
  scrollTarget?.scrollIntoView?.({ block: "start", behavior: scrollBehavior() });
}

/**
 * Converts the backend ISO 8601 UTC timestamp into a locale-neutral
 * "YYYY-MM-DD HH:mm:ss UTC" string for clear audit-context display.
 *
 * A-AIPF010-02: UTC is used explicitly so that no timezone conversion
 * obscures the scan time. Falls back to the raw string on parse failure.
 */
function formatCheckedAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  );
}

/**
 * Maps a backend result string to its CSS-module badge variant class.
 *
 * Color categories (per AIPF-010 visual requirements):
 *   Green  → 200 OK
 *   Cyan   → 301/302 Redirect
 *   Amber  → 403 Forbidden, Connection refused, Blocked
 *   Red    → Timeout, DNS failure, Server error
 *   Gray   → 404, 410, Unknown
 */
function resultBadgeClass(result: string): string {
  switch (result) {
    case "200 OK":              return styles.resultBadgeOk;
    case "301/302 Redirect":    return styles.resultBadgeRedirect;
    case "403 Forbidden":
    case "Connection refused":
    case "Blocked":             return styles.resultBadgeWarning;
    case "Timeout":
    case "DNS failure":
    case "Server error":        return styles.resultBadgeError;
    default:                    return styles.resultBadgeNeutral;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Must match backend maxUrlsPerBatch (AIPF-007 DEFAULT_CONFIG).
 * A-AIPF009-03: Backend enforcement is authoritative.
 */
const MAX_URLS_PER_BATCH = 100;

/**
 * With basePath '/tools/url-activity-scanner', the browser requests
 * forgeforward.app/tools/url-activity-scanner/api/scan.
 * nginx proxies this to port 3002, where Next.js routes /api/scan to
 * src/app/api/scan/route.ts.
 */
const API_ENDPOINT = "/tools/url-activity-scanner/api/scan";

// ─── Types ────────────────────────────────────────────────────────────────────

// ScanResult is imported from ./csvExport (AIPF-011) to avoid duplication.
// ApiSuccess and ApiError are local; they wrap ScanResult for API responses.

interface ApiSuccess {
  ok: true;
  results: ScanResult[];
  limits: Record<string, number>;
}

interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    retryAfterSeconds: number | null;
  };
  limits: Record<string, number>;
}

type ApiResponse = ApiSuccess | ApiError;

// ─── Page component ───────────────────────────────────────────────────────────

export default function UrlActivityScannerPage() {
  const [urlInput, setUrlInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<ScanResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Polite status text, used only when focus does not already convey the
  // state: completion says just "Scan complete." when the focused results
  // heading announces the URL count.
  const [status, setStatus] = useState("");
  const [pendingFocus, setPendingFocus] = useState<"results" | "submit" | null>(null);
  // The loading message is shown before the controls are disabled and hidden
  // only after focus has left it, so a focused element is never disabled or
  // hidden (which would drop focus to <body>).
  const [progressVisible, setProgressVisible] = useState(false);
  const [loadingCount, setLoadingCount] = useState(0);

  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const loadingRef = useRef<HTMLParagraphElement>(null);
  const resultsSectionRef = useRef<HTMLElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const resultKeySectionRef = useRef<HTMLElement>(null);
  const resultKeyHeadingRef = useRef<HTMLHeadingElement>(null);
  const inFlightRef = useRef(false);
  const scrollToResultsRef = useRef(false);

  // True when focus is still where the scan left it (the form, the loading
  // message, or nowhere). False when the user has deliberately moved focus
  // elsewhere, which is then left alone.
  const focusIsInScanFlow = () => {
    const active = document.activeElement;
    return (
      !active ||
      active === document.body ||
      (formRef.current?.contains(active) ?? false)
    );
  };

  // Focus moves only after loading ends, when the target is enabled and rendered.
  useLayoutEffect(() => {
    if (pendingFocus === null || isLoading) return;
    const inFlow = focusIsInScanFlow();
    if (pendingFocus === "results") {
      if (inFlow) {
        resultsHeadingRef.current?.focus({ preventScroll: true });
        scrollToResultsRef.current = true;
        setStatus("Scan complete.");
      } else {
        const n = results?.length ?? 0;
        setStatus(`Scan complete. Results for ${n} URL${n !== 1 ? "s" : ""} are available.`);
      }
    } else if (inFlow) {
      submitRef.current?.focus({ preventScroll: true });
    }
    setProgressVisible(false);
    setPendingFocus(null);
  }, [pendingFocus, isLoading, results]);

  // Scroll only after the loading message is hidden, so the layout above the
  // results no longer shifts.
  useLayoutEffect(() => {
    if (progressVisible || !scrollToResultsRef.current) return;
    scrollToResultsRef.current = false;
    resultsSectionRef.current?.scrollIntoView?.({ block: "start", behavior: scrollBehavior() });
  }, [progressVisible]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inFlightRef.current) return;
    setError(null);
    setResults(null);
    setStatus("");

    const urls = urlInput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (urls.length === 0) {
      setError("Please enter at least one URL.");
      return;
    }
    if (urls.length > MAX_URLS_PER_BATCH) {
      setError(
        `Too many URLs. Please enter no more than ${MAX_URLS_PER_BATCH} at a time. ` +
        `(The backend limit is authoritative and may differ.)`
      );
      return;
    }

    inFlightRef.current = true;
    // The focused loading message announces itself; the live region speaks
    // only when the user is elsewhere.
    const moveFocus = focusIsInScanFlow();
    flushSync(() => {
      setLoadingCount(urls.length);
      setProgressVisible(true);
    });
    if (moveFocus) loadingRef.current?.focus({ preventScroll: true });
    setIsLoading(true);
    setStatus(
      moveFocus
        ? ""
        : `Scanning ${urls.length} URL${urls.length !== 1 ? "s" : ""}\u2026`
    );

    try {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });

      const data: ApiResponse = await response.json();

      if (data.ok) {
        setResults(data.results);
        setPendingFocus("results");
      } else {
        setError(
          formatApiError(
            data.error?.message ?? "An error occurred. Please try again.",
            data.error?.retryAfterSeconds ?? null
          )
        );
        setStatus("");
        setPendingFocus("submit");
      }
    } catch {
      setError(
        "Could not reach the scanner service. Please check your connection and try again."
      );
      setStatus("");
      setPendingFocus("submit");
    } finally {
      inFlightRef.current = false;
      setIsLoading(false);
    }
  };

  /**
   * AIPF-011: Client-side CSV export.
   *
   * Uses only the in-memory results already displayed on this page.
   * No server request is made. The Blob is created, linked, clicked, and
   * URL-revoked entirely in the browser.
   *
   * A-AIPF011-05: document.body.appendChild + .click() + removeChild is the
   *   standard cross-browser method for triggering a named file download.
   *   The anchor is added and removed synchronously so it never persists in
   *   the DOM after the handler returns.
   */
  const handleExport = () => {
    if (!results || results.length === 0) return;
    const csv = buildCsv(results);
    const filename = buildCsvFilename();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const summary = results !== null ? summarizeResults(results, CLASSIFICATIONS) : null;

  const jumpToResultKey = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    bringIntoView(resultKeyHeadingRef.current, resultKeySectionRef.current);
  };

  const jumpToResults = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    bringIntoView(resultsHeadingRef.current, resultsSectionRef.current);
  };

  /* ── Result key ───────────────────────────────────────────────────────────
     Always rendered and fully expanded. Placed directly below the form while
     there are no results, and after the results once they exist.
     A-AIPF010-01: Color is reinforced by text — never the sole signal. */
  const resultKey = (
    <section
      id="result-key"
      ref={resultKeySectionRef}
      aria-label="Result key"
      className={styles.resultKey}
    >
      <div className={styles.resultKeyHeader}>
        <h2
          id="result-key-heading"
          ref={resultKeyHeadingRef}
          tabIndex={-1}
          className={styles.resultKeyHeading}
        >
          Result key
        </h2>
        {results !== null && (
          <a href="#results-heading" className={styles.navLink} onClick={jumpToResults}>
            ↑ Back to results
          </a>
        )}
      </div>
      <ul className={styles.resultKeyList}>
        {RESULT_KEY_ENTRIES.map(({ result, meaning }) => (
          <li key={result} className={styles.resultKeyEntry}>
            <span className={`${styles.resultBadge} ${resultBadgeClass(result)}`}>
              {result}
            </span>
            <span className={styles.resultKeyMeaning}>{meaning}</span>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <main className={styles.main}>
      <div className={`${styles.card} ${results !== null ? styles.cardWide : ""}`}>
        <div className={styles.intro}>

          {/* ── Header ──────────────────────────────────────────────────────── */}
          <header className={styles.header}>
            {/*
             * Plain <a> navigates outside this Next.js app to the ForgeForward
             * tools page. Next.js <Link> is not used here because it would
             * prepend basePath, producing /tools/url-activity-scanner/tools.
             */}
            <a href="/tools" className={styles.backLink} aria-label="Back to all tools">
              ← All tools
            </a>
            <h1 className={styles.title}>URL Activity Scanner</h1>
            <p className={styles.tagline}>
              Check whether suspicious URLs appear active without viewing,
              rendering, downloading, or storing content.
            </p>
          </header>

          {/* ── Safety notice ────────────────────────────────────────────────── */}
          <div className={styles.notice} role="note">
            <p>
              <strong>Safety:</strong> This tool checks only basic network and
              HTTP response metadata. It does not render pages, execute scripts,
              preview content, download files, or save scan history.
            </p>
          </div>

          {/* ── Scan form ────────────────────────────────────────────────────── */}
          <form ref={formRef} onSubmit={handleSubmit} className={styles.form} noValidate>
            <label htmlFor="url-input" className={styles.label}>
              URLs to scan
            </label>

            <textarea
              id="url-input"
              className={styles.textarea}
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder={
                "Paste one URL per line...\nhttps://example.com\nsuspicious-domain.test/path"
              }
              rows={8}
              disabled={isLoading}
              aria-describedby={error ? "scan-error" : undefined}
              aria-label="URLs to scan, one per line"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
            />

            {error && (
              <p
                id="scan-error"
                role="alert"
                aria-live="assertive"
                className={styles.error}
              >
                {error}
              </p>
            )}

            <button
              ref={submitRef}
              type="submit"
              className={styles.button}
              disabled={isLoading}
              aria-busy={isLoading}
            >
              {isLoading ? "Scanning URLs safely\u2026" : "Scan URLs"}
            </button>

            {/* Focus destination while the controls above are disabled. */}
            <p
              ref={loadingRef}
              id="scan-progress"
              tabIndex={-1}
              hidden={!progressVisible}
              className={styles.loadingMessage}
            >
              Scan in progress: {loadingCount} URL{loadingCount !== 1 ? "s" : ""}. Results
              will appear when the scan finishes.
            </p>
          </form>

          <p role="status" aria-live="polite" className={styles.srOnly}>
            {status}
          </p>

          {results === null && resultKey}
        </div>

        {/* ── Results ──────────────────────────────────────────────────────────
            A-AIPF009-05: Plain <span> elements — never <a> tags.
            A-AIPF010-03: normalized_url is shown only when it differs from
              original_input to avoid displaying identical text twice.
            A-AIPF010-04: checked_at is formatted as YYYY-MM-DD HH:mm:ss UTC
              for unambiguous locale-neutral audit context. */}
        {results !== null && summary !== null && (
          <section
            ref={resultsSectionRef}
            aria-label="Scan results"
            className={styles.results}
          >
            {/* Sticky within the results section only, so it never covers the result key. */}
            <div className={styles.resultsToolbar}>
              <h2
                id="results-heading"
                ref={resultsHeadingRef}
                tabIndex={-1}
                className={styles.resultsTitle}
              >
                Results — {results.length} URL{results.length !== 1 ? "s" : ""}
              </h2>
              <div className={styles.toolbarActions}>
                <a href="#result-key" className={styles.navLink} onClick={jumpToResultKey}>
                  Result key ↓
                </a>
                {/*
                 * AIPF-011: Export button. Only rendered when results exist.
                 * Client-side download only — no server request is made.
                 */}
                <button
                  type="button"
                  onClick={handleExport}
                  className={styles.exportButton}
                >
                  Export CSV
                </button>
              </div>
            </div>
            {/*
             * A-AIPF012-02: Export notice includes the server-side
             * clarification required by AIPF-012 ("The server does not
             * generate or save the CSV file.").
             */}
            <p className={styles.exportHint}>
              CSV export is generated in your browser from the temporary results
              currently shown on this page. The server does not generate or save
              the CSV file.
            </p>

            {/* Counts derived from the returned results; all 11 classifications, zeros included. */}
            <div className={styles.summary}>
              <h3 id="summary-heading" className={styles.summaryHeading}>
                Classification counts
              </h3>
              <dl className={styles.summaryList} aria-labelledby="summary-heading">
                {summary.counts.map(({ result, count }) => (
                  <div
                    key={result}
                    className={`${styles.summaryItem} ${count === 0 ? styles.summaryItemZero : ""}`}
                  >
                    <dt>
                      <span
                        className={`${styles.resultBadge} ${
                          count === 0 ? styles.resultBadgeNeutral : resultBadgeClass(result)
                        }`}
                      >
                        {result}
                      </span>
                    </dt>
                    <dd className={styles.summaryCount}>{count}</dd>
                  </div>
                ))}
                {summary.unrecognized > 0 && (
                  <div className={styles.summaryItem}>
                    <dt>
                      <span className={`${styles.resultBadge} ${styles.resultBadgeNeutral}`}>
                        Unrecognized result
                      </span>
                    </dt>
                    <dd className={styles.summaryCount}>{summary.unrecognized}</dd>
                  </div>
                )}
              </dl>
            </div>

            <div className={styles.columnHeader} aria-hidden="true">
              <span>#</span>
              <span>Result · Checked at</span>
              <span>URL</span>
              <span>Meaning</span>
            </div>
            <ol className={styles.resultList} aria-label="Scan results list">
              {results.map((r, index) => (
                <li key={index} className={styles.resultItem}>
                  <span className={styles.resultIndex} aria-hidden="true">
                    {index + 1}
                  </span>

                  <div className={styles.cellResult}>
                    <div className={styles.resultRow}>
                      <span className={`${styles.resultLabel} ${styles.labelWideHidden}`}>Result</span>
                      <span className={`${styles.resultBadge} ${resultBadgeClass(r.result)}`}>
                        {r.result}
                      </span>
                    </div>
                    <div className={styles.resultRow}>
                      <span className={`${styles.resultLabel} ${styles.labelWideHidden}`}>Checked at</span>
                      <span className={styles.timestamp}>{formatCheckedAt(r.checked_at)}</span>
                    </div>
                  </div>

                  <div className={styles.cellUrls}>
                    <div className={styles.resultRow}>
                      <span className={styles.resultLabel}>Input</span>
                      <span className={styles.resultValue}>{r.original_input}</span>
                    </div>

                    {/*
                     * A-AIPF010-03: Only shown when normalized_url differs from
                     * original_input. Identical values add no informational value.
                     * Neither field is ever wrapped in an <a> tag.
                     */}
                    {r.normalized_url !== null &&
                     r.normalized_url !== r.original_input && (
                      <div className={styles.resultRow}>
                        <span className={styles.resultLabel}>Normalized</span>
                        <span className={styles.resultValue}>{r.normalized_url}</span>
                      </div>
                    )}

                    {r.redirected_to !== null && (
                      <div className={styles.resultRow}>
                        <span className={styles.resultLabel}>Redirected to</span>
                        <span className={styles.resultValue}>{r.redirected_to}</span>
                      </div>
                    )}
                  </div>

                  <div className={styles.cellMeaning}>
                    <div className={styles.resultRow}>
                      <span className={`${styles.resultLabel} ${styles.labelWideHidden}`}>Meaning</span>
                      <span className={styles.resultProse}>{r.meaning}</span>
                    </div>

                    {r.notes !== null && (
                      <div className={styles.resultRow}>
                        <span className={styles.resultLabel}>Notes</span>
                        <span className={styles.resultProse}>{r.notes}</span>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {results !== null && resultKey}

        {/* ── Footer notes ─────────────────────────────────────────────────── */}
        <footer className={styles.footer}>
          <p className={styles.privacyNote}>
            <strong>Privacy:</strong> Submitted URLs and scan results are
            processed temporarily and are not saved to a database or scan
            history.
          </p>
          <p className={styles.warningNote}>
            <strong>Warning:</strong> Do not use this tool as a final
            determination of whether content is malicious or illegal. It checks
            only whether a URL appears active, blocked, missing, redirected, or
            unreachable.
          </p>
        </footer>

      </div>
    </main>
  );
}
