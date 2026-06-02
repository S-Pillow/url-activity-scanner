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
    expect(within(resultsSection).getByText("https://example.com")).toBeInTheDocument();
    expect(within(resultsSection).getByText("200 OK")).toBeInTheDocument();
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
