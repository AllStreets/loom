/**
 * TerminalDeck.test.tsx — render, poller lifecycle, sorted movers, tape
 * duplication, reduced-motion, empty state, stale chip; Phase 17 depth:
 * editable watchlist (add/remove/live pickup), symbol detail overlay,
 * crypto/FX strips, per-source health chips, and no-leaked-intervals
 * lifecycle for the new polls (fake timers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import TerminalDeck from "./TerminalDeck";
import * as quotes from "../../lib/terminal/quotes";
import type { Quote, QuotesSnapshot } from "../../lib/terminal/quotes";
import * as watch from "../../lib/watch/runtime";
import type { MarketBook, MarketChart, MarketCrypto, MarketFx, MarketTrade } from "../../lib/core";

let reduced = false;
vi.mock("framer-motion", () => ({ useReducedMotion: () => reduced }));

// The market source facade is the deck's only path to chart/crypto/fx/floor data.
const source = vi.hoisted(() => ({
  getChart: vi.fn<(symbol: string, signal?: AbortSignal) => Promise<MarketChart>>(),
  getCrypto: vi.fn<(product: string, signal?: AbortSignal) => Promise<MarketCrypto>>(),
  getFx: vi.fn<(base: string, symbols: string[], signal?: AbortSignal) => Promise<MarketFx>>(),
  getBook: vi.fn<(product: string, depth: number, signal?: AbortSignal) => Promise<MarketBook>>(),
  getTrades: vi.fn<(product: string, signal?: AbortSignal) => Promise<MarketTrade[]>>(),
}));
vi.mock("../../lib/market/source", () => source);

function q(symbol: string, price: number, chgPct: number): Quote {
  return { symbol, price, chg: (price * chgPct) / 100, chgPct };
}

const FULL: Quote[] = [
  q("SPY", 500, 0.5),
  q("QQQ", 430, -0.3),
  q("DIA", 390, 0.1),
  q("IWM", 210, -1.2),
  q("AAPL", 190, 0.4),
  q("MSFT", 420, -2.1),
  q("NVDA", 120, 5.5),
  q("GOOGL", 175, 0.9),
  q("AMZN", 185, -0.6),
  q("META", 500, 3.2),
  q("TSLA", 250, -4.8),
  q("^VIX", 14.2, 2.0),
  q("^TNX", 4.25, -0.5),
  q("GC=F", 2350, 0.7),
  q("CL=F", 78.4, -1.1),
  q("BTC-USD", 64000, 1.5),
];

const CHART: MarketChart = {
  symbol: "SPY",
  name: "S&P 500",
  price: 502.5,
  prevClose: 500,
  open: 499.2,
  high: 505.1,
  low: 498.4,
  volume: 12_400_000,
  closes: [499.2, 500.8, 501.9, 502.5],
  timestamps: [1_755_600_000, 1_755_601_800, 1_755_603_600, 1_755_605_400],
};

function cryptoFix(product: string): MarketCrypto {
  return {
    product,
    price: product === "BTC-USD" ? 64000 : 3000,
    bid: null,
    ask: null,
    open24h: 62000,
    high24h: 65000,
    low24h: 61000,
    volume24h: 1000,
    changePct24h: 3.23,
    time: "2026-08-22T12:00:00Z",
  };
}

const FX_FIX: MarketFx = { base: "USD", date: "2026-08-21", rates: { EUR: 0.9207, GBP: 0.7791, JPY: 146.32 } };

// Floor fixtures: bids best-first (desc), asks best-first (asc) → mid 100.
const BOOK_FIX: MarketBook = {
  product: "BTC-USD",
  bids: [
    { price: 99, size: 1 },
    { price: 98, size: 2 },
  ],
  asks: [
    { price: 101, size: 1.5 },
    { price: 102, size: 0.5 },
  ],
};
const TRADES_FIX: MarketTrade[] = [
  { tradeId: 2, time: "2026-08-22T12:00:01Z", price: 100.4, size: 0.1, side: "buy" },
  { tradeId: 1, time: "2026-08-22T12:00:00Z", price: 100.3, size: 0.3, side: "sell" },
];

function stubQuotes(snap: QuotesSnapshot) {
  vi.spyOn(quotes, "getQuotes").mockReturnValue(snap);
  vi.spyOn(quotes, "startQuotes").mockImplementation(() => {});
  vi.spyOn(quotes, "stopQuotes").mockImplementation(() => {});
}

beforeEach(() => {
  reduced = false;
  localStorage.clear();
  vi.spyOn(watch, "getSalient").mockReturnValue([]);
  source.getChart.mockResolvedValue(CHART);
  source.getCrypto.mockImplementation(async (p) => cryptoFix(p));
  source.getFx.mockResolvedValue(FX_FIX);
  source.getBook.mockImplementation(async (p) => ({ ...BOOK_FIX, product: p }));
  source.getTrades.mockResolvedValue(TRADES_FIX);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  source.getChart.mockReset();
  source.getCrypto.mockReset();
  source.getFx.mockReset();
  source.getBook.mockReset();
  source.getTrades.mockReset();
  localStorage.clear();
});

describe("TerminalDeck", () => {
  it("starts the quotes poller on mount and stops it on unmount", () => {
    const start = vi.spyOn(quotes, "startQuotes").mockImplementation(() => {});
    const stop = vi.spyOn(quotes, "stopQuotes").mockImplementation(() => {});
    vi.spyOn(quotes, "getQuotes").mockReturnValue({ quotes: FULL, stale: false, updatedAt: 1 });
    const { unmount } = render(<TerminalDeck />);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("renders index cards, movers, macro, and the wire with data", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId } = render(<TerminalDeck />);
    expect(getByTestId("index-card-SPY")).toBeTruthy();
    expect(getByTestId("index-card-QQQ")).toBeTruthy();
    expect(getByTestId("movers-table")).toBeTruthy();
    expect(getByTestId("macro-chip-^VIX")).toBeTruthy();
    expect(getByTestId("finance-wire")).toBeTruthy();
  });

  it("sorts movers by absolute percent change descending", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId } = render(<TerminalDeck />);
    const table = getByTestId("movers-table");
    const rows = Array.from(table.querySelectorAll('[data-testid^="mover-row-"]'));
    const symbols = rows.map((r) => r.getAttribute("data-testid")!.replace("mover-row-", ""));
    // TSLA -4.8 > NVDA 5.5? |5.5| > |4.8| → NVDA first, then TSLA, then META 3.2, MSFT 2.1...
    expect(symbols[0]).toBe("NVDA");
    expect(symbols[1]).toBe("TSLA");
    expect(symbols[2]).toBe("META");
    // movers are the watchlist only (7 defaults)
    expect(symbols.length).toBe(7);
  });

  it("duplicates tape content for a seamless marquee (motion on)", () => {
    reduced = false;
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId } = render(<TerminalDeck />);
    expect(getByTestId("tape-track")).toBeTruthy();
    expect(getByTestId("tape-copy-a")).toBeTruthy();
    expect(getByTestId("tape-copy-b")).toBeTruthy();
  });

  it("renders a single static tape copy under reduced motion", () => {
    reduced = true;
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId, queryByTestId } = render(<TerminalDeck />);
    expect(getByTestId("tape-static")).toBeTruthy();
    expect(queryByTestId("tape-track")).toBeNull();
  });

  it("shows the quiet empty state when there is no data", () => {
    stubQuotes({ quotes: [], stale: false, updatedAt: 0 });
    const { getByTestId, queryByTestId } = render(<TerminalDeck />);
    expect(getByTestId("terminal-quiet")).toBeTruthy();
    expect(queryByTestId("index-cards")).toBeNull();
  });

  it("says the tape is DARK (not quiet) when the source failed", () => {
    stubQuotes({ quotes: [], stale: true, updatedAt: 0 });
    const { getByTestId } = render(<TerminalDeck />);
    expect(getByTestId("terminal-quiet").textContent).toMatch(/THE TAPE IS DARK/);
  });

  it("shows a STALE chip and dims when serving stale data", () => {
    stubQuotes({ quotes: FULL, stale: true, updatedAt: 1 });
    const { getByTestId } = render(<TerminalDeck />);
    expect(getByTestId("stale-chip")).toBeTruthy();
    const deck = getByTestId("terminal-deck") as HTMLElement;
    expect(parseFloat(deck.style.opacity)).toBeLessThan(1);
  });

  it("filters the wire to finance and geo categories", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    vi.spyOn(watch, "getSalient").mockReturnValue([
      { id: "1", title: "Fed holds rates", category: "finance", source: "auspex", publishedAt: new Date().toISOString(), score: 0.9, reasons: [] },
      { id: "2", title: "Border tension", category: "geo", source: "auspex", publishedAt: new Date().toISOString(), score: 0.7, reasons: [] },
      { id: "3", title: "New telescope", category: "science", source: "auspex", publishedAt: new Date().toISOString(), score: 0.6, reasons: [] },
    ]);
    const { getAllByTestId } = render(<TerminalDeck />);
    const rows = getAllByTestId("wire-row");
    expect(rows.length).toBe(2); // finance + geo, not science
  });

  it("updates on loom-quotes events", () => {
    stubQuotes({ quotes: [], stale: false, updatedAt: 0 });
    const { queryByTestId, getByTestId } = render(<TerminalDeck />);
    expect(queryByTestId("index-cards")).toBeNull();
    act(() => {
      window.dispatchEvent(
        new CustomEvent<QuotesSnapshot>("loom-quotes", { detail: { quotes: FULL, stale: false, updatedAt: 2 } })
      );
    });
    expect(getByTestId("index-cards")).toBeTruthy();
  });
});

// ── Editable watchlist ────────────────────────────────────────────────────────

describe("TerminalDeck — watchlist", () => {
  it("adds a valid ticker: uppercased, persisted, row appears awaiting data", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId } = render(<TerminalDeck />);
    const input = getByTestId("watch-add-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ibm" } });
    expect(input.value).toBe("IBM");
    fireEvent.click(getByTestId("watch-add-btn"));
    // Persisted through the setting; the deck picked up the change live.
    expect(localStorage.getItem("terminal.symbols")).toContain("IBM");
    expect(getByTestId("mover-row-IBM")).toBeTruthy();
    // No quote yet — the row says so instead of pretending.
    expect(getByTestId("mover-awaiting-IBM")).toBeTruthy();
    expect(input.value).toBe(""); // cleared after a successful add
  });

  it("adds on Enter as well as the ADD button", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId } = render(<TerminalDeck />);
    const input = getByTestId("watch-add-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "COIN" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(getByTestId("mover-row-COIN")).toBeTruthy();
  });

  it("rejects an invalid ticker calmly (no write, aria-invalid)", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId, queryByTestId } = render(<TerminalDeck />);
    const input = getByTestId("watch-add-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "BAD$" } });
    fireEvent.click(getByTestId("watch-add-btn"));
    expect(localStorage.getItem("terminal.symbols")).toBeNull(); // never written
    expect(queryByTestId("mover-row-BAD$")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("rejects a duplicate ticker (dedupe)", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId, getAllByTestId } = render(<TerminalDeck />);
    const input = getByTestId("watch-add-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "AAPL" } });
    fireEvent.click(getByTestId("watch-add-btn"));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(getAllByTestId("mover-row-AAPL")).toHaveLength(1);
  });

  it("removes a ticker via the row's hover-reveal control", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId, queryByTestId } = render(<TerminalDeck />);
    fireEvent.click(getByTestId("mover-remove-TSLA"));
    expect(queryByTestId("mover-row-TSLA")).toBeNull();
    expect(localStorage.getItem("terminal.symbols")).not.toContain("TSLA");
  });

  it("states an empty watchlist instead of a blank panel", () => {
    localStorage.setItem("terminal.symbols", "");
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId } = render(<TerminalDeck />);
    expect(getByTestId("movers-empty").textContent).toMatch(/YOUR TAPE IS EMPTY/);
  });

  it("index and macro symbols stay fixed — remove buttons only on movers rows", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { queryByTestId } = render(<TerminalDeck />);
    expect(queryByTestId("mover-remove-SPY")).toBeNull(); // SPY is an index card, not a mover
    expect(queryByTestId("mover-row-^VIX")).toBeNull(); // macro never in movers
  });
});

// ── Symbol detail overlay ─────────────────────────────────────────────────────

describe("TerminalDeck — symbol detail", () => {
  it("opens from an index card, fetches a fresh chart, renders readouts", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId, findByTestId } = render(<TerminalDeck />);
    fireEvent.click(getByTestId("index-card-SPY"));
    expect(getByTestId("symbol-detail")).toBeTruthy();
    expect(source.getChart).toHaveBeenCalledWith("SPY");
    await findByTestId("detail-chart");
    const readouts = getByTestId("detail-readouts");
    expect(readouts.textContent).toMatch(/Open/i);
    expect(readouts.textContent).toMatch(/Prev Close/i);
    expect(readouts.textContent).toMatch(/12\.4M/); // volume, compact
    expect(readouts.textContent).toMatch(/\+0\.50%/); // Δ% from 500 → 502.5
  });

  it("opens from a mover row", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId, findByTestId } = render(<TerminalDeck />);
    fireEvent.click(getByTestId("mover-row-NVDA"));
    await findByTestId("detail-chart");
    expect(source.getChart).toHaveBeenCalledWith("NVDA");
  });

  it("shows a loading state before the chart lands", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    source.getChart.mockReturnValue(new Promise(() => {})); // never resolves
    const { getByTestId } = render(<TerminalDeck />);
    fireEvent.click(getByTestId("index-card-SPY"));
    expect(getByTestId("detail-loading")).toBeTruthy();
  });

  it("states a dark chart calmly when the source fails", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    source.getChart.mockRejectedValue(new Error("429"));
    const { getByTestId, findByTestId } = render(<TerminalDeck />);
    fireEvent.click(getByTestId("index-card-SPY"));
    const err = await findByTestId("detail-error");
    expect(err.textContent).toMatch(/THE CHART IS DARK — the source did not answer\./);
  });

  it("closes on Escape", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId, queryByTestId, findByTestId } = render(<TerminalDeck />);
    fireEvent.click(getByTestId("index-card-SPY"));
    await findByTestId("detail-chart");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByTestId("symbol-detail")).toBeNull();
  });

  it("closes on click outside (backdrop), not on click inside", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId, queryByTestId, findByTestId } = render(<TerminalDeck />);
    fireEvent.click(getByTestId("mover-row-NVDA"));
    await findByTestId("detail-chart");
    fireEvent.click(getByTestId("symbol-detail")); // inside — stays open
    expect(queryByTestId("symbol-detail")).toBeTruthy();
    fireEvent.click(getByTestId("detail-backdrop")); // outside — closes
    expect(queryByTestId("symbol-detail")).toBeNull();
  });

  it("closes via the ✕ control", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId, queryByTestId, findByTestId } = render(<TerminalDeck />);
    fireEvent.click(getByTestId("index-card-QQQ"));
    await findByTestId("detail-chart");
    fireEvent.click(getByTestId("detail-close"));
    expect(queryByTestId("symbol-detail")).toBeNull();
  });
});

// ── Crypto floor overlay ──────────────────────────────────────────────────────

describe("TerminalDeck — crypto floor overlay", () => {
  it("opens from a crypto chip — the clicked symbol IS the product", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { findByTestId, getByTestId } = render(<TerminalDeck />);
    fireEvent.click(await findByTestId("crypto-chip-BTC-USD"));
    expect(getByTestId("floor-detail")).toBeTruthy();
    expect(getByTestId("floor-detail").getAttribute("aria-label")).toBe("BTC-USD floor");
    await waitFor(() =>
      expect(source.getBook).toHaveBeenCalledWith("BTC-USD", expect.any(Number), expect.anything())
    );
    expect(source.getTrades).toHaveBeenCalledWith("BTC-USD", expect.anything());
  });

  it("a different chip opens a different product's floor", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { findByTestId, getByTestId } = render(<TerminalDeck />);
    fireEvent.click(await findByTestId("crypto-chip-ETH-USD"));
    expect(getByTestId("floor-detail").getAttribute("aria-label")).toBe("ETH-USD floor");
    await waitFor(() =>
      expect(source.getBook).toHaveBeenCalledWith("ETH-USD", expect.any(Number), expect.anything())
    );
  });

  it("floor and symbol detail are mutually exclusive — each closes the other", async () => {
    // Both overlays install their own window Esc handler; mounted together,
    // one keypress would close both (review finding, Phase 18 ship gate).
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { findByTestId, getByTestId, queryByTestId } = render(<TerminalDeck />);
    fireEvent.click(getByTestId("index-card-SPY"));
    expect(getByTestId("symbol-detail")).toBeTruthy();
    fireEvent.click(await findByTestId("crypto-chip-BTC-USD"));
    expect(getByTestId("floor-detail")).toBeTruthy();
    expect(queryByTestId("symbol-detail")).toBeNull();
    fireEvent.click(getByTestId("index-card-SPY"));
    expect(getByTestId("symbol-detail")).toBeTruthy();
    expect(queryByTestId("floor-detail")).toBeNull();
  });

  it("renders the ladder and tape from the floor sources", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { findByTestId, findAllByTestId } = render(<TerminalDeck />);
    fireEvent.click(await findByTestId("crypto-chip-BTC-USD"));
    expect((await findAllByTestId("floor-bid-row")).length).toBe(2);
    expect((await findAllByTestId("floor-trade-row")).length).toBe(2);
    expect((await findByTestId("floor-mid")).textContent).toBe("100.00");
  });

  it("closes on Escape", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { findByTestId, queryByTestId } = render(<TerminalDeck />);
    fireEvent.click(await findByTestId("crypto-chip-BTC-USD"));
    await findByTestId("floor-detail");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByTestId("floor-detail")).toBeNull();
  });

  it("closes on click outside (backdrop), not on click inside", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { findByTestId, getByTestId, queryByTestId } = render(<TerminalDeck />);
    fireEvent.click(await findByTestId("crypto-chip-BTC-USD"));
    fireEvent.click(getByTestId("floor-detail")); // inside — stays open
    expect(queryByTestId("floor-detail")).toBeTruthy();
    fireEvent.click(getByTestId("floor-backdrop")); // outside — closes
    expect(queryByTestId("floor-detail")).toBeNull();
  });

  it("closes via the ✕ control", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { findByTestId, getByTestId, queryByTestId } = render(<TerminalDeck />);
    fireEvent.click(await findByTestId("crypto-chip-SOL-USD"));
    fireEvent.click(getByTestId("floor-close"));
    expect(queryByTestId("floor-detail")).toBeNull();
  });

  it("floor polls run ONLY while the overlay is open (fake timers)", async () => {
    vi.useFakeTimers();
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { getByTestId } = render(<TerminalDeck />);

    // No floor polls before the overlay opens — ever.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(source.getBook).not.toHaveBeenCalled();
    expect(source.getTrades).not.toHaveBeenCalled();

    // Open: immediate first tick, then the 2s/3s cadences.
    act(() => {
      fireEvent.click(getByTestId("crypto-chip-BTC-USD"));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(source.getBook).toHaveBeenCalledTimes(1);
    expect(source.getTrades).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(6_000));
    // t=6s: book at 2/4/6 (+3), trades at 3/6 (+2).
    expect(source.getBook).toHaveBeenCalledTimes(4);
    expect(source.getTrades).toHaveBeenCalledTimes(3);

    // Close: zero further floor calls, no matter how long we wait.
    act(() => {
      fireEvent.click(getByTestId("floor-close"));
    });
    const book = source.getBook.mock.calls.length;
    const trades = source.getTrades.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(source.getBook).toHaveBeenCalledTimes(book);
    expect(source.getTrades).toHaveBeenCalledTimes(trades);
    vi.useRealTimers();
  });
});

// ── Crypto + FX strips ────────────────────────────────────────────────────────

describe("TerminalDeck — crypto and fx strips", () => {
  it("renders BTC/ETH/SOL spot + 24h delta from the crypto source", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { findByTestId } = render(<TerminalDeck />);
    const btc = await findByTestId("crypto-chip-BTC-USD");
    expect(btc.textContent).toMatch(/BTC/);
    expect(btc.textContent).toMatch(/64,000/);
    expect(btc.textContent).toMatch(/\+3\.23%/);
    await findByTestId("crypto-chip-ETH-USD");
    await findByTestId("crypto-chip-SOL-USD");
    expect(source.getCrypto).toHaveBeenCalledTimes(3);
  });

  it("states a dark crypto feed when every product fails", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    source.getCrypto.mockRejectedValue(new Error("down"));
    const { findByTestId } = render(<TerminalDeck />);
    const err = await findByTestId("crypto-error");
    expect(err.textContent).toMatch(/THE CRYPTO FEED IS DARK — the source did not answer\./);
  });

  it("renders EUR/GBP/JPY daily rates with an honest daily label", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { findByTestId, getByTestId } = render(<TerminalDeck />);
    const eur = await findByTestId("fx-chip-EUR");
    expect(eur.textContent).toMatch(/0\.9207/);
    expect(getByTestId("fx-chip-JPY").textContent).toMatch(/146\.32/);
    // Frankfurter is daily data — the label says so, with the rate date.
    expect(getByTestId("fx-daily-label").textContent).toMatch(/daily · 2026-08-21/);
    expect(source.getFx).toHaveBeenCalledWith("USD", ["EUR", "GBP", "JPY"], expect.anything());
  });

  it("states a dark fx feed on failure", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    source.getFx.mockRejectedValue(new Error("down"));
    const { findByTestId } = render(<TerminalDeck />);
    const err = await findByTestId("fx-error");
    expect(err.textContent).toMatch(/THE FX FEED IS DARK — the source did not answer\./);
  });

  it("keeps the strips alive even when the equities tape is empty", async () => {
    stubQuotes({ quotes: [], stale: true, updatedAt: 0 });
    const { getByTestId, findByTestId } = render(<TerminalDeck />);
    expect(getByTestId("terminal-quiet")).toBeTruthy();
    await findByTestId("crypto-chip-BTC-USD");
    await findByTestId("fx-chip-EUR");
  });
});

// ── Health chrome ─────────────────────────────────────────────────────────────

describe("TerminalDeck — health chips", () => {
  it("shows go for fresh sources, danger for equities when stale", async () => {
    stubQuotes({ quotes: FULL, stale: true, updatedAt: Date.now() - 300_000 });
    const { getByTestId, findByTestId } = render(<TerminalDeck />);
    // Equities: last poll failed → danger, with the age of the last success.
    expect(getByTestId("health-equities").getAttribute("data-tone")).toBe("danger");
    // Crypto/FX land fresh from the mocks → go.
    await waitFor(() => expect(getByTestId("health-crypto").getAttribute("data-tone")).toBe("go"));
    await findByTestId("fx-chip-EUR");
    expect(getByTestId("health-fx").getAttribute("data-tone")).toBe("go");
  });

  it("shows go for fresh equities and danger + calm copy for a dark source", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: Date.now() });
    source.getCrypto.mockRejectedValue(new Error("down"));
    const { getByTestId, findByTestId } = render(<TerminalDeck />);
    expect(getByTestId("health-equities").getAttribute("data-tone")).toBe("go");
    await findByTestId("crypto-error");
    expect(getByTestId("health-crypto").getAttribute("data-tone")).toBe("danger");
  });

  it("dims (not blank, not lying) before a source's first pull lands", () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: Date.now() });
    source.getCrypto.mockReturnValue(new Promise(() => {}));
    source.getFx.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(<TerminalDeck />);
    expect(getByTestId("health-crypto").getAttribute("data-tone")).toBe("dim");
    expect(getByTestId("health-fx").getAttribute("data-tone")).toBe("dim");
    expect(getByTestId("crypto-warming")).toBeTruthy();
    expect(getByTestId("fx-warming")).toBeTruthy();
  });
});

// ── Poll lifecycle (fake timers — no leaked intervals) ────────────────────────

describe("TerminalDeck — poll lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("crypto polls every 30s, fx every 10min; both stop dead on unmount", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const { unmount } = render(<TerminalDeck />);
    // Immediate first pull on mount: 3 crypto products + 1 fx call.
    expect(source.getCrypto).toHaveBeenCalledTimes(3);
    expect(source.getFx).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(source.getCrypto).toHaveBeenCalledTimes(6);
    expect(source.getFx).toHaveBeenCalledTimes(1); // fx cadence is 10min

    await act(() => vi.advanceTimersByTimeAsync(570_000)); // t = 10min
    expect(source.getFx).toHaveBeenCalledTimes(2);

    unmount();
    const cryptoCalls = source.getCrypto.mock.calls.length;
    const fxCalls = source.getFx.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(1_200_000));
    expect(source.getCrypto).toHaveBeenCalledTimes(cryptoCalls); // no leak
    expect(source.getFx).toHaveBeenCalledTimes(fxCalls); // no leak
  });

  it("pauses while the document is hidden and resumes on visible", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    render(<TerminalDeck />);
    expect(source.getCrypto).toHaveBeenCalledTimes(3);

    Object.defineProperty(document, "hidden", { value: true, configurable: true, writable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(source.getCrypto).toHaveBeenCalledTimes(3); // paused

    Object.defineProperty(document, "hidden", { value: false, configurable: true, writable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(source.getCrypto).toHaveBeenCalledTimes(6); // immediate resume pull
  });

  it("survives a deck switch: unmount kills intervals, remount restarts them", async () => {
    stubQuotes({ quotes: FULL, stale: false, updatedAt: 1 });
    const first = render(<TerminalDeck />);
    expect(source.getCrypto).toHaveBeenCalledTimes(3);
    first.unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(source.getCrypto).toHaveBeenCalledTimes(3); // dead while unmounted

    render(<TerminalDeck />);
    expect(source.getCrypto).toHaveBeenCalledTimes(6); // fresh start
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(source.getCrypto).toHaveBeenCalledTimes(9); // exactly one interval
  });
});
