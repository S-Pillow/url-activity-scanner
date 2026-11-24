/**
 * @jest-environment jsdom
 *
 * AIPF-009: URL Activity Scanner Page — Component Tests
 *
 * All tests use React Testing Library with a jsdom environment.
 * The global `fetch` is replaced with jest.fn() before each test so no
 * live API calls are made.
 *
 * Key invariants verified:
 *   - URLs in results are NEVER wrapped in <a> tags.
 *   - Submitted URLs and results are never written to localStorage,
 *     sessionStorage, or document.cookie.
 *   - fetch is only called once, to the correct local endpoint.
 *
 * Test count: 22 tests covering all required AIPF-009 test cases (1–20)
 * plus two additional safety checks.
 */

import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UrlActivityScannerPage from "../page";
import { escapeCsvCell, buildCsv, buildCsvFilename, CSV_HEADER } from "../csvExport";

// ─── Mock next/link ───────────────────────────────────────────────────────────
// next/link is a Next.js-specific module. In the jsdom test environment we
// render the component without the Next.js router, so we stub Link with a
// plain <a> tag that passes href through.
jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// ─── Constants ────────────────────────────────────────────────────────────────

const API_ENDPOINT = "/tools/url-activity-scanner/api/scan";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeSuccessBody(urls = ["https://example.com"]) {
  return {
    ok: true,
    results: urls.map((u) => ({
      original_input: u,
      normalized_url: u,
      result: "200 OK",
      meaning: "Content likely exists",
      redirected_to: null,
      checked_at: "2026-01-01T00:00:00.000Z",
      notes: null,
    })),
    limits: { maxUrlsPerBatch: 100 },
  };
}

function makeErrorBody(
  code = "INVALID_REQUEST",
  message = "Something went wrong.",
  retryAfterSeconds: number | null = null
) {
  return {
    ok: false,
    error: { code, message, retryAfterSeconds },
    limits: { maxUrlsPerBatch: 100 },
  };
}

/**
 * Returns a minimal fetch response stub — just the .json() method the
 * component calls. jsdom does not provide the Fetch API Response constructor,
 * so we use plain objects instead.
 */
function makeFetchResponse(body: unknown, status = 200) {
  return { json: () => Promise.resolve(body), ok: status < 400, status };
}

/** Sets up global.fetch to return a resolved stub with the given JSON body. */
function mockFetchSuccess(body = makeSuccessBody()) {
  global.fetch = jest.fn().mockResolvedValue(makeFetchResponse(body, 200));
}

/** Sets up global.fetch to return a resolved stub with an error JSON body. */
function mockFetchError(body = makeErrorBody()) {
  global.fetch = jest.fn().mockResolvedValue(makeFetchResponse(body, 400));
}

/** Waits a tick for React state updates to flush after an async action. */
async function flushPromises() {
  await waitFor(() => {});
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset fetch mock for each test
  jest.resetAllMocks();
  mockFetchSuccess();

  // Clear any accidental storage writes
  localStorage.clear();
  sessionStorage.clear();
});

// ─── 1. Static content (tests 1–3) ───────────────────────────────────────────

describe("1. Static page content", () => {
  it("renders the page title 'URL Activity Scanner' (test 1)", () => {
    render(<UrlActivityScannerPage />);
    expect(
      screen.getByRole("heading", { name: /URL Activity Scanner/i })
    ).toBeInTheDocument();
  });

  it("renders the tagline text (test 2)", () => {
    render(<UrlActivityScannerPage />);
    expect(
      screen.getByText(/Check whether suspicious URLs appear active/i)
    ).toBeInTheDocument();
  });

  it("renders the safety notice (test 3)", () => {
    render(<UrlActivityScannerPage />);
    expect(
      screen.getByText(/does not render pages/i)
    ).toBeInTheDocument();
  });

  it("renders the privacy note in the footer", () => {
    render(<UrlActivityScannerPage />);
    expect(
      screen.getByText(/processed temporarily and are not saved/i)
    ).toBeInTheDocument();
  });

  it("renders the warning note in the footer", () => {
    render(<UrlActivityScannerPage />);
    expect(
      screen.getByText(/Do not use this tool as a final determination/i)
    ).toBeInTheDocument();
  });
});

