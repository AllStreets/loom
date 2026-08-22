/**
 * browser.test.ts — market browser adapters: validation, normalizers (same
 * shapes as market.rs, checked against real-response fixtures), and fetchers
 * with mocked fetch. No network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PRODUCT_WHITELIST,
  isValidSymbol,
  isValidProduct,
  isValidFxCode,
  clampDepth,
  normalizeChart,
  normalizeCrypto,
  normalizeBook,
  normalizeTrades,
  normalizeFx,
  fetchChartBrowser,
  fetchCryptoBrowser,
  fetchBookBrowser,
  fetchTradesBrowser,
  fetchFxBrowser,
} from "./browser";

// ── Fixtures (shapes captured from the live endpoints) ──────────────────────

const chartFixture = {
  chart: {
    result: [
      {
        meta: {
          symbol: "SPY",
          shortName: "SPDR S&P 500",
          regularMarketPrice: 450.5,
          chartPreviousClose: 445.0,
        },
        timestamp: [1000, 1060, 1120, 1180],
        indicators: {
          quote: [
            {
              close: [448.0, null, 450.5, 451.0],
              open: [447.5, null, 450.0, 450.6],
              high: [448.5, null, 451.2, 451.5],
              low: [447.0, null, 449.8, 450.2],
              volume: [1000, null, 2000, 1500],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

const tickerFixture = {
  ask: "77361.43",
  bid: "77361.42",
  volume: "8236.076",
  trade_id: 1077999263,
  price: "77361.43",
  size: "0.00021692",
  time: "2026-08-22T17:51:35.388253286Z",
};

const statsFixture = {
  open: "77376.05",
  high: "78828.37",
  low: "76471.7",
  last: "77353.5",
  volume: "8236.076",
  volume_30day: "191406.87",
};

const bookFixture = {
  sequence: 123,
  bids: [
    ["77361.42", "0.061", 4],
    ["77360.41", "0.02", 1],
    ["77360.16", "0.00007", 1],
    ["bogus"],
    ["77359.90", "0.001", 1],
  ],
  asks: [
    ["77361.43", "0.5", 2],
    ["77362.00", "1.25", 1],
  ],
};

const tradesFixture = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    trade_id: 1000 + i,
    side: i % 2 === 0 ? "buy" : "sell",
    size: "0.0024",
    price: "77367.82",
    time: "2026-08-22T17:51:34.074499Z",
  }));

const fxFixture = {
  amount: 1.0,
  base: "USD",
  date: "2026-08-21",
  rates: { EUR: 0.85477, GBP: 0.73228, JPY: 158.7 },
};

// ── Validation (mirror of market.rs tables) ─────────────────────────────────

describe("validation", () => {
  it("accepts valid symbols", () => {
    for (const s of ["SPY", "^VIX", "^TNX", "GC=F", "BTC-USD", "BRK.B", "A", "ABCDEFGHIJKL"]) {
      expect(isValidSymbol(s), s).toBe(true);
    }
  });

  it("rejects invalid symbols", () => {
    for (const s of ["", "bad sym", "ABCDEFGHIJKLM", "$PY", "../x", "spy", "A/B"]) {
      expect(isValidSymbol(s), s).toBe(false);
    }
  });

  it("accepts exactly the product whitelist", () => {
    for (const p of PRODUCT_WHITELIST) expect(isValidProduct(p), p).toBe(true);
    for (const p of ["DOGE-USD", "XRP-USD", "btc-usd", "BTC-EUR", "BTC", ""]) {
      expect(isValidProduct(p), p).toBe(false);
    }
  });

  it("validates fx codes as exactly three uppercase letters", () => {
    for (const c of ["USD", "EUR", "GBP", "JPY"]) expect(isValidFxCode(c), c).toBe(true);
    for (const c of ["", "US", "USDX", "usd", "U$D", "1SD"]) expect(isValidFxCode(c), c).toBe(false);
  });

  it("clamps depth to [1, 50]", () => {
    expect(clampDepth(0)).toBe(1);
    expect(clampDepth(1)).toBe(1);
    expect(clampDepth(12)).toBe(12);
    expect(clampDepth(50)).toBe(50);
    expect(clampDepth(999)).toBe(50);
    expect(clampDepth(NaN)).toBe(1);
    expect(clampDepth(7.9)).toBe(7);
  });
});

// ── Normalizers ─────────────────────────────────────────────────────────────

describe("normalizeChart", () => {
  it("produces the market.rs shape from a full fixture", () => {
    const c = normalizeChart("SPY", chartFixture)!;
    expect(c).not.toBeNull();
    expect(c.symbol).toBe("SPY");
    expect(c.name).toBe("SPDR S&P 500");
    expect(c.price).toBe(450.5);
    expect(c.prevClose).toBe(445.0);
    // Nulls dropped pairwise, timestamps aligned.
    expect(c.closes).toEqual([448.0, 450.5, 451.0]);
    expect(c.timestamps).toEqual([1000, 1120, 1180]);
    // Day OHLC/volume derived from the series.
    expect(c.open).toBe(447.5);
    expect(c.high).toBe(451.5);
    expect(c.low).toBe(447.0);
    expect(c.volume).toBe(4500);
  });

  it("returns null when the price is missing", () => {
    expect(normalizeChart("X", { chart: { result: [{ meta: { shortName: "X" } }] } })).toBeNull();
    expect(normalizeChart("X", {})).toBeNull();
    expect(normalizeChart("X", null)).toBeNull();
  });

  it("falls back prevClose: previousClose, then price on zero/absent", () => {
    const meta = (m: Record<string, unknown>) => ({ chart: { result: [{ meta: m }] } });
    expect(normalizeChart("A", meta({ regularMarketPrice: 10, previousClose: 8 }))!.prevClose).toBe(8);
    expect(normalizeChart("A", meta({ regularMarketPrice: 10, chartPreviousClose: 0 }))!.prevClose).toBe(10);
    const bare = normalizeChart("A", meta({ regularMarketPrice: 10 }))!;
    expect(bare.prevClose).toBe(10);
    expect(bare.closes).toEqual([]);
    expect(bare.open).toBeNull();
    expect(bare.volume).toBeNull();
  });
});

describe("normalizeCrypto", () => {
  it("merges ticker and stats, parsing Coinbase string numbers", () => {
    const c = normalizeCrypto("BTC-USD", tickerFixture, statsFixture)!;
    expect(c.product).toBe("BTC-USD");
    expect(c.price).toBe(77361.43);
    expect(c.bid).toBe(77361.42);
    expect(c.ask).toBe(77361.43);
    expect(c.open24h).toBe(77376.05);
    expect(c.high24h).toBe(78828.37);
    expect(c.low24h).toBe(76471.7);
    expect(c.volume24h).toBe(8236.076);
    expect(c.changePct24h).toBeCloseTo(((77361.43 - 77376.05) / 77376.05) * 100, 9);
    expect(c.time).toBe("2026-08-22T17:51:35.388253286Z");
  });

  it("degrades stats fields to null when stats are missing", () => {
    const c = normalizeCrypto("ETH-USD", tickerFixture, null)!;
    expect(c.price).toBe(77361.43);
    expect(c.open24h).toBeNull();
    expect(c.changePct24h).toBeNull();
  });

  it("returns null without a ticker price", () => {
    expect(normalizeCrypto("BTC-USD", { bid: "1.0" }, statsFixture)).toBeNull();
  });
});

describe("normalizeBook", () => {
  it("truncates each side to depth and skips malformed rows", () => {
    const b = normalizeBook("BTC-USD", bookFixture, 2)!;
    expect(b.bids).toHaveLength(2);
    expect(b.asks).toHaveLength(2);
    expect(b.bids[0]).toEqual({ price: 77361.42, size: 0.061 });
  });

  it("takes all valid rows when depth exceeds rows", () => {
    const b = normalizeBook("BTC-USD", bookFixture, 50)!;
    expect(b.bids).toHaveLength(4); // malformed row skipped
    expect(b.asks).toHaveLength(2);
  });

  it("returns null when neither side is present", () => {
    expect(normalizeBook("BTC-USD", { sequence: 1 }, 10)).toBeNull();
  });
});

describe("normalizeTrades", () => {
  it("caps at 30 and maps fields", () => {
    const t = normalizeTrades(tradesFixture(45))!;
    expect(t).toHaveLength(30);
    expect(t[0]).toEqual({
      tradeId: 1000,
      time: "2026-08-22T17:51:34.074499Z",
      price: 77367.82,
      size: 0.0024,
      side: "buy",
    });
    expect(t[1].side).toBe("sell");
  });

  it("skips malformed rows and returns null for non-arrays", () => {
    expect(normalizeTrades([...tradesFixture(3), { garbage: true }])).toHaveLength(3);
    expect(normalizeTrades({ message: "NotFound" })).toBeNull();
  });
});

describe("normalizeFx", () => {
  it("produces base/date/rates", () => {
    const fx = normalizeFx(fxFixture)!;
    expect(fx.base).toBe("USD");
    expect(fx.date).toBe("2026-08-21");
    expect(fx.rates).toEqual({ EUR: 0.85477, GBP: 0.73228, JPY: 158.7 });
  });

  it("returns null when rates are missing", () => {
    expect(normalizeFx({ base: "USD", date: "2026-08-21" })).toBeNull();
    expect(normalizeFx(null)).toBeNull();
  });
});

// ── Fetchers (mocked fetch) ─────────────────────────────────────────────────

const mockFetch = vi.fn();

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchChartBrowser", () => {
  it("routes through the existing corsproxy dev path outside Tauri", async () => {
    // test-setup injects __TAURI_INTERNALS__; a plain browser has neither global.
    const w = window as unknown as Record<string, unknown>;
    const orig = w.__TAURI_INTERNALS__;
    delete w.__TAURI_INTERNALS__;
    try {
      mockFetch.mockResolvedValue(jsonResponse(chartFixture));
      const c = await fetchChartBrowser("SPY");
      expect(c!.price).toBe(450.5);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("corsproxy.io");
      expect(url).toContain(encodeURIComponent("https://query1.finance.yahoo.com/v8/finance/chart/SPY"));
      // The 10s timeout signal must be attached.
      expect((mockFetch.mock.calls[0][1] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    } finally {
      if (orig !== undefined) w.__TAURI_INTERNALS__ = orig;
    }
  });

  it("hits Yahoo direct inside the Tauri webview (no third-party proxy)", async () => {
    // __TAURI_INTERNALS__ is present via test-setup → quoteUrl goes direct.
    mockFetch.mockResolvedValue(jsonResponse(chartFixture));
    await fetchChartBrowser("SPY");
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=15m&range=1d");
  });

  it("rejects an invalid symbol BEFORE any request", async () => {
    expect(await fetchChartBrowser("../etc")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null on HTTP error and on network failure", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false));
    expect(await fetchChartBrowser("SPY")).toBeNull();
    mockFetch.mockRejectedValueOnce(new Error("net down"));
    expect(await fetchChartBrowser("SPY")).toBeNull();
  });
});

describe("fetchCryptoBrowser", () => {
  it("fetches ticker + stats direct from Coinbase and merges", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(jsonResponse(url.endsWith("/stats") ? statsFixture : tickerFixture)),
    );
    const c = await fetchCryptoBrowser("BTC-USD");
    expect(c!.price).toBe(77361.43);
    expect(c!.open24h).toBe(77376.05);
    const urls = mockFetch.mock.calls.map((call) => call[0] as string);
    expect(urls).toContain("https://api.exchange.coinbase.com/products/BTC-USD/ticker");
    expect(urls).toContain("https://api.exchange.coinbase.com/products/BTC-USD/stats");
  });

  it("survives a stats failure (fields null) but not a ticker failure", async () => {
    mockFetch.mockImplementation((url: string) =>
      url.endsWith("/stats") ? Promise.reject(new Error("boom")) : Promise.resolve(jsonResponse(tickerFixture)),
    );
    const c = await fetchCryptoBrowser("BTC-USD");
    expect(c!.price).toBe(77361.43);
    expect(c!.open24h).toBeNull();

    mockFetch.mockImplementation((url: string) =>
      url.endsWith("/ticker") ? Promise.reject(new Error("boom")) : Promise.resolve(jsonResponse(statsFixture)),
    );
    expect(await fetchCryptoBrowser("BTC-USD")).toBeNull();
  });

  it("rejects a non-whitelisted product BEFORE any request", async () => {
    expect(await fetchCryptoBrowser("DOGE-USD")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fetchBookBrowser", () => {
  it("fetches level-2 and truncates to the clamped depth", async () => {
    mockFetch.mockResolvedValue(jsonResponse(bookFixture));
    const b = await fetchBookBrowser("BTC-USD", 2);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.exchange.coinbase.com/products/BTC-USD/book?level=2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(b!.bids).toHaveLength(2);
  });

  it("clamps an absurd depth to 50", async () => {
    mockFetch.mockResolvedValue(jsonResponse(bookFixture));
    const b = await fetchBookBrowser("BTC-USD", 9999);
    expect(b!.bids).toHaveLength(4); // all valid rows, well under 50
  });

  it("rejects invalid product before fetch; null on HTTP error", async () => {
    expect(await fetchBookBrowser("EVIL-USD", 10)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockResolvedValue(jsonResponse({}, false));
    expect(await fetchBookBrowser("BTC-USD", 10)).toBeNull();
  });
});

describe("fetchTradesBrowser", () => {
  it("fetches trades direct and caps at 30", async () => {
    mockFetch.mockResolvedValue(jsonResponse(tradesFixture(45)));
    const t = await fetchTradesBrowser("SOL-USD");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.exchange.coinbase.com/products/SOL-USD/trades",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(t).toHaveLength(30);
  });

  it("rejects invalid product before fetch", async () => {
    expect(await fetchTradesBrowser("btc-usd")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fetchFxBrowser", () => {
  it("fetches Frankfurter direct with base and joined symbols", async () => {
    mockFetch.mockResolvedValue(jsonResponse(fxFixture));
    const fx = await fetchFxBrowser("USD", ["EUR", "GBP", "JPY"]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,JPY",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fx!.rates.JPY).toBe(158.7);
  });

  it("rejects bad base, bad codes, and empty lists BEFORE any request", async () => {
    expect(await fetchFxBrowser("usd", ["EUR"])).toBeNull();
    expect(await fetchFxBrowser("USD", ["EU"])).toBeNull();
    expect(await fetchFxBrowser("USD", [])).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null on a malformed body", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ nope: true }));
    expect(await fetchFxBrowser("USD", ["EUR"])).toBeNull();
  });
});
