/**
 * @jest-environment jsdom
 *
 * UIUX-PILOT-02: Results experience regression tests (R1, R2, R6, R7, R8).
 * fetch is mocked; no live requests are made.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import UrlActivityScannerPage from "../page";

const CLASSES = [
  ["200 OK", "Content likely exists"],
  ["301/302 Redirect", "URL redirects somewhere active"],
  ["403 Forbidden", "Server exists, but access is blocked"],
  ["404 Not Found", "No content at that path"],
  ["410 Gone", "Content used to exist but is gone"],
  ["Timeout", "Server did not respond to the scanner request"],
  ["DNS failure", "Domain does not resolve"],
  ["Connection refused", "Host exists but service may be down"],
  ["Blocked", "URL points to a private, internal, unsupported, or unsafe destination"],
  ["Server error", "Server or CDN responded with an error to this scanner request"],
  ["Unknown", "The URL responded in an unexpected way"],
] as const;

function result(i: number, cls: number) {
  return {
    original_input: `https://host-${i}.example.test/`,
    normalized_url: `https://host-${i}.example.test/`,
    result: CLASSES[cls][0],
    meaning: CLASSES[cls][1],
    redirected_to: null,
    checked_at: "2026-11-24T05:00:00.000Z",
    notes: null,
  };
}

const okBody = (results: unknown[]) => ({ ok: true, results, limits: { maxUrlsPerBatch: 100 } });
const respond = (body: unknown, status = 200) => ({ json: () => Promise.resolve(body), ok: status < 400, status });

let scrollSpy: jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  scrollSpy = jest.fn();
  Element.prototype.scrollIntoView = scrollSpy;
  delete (window as unknown as Record<string, unknown>).matchMedia;
});

async function scan(results: unknown[], input = "https://host-0.example.test/") {
  global.fetch = jest.fn().mockResolvedValue(respond(okBody(results)));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: input } });
  fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
  return screen.findByRole("region", { name: /Scan results/i });
}

function summaryCounts(region: HTMLElement): Record<string, number> {
  const dl = within(region).getByRole("heading", { name: /Classification counts/i })
    .nextElementSibling as HTMLElement;
  const out: Record<string, number> = {};
  dl.querySelectorAll("div").forEach((row) => {
    out[row.querySelector("dt")!.textContent!.trim()] = Number(row.querySelector("dd")!.textContent);
  });
  return out;
}

describe("R1 — results visibility and focus", () => {
  it("moves focus to the results heading and scrolls the results into view on success", async () => {
    render(<UrlActivityScannerPage />);
    await scan([result(0, 0)]);
    const heading = screen.getByRole("heading", { name: /Results — 1 URL$/ });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrollSpy).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
  });

  it("announces loading via the focused loading message and completion via the status region, once each", async () => {
    let resolve!: (v: unknown) => void;
    global.fetch = jest.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    render(<UrlActivityScannerPage />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://a.test\nhttps://b.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Scan URLs/i }));
    const loading = document.getElementById("scan-progress")!;
    expect(loading).toHaveFocus();
    expect(loading).toHaveTextContent("Scan in progress: 2 URLs. Results will appear when the scan finishes.");
    // The focused message is read on focus; the live region stays quiet to avoid a duplicate.
    expect(status).toHaveTextContent("");

    await act(async () => resolve(respond(okBody([result(0, 0), result(1, 3)]))));
    await screen.findByRole("region", { name: /Scan results/i });
    expect(status).toHaveTextContent(/^Scan complete\.$/);
  });

  it("uses smooth scrolling unless reduced motion is requested", async () => {
    const mm = (reduce: boolean) =>
      jest.fn().mockImplementation((q: string) => ({ matches: reduce && q.includes("reduce"), media: q }));

    window.matchMedia = mm(false) as unknown as typeof window.matchMedia;
    const { unmount } = render(<UrlActivityScannerPage />);
    await scan([result(0, 0)]);
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: "start", behavior: "smooth" }));
    unmount();

    scrollSpy.mockClear();
    window.matchMedia = mm(true) as unknown as typeof window.matchMedia;
    render(<UrlActivityScannerPage />);
    await scan([result(0, 0)]);
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: "start", behavior: "auto" }));
  });

  it("returns focus to the scan button after an API error, without moving to results", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      respond({ ok: false, error: { code: "IP_RATE_LIMITED", message: "Limit reached", retryAfterSeconds: 90 }, limits: {} }, 429)
    );
    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://a.test" } });
    const button = screen.getByRole("button", { name: /Scan URLs/i });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Limit reached. Please wait 1 minute and 30 seconds (90 seconds) before retrying."
    );
    await waitFor(() => expect(button).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("returns focus to the scan button after a network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("offline"));
    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://a.test" } });
    const button = screen.getByRole("button", { name: /Scan URLs/i });
    fireEvent.click(button);
    await screen.findByRole("alert");
    await waitFor(() => expect(button).toHaveFocus());
  });

  it("does not move focus or scroll on a validation failure", async () => {
    global.fetch = jest.fn();
    render(<UrlActivityScannerPage />);
    const button = screen.getByRole("button", { name: /Scan URLs/i });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(button).toHaveFocus();
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("moves focus to the new results heading on a repeated scan", async () => {
    render(<UrlActivityScannerPage />);
    await scan([result(0, 0)]);
    await waitFor(() => expect(screen.getByRole("heading", { name: /Results — 1 URL$/ })).toHaveFocus());
    await scan([result(0, 0), result(1, 1), result(2, 2)], "a\nb\nc");
    await waitFor(() => expect(screen.getByRole("heading", { name: /Results — 3 URLs/ })).toHaveFocus());
    expect(scrollSpy).toHaveBeenCalledTimes(2);
  });
});

describe("R1 — loading-state focus (UIUX-PILOT-03)", () => {
  function pendingFetch() {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    global.fetch = jest.fn().mockReturnValue(
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      })
    );
    return { resolve: (v: unknown) => resolve(v), reject: (e: unknown) => reject(e) };
  }

  function startScan(value = "https://a.test") {
    fireEvent.change(screen.getByRole("textbox"), { target: { value } });
    const button = screen.getByRole("button", { name: /Scan URLs/i });
    button.focus();
    fireEvent.click(button);
    return button;
  }

  it("moves focus from the disabled scan button to the loading message, keeping native disabled controls", () => {
    pendingFetch();
    render(<UrlActivityScannerPage />);
    const button = startScan("https://a.test\nhttps://b.test\nhttps://c.test");
    const loading = document.getElementById("scan-progress")!;
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("disabled");
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(loading).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(loading).toHaveAttribute("tabindex", "-1");
    expect(loading).not.toHaveAttribute("hidden");
    expect(loading).toHaveTextContent("3 URLs");
  });

  it("hides the loading message when idle and keeps it out of the tab order", () => {
    render(<UrlActivityScannerPage />);
    const loading = document.getElementById("scan-progress")!;
    expect(loading).toHaveAttribute("hidden");
    expect(loading).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus from the loading message to the results heading on success", async () => {
    const f = pendingFetch();
    render(<UrlActivityScannerPage />);
    startScan();
    await act(async () => f.resolve(respond(okBody([result(0, 0)]))));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Results — 1 URL$/ })).toHaveFocus());
    expect(document.getElementById("scan-progress")).toHaveAttribute("hidden");
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("scrolls to the results only after the loading message is hidden, so the target does not shift", async () => {
    const hiddenAtScroll: boolean[] = [];
    scrollSpy.mockImplementation(() => hiddenAtScroll.push(document.getElementById("scan-progress")!.hidden));
    const f = pendingFetch();
    render(<UrlActivityScannerPage />);
    startScan();
    await act(async () => f.resolve(respond(okBody([result(0, 0)]))));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Results — 1 URL$/ })).toHaveFocus());
    expect(hiddenAtScroll).toEqual([true]);
  });

  // Browsers drop focus to <body> when a focused element becomes disabled or
  // hidden, so each hand-off must happen while the old target is still usable.
  it("never disables or hides the element that holds focus", async () => {
    const seen: Array<{ target: string; buttonDisabled: boolean; progressHidden: boolean }> = [];
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      seen.push({
        target: el.id || el.tagName,
        buttonDisabled: (document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled,
        progressHidden: document.getElementById("scan-progress")!.hidden,
      });
    };
    document.addEventListener("focusin", onFocusIn);
    try {
      let f = pendingFetch();
      const { unmount } = render(<UrlActivityScannerPage />);
      startScan();
      seen.length = 0;
      await act(async () => {});
      await act(async () => f.resolve(respond(okBody([result(0, 0)]))));
      await waitFor(() => expect(screen.getByRole("heading", { name: /Results — 1 URL$/ })).toHaveFocus());
      unmount();

      f = pendingFetch();
      render(<UrlActivityScannerPage />);
      const button = startScan();
      await act(async () => f.reject(new Error("offline")));
      await waitFor(() => expect(button).toHaveFocus());
    } finally {
      document.removeEventListener("focusin", onFocusIn);
    }
    expect(seen).toEqual([
      { target: "results-heading", buttonDisabled: false, progressHidden: false },
      { target: "BUTTON", buttonDisabled: false, progressHidden: true },
      { target: "scan-progress", buttonDisabled: false, progressHidden: false },
      { target: "BUTTON", buttonDisabled: false, progressHidden: false },
    ]);
  });

  it("moves focus from the loading message back to the scan button on API and network errors", async () => {
    let f = pendingFetch();
    const { unmount } = render(<UrlActivityScannerPage />);
    let button = startScan();
    await act(async () =>
      f.resolve(respond({ ok: false, error: { code: "IP_RATE_LIMITED", message: "Limit", retryAfterSeconds: 5 }, limits: {} }, 429))
    );
    await waitFor(() => expect(button).toHaveFocus());
    unmount();

    f = pendingFetch();
    render(<UrlActivityScannerPage />);
    button = startScan();
    await act(async () => f.reject(new Error("offline")));
    await screen.findByRole("alert");
    await waitFor(() => expect(button).toHaveFocus());
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does not steal focus or scroll at completion if the user moved focus elsewhere during loading", async () => {
    const f = pendingFetch();
    render(<UrlActivityScannerPage />);
    startScan("https://a.test\nhttps://b.test");
    const back = screen.getByRole("link", { name: /Back to all tools/i });
    back.focus();
    await act(async () => f.resolve(respond(okBody([result(0, 0), result(1, 1)]))));
    await screen.findByRole("region", { name: /Scan results/i });
    expect(back).toHaveFocus();
    expect(scrollSpy).not.toHaveBeenCalled();
    // Focus did not announce the results, so the status region includes the count.
    expect(screen.getByRole("status")).toHaveTextContent("Scan complete. Results for 2 URLs are available.");
  });

  it("does not steal focus on an error if the user moved focus elsewhere during loading", async () => {
    const f = pendingFetch();
    render(<UrlActivityScannerPage />);
    startScan();
    const back = screen.getByRole("link", { name: /Back to all tools/i });
    back.focus();
    await act(async () => f.reject(new Error("offline")));
    await screen.findByRole("alert");
    expect(back).toHaveFocus();
  });

  it("announces loading in the status region when a scan starts while focus is outside the form", () => {
    pendingFetch();
    render(<UrlActivityScannerPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://a.test" } });
    const back = screen.getByRole("link", { name: /Back to all tools/i });
    back.focus();
    fireEvent.submit(document.querySelector("form")!);
    expect(back).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Scanning 1 URL…");
  });

  it("ignores further submissions while a scan is in flight", async () => {
    const f = pendingFetch();
    render(<UrlActivityScannerPage />);
    startScan();
    const form = document.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.submit(form);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(document.getElementById("scan-progress")).toHaveFocus();
    await act(async () => f.resolve(respond(okBody([result(0, 0)]))));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Results — 1 URL$/ })).toHaveFocus());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("handles a fast (already-resolved) response without leaving focus on the body", async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(okBody([result(0, 0)])));
    render(<UrlActivityScannerPage />);
    startScan();
    await waitFor(() => expect(screen.getByRole("heading", { name: /Results — 1 URL$/ })).toHaveFocus());
  });

  it("re-homes focus on the loading message for each repeated scan", async () => {
    let f = pendingFetch();
    render(<UrlActivityScannerPage />);
    startScan();
    expect(document.getElementById("scan-progress")).toHaveFocus();
    await act(async () => f.resolve(respond(okBody([result(0, 0)]))));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Results — 1 URL$/ })).toHaveFocus());

    f = pendingFetch();
    startScan("a\nb");
    expect(document.getElementById("scan-progress")).toHaveFocus();
    expect(document.getElementById("scan-progress")).toHaveTextContent("2 URLs");
    await act(async () => f.resolve(respond(okBody([result(0, 0), result(1, 1)]))));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Results — 2 URLs/ })).toHaveFocus());
  });
});

describe("R2 — classification summary", () => {
  it("shows all 11 classifications with zeros for a single result", async () => {
    render(<UrlActivityScannerPage />);
    const region = await scan([result(0, 0)]);
    const counts = summaryCounts(region);
    expect(Object.keys(counts)).toEqual(CLASSES.map(([c]) => c));
    expect(counts["200 OK"]).toBe(1);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("counts mixed results exactly", async () => {
    render(<UrlActivityScannerPage />);
    const region = await scan(CLASSES.map((_, i) => result(i, i)));
    const counts = summaryCounts(region);
    expect(Object.values(counts)).toEqual(Array(11).fill(1));
  });

  it("counts a 100-result batch with a missing classification and sums to 100", async () => {
    render(<UrlActivityScannerPage />);
    // Ten classifications only: "Unknown" (index 10) is absent.
    const region = await scan(Array.from({ length: 100 }, (_, i) => result(i, i % 10)));
    const counts = summaryCounts(region);
    expect(counts["Unknown"]).toBe(0);
    expect(counts["200 OK"]).toBe(10);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(100);
    expect(screen.getByRole("heading", { name: /Results — 100 URLs/ })).toBeInTheDocument();
  });

  it("introduces no safety, threat or maliciousness categories", async () => {
    render(<UrlActivityScannerPage />);
    const region = await scan([result(0, 0)]);
    const summary = within(region).getByRole("heading", { name: /Classification counts/i }).parentElement!;
    expect(summary.textContent).not.toMatch(/safe|threat|malicious|illegal|danger/i);
  });
});

describe("R6 — export reachability", () => {
  it("keeps a single Export CSV button in the results toolbar next to the heading", async () => {
    render(<UrlActivityScannerPage />);
    await scan([result(0, 0)]);
    const buttons = screen.getAllByRole("button", { name: /Export CSV/i });
    expect(buttons).toHaveLength(1);
    const heading = screen.getByRole("heading", { name: /Results — 1 URL$/ });
    expect(heading.parentElement).toContainElement(buttons[0]);
  });
});

describe("R8 — result key placement and navigation", () => {
  const follows = (a: Node, b: Node) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("places the complete key directly after the form when there are no results", () => {
    render(<UrlActivityScannerPage />);
    const form = document.querySelector("form")!;
    const key = screen.getByRole("region", { name: /Result key/i });
    expect(follows(form, key)).toBe(true);
    expect(within(key).getAllByRole("listitem")).toHaveLength(11);
    expect(within(key).queryByRole("link", { name: /Back to results/i })).not.toBeInTheDocument();
  });

  it("places the complete key after populated results, still fully expanded", async () => {
    render(<UrlActivityScannerPage />);
    const results = await scan([result(0, 0)]);
    const key = screen.getByRole("region", { name: /Result key/i });
    expect(follows(results, key)).toBe(true);
    expect(within(key).getAllByRole("listitem")).toHaveLength(11);
    for (const [cls, meaning] of CLASSES) {
      expect(within(key).getByText(cls)).toBeVisible();
      expect(within(key).getByText(meaning)).toBeVisible();
    }
  });

  it("navigates from results to the key and back with focus following", async () => {
    render(<UrlActivityScannerPage />);
    await scan([result(0, 0)]);
    fireEvent.click(screen.getByRole("link", { name: /Result key/i }));
    expect(screen.getByRole("heading", { name: /^Result key$/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("link", { name: /Back to results/i }));
    expect(screen.getByRole("heading", { name: /Results — 1 URL$/ })).toHaveFocus();
  });

  it("navigation links point at in-page anchors only", async () => {
    render(<UrlActivityScannerPage />);
    await scan([result(0, 0)]);
    expect(screen.getByRole("link", { name: /Result key/i })).toHaveAttribute("href", "#result-key");
    expect(screen.getByRole("link", { name: /Back to results/i })).toHaveAttribute("href", "#results-heading");
  });
});

describe("R5 — conditional fields and order are preserved", () => {
  it("renders results in the returned order with conditional fields", async () => {
    render(<UrlActivityScannerPage />);
    const region = await scan([
      {
        ...result(0, 1),
        original_input: "moved.example.test",
        normalized_url: "https://moved.example.test/",
        redirected_to: "https://dest.example.test/",
        notes: "Redirect chain: 1 hop",
      },
      result(1, 3),
    ]);
    const items = within(within(region).getByRole("list", { name: /Scan results list/i })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Normalized")).toBeInTheDocument();
    expect(within(items[0]).getByText("Redirected to")).toBeInTheDocument();
    expect(within(items[0]).getByText("Notes")).toBeInTheDocument();
    expect(within(items[0]).getByText("Redirect chain: 1 hop")).toBeInTheDocument();
    expect(within(items[1]).getByText("https://host-1.example.test/")).toBeInTheDocument();
    expect(within(items[1]).queryByText("Normalized")).not.toBeInTheDocument();
    expect(within(items[1]).queryByText("Redirected to")).not.toBeInTheDocument();
    expect(within(items[1]).getByText("Checked at")).toBeInTheDocument();
    expect(within(items[1]).getByText("2026-11-24 05:00:00 UTC")).toBeInTheDocument();
    expect(region.querySelectorAll("a[href*='example.test']")).toHaveLength(0);
  });
});
