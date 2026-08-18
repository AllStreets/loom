/**
 * quotes.test.ts — normalization, poll lifecycle, stale path, no-poll-when-inactive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeQuote,
  fetchQuote,
  fetchAllQuotes,
  quoteUrl,
  startQuotes,
  stopQuotes,
  getQuotes,
  isPolling,
  SYMBOLS,
  SYMBOL_LABELS,
  _resetQuotesForTests,
} from "./quotes";

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
    // jsdom has no window.__TAURI__ → proxy path.
    const u = quoteUrl("SPY");
    expect(u).toContain("corsproxy.io");
    expect(u).toContain(encodeURIComponent("query1.finance.yahoo.com"));
    expect(u).toContain(encodeURIComponent("SPY"));
  });

  it("encodes special-char symbols safely (nested-encoded through the proxy)", () => {
    // '=' → %3D (inner symbol encode) → %253D (outer proxy-url encode).
    expect(quoteUrl("GC=F")).toContain("GC%253DF");
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
  afterEach(() => vi.restoreAllMocks());
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
});
