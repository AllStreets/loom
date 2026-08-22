/**
 * quotes.test.ts — normalization, poll lifecycle, stale path, no-poll-when-inactive,
 * and Tauri routing (fetchAllQuotesTauri path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock core so quoteFetch (the Rust IPC wrapper) can be controlled in tests.
const mockQuoteFetch = vi.fn<[string[]], Promise<string>>();
vi.mock("../core", () => ({
  quoteFetch: (...args: unknown[]) => mockQuoteFetch(...(args as [string[]])),
  ShellUnavailableError: class ShellUnavailableError extends Error {
    constructor() { super("This surface needs the desktop shell."); this.name = "ShellUnavailableError"; }
  },
}));

import {
  normalizeQuote,
  fetchQuote,
  fetchAllQuotes,
  quoteUrl,
  startQuotes,
  stopQuotes,
  getQuotes,
  isPolling,
  getWatchlist,
  addWatchSymbol,
  removeWatchSymbol,
  activeSymbols,
  SYMBOLS,
  SYMBOL_LABELS,
  INDEX_SYMBOLS,
  EQUITY_SYMBOLS,
  MACRO_SYMBOLS,
  _resetQuotesForTests,
} from "./quotes";

// inTauri() now mirrors safeInvoke (checks __TAURI_INTERNALS__ too, which
// test-setup.ts injects globally) — browser-path tests must strip BOTH.
function withNoTauri<T>(fn: () => T): T {
  const restore = stripTauriGlobals();
  try { return fn(); } finally { restore(); }
}

/** Strip both Tauri globals; returns a restore fn. For async suites use in
 *  beforeEach/afterEach so restoration happens after awaited work. */
function stripTauriGlobals(): () => void {
  const w = window as unknown as { __TAURI__?: object; __TAURI_INTERNALS__?: object };
  const t = w.__TAURI__; const ti = w.__TAURI_INTERNALS__;
  delete w.__TAURI__; delete w.__TAURI_INTERNALS__;
  return () => {
    if (t !== undefined) w.__TAURI__ = t;
    if (ti !== undefined) w.__TAURI_INTERNALS__ = ti;
  };
}


// A minimal well-formed Yahoo /v8/chart body.
function chartBody(opts: {
  price: number;
  prevClose?: number;
  shortName?: string;
  closes?: Array<number | null>;
}) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol: "TEST",
            regularMarketPrice: opts.price,
            chartPreviousClose: opts.prevClose,
            shortName: opts.shortName,
          },
          indicators: { quote: [{ close: opts.closes }] },
        },
      ],
    },
  };
}

describe("normalizeQuote", () => {
  it("computes chg and chgPct from price vs previous close", () => {
    const q = normalizeQuote("SPY", chartBody({ price: 110, prevClose: 100 }));
    expect(q).not.toBeNull();
    expect(q!.symbol).toBe("SPY");
    expect(q!.price).toBe(110);
    expect(q!.chg).toBeCloseTo(10);
    expect(q!.chgPct).toBeCloseTo(10);
  });

  it("handles negative moves", () => {
    const q = normalizeQuote("QQQ", chartBody({ price: 90, prevClose: 100 }));
    expect(q!.chg).toBeCloseTo(-10);
    expect(q!.chgPct).toBeCloseTo(-10);
  });

  it("falls back to previousClose when chartPreviousClose absent", () => {
    const body = {
      chart: {
        result: [{ meta: { regularMarketPrice: 105, previousClose: 100 } }],
      },
    };
    const q = normalizeQuote("DIA", body);
    expect(q!.chgPct).toBeCloseTo(5);
  });

  it("yields zero delta when no previous close is available", () => {
    const body = { chart: { result: [{ meta: { regularMarketPrice: 50 } }] } };
    const q = normalizeQuote("IWM", body);
    expect(q!.chg).toBe(0);
    expect(q!.chgPct).toBe(0);
  });

  it("extracts a spark from the intraday close series (drops nulls)", () => {
    const q = normalizeQuote("AAPL", chartBody({ price: 100, prevClose: 98, closes: [98, null, 99, 100] }));
    expect(q!.spark).toEqual([98, 99, 100]);
  });

  it("omits spark when fewer than two clean closes", () => {
    const q = normalizeQuote("MSFT", chartBody({ price: 100, prevClose: 98, closes: [null, 100] }));
    expect(q!.spark).toBeUndefined();
  });

  it("captures shortName as name when present", () => {
    const q = normalizeQuote("NVDA", chartBody({ price: 100, shortName: "NVIDIA Corp" }));
    expect(q!.name).toBe("NVIDIA Corp");
  });

  it("returns null when price is missing", () => {
    expect(normalizeQuote("BAD", { chart: { result: [{ meta: {} }] } })).toBeNull();
    expect(normalizeQuote("BAD", {})).toBeNull();
    expect(normalizeQuote("BAD", null)).toBeNull();
  });
});

