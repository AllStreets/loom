/**
 * Floor.test.tsx — THE FLOOR inside the Terminal: pure helpers (ladder math,
 * taker-side inversion, formatting), ladder/tape/header anatomy, calm
 * per-panel errors, and the poll lifecycle (2s/3s/30s cadences, unmount stops
 * everything, document-hidden pause) under fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import Floor, {
  cumulate,
  bookStats,
  takerSide,
  fmtTradeTime,
  fmtFloorPrice,
  fmtFloorSize,
} from "./Floor";
import type { MarketBook, MarketCrypto, MarketTrade } from "../../lib/core";

// Mock the market source facade — the floor's only data seam
const marketSource = vi.hoisted(() => ({
  getBook: vi.fn(),
  getTrades: vi.fn(),
  getCrypto: vi.fn(),
}));
vi.mock("../../lib/market/source", () => marketSource);

// ── Fixtures ─────────────────────────────────────────────────────────────────
// bids best-first (desc), asks best-first (asc): mid 100, spread 2 → 200bps.
const FAKE_BOOK: MarketBook = {
  product: "BTC-USD",
  bids: [
    { price: 99, size: 1 },
    { price: 98, size: 2 },
    { price: 97, size: 3 },
  ],
  asks: [
    { price: 101, size: 1.5 },
    { price: 102, size: 0.5 },
  ],
};
const FAKE_TRADES: MarketTrade[] = [
  // Coinbase side = MAKER side: "buy" → taker sold; "sell" → taker bought.
  { tradeId: 3, time: "2026-08-22T12:00:02Z", price: 100.5, size: 0.2, side: "sell" },
  { tradeId: 2, time: "2026-08-22T12:00:01Z", price: 100.4, size: 0.1, side: "buy" },
  { tradeId: 1, time: "2026-08-22T12:00:00Z", price: 100.3, size: 0.3, side: "sell" },
];
const FAKE_CRYPTO: MarketCrypto = {
  product: "BTC-USD",
  price: 100.25,
  bid: 99,
  ask: 101,
  open24h: 95,
  high24h: 102,
  low24h: 94,
  volume24h: 1234,
  changePct24h: 5.53,
  time: "2026-08-22T12:00:02Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  marketSource.getBook.mockResolvedValue(FAKE_BOOK);
  marketSource.getTrades.mockResolvedValue(FAKE_TRADES);
  marketSource.getCrypto.mockResolvedValue(FAKE_CRYPTO);
});

afterEach(() => {
  cleanup();
  // Always restore real timers to prevent state leaking between tests
  vi.useRealTimers();
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("floor helpers", () => {
  it("cumulate produces a running sum in the given order", () => {
    const rows = cumulate([
      { price: 99, size: 1 },
      { price: 98, size: 2 },
      { price: 97, size: 3 },
    ]);
    expect(rows.map((r) => r.cum)).toEqual([1, 3, 6]);
    expect(cumulate([])).toEqual([]);
  });

  it("bookStats derives mid + spread (abs and bps) from the touch", () => {
    const s = bookStats(FAKE_BOOK);
    expect(s).not.toBeNull();
    expect(s!.mid).toBe(100);
    expect(s!.spreadAbs).toBe(2);
    expect(s!.spreadBps).toBeCloseTo(200, 6);
  });

  it("bookStats is null for a one-sided or empty book", () => {
    expect(bookStats(null)).toBeNull();
    expect(bookStats({ product: "BTC-USD", bids: [], asks: [] })).toBeNull();
    expect(bookStats({ product: "BTC-USD", bids: [{ price: 99, size: 1 }], asks: [] })).toBeNull();
  });

  it("takerSide inverts the maker side — maker buy means the taker SOLD", () => {
    // Coinbase Exchange `side` is the MAKER side; the tape tints by taker.
    expect(takerSide("buy")).toBe("sell");
    expect(takerSide("sell")).toBe("buy");
  });

  it("fmtTradeTime renders HH:MM:SS and degrades calmly on junk", () => {
    const t = fmtTradeTime("2026-08-22T12:00:02Z");
    expect(t).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(t.endsWith(":02")).toBe(true);
    expect(fmtTradeTime("not-a-time")).toBe("--:--:--");
  });

  it("fmtFloorPrice: 2dp with separators, 4dp under a dollar", () => {
    expect(fmtFloorPrice(117234.5)).toBe("117,234.50");
    expect(fmtFloorPrice(0.1234)).toBe("0.1234");
  });

  it("fmtFloorSize: coarse above 1k, fine below", () => {
    expect(fmtFloorSize(1234.5)).toBe("1,235");
    expect(fmtFloorSize(12.345)).toBe("12.35");
    expect(fmtFloorSize(0.1234)).toBe("0.1234");
  });
});

// ── Anatomy ──────────────────────────────────────────────────────────────────

describe("Floor — anatomy", () => {
  it("ladder: asks above, bids below, cumulative sizes max-normalized per side", async () => {
    render(<Floor product="BTC-USD" />);

    await waitFor(() => {
      expect(screen.getAllByTestId("floor-ask-row")).toHaveLength(2);
    });
    const askRows = screen.getAllByTestId("floor-ask-row");
    const bidRows = screen.getAllByTestId("floor-bid-row");
    expect(bidRows).toHaveLength(3);
    // Asks render worst-first so the best ask touches the mid line:
    // cum column shows the running sums 2.0000 (worst) then 1.5000 (best).
    expect(askRows[0].textContent).toContain("102.00");
    expect(askRows[1].textContent).toContain("101.00");
    expect(askRows[1].textContent).toContain("1.5000");
    // Bids best-first: 99 cum 1, 98 cum 3, 97 cum 6.
    expect(bidRows[0].textContent).toContain("99.00");
    expect(bidRows[2].textContent).toContain("6.0000");
    // DOM order: all ask rows precede all bid rows.
    const book = screen.getByTestId("floor-book");
    const order = Array.from(book.querySelectorAll("[data-testid$='-row']")).map((el) =>
      el.getAttribute("data-testid")
    );
    expect(order).toEqual([
      "floor-ask-row",
      "floor-ask-row",
      "floor-bid-row",
      "floor-bid-row",
      "floor-bid-row",
    ]);
  });

  it("header readout: spot, 24h delta, mid and spread (abs + bps)", async () => {
    render(<Floor product="BTC-USD" />);

    await waitFor(() => {
      expect(screen.getByTestId("floor-spot").textContent).toBe("100.25");
    });
    expect(screen.getByTestId("floor-delta").textContent).toBe("24H +5.53%");
    expect(screen.getByTestId("floor-mid").textContent).toBe("100.00");
    expect(screen.getByTestId("floor-spread").textContent).toBe("2.00 · 200.0bps");
  });

  it("tape: newest-first rows tinted by TAKER side (maker sell = taker bought)", async () => {
    render(<Floor product="BTC-USD" />);

    await waitFor(() => {
      expect(screen.getAllByTestId("floor-trade-row")).toHaveLength(3);
    });
    const rows = screen.getAllByTestId("floor-trade-row");
    // FAKE_TRADES[0] maker "sell" → taker BOUGHT; [1] maker "buy" → taker SOLD.
    expect(rows[0].getAttribute("data-side")).toBe("buy");
    expect(rows[1].getAttribute("data-side")).toBe("sell");
    expect(rows[0].textContent).toContain("100.50");
  });

  it("tape caps at 20 rows", async () => {
    const many: MarketTrade[] = Array.from({ length: 27 }, (_, i) => ({
      tradeId: 1000 - i,
      time: "2026-08-22T12:00:00Z",
      price: 100 + i,
      size: 0.1,
      side: i % 2 ? "buy" : "sell",
    }));
    marketSource.getTrades.mockResolvedValue(many);
    render(<Floor product="BTC-USD" />);

    await waitFor(() => {
      expect(screen.getAllByTestId("floor-trade-row")).toHaveLength(20);
    });
  });

  it("polls the given product — the clicked symbol IS the product", async () => {
    render(<Floor product="ETH-USD" />);
    await waitFor(() => {
      expect(marketSource.getBook).toHaveBeenCalledWith("ETH-USD", expect.any(Number), expect.anything());
    });
    expect(marketSource.getTrades).toHaveBeenCalledWith("ETH-USD", expect.anything());
    expect(marketSource.getCrypto).toHaveBeenCalledWith("ETH-USD", expect.anything());
  });
});

// ── Calm per-panel errors ────────────────────────────────────────────────────

describe("Floor — panel errors are calm, never blank", () => {
  it("book failure states itself while the tape stays live", async () => {
    marketSource.getBook.mockRejectedValue(new Error("feed down"));
    render(<Floor product="BTC-USD" />);

    await waitFor(() => {
      expect(screen.getByTestId("floor-book-copy").textContent).toBe(
        "the book is dark — retrying"
      );
    });
    // The rest of the floor is untouched — never blank.
    expect(screen.getAllByTestId("floor-trade-row").length).toBeGreaterThan(0);
    expect(screen.getByTestId("floor-spot").textContent).toBe("100.25");
  });

  it("tape failure states itself while the book stays live", async () => {
    marketSource.getTrades.mockRejectedValue(new Error("feed down"));
    render(<Floor product="BTC-USD" />);

    await waitFor(() => {
      expect(screen.getByTestId("floor-tape-copy").textContent).toBe(
        "the tape is dark — retrying"
      );
    });
    expect(screen.getAllByTestId("floor-bid-row").length).toBeGreaterThan(0);
  });

  it("ticker failure states itself; spot degrades to a dash", async () => {
    marketSource.getCrypto.mockRejectedValue(new Error("feed down"));
    render(<Floor product="BTC-USD" />);

    await waitFor(() => {
      expect(screen.getByTestId("floor-spot-copy").textContent).toBe(
        "the ticker is dark — retrying"
      );
    });
    expect(screen.getByTestId("floor-spot").textContent).toBe("—");
  });

  it("a failed poll keeps polling — the poll IS the retry", async () => {
    vi.useFakeTimers();
    marketSource.getBook.mockRejectedValue(new Error("feed down"));

    act(() => {
      render(<Floor product="BTC-USD" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const before = marketSource.getBook.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await Promise.resolve();
    });
    expect(marketSource.getBook.mock.calls.length).toBeGreaterThan(before);
  });
});

// ── Poll lifecycle (fake timers) ─────────────────────────────────────────────

describe("Floor — poll lifecycle (fake timers)", () => {
  it("polls at the documented cadences: book 2s, tape 3s, spot 30s", async () => {
    vi.useFakeTimers();

    act(() => {
      render(<Floor product="BTC-USD" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Immediate first tick for each poll.
    expect(marketSource.getBook).toHaveBeenCalledTimes(1);
    expect(marketSource.getTrades).toHaveBeenCalledTimes(1);
    expect(marketSource.getCrypto).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });
    // t=6s: book at 2/4/6 (+3), trades at 3/6 (+2), spot untouched.
    expect(marketSource.getBook).toHaveBeenCalledTimes(4);
    expect(marketSource.getTrades).toHaveBeenCalledTimes(3);
    expect(marketSource.getCrypto).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(24_000);
      await Promise.resolve();
    });
    // t=30s: spot fires its second tick.
    expect(marketSource.getCrypto).toHaveBeenCalledTimes(2);
  });

  it("unmount stops ALL floor polls — no leaks", async () => {
    vi.useFakeTimers();

    let unmount!: () => void;
    act(() => {
      ({ unmount } = render(<Floor product="BTC-USD" />));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      unmount();
    });
    const book = marketSource.getBook.mock.calls.length;
    const trades = marketSource.getTrades.mock.calls.length;
    const crypto = marketSource.getCrypto.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    expect(marketSource.getBook.mock.calls.length).toBe(book);
    expect(marketSource.getTrades.mock.calls.length).toBe(trades);
    expect(marketSource.getCrypto.mock.calls.length).toBe(crypto);
  });

  describe("document-hidden pause", () => {
    afterEach(() => {
      Reflect.deleteProperty(document, "hidden");
    });

    function setDocHidden(hidden: boolean) {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }

    it("hiding the document pauses every floor poll; visibility resumes them", async () => {
      vi.useFakeTimers();

      act(() => {
        render(<Floor product="BTC-USD" />);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => {
        setDocHidden(true);
      });
      const book = marketSource.getBook.mock.calls.length;
      const trades = marketSource.getTrades.mock.calls.length;
      const crypto = marketSource.getCrypto.mock.calls.length;

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(marketSource.getBook.mock.calls.length).toBe(book);
      expect(marketSource.getTrades.mock.calls.length).toBe(trades);
      expect(marketSource.getCrypto.mock.calls.length).toBe(crypto);

      await act(async () => {
        setDocHidden(false);
        await Promise.resolve();
      });
      // Resuming runs an immediate tick on every poll.
      expect(marketSource.getBook.mock.calls.length).toBe(book + 1);
      expect(marketSource.getTrades.mock.calls.length).toBe(trades + 1);
      expect(marketSource.getCrypto.mock.calls.length).toBe(crypto + 1);
    });
  });
});
