/**
 * AIPF-009: URL Activity Scanner — UI Page
 *
 * Client component that renders the scanner form and results.
 *
 * Assumption A-AIPF009-02 — Client component:
 *   The page is a React Client Component ("use client") because it manages
 *   interactive form state, loading state, and API response state. A Server
 *   Component cannot hold mutable state. The actual scanning happens
 *   server-side in route.ts (AIPF-008A) and the security modules
 *   (AIPF-002–007); the client component merely presents the interface.
 *
 * Assumption A-AIPF009-03 — Frontend batch limit:
 *   The frontend validates that the user submits no more than MAX_URLS_PER_BATCH
 *   (100) URLs. This must match backend maxUrlsPerBatch (AIPF-007/008).
 *   The backend is authoritative — if the limits diverge, the backend error
 *   message is shown to the user. This constant is labeled as an assumption
 *   and must be updated if the backend default changes.
 *
 * Assumption A-AIPF009-04 — Blank lines:
 *   Blank lines in the textarea are silently filtered out on the client before
 *   submission (matching the backend's expected behavior per A-AIPF008-05).
 *   The count shown to the user (e.g. "101 URLs") reflects non-blank lines
 *   only, consistent with what the backend will receive.
 *
 * Assumption A-AIPF009-05 — Result display:
 *   Results are rendered as plain text with no anchor tags, no href attributes,
 *   and no clickable behavior. AIPF-010 will own the polished result table.
 *   This ticket renders only the seven approved fields as a simple list.
 *
 * Safety guarantee:
 *   - No submitted URL, normalized URL, or scan result is written to
 *     localStorage, sessionStorage, cookies, IndexedDB, or any database.
 *   - Results live only in React component state and are cleared on page
 *     refresh.
 *   - No returned URL field is rendered as an anchor (<a>) element.
 *   - No analytics events containing submitted URLs are fired.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import styles from "./page.module.css";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum URLs allowed per batch.
 * A-AIPF009-03: Must match backend maxUrlsPerBatch (AIPF-007 DEFAULT_CONFIG).
 * Backend enforcement is authoritative; this is a UX-only early guard.
 */
const MAX_URLS_PER_BATCH = 100;

/**
 * The API endpoint this page submits to.
 */
const API_ENDPOINT = "/api/tools/url-activity-scanner";

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

  // ── Form submission handler ──────────────────────────────────────────────

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setError(null);
    setResults(null);

    // Parse URLs: one per line, trim whitespace, filter blank lines (A-AIPF009-04).
    const urls = urlInput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // ── Frontend validation (A-AIPF009-03) ─────────────────────────────────
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
      // POST to the API route — no third-party requests, no URL logging.
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });

      const data: ApiResponse = await response.json();

      if (data.ok) {
        // Store results only in component state — never persisted (A-AIPF009-05).
        setResults(data.results);
      } else {
        // Show the backend's safe error message. Never surface internal codes.
        const base =
          data.error?.message ?? "An error occurred. Please try again.";
        const retry =
          data.error?.retryAfterSeconds != null
            ? ` Please wait ${data.error.retryAfterSeconds} seconds before retrying.`
            : "";
        setError(`${base}${retry}`);
      }
    } catch {
      // Network error — no request details are included in the message.
      setError(
        "Could not reach the scanner service. Please check your connection and try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <main className={styles.main}>
      <div className={styles.card}>

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className={styles.header}>
          <Link href="/" className={styles.backLink} aria-label="Back to all tools">
            ← All tools
          </Link>
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

        {/* ── Results (plain text — no clickable links) ─────────────────────
            A-AIPF009-05: Rendered as <span> elements, never as <a> elements.
            AIPF-010 will replace this section with the polished result table. */}
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
                      {/* Plain text only — never an anchor element */}
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

        {/* ── Footer: privacy and warning notes ───────────────────────────── */}
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