// ─── 2. Textarea input (test 4) ──────────────────────────────────────────────

describe("2. Textarea input", () => {
  it("textarea accepts one URL per line (test 4)", async () => {
    const user = userEvent.setup();
    render(<UrlActivityScannerPage />);

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "https://example.com");

    expect(textarea).toHaveValue("https://example.com");
  });

  it("textarea has an accessible label", () => {
    render(<UrlActivityScannerPage />);
    // Label text or aria-label must be present and associated
    const textarea = screen.getByLabelText(/URLs to scan/i);
    expect(textarea).toBeInTheDocument();
  });
});

// ─── 3. Frontend validation (tests 5–6) ──────────────────────────────────────

describe("3. Frontend validation", () => {
  it("shows an error for empty submission (test 5)", async () => {
    const user = userEvent.setup();
    render(<UrlActivityScannerPage />);

    const button = screen.getByRole("button", { name: /Scan URLs/i });
    await user.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /at least one URL/i
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows an error when more than 100 non-empty lines are submitted (test 6)", async () => {
    render(<UrlActivityScannerPage />);

    const textarea = screen.getByRole("textbox");
    const urls = Array.from({ length: 101 }, (_, i) => `https://e${i}.com`).join("\n");
    // Use fireEvent for large input to avoid slow userEvent.type
    fireEvent.change(textarea, { target: { value: urls } });

    const button = screen.getByRole("button", { name: /Scan URLs/i });
    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many URLs/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("ignores blank lines when counting URL limit", async () => {
    render(<UrlActivityScannerPage />);
    const textarea = screen.getByRole("textbox");

    // 100 real URLs + 10 blank lines = only 100 non-blank → should allow
    const urls = Array.from({ length: 100 }, (_, i) => `https://e${i}.com`);
    const withBlanks = urls.join("\n\n"); // every URL separated by a blank line
    fireEvent.change(textarea, { target: { value: withBlanks } });

    const button = screen.getByRole("button", { name: /Scan URLs/i });
    fireEvent.click(button);

    // Should not show the "too many" error
    await flushPromises();
    expect(screen.queryByText(/Too many URLs/i)).not.toBeInTheDocument();
  });
});

// ─── 4. API integration (tests 7–9) ──────────────────────────────────────────

describe("4. API integration", () => {
  it("scan button sends POST to the correct endpoint (test 7)", async () => {
    const user = userEvent.setup();
    render(<UrlActivityScannerPage />);

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "https://example.com");
    await user.click(screen.getByRole("button", { name: /Scan URLs/i }));

    await flushPromises();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      API_ENDPOINT,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("request body contains the urls array (test 8)", async () => {
    const user = userEvent.setup();
    render(<UrlActivityScannerPage />);

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "https://example.com");
    await user.click(screen.getByRole("button", { name: /Scan URLs/i }));

    await flushPromises();

    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit
    ];
    const body = JSON.parse(options.body as string);
    expect(body).toHaveProperty("urls");
    expect(Array.isArray(body.urls)).toBe(true);
    expect(body.urls).toContain("https://example.com");
  });

  it("blank lines are filtered before sending the request (test 9)", async () => {
    render(<UrlActivityScannerPage />);
    const textarea = screen.getByRole("textbox");

    fireEvent.change(textarea, {
      target: { value: "https://a.com\n\n  \nhttps://b.com\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));

    await flushPromises();

    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit
    ];
    const body = JSON.parse(options.body as string);
    // Only the two non-blank URLs should be in the array
    expect(body.urls).toEqual(["https://a.com", "https://b.com"]);
  });
});

// ─── 5. Loading state (test 10) ──────────────────────────────────────────────

describe("5. Loading state", () => {
  it("disables the scan button while loading (test 10)", async () => {
    // Hold fetch in a pending state until we explicitly resolve it
    let resolveFetch!: (value: unknown) => void;
    global.fetch = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const user = userEvent.setup();
    render(<UrlActivityScannerPage />);

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "https://example.com");

    const button = screen.getByRole("button", { name: /Scan URLs/i });
    await user.click(button);

    // Button should now be disabled while fetch is pending
    expect(screen.getByRole("button")).toBeDisabled();

    // Resolve fetch to clean up
    resolveFetch(makeFetchResponse(makeSuccessBody(), 200));
    await flushPromises();
  });
});

// ─── 6. Result handling (tests 11–12) ────────────────────────────────────────

describe("6. Result handling", () => {
  it("displays results in component state after a successful response (test 11)", async () => {
    mockFetchSuccess(makeSuccessBody(["https://example.com"]));
    render(<UrlActivityScannerPage />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));

    // Result section should appear
    const resultsSection = await screen.findByRole("region", {
      name: /Scan results/i,
    });
    expect(resultsSection).toBeInTheDocument();
    // The classification summary also shows "200 OK", so scope to the result list.
    const resultList = within(resultsSection).getByRole("list", { name: /Scan results list/i });
    expect(within(resultList).getByText("https://example.com")).toBeInTheDocument();
    expect(within(resultList).getByText("200 OK")).toBeInTheDocument();
  });

  it("displays a safe error message for API error responses (test 12)", async () => {
    mockFetchError(makeErrorBody("IP_RATE_LIMITED", "Rate limit exceeded. Try again soon.", 60));
    render(<UrlActivityScannerPage />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Rate limit exceeded/i);
    // retryAfterSeconds should appear in the message
    expect(alert).toHaveTextContent(/60 seconds/i);
  });

  it("displays a generic error for a network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network offline"));
    render(<UrlActivityScannerPage />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));

    const alert = await screen.findByRole("alert");
    // Internal error details must NOT be shown to the user
    expect(alert).not.toHaveTextContent(/Network offline/i);
    expect(alert).toHaveTextContent(/could not reach/i);
  });
});