describe("symbol universe", () => {
  it("covers all required tickers", () => {
    for (const s of ["SPY", "QQQ", "DIA", "IWM", "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "^VIX", "^TNX", "GC=F", "CL=F", "BTC-USD"]) {
      expect(SYMBOLS).toContain(s);
    }
  });
  it("labels macro symbols", () => {
    expect(SYMBOL_LABELS["^VIX"]).toBe("VIX");
    expect(SYMBOL_LABELS["^TNX"]).toBe("10Y YIELD");
    expect(SYMBOL_LABELS["BTC-USD"]).toBe("BITCOIN");
  });
});

describe("fetchQuote", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a normalized quote on a good response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chartBody({ price: 100, prevClose: 100 }),
    }));
    const q = await fetchQuote("SPY");
    expect(q!.symbol).toBe("SPY");
    expect(q!.price).toBe(100);
  });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    expect(await fetchQuote("SPY")).toBeNull();
  });

  it("returns null on a thrown fetch (network/abort)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await fetchQuote("SPY")).toBeNull();
  });

  it("fetches the quoteUrl for the symbol", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => chartBody({ price: 1 }) });
    vi.stubGlobal("fetch", fetchSpy);
    await fetchQuote("GC=F");
    expect(fetchSpy).toHaveBeenCalledWith(quoteUrl("GC=F"), expect.anything());
  });
});

describe("quoteUrl", () => {
  it("routes through a keyless CORS proxy in the browser (no __TAURI__)", () => {
    withNoTauri(() => {
      const u = quoteUrl("SPY");
      expect(u).toContain("corsproxy.io");
      expect(u).toContain(encodeURIComponent("query1.finance.yahoo.com"));
      expect(u).toContain(encodeURIComponent("SPY"));
    });
  });

  it("encodes special-char symbols safely (nested-encoded through the proxy)", () => {
    // '=' → %3D (inner symbol encode) → %253D (outer proxy-url encode).
    withNoTauri(() => {
      expect(quoteUrl("GC=F")).toContain("GC%253DF");
    });
  });

  it("hits Yahoo directly inside the Tauri webview", () => {
    (window as unknown as { __TAURI__?: object }).__TAURI__ = {};
    try {
      const u = quoteUrl("SPY");
      expect(u.startsWith("https://query1.finance.yahoo.com/")).toBe(true);
      expect(u).not.toContain("corsproxy");
    } finally {
      delete (window as unknown as { __TAURI__?: object }).__TAURI__;
    }
  });
});

describe("fetchAllQuotes", () => {
  // These exercise the BROWSER fetch chain — strip Tauri globals per test.
  let restoreTauri: () => void;
  beforeEach(() => { restoreTauri = stripTauriGlobals(); });
  afterEach(() => { restoreTauri(); vi.restoreAllMocks(); });
  it("drops failed symbols but returns the rest", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      call += 1;
      if (call % 2 === 0) return { ok: false, status: 500 };
      return { ok: true, json: async () => chartBody({ price: 100, prevClose: 99 }) };
    }));
    const quotes = await fetchAllQuotes();
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.length).toBeLessThan(SYMBOLS.length);
  });
});

