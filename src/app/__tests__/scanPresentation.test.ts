/**
 * UIUX-PILOT-02: Unit tests for summary counts (R2) and error wording (R7).
 */
import { formatApiError, formatDuration, summarizeResults } from "../scanPresentation";

const CLASSES = [
  "200 OK",
  "301/302 Redirect",
  "403 Forbidden",
  "404 Not Found",
  "410 Gone",
  "Timeout",
  "DNS failure",
  "Connection refused",
  "Blocked",
  "Server error",
  "Unknown",
];

const sum = (s: ReturnType<typeof summarizeResults>) =>
  s.counts.reduce((a, c) => a + c.count, 0) + s.unrecognized;

describe("summarizeResults", () => {
  it("counts a single result and reports zeros for the other ten classifications", () => {
    const s = summarizeResults([{ result: "200 OK" }], CLASSES);
    expect(s.total).toBe(1);
    expect(s.counts).toHaveLength(11);
    expect(s.counts.find((c) => c.result === "200 OK")?.count).toBe(1);
    expect(s.counts.filter((c) => c.count === 0)).toHaveLength(10);
    expect(sum(s)).toBe(1);
  });

  it("counts one of each classification in canonical order", () => {
    const s = summarizeResults(CLASSES.map((result) => ({ result })), CLASSES);
    expect(s.counts.map((c) => c.result)).toEqual(CLASSES);
    expect(s.counts.every((c) => c.count === 1)).toBe(true);
    expect(sum(s)).toBe(11);
  });

  it("counts a 100-result batch exactly and sums to the total", () => {
    const results = Array.from({ length: 100 }, (_, i) => ({ result: CLASSES[i % 11] }));
    const s = summarizeResults(results, CLASSES);
    expect(s.total).toBe(100);
    expect(s.counts[0].count).toBe(10); // indices 0, 11, ..., 99
    expect(s.counts.slice(1).every((c) => c.count === 9)).toBe(true);
    expect(sum(s)).toBe(100);
  });

  it("reports missing classifications as zero", () => {
    const s = summarizeResults(
      [{ result: "404 Not Found" }, { result: "404 Not Found" }, { result: "Timeout" }],
      CLASSES
    );
    expect(s.counts.find((c) => c.result === "404 Not Found")?.count).toBe(2);
    expect(s.counts.find((c) => c.result === "Timeout")?.count).toBe(1);
    expect(s.counts.find((c) => c.result === "200 OK")?.count).toBe(0);
    expect(sum(s)).toBe(3);
  });

  it("keeps out-of-contract results separate rather than folding them into Unknown", () => {
    const s = summarizeResults([{ result: "Unknown" }, { result: "Teapot" }], CLASSES);
    expect(s.counts.find((c) => c.result === "Unknown")?.count).toBe(1);
    expect(s.unrecognized).toBe(1);
    expect(sum(s)).toBe(2);
  });

  it("handles an empty result list", () => {
    const s = summarizeResults([], CLASSES);
    expect(s.total).toBe(0);
    expect(sum(s)).toBe(0);
  });
});

describe("formatDuration", () => {
  it.each([
    [1, "1 second"],
    [45, "45 seconds"],
    [60, "1 minute"],
    [61, "1 minute and 1 second"],
    [90, "1 minute and 30 seconds"],
    [120, "2 minutes"],
    [1260, "21 minutes"],
    [1261, "21 minutes and 1 second"],
    [3600, "1 hour"],
    [3661, "1 hour, 1 minute and 1 second"],
    [0, "0 seconds"],
  ])("formats %d seconds as %s", (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });

  it("rounds fractional seconds up so the user never retries early", () => {
    expect(formatDuration(59.2)).toBe("1 minute");
    expect(formatDuration(0.4)).toBe("1 second");
  });
});

describe("formatApiError", () => {
  it("adds a sentence break between the backend message and the retry hint", () => {
    expect(formatApiError("This IP has exceeded the limit of 20 batches per hour", 1260)).toBe(
      "This IP has exceeded the limit of 20 batches per hour. " +
        "Please wait 21 minutes (1260 seconds) before retrying."
    );
  });

  it("does not double existing terminal punctuation", () => {
    expect(formatApiError("Try again soon.", 30)).toBe(
      "Try again soon. Please wait 30 seconds before retrying."
    );
  });

  it("shows exact seconds alongside non-whole-minute waits", () => {
    expect(formatApiError("Rate limited", 90)).toBe(
      "Rate limited. Please wait 1 minute and 30 seconds (90 seconds) before retrying."
    );
  });

  it("uses singular units", () => {
    expect(formatApiError("Rate limited", 1)).toBe(
      "Rate limited. Please wait 1 second before retrying."
    );
    expect(formatApiError("Rate limited", 60)).toBe(
      "Rate limited. Please wait 1 minute (60 seconds) before retrying."
    );
  });

  it("omits the retry hint when the backend supplies no delay", () => {
    expect(
      formatApiError(
        "The batch did not complete within the allowed time. Please try a smaller batch.",
        null
      )
    ).toBe("The batch did not complete within the allowed time. Please try a smaller batch.");
  });
});