// ─── 7. No clickable URLs (tests 13–15) ──────────────────────────────────────

describe("7. No clickable URLs", () => {
  async function renderWithResults(
    resultOverride?: Partial<(typeof makeSuccessBody)["prototype"]>
  ) {
    const body = {
      ok: true,
      results: [
        {
          original_input: "https://submitted.example.com",
          normalized_url: "https://normalized.example.com",
          result: "301/302 Redirect",
          meaning: "URL redirects somewhere active",
          redirected_to: "https://redirected.example.com",
          checked_at: "2026-01-01T00:00:00.000Z",
          notes: null,
          ...resultOverride,
        },
      ],
      limits: { maxUrlsPerBatch: 100 },
    };
    global.fetch = jest.fn().mockResolvedValue(makeFetchResponse(body, 200));

    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://submitted.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await screen.findByRole("region", { name: /Scan results/i });
  }

  it("submitted URLs are not rendered as clickable links (test 13)", async () => {
    await renderWithResults();
    // All <a> tags in the results section must NOT href to the submitted URL
    const links = screen.queryAllByRole("link");
    for (const link of links) {
      expect(link).not.toHaveAttribute(
        "href",
        expect.stringContaining("submitted.example.com")
      );
    }
  });

  it("normalized_url is not rendered as a clickable link (test 14)", async () => {
    await renderWithResults();
    const links = screen.queryAllByRole("link");
    for (const link of links) {
      expect(link).not.toHaveAttribute(
        "href",
        expect.stringContaining("normalized.example.com")
      );
    }
  });

  it("redirected_to is not rendered as a clickable link (test 15)", async () => {
    await renderWithResults();
    // Verify the redirect destination is displayed as text but not as a link
    expect(screen.getByText("https://redirected.example.com")).toBeInTheDocument();
    const links = screen.queryAllByRole("link");
    for (const link of links) {
      expect(link).not.toHaveAttribute(
        "href",
        expect.stringContaining("redirected.example.com")
      );
    }
  });
});

// ─── 8. No persistent storage (tests 16–18) ──────────────────────────────────