describe("poll runtime", () => {
  let restoreTauriPR: () => void;
  beforeEach(() => { restoreTauriPR = stripTauriGlobals(); });
  afterEach(() => { restoreTauriPR(); });
  beforeEach(() => {
    _resetQuotesForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    _resetQuotesForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does NOT poll before start (no background burn)", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(isPolling()).toBe(false);
    // advancing time fires nothing
    vi.advanceTimersByTime(120_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("polls immediately on start and populates the snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chartBody({ price: 100, prevClose: 100 }),
    }));
    startQuotes();
    expect(isPolling()).toBe(true);
    await vi.waitFor(() => expect(getQuotes().quotes.length).toBeGreaterThan(0));
    expect(getQuotes().stale).toBe(false);
    expect(getQuotes().updatedAt).toBeGreaterThan(0);
  });

  it("keeps last quotes and flips stale when a later poll fails", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      if (fail) throw new Error("down");
      return { ok: true, json: async () => chartBody({ price: 100, prevClose: 100 }) };
    }));
    startQuotes();
    await vi.waitFor(() => expect(getQuotes().quotes.length).toBeGreaterThan(0));
    const before = getQuotes().quotes.length;

    fail = true;
    await vi.advanceTimersByTimeAsync(60_000); // trigger the interval poll
    await vi.waitFor(() => expect(getQuotes().stale).toBe(true));
    expect(getQuotes().quotes.length).toBe(before); // kept last-known
  });

  it("emits loom-quotes on fresh data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chartBody({ price: 100, prevClose: 100 }),
    }));
    const spy = vi.fn();
    window.addEventListener("loom-quotes", spy);
    startQuotes();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    window.removeEventListener("loom-quotes", spy);
  });

  it("stop clears the interval; no further polling", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chartBody({ price: 100, prevClose: 100 }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    startQuotes();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    stopQuotes();
    expect(isPolling()).toBe(false);
    const calls = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  it("start is idempotent (one interval)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chartBody({ price: 1, prevClose: 1 }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    startQuotes();
    startQuotes();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const afterStart = fetchSpy.mock.calls.length;
    // Only one interval → exactly SYMBOLS.length calls per tick.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy.mock.calls.length).toBe(afterStart + SYMBOLS.length);
  });

  it("hidden-pause: no fetch while document.hidden; polling resumes on visible", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chartBody({ price: 100, prevClose: 100 }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    // Start with the document visible so the poller begins.
    startQuotes();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const callsAfterStart = fetchSpy.mock.calls.length;

    // Simulate the tab becoming hidden.
    Object.defineProperty(document, "hidden", { value: true, configurable: true, writable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    // Advance well past one poll interval — no new fetches should fire.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterStart);

    // Simulate the tab becoming visible again.
    Object.defineProperty(document, "hidden", { value: false, configurable: true, writable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    // The resume path calls poll() immediately — wait for at least one new fetch.
    await vi.waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterStart));

    // Restore document.hidden to false for subsequent tests.
    Object.defineProperty(document, "hidden", { value: false, configurable: true, writable: true });
  });
});

// ── Tauri routing path (fetchAllQuotesTauri) ──────────────────────────────────
describe("fetchAllQuotes — Tauri path (LOOM's Rust proxy)", () => {
  beforeEach(() => {
    mockQuoteFetch.mockReset();
    // Set __TAURI__ so inTauri() returns true
    (window as unknown as { __TAURI__?: object }).__TAURI__ = {};
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI__?: object }).__TAURI__;
    vi.restoreAllMocks();
  });

  it("routes through quoteFetch (invoke) when Tauri is present, not browser fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const raw = JSON.stringify(SYMBOLS.map((s) => ({ symbol: s, body: chartBody({ price: 100, prevClose: 99 }) })));
    mockQuoteFetch.mockResolvedValue(raw);
    const quotes = await fetchAllQuotes();
    expect(mockQuoteFetch).toHaveBeenCalledWith([...SYMBOLS]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(quotes.length).toBe(SYMBOLS.length);
  });

  it("normalizes the Rust array shape through the existing normalizer", async () => {
    const body = chartBody({ price: 450, prevClose: 440, shortName: "S&P 500" });
    const raw = JSON.stringify([{ symbol: "SPY", body }]);
    mockQuoteFetch.mockResolvedValue(raw);
    const quotes = await fetchAllQuotes();
    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe("SPY");
    expect(quotes[0].price).toBe(450);
    expect(quotes[0].name).toBe("S&P 500");
  });

  it("null body entries are dropped (partial success — individual fetch failures)", async () => {
    const raw = JSON.stringify([
      { symbol: "SPY", body: chartBody({ price: 450, prevClose: 440 }) },
      { symbol: "^VIX", body: null },
    ]);
    mockQuoteFetch.mockResolvedValue(raw);
    const quotes = await fetchAllQuotes();
    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe("SPY");
  });

  it("returns empty array on quoteFetch rejection (never throws)", async () => {
    mockQuoteFetch.mockRejectedValue(new Error("IPC error"));
    const quotes = await fetchAllQuotes();
    expect(quotes).toEqual([]);
  });

  it("returns empty array on malformed JSON from quoteFetch", async () => {
    mockQuoteFetch.mockResolvedValue("not-json");
    const quotes = await fetchAllQuotes();
    expect(quotes).toEqual([]);
  });
});

