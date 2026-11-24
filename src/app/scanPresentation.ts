/**
 * UIUX-PILOT-02: Pure presentation helpers for the scanner page.
 *
 * No network, DOM or storage access. Kept separate from page.tsx so the
 * summary arithmetic and error wording can be unit-tested directly.
 */

export interface ClassificationCount {
  result: string;
  count: number;
}

export interface ResultSummary {
  /** One entry per known classification, in canonical order, including zeros. */
  counts: ClassificationCount[];
  /** Results whose classification is not in the known list (outside the API contract). */
  unrecognized: number;
  total: number;
}

/**
 * Counts results per classification. Every result is counted exactly once,
 * so the sum of counts plus unrecognized always equals total.
 */
export function summarizeResults(
  results: ReadonlyArray<{ result: string }>,
  classifications: ReadonlyArray<string>
): ResultSummary {
  const tally = new Map<string, number>(classifications.map((c) => [c, 0]));
  let unrecognized = 0;
  for (const r of results) {
    const current = tally.get(r.result);
    if (current === undefined) unrecognized++;
    else tally.set(r.result, current + 1);
  }
  return {
    counts: classifications.map((result) => ({ result, count: tally.get(result) ?? 0 })),
    unrecognized,
    total: results.length,
  };
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/**
 * Formats a retry delay exactly, without rounding down.
 * Fractional seconds round up so the user never retries too early.
 *
 * @example formatDuration(45)   → "45 seconds"
 * @example formatDuration(60)   → "1 minute"
 * @example formatDuration(90)   → "1 minute and 30 seconds"
 * @example formatDuration(1260) → "21 minutes"
 * @example formatDuration(3661) → "1 hour, 1 minute and 1 second"
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const parts: string[] = [];
  if (hours) parts.push(plural(hours, "hour"));
  if (minutes) parts.push(plural(minutes, "minute"));
  if (seconds || parts.length === 0) parts.push(plural(seconds, "second"));
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Builds the user-facing API error text: the backend message as a complete
 * sentence, followed by the retry delay when the backend supplies one.
 * Delays of a minute or more also show the exact seconds from the backend.
 */
export function formatApiError(message: string, retryAfterSeconds: number | null): string {
  const trimmed = message.trim();
  const base = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  if (retryAfterSeconds == null) return base;
  const exact = Math.max(0, Math.ceil(retryAfterSeconds));
  const readable = formatDuration(exact);
  const wait = exact >= 60 ? `${readable} (${plural(exact, "second")})` : readable;
  return `${base} Please wait ${wait} before retrying.`;
}
