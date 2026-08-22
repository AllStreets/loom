/**
 * source.test.ts — the market source facade routes by runtime and never
 * resolves null: desktop → market.rs typed commands; browser dev → the
 * browser adapters, with adapter null converted to a thrown Error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const core = vi.hoisted(() => ({
  marketChart: vi.fn(),
  marketCrypto: vi.fn(),
  marketFx: vi.fn(),
  marketBook: vi.fn(),
  marketTrades: vi.fn(),
}));
vi.mock("../core", () => core);

const browser = vi.hoisted(() => ({
  fetchChartBrowser: vi.fn(),
  fetchCryptoBrowser: vi.fn(),
  fetchFxBrowser: vi.fn(),
  fetchBookBrowser: vi.fn(),
  fetchTradesBrowser: vi.fn(),
}));
vi.mock("./browser", () => browser);

import { getBook, getChart, getCrypto, getFx, getTrades } from "./source";

/** Strip both Tauri globals; returns a restore fn. */
function stripTauriGlobals(): () => void {
  const w = window as unknown as { __TAURI__?: object; __TAURI_INTERNALS__?: object };
  const t = w.__TAURI__;
  const ti = w.__TAURI_INTERNALS__;
  delete w.__TAURI__;
  delete w.__TAURI_INTERNALS__;
  return () => {
    if (t !== undefined) w.__TAURI__ = t;
    if (ti !== undefined) w.__TAURI_INTERNALS__ = ti;
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("source facade — desktop (Tauri present via test-setup)", () => {
  it("routes chart/crypto/fx through the Rust commands, not the browser adapters", async () => {
    core.marketChart.mockResolvedValue({ symbol: "SPY" });
    core.marketCrypto.mockResolvedValue({ product: "BTC-USD" });
    core.marketFx.mockResolvedValue({ base: "USD" });
    await getChart("SPY");
    await getCrypto("BTC-USD");
    await getFx("USD", ["EUR"]);
    expect(core.marketChart).toHaveBeenCalledWith("SPY");
    expect(core.marketCrypto).toHaveBeenCalledWith("BTC-USD");
    expect(core.marketFx).toHaveBeenCalledWith("USD", ["EUR"]);
    expect(browser.fetchChartBrowser).not.toHaveBeenCalled();
    expect(browser.fetchCryptoBrowser).not.toHaveBeenCalled();
    expect(browser.fetchFxBrowser).not.toHaveBeenCalled();
  });

  it("routes book/trades through the Rust commands, not the browser adapters", async () => {
    core.marketBook.mockResolvedValue({ product: "BTC-USD", bids: [], asks: [] });
    core.marketTrades.mockResolvedValue([]);
    await getBook("BTC-USD", 12);
    await getTrades("BTC-USD");
    expect(core.marketBook).toHaveBeenCalledWith("BTC-USD", 12);
    expect(core.marketTrades).toHaveBeenCalledWith("BTC-USD");
    expect(browser.fetchBookBrowser).not.toHaveBeenCalled();
    expect(browser.fetchTradesBrowser).not.toHaveBeenCalled();
  });
});

describe("source facade — browser dev (no Tauri globals)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stripTauriGlobals();
  });
  afterEach(() => {
    restore();
  });

  it("routes through the browser adapters", async () => {
    browser.fetchChartBrowser.mockResolvedValue({ symbol: "SPY" });
    browser.fetchCryptoBrowser.mockResolvedValue({ product: "BTC-USD" });
    browser.fetchFxBrowser.mockResolvedValue({ base: "USD" });
    browser.fetchBookBrowser.mockResolvedValue({ product: "BTC-USD", bids: [], asks: [] });
    browser.fetchTradesBrowser.mockResolvedValue([]);
    await getChart("SPY");
    await getCrypto("BTC-USD");
    await getFx("USD", ["EUR"]);
    await getBook("BTC-USD", 12);
    await getTrades("BTC-USD");
    expect(browser.fetchChartBrowser).toHaveBeenCalled();
    expect(browser.fetchCryptoBrowser).toHaveBeenCalled();
    expect(browser.fetchFxBrowser).toHaveBeenCalled();
    expect(browser.fetchBookBrowser).toHaveBeenCalledWith("BTC-USD", 12, undefined);
    expect(browser.fetchTradesBrowser).toHaveBeenCalledWith("BTC-USD", undefined);
    expect(core.marketChart).not.toHaveBeenCalled();
    expect(core.marketBook).not.toHaveBeenCalled();
    expect(core.marketTrades).not.toHaveBeenCalled();
  });

  it("converts adapter null into a thrown Error (one failure path for the UI)", async () => {
    browser.fetchChartBrowser.mockResolvedValue(null);
    browser.fetchCryptoBrowser.mockResolvedValue(null);
    browser.fetchFxBrowser.mockResolvedValue(null);
    browser.fetchBookBrowser.mockResolvedValue(null);
    browser.fetchTradesBrowser.mockResolvedValue(null);
    await expect(getChart("SPY")).rejects.toThrow(/did not answer/);
    await expect(getCrypto("BTC-USD")).rejects.toThrow(/did not answer/);
    await expect(getFx("USD", ["EUR"])).rejects.toThrow(/did not answer/);
    await expect(getBook("BTC-USD", 12)).rejects.toThrow(/did not answer/);
    await expect(getTrades("BTC-USD")).rejects.toThrow(/did not answer/);
  });
});