// ── Editable watchlist (terminal.symbols) ─────────────────────────────────────
describe("watchlist config", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("getWatchlist defaults to EQUITY_SYMBOLS when never set", () => {
    expect(getWatchlist()).toEqual([...EQUITY_SYMBOLS]);
  });

  it("getWatchlist reads the setting, dropping malformed entries and dupes", () => {
    localStorage.setItem("terminal.symbols", "AAPL,IBM,AAPL,bad$,GC=F");
    // "bad$" uppercases to "BAD$" which fails the ticker regex → dropped.
    expect(getWatchlist()).toEqual(["AAPL", "IBM", "GC=F"]);
  });

  it("getWatchlist returns [] for an explicitly empty setting", () => {
    localStorage.setItem("terminal.symbols", "");
    expect(getWatchlist()).toEqual([]);
  });

  it("getWatchlist caps a hand-edited over-length list at WATCHLIST_MAX on read", () => {
    // 30 valid tickers written raw — bypassing setSetting's write-time cap —
    // must not fan out past the rate-friendly maximum at the fetch layer.
    const many = Array.from({ length: 30 }, (_, i) => `T${i}`).join(",");
    localStorage.setItem("terminal.symbols", many);
    const list = getWatchlist();
    expect(list.length).toBe(24);
    expect(list[0]).toBe("T0");
    expect(list[23]).toBe("T23");
  });

  it("addWatchSymbol uppercases, validates, dedupes, persists", () => {
    expect(addWatchSymbol("ibm")).toBe(true);
    expect(getWatchlist()).toEqual([...EQUITY_SYMBOLS, "IBM"]);
    expect(addWatchSymbol("IBM")).toBe(false); // dupe
    expect(addWatchSymbol("bad$")).toBe(false); // invalid
    expect(getWatchlist()).toEqual([...EQUITY_SYMBOLS, "IBM"]);
  });

  it("removeWatchSymbol removes and persists; unknown symbol is a no-op", () => {
    expect(removeWatchSymbol("TSLA")).toBe(true);
    expect(getWatchlist()).not.toContain("TSLA");
    expect(removeWatchSymbol("TSLA")).toBe(false);
  });

  it("activeSymbols = fixed indices + watchlist + fixed macro, deduped", () => {
    localStorage.setItem("terminal.symbols", "AAPL,BTC-USD,SPY");
    const syms = activeSymbols();
    // Fixed sets always present; watchlisted dupes (BTC-USD, SPY) not doubled.
    for (const s of [...INDEX_SYMBOLS, ...MACRO_SYMBOLS, "AAPL"]) expect(syms).toContain(s);
    expect(syms.filter((s) => s === "BTC-USD")).toHaveLength(1);
    expect(syms.filter((s) => s === "SPY")).toHaveLength(1);
  });

  it("activeSymbols equals SYMBOLS with the default watchlist", () => {
    expect(activeSymbols()).toEqual([...SYMBOLS]);
  });
});

// ── Live watchlist pickup (loom-settings-changed → immediate refresh) ─────────
describe("poll runtime — watchlist live pickup", () => {
  let restoreTauriWL: () => void;
  beforeEach(() => {
    restoreTauriWL = stripTauriGlobals();
    localStorage.clear();
    _resetQuotesForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    _resetQuotesForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    restoreTauriWL();
  });

  function settingsEvent(key: string) {
    window.dispatchEvent(new CustomEvent("loom-settings-changed", { detail: { key, value: "x" } }));
  }

  it("refreshes immediately (with the new universe) on terminal.symbols change", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      fetched.push(url);
      return { ok: true, json: async () => chartBody({ price: 100, prevClose: 99 }) };
    }));
    startQuotes();
    await vi.waitFor(() => expect(getQuotes().quotes.length).toBeGreaterThan(0));
    const callsAfterStart = fetched.length;

    localStorage.setItem("terminal.symbols", "IBM"); // watchlist = IBM only
    settingsEvent("terminal.symbols");
    // Immediate re-poll: indices + IBM + macro = 10 symbols, no 60s wait.
    await vi.waitFor(() => expect(fetched.length).toBe(callsAfterStart + 10));
    expect(fetched.slice(callsAfterStart).some((u) => u.includes("IBM"))).toBe(true);
  });

  it("ignores other settings keys", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chartBody({ price: 100, prevClose: 99 }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    startQuotes();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const calls = fetchSpy.mock.calls.length;
    settingsEvent("cockpit.deck");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  it("does nothing when stopped (no leaked listener)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chartBody({ price: 100, prevClose: 99 }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    startQuotes();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    stopQuotes();
    const calls = fetchSpy.mock.calls.length;
    settingsEvent("terminal.symbols");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });
});