describe("8. No persistent storage", () => {
  it("does not write to localStorage (test 16)", async () => {
    const setItemSpy = jest.spyOn(Storage.prototype, "setItem");
    render(<UrlActivityScannerPage />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await flushPromises();

    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it("does not write to sessionStorage (test 17)", async () => {
    const setItemSpy = jest.spyOn(Storage.prototype, "setItem");
    render(<UrlActivityScannerPage />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await flushPromises();

    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it("does not write cookies (test 18)", async () => {
    const originalCookie = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "cookie"
    );
    const cookieWriteSpy = jest.fn();
    Object.defineProperty(document, "cookie", {
      set: cookieWriteSpy,
      get: () => "",
      configurable: true,
    });

    try {
      render(<UrlActivityScannerPage />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "https://example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
      await flushPromises();

      expect(cookieWriteSpy).not.toHaveBeenCalled();
    } finally {
      if (originalCookie) {
        Object.defineProperty(document, "cookie", originalCookie);
      }
    }
  });
});

// ─── 9. No third-party requests (test 19) ────────────────────────────────────

describe("9. No third-party requests", () => {
  it("fetch is called only once and only to the local API endpoint (test 19)", async () => {
    render(<UrlActivityScannerPage />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://example.com\nhttps://example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await flushPromises();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string];
    expect(url).toBe(API_ENDPOINT);
    // Must be a relative path — not an absolute third-party URL
    expect(url).not.toMatch(/^https?:\/\//);
  });
});

// ─── 10. AIPF-010 Result table and result key ────────────────────────────────
//
// Tests 20–33 cover the AIPF-010 requirements:
//   - All seven approved fields are displayed correctly.
//   - redirected_to and notes are shown only when present.
//   - checked_at is formatted as YYYY-MM-DD HH:mm:ss UTC.
//   - The result key/legend is always visible and complete.
//   - No submitted or returned URL is clickable.
//   - No img elements or content previews appear in the results section.

describe("10. AIPF-010 Result table and result key", () => {
  // ── Fixture with all seven fields populated (including optional ones) ─────

  const FULL_RESULT_BODY = {
    ok: true,
    results: [
      {
        original_input:  "https://submitted.example.com",
        normalized_url:  "https://normalized.example.com",
        result:          "301/302 Redirect",
        meaning:         "URL redirects somewhere active",
        redirected_to:   "https://redirected.example.com",
        checked_at:      "2026-06-02T04:33:16.000Z",
        notes:           "Redirect chain: 1 hop",
      },
    ],
    limits: { maxUrlsPerBatch: 100 },
  };

  async function renderFullResult() {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse(FULL_RESULT_BODY, 200)
    );
    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://submitted.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await screen.findByRole("region", { name: /Scan results/i });
  }

  // ── Field display (tests 20–27) ───────────────────────────────────────────

  it("displays original_input in the result section (test 20)", async () => {
    await renderFullResult();
    const region = screen.getByRole("region", { name: /Scan results/i });
    expect(within(region).getByText("https://submitted.example.com")).toBeInTheDocument();
  });

  it("displays normalized_url as plain text when it differs from original_input (test 21)", async () => {
    await renderFullResult();
    const region = screen.getByRole("region", { name: /Scan results/i });
    expect(within(region).getByText("https://normalized.example.com")).toBeInTheDocument();
  });

  it("hides normalized_url row when value equals original_input (test 22)", async () => {
    // makeSuccessBody sets normalized_url === original_input
    mockFetchSuccess(makeSuccessBody(["https://example.com"]));
    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await screen.findByRole("region", { name: /Scan results/i });

    // "https://example.com" should appear exactly once (only as Input, not also as Normalized)
    const region = screen.getByRole("region", { name: /Scan results/i });
    expect(within(region).getAllByText("https://example.com")).toHaveLength(1);
  });

  it("displays result as a badge with text (test 23)", async () => {
    await renderFullResult();
    const region = screen.getByRole("region", { name: /Scan results/i });
    // The classification summary also shows the label, so scope to the result list.
    const resultList = within(region).getByRole("list", { name: /Scan results list/i });
    expect(within(resultList).getByText("301/302 Redirect")).toBeInTheDocument();
  });

  it("displays meaning in the result section (test 24)", async () => {
    await renderFullResult();
    const region = screen.getByRole("region", { name: /Scan results/i });
    expect(within(region).getByText("URL redirects somewhere active")).toBeInTheDocument();
  });

  it("displays redirected_to as plain text when present (test 25)", async () => {
    await renderFullResult();
    const region = screen.getByRole("region", { name: /Scan results/i });
    expect(within(region).getByText("https://redirected.example.com")).toBeInTheDocument();
  });

  it("hides redirected_to row when value is null (test 26)", async () => {
    mockFetchSuccess(makeSuccessBody(["https://example.com"]));
    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await screen.findByRole("region", { name: /Scan results/i });

    const region = screen.getByRole("region", { name: /Scan results/i });
    expect(within(region).queryByText(/^Redirected to$/i)).not.toBeInTheDocument();
  });

  it("displays notes as plain text when present (test 27)", async () => {
    await renderFullResult();
    const region = screen.getByRole("region", { name: /Scan results/i });
    expect(within(region).getByText("Redirect chain: 1 hop")).toBeInTheDocument();
  });

  it("hides notes row when value is null (test 28)", async () => {
    mockFetchSuccess(makeSuccessBody(["https://example.com"]));
    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await screen.findByRole("region", { name: /Scan results/i });

    const region = screen.getByRole("region", { name: /Scan results/i });
    expect(within(region).queryByText(/^Notes$/i)).not.toBeInTheDocument();
  });

  // ── Timestamp formatting (test 29) ───────────────────────────────────────

  it("formats checked_at as YYYY-MM-DD HH:mm:ss UTC (test 29)", async () => {
    await renderFullResult();
    // "2026-06-02T04:33:16.000Z" must appear as "2026-06-02 04:33:16 UTC"
    expect(screen.getByText("2026-06-02 04:33:16 UTC")).toBeInTheDocument();
  });

  // ── Result key (tests 30–31) ─────────────────────────────────────────────

  it("renders the result key section at all times (test 30)", () => {
    render(<UrlActivityScannerPage />);
    expect(
      screen.getByRole("region", { name: /Result key/i })
    ).toBeInTheDocument();
  });

  it("result key contains all 11 required result types (test 31)", () => {
    render(<UrlActivityScannerPage />);
    const required = [
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
    ] as const;
    for (const label of required) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  // ── No clickable URLs in result items (tests 32–34) ──────────────────────

  it("original_input in result item is not a link (test 32)", async () => {
    await renderFullResult();
    const links = screen.queryAllByRole("link");
    for (const link of links) {
      expect(link).not.toHaveAttribute(
        "href",
        expect.stringContaining("submitted.example.com")
      );
    }
  });

  it("normalized_url in result item is not a link (test 33)", async () => {
    await renderFullResult();
    const links = screen.queryAllByRole("link");
    for (const link of links) {
      expect(link).not.toHaveAttribute(
        "href",
        expect.stringContaining("normalized.example.com")
      );
    }
  });

  it("redirected_to in result item is not a link (test 34)", async () => {
    await renderFullResult();
    const links = screen.queryAllByRole("link");
    for (const link of links) {
      expect(link).not.toHaveAttribute(
        "href",
        expect.stringContaining("redirected.example.com")
      );
    }
  });

  // ── No content rendering or previews (test 35) ────────────────────────────

  it("renders no img elements in the results section (test 35)", async () => {
    await renderFullResult();
    const region = screen.getByRole("region", { name: /Scan results/i });
    // No favicon, thumbnail, screenshot, or page preview
    expect(region.querySelectorAll("img")).toHaveLength(0);
  });
});

// ─── 12. AIPF-012 Privacy notice and data-handling UI ────────────────────────
//
// Tests 59–62 verify that:
//   - All required privacy/safety/data-handling notices are present.
//   - The page does not contain overclaiming language about logging,
//     compliance, or malicious-content determination.
//
// A-AIPF012-01: The public prototype notice is always visible at the top
//   of the card (before the scan form), so tests 59 and 61-62 render the
//   component without scanning.
// A-AIPF012-02: The export notice appears inside the results section, which
//   renders only when scan results exist. Test 60 scans first.
// A-AIPF012-03: No-overclaiming tests check document.body.textContent, not
//   specific elements, since the guarantee applies to the whole rendered page.

describe("12. AIPF-012 Privacy notice and data-handling UI", () => {
  it("export hint includes server-side clarification after a scan (test 60)", async () => {
    mockFetchSuccess(makeSuccessBody(["https://example.com"]));
    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await screen.findByRole("region", { name: /Scan results/i });

    // A-AIPF012-02: The export hint must include the server clarification sentence
    expect(
      screen.getByText(/server does not generate or save/i)
    ).toBeInTheDocument();
  });

  it("page does not claim infrastructure logging is fully verified (test 61)", () => {
    render(<UrlActivityScannerPage />);
    const text = document.body.textContent ?? "";
    // A-AIPF012-03: These phrases would constitute logging overclaims
    expect(text).not.toMatch(/nothing is ever logged/i);
    expect(text).not.toMatch(/no logs exist/i);
    expect(text).not.toMatch(/fully compliant/i);
    expect(text).not.toMatch(/infrastructure log/i);
    expect(text).not.toMatch(/guaranteed.*log/i);
  });

  it("page does not claim the tool proves content is malicious or safe (test 62)", () => {
    render(<UrlActivityScannerPage />);
    const text = document.body.textContent ?? "";
    // A-AIPF012-03: These phrases would be overclaiming content classification
    expect(text).not.toMatch(/proves.*safe/i);
    expect(text).not.toMatch(/proves.*malicious/i);
    expect(text).not.toMatch(/proves.*illegal/i);
    expect(text).not.toMatch(/confirms.*illegal/i);
    expect(text).not.toMatch(/determines.*illegal/i);
  });
});

// ─── 11. AIPF-011 CSV export ──────────────────────────────────────────────────
//
// Tests 36–58 cover the AIPF-011 requirements:
//
//   Component integration tests (36–41, 56–58):
//     Verify the export button renders, is hidden before results exist,
//     triggers a client-side download, and does not call fetch.
//
//   CSV content tests (42–54, via Blob capture):
//     Verify every approved field is included; null fields are empty cells;
//     no metadata / backend-internal fields appear.
//
//   Pure-function unit tests (55):
//     Directly test escapeCsvCell, buildCsv, and buildCsvFilename.
//     These run without mounting the component.

describe("11. AIPF-011 CSV export", () => {
  // ── Blob + anchor mocks ────────────────────────────────────────────────────
  //
  // jsdom does not implement URL.createObjectURL or URL.revokeObjectURL.
  // jest.spyOn requires the property to already exist, so we assign the
  // mock functions directly to the URL constructor. The global beforeEach
  // calls jest.resetAllMocks() which clears mock state (call counts, etc.)
  // but does not delete properties; our describe-level beforeEach re-assigns
  // fresh jest.fn() instances each time, so isolation is maintained.

  let capturedBlob: Blob | undefined;

  beforeEach(() => {
    capturedBlob = undefined;

    // Capture the Blob so tests can read CSV content via blob.text()
    (URL as unknown as Record<string, unknown>).createObjectURL = jest.fn(
      (obj: unknown) => {
        capturedBlob = obj as Blob;
        return "blob:fake-url";
      }
    );
    (URL as unknown as Record<string, unknown>).revokeObjectURL = jest.fn();

    // Suppress the programmatic .click() that triggers the browser download
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  // ── Scan fixture with two results (one with all fields, one with nulls) ───

  const EXPORT_BODY = {
    ok: true,
    results: [
      {
        original_input:  "https://submitted.example.com",
        normalized_url:  "https://normalized.example.com",
        result:          "200 OK",
        meaning:         "Content likely exists",
        redirected_to:   "https://redir.example.com",
        checked_at:      "2026-06-02T04:33:16.000Z",
        notes:           "Some note",
      },
      {
        original_input:  "https://another.example.com",
        normalized_url:  "https://another.example.com",
        result:          "404 Not Found",
        meaning:         "No content at that path",
        redirected_to:   null,
        checked_at:      "2026-06-02T04:33:17.000Z",
        notes:           null,
      },
    ],
    limits: { maxUrlsPerBatch: 100 },
  };

  async function renderAndScanForExport() {
    global.fetch = jest.fn().mockResolvedValue(makeFetchResponse(EXPORT_BODY, 200));
    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://submitted.example.com\nhttps://another.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    await screen.findByRole("region", { name: /Scan results/i });
  }

  /**
   * Reads a Blob as a UTF-8 string using FileReader.
   * jsdom's Blob does not implement the modern .text() method, but it does
   * support the classic FileReader API which achieves the same result.
   */
  function readBlobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target!.result as string);
      reader.onerror = () => reject(new Error("FileReader error"));
      reader.readAsText(blob, "utf-8");
    });
  }

  /** Triggers the export and returns the full CSV text from the captured Blob. */
  async function getCsv(): Promise<string> {
    await renderAndScanForExport();
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));
    expect(capturedBlob).toBeDefined();
    return readBlobText(capturedBlob!);
  }

  // ── 1. Button visibility (tests 36–37) ────────────────────────────────────

  it("export button is not shown before results exist (test 36)", () => {
    render(<UrlActivityScannerPage />);
    expect(screen.queryByRole("button", { name: /Export CSV/i })).not.toBeInTheDocument();
  });

  it("export button appears after a successful scan (test 37)", async () => {
    await renderAndScanForExport();
    expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
  });

  // ── 2. Client-side only — no fetch (tests 38–39) ─────────────────────────

  it("clicking export does not make a network request (test 38)", async () => {
    await renderAndScanForExport();
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));
    // fetch was called exactly once (for the scan); export must not add a call
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("clicking export calls URL.createObjectURL — proving client-side Blob download (test 39)", async () => {
    await renderAndScanForExport();
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));
    const createObjectURL = (URL as unknown as Record<string, unknown>).createObjectURL as jest.Mock;
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(capturedBlob).toBeInstanceOf(Blob);
  });

  // ── 3. CSV structure (tests 40–41) ────────────────────────────────────────

  it("CSV begins with the privacy notice comment (test 40)", async () => {
    const csv = await getCsv();
    expect(csv).toMatch(/^# Privacy Notice:/i);
  });

  it("CSV contains the exact required header row (test 41)", async () => {
    const csv = await getCsv();
    expect(csv).toContain(CSV_HEADER);
    // Verify no extra fields sneak in
    expect(CSV_HEADER).toBe(
      "original_input,normalized_url,result,meaning,redirected_to,checked_at,notes"
    );
  });

  // ── 4. All seven approved fields are present (tests 42–48) ───────────────

  it("CSV includes original_input (test 42)", async () => {
    const csv = await getCsv();
    expect(csv).toContain("https://submitted.example.com");
  });

  it("CSV includes normalized_url (test 43)", async () => {
    const csv = await getCsv();
    expect(csv).toContain("https://normalized.example.com");
  });

  it("CSV includes result (test 44)", async () => {
    const csv = await getCsv();
    expect(csv).toContain("200 OK");
  });

  it("CSV includes meaning (test 45)", async () => {
    const csv = await getCsv();
    expect(csv).toContain("Content likely exists");
  });

  it("CSV includes redirected_to when present (test 46)", async () => {
    const csv = await getCsv();
    expect(csv).toContain("https://redir.example.com");
  });

  it("CSV includes checked_at as ISO timestamp (test 47)", async () => {
    const csv = await getCsv();
    expect(csv).toContain("2026-06-02T04:33:16.000Z");
  });

  it("CSV includes notes when present (test 48)", async () => {
    const csv = await getCsv();
    expect(csv).toContain("Some note");
  });

  // ── 5. Null fields → empty cells (tests 49–50) ────────────────────────────

  it("null redirected_to exports as an empty cell (test 49)", async () => {
    const csv = await getCsv();
    // Parse data rows only (skip comment + header)
    const dataRows = csv
      .split(/\r?\n/)
      .filter((r) => r.trim() && !r.startsWith("#") && !r.startsWith("original_input"));
    // Second data row = another.example.com, which has null redirected_to
    const fields = dataRows[1].split(",");
    expect(fields[4]).toBe(""); // redirected_to is column index 4
  });

  it("null notes exports as an empty cell (test 50)", async () => {
    const csv = await getCsv();
    const dataRows = csv
      .split(/\r?\n/)
      .filter((r) => r.trim() && !r.startsWith("#") && !r.startsWith("original_input"));
    const fields = dataRows[1].split(",");
    expect(fields[6]).toBe(""); // notes is column index 6
  });

  // ── 6. No metadata/backend fields exported (test 51) ─────────────────────

  it("CSV header contains exactly the seven approved fields and no others (test 51)", async () => {
    const csv = await getCsv();
    const headerLine = csv
      .split(/\r?\n/)
      .find((r) => r.startsWith("original_input"));
    expect(headerLine).toBe(
      "original_input,normalized_url,result,meaning,redirected_to,checked_at,notes"
    );
    // Verify no internal/metadata fields are present
    for (const forbidden of [
      "response_body", "response_headers", "content_type", "content_length",
      "page_title", "favicon", "screenshot", "thumbnail", "dns_records",
      "resolved_ip", "client_ip", "rate_limit",
    ]) {
      expect(headerLine).not.toContain(forbidden);
    }
  });

  // ── 7. Storage checks during export (tests 52–53) ────────────────────────

  it("no localStorage writes occur during export (test 52)", async () => {
    const spy = jest.spyOn(Storage.prototype, "setItem");
    await renderAndScanForExport();
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no sessionStorage writes occur during export (test 53)", async () => {
    const spy = jest.spyOn(Storage.prototype, "setItem");
    await renderAndScanForExport();
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // ── 8. Pure-function unit tests (tests 54–58) ────────────────────────────
  //
  // These call csvExport helpers directly without mounting the component.

  it("escapeCsvCell: wraps values containing commas in double quotes (test 54)", () => {
    expect(escapeCsvCell("value,with,commas")).toBe('"value,with,commas"');
  });

  it("escapeCsvCell: escapes internal double quotes by doubling them (test 55)", () => {
    expect(escapeCsvCell('say "hello"')).toBe('"say ""hello"""');
  });

  it("escapeCsvCell: wraps values containing newlines in double quotes (test 56)", () => {
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("buildCsvFilename: filename includes 'url-activity-scan-results' (test 57)", () => {
    const fn = buildCsvFilename(new Date("2026-06-02T04:33:16.000Z"));
    expect(fn).toContain("url-activity-scan-results");
  });

  it("buildCsvFilename: filename includes a UTC timestamp pattern (test 58)", () => {
    const fn = buildCsvFilename(new Date("2026-06-02T04:33:16.000Z"));
    // Expected: url-activity-scan-results-2026-06-02-04-33-16-UTC.csv
    expect(fn).toMatch(/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-UTC\.csv$/);
    expect(fn).toBe("url-activity-scan-results-2026-06-02-04-33-16-UTC.csv");
  });
});

// ─── 13. AIPF-006B/010B: Improved result meaning text (UI layer) ─────────────

describe("13. AIPF-006B/010B: Result key displays improved meanings", () => {
  it("result key displays the improved Server error meaning (test 63)", () => {
    render(<UrlActivityScannerPage />);
    expect(
      screen.getByText("Server or CDN responded with an error to this scanner request")
    ).toBeInTheDocument();
  });

  it("result key displays the improved Timeout meaning (test 64)", () => {
    render(<UrlActivityScannerPage />);
    expect(
      screen.getByText("Server did not respond to the scanner request")
    ).toBeInTheDocument();
  });

  it("result key does not display the old Server error meaning (test 65)", () => {
    render(<UrlActivityScannerPage />);
    expect(
      screen.queryByText("Server responded but failed to process the request")
    ).not.toBeInTheDocument();
  });

  it("result key does not claim the site is down, safe, or malicious (test 66)", () => {
    render(<UrlActivityScannerPage />);
    const text = document.body.textContent ?? "";
    // Overclaiming assertions (same contract as resultMapper.test.ts 57–58)
    expect(text).not.toMatch(/site is down/i);
    expect(text).not.toMatch(/website is offline/i);
    expect(text).not.toMatch(/site is broken/i);
    expect(text).not.toMatch(/site is safe/i);
    expect(text).not.toMatch(/site is malicious/i);
    expect(text).not.toMatch(/site is illegal/i);
  });
});
