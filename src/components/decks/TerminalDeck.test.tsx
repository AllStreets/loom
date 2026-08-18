/**
 * TerminalDeck.test.tsx — render, poller lifecycle, sorted movers, tape
 * duplication, reduced-motion, empty state, stale chip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import TerminalDeck from "./TerminalDeck";
import * as quotes from "../../lib/terminal/quotes";
import type { Quote, QuotesSnapshot } from "../../lib/terminal/quotes";
import * as watch from "../../lib/watch/runtime";

let reduced = false;
vi.mock("framer-motion", () => ({ useReducedMotion: () => reduced }));

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

function stubQuotes(snap: QuotesSnapshot) {
  vi.spyOn(quotes, "getQuotes").mockReturnValue(snap);
  vi.spyOn(quotes, "startQuotes").mockImplementation(() => {});
  vi.spyOn(quotes, "stopQuotes").mockImplementation(() => {});
}

beforeEach(() => {
  reduced = false;
  vi.spyOn(watch, "getSalient").mockReturnValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    // movers are equities only (7 of them)
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
