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

import { useState } from "react";
import styles from "./page.module.css";

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

interface ScanResult {
  original_input: string;
  normalized_url: string | null;
  result: string;
  meaning: string;
  redirected_to: string | null;
  checked_at: string;
  notes: string | null;
}

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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setResults(null);

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

    setIsLoading(true);

    try {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });

      const data: ApiResponse = await response.json();

      if (data.ok) {
        setResults(data.results);
      } else {
        const base = data.error?.message ?? "An error occurred. Please try again.";
        const retry =
          data.error?.retryAfterSeconds != null
            ? ` Please wait ${data.error.retryAfterSeconds} seconds before retrying.`
            : "";
        setError(`${base}${retry}`);
      }
    } catch {
      setError(
        "Could not reach the scanner service. Please check your connection and try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className={styles.main}>
      <div className={styles.card}>

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
        <form onSubmit={handleSubmit} className={styles.form} noValidate>
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
            type="submit"
            className={styles.button}
            disabled={isLoading}
            aria-busy={isLoading}
          >
            {isLoading ? "Scanning URLs safely\u2026" : "Scan URLs"}
          </button>
        </form>

        {/* ── Results ──────────────────────────────────────────────────────────
            A-AIPF009-05: Plain <span> elements — never <a> tags.
            AIPF-010 will replace this with the polished result table. */}
        {results !== null && (
          <section aria-label="Scan results" className={styles.results}>
            <h2 className={styles.resultsTitle}>
              Results — {results.length} URL{results.length !== 1 ? "s" : ""}
            </h2>
            <ul className={styles.resultList}>
              {results.map((r, index) => (
                <li key={index} className={styles.resultItem}>
                  <div className={styles.resultRow}>
                    <span className={styles.resultLabel}>Input</span>
                    <span className={styles.resultValue}>{r.original_input}</span>
                  </div>
                  <div className={styles.resultRow}>
                    <span className={styles.resultLabel}>Result</span>
                    <span className={`${styles.resultValue} ${styles.resultCode}`}>
                      {r.result}
                    </span>
                  </div>
                  <div className={styles.resultRow}>
                    <span className={styles.resultLabel}>Meaning</span>
                    <span className={styles.resultValue}>{r.meaning}</span>
                  </div>
                  {r.redirected_to !== null && (
                    <div className={styles.resultRow}>
                      <span className={styles.resultLabel}>Redirected to</span>
                      <span className={styles.resultValue}>{r.redirected_to}</span>
                    </div>
                  )}
                  {r.notes !== null && (
                    <div className={styles.resultRow}>
                      <span className={styles.resultLabel}>Notes</span>
                      <span className={styles.resultValue}>{r.notes}</span>
                    </div>
                  )}
                  <div className={styles.resultRow}>
                    <span className={styles.resultLabel}>Checked at</span>
                    <span className={styles.resultValue}>
                      {new Date(r.checked_at).toLocaleString()}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

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
