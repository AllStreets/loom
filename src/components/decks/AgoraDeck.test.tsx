import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgoraDeck, {
  cumulate,
  bookStats,
  takerSide,
  fmtTradeTime,
  fmtFloorPrice,
} from "./AgoraDeck";
import type { MarketBook, MarketCrypto, MarketTrade } from "../../lib/core";

// Mock framer-motion so reducedMotion=true (no fade, simpler assertions)
vi.mock("framer-motion", () => ({
  useReducedMotion: () => true,
}));

// Mock settings
const settingsMock = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
vi.mock("../../lib/voice/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/voice/settings")>();
  return {
    ...actual,
    getSetting: settingsMock.getSetting,
    setSetting: settingsMock.setSetting,
  };
});

// Mock core — agora wrappers
vi.mock("../../lib/core", () => ({
  agoraStart: vi.fn().mockResolvedValue("started"),
  agoraStop: vi.fn().mockResolvedValue(undefined),
  agoraStatus: vi.fn().mockResolvedValue({ running: false }),
  agoraLogs: vi.fn().mockResolvedValue([]),
}));

// Mock the market source facade — the floor's only data seam
const marketSource = vi.hoisted(() => ({
  getBook: vi.fn(),
  getTrades: vi.fn(),
  getCrypto: vi.fn(),
}));
vi.mock("../../lib/market/source", () => marketSource);

// ── Floor fixtures ───────────────────────────────────────────────────────────
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

// Helper to create a fetch that resolves (reachable)
function makeResolvingFetch() {
  return vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
}

// Helper to create a fetch that rejects (unreachable)
function makeRejectingFetch() {
  return vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsMock.getSetting.mockImplementation((key: string) => {
    if (key === "deck.agora.url") return "http://localhost:3000";
    if (key === "deck.agora.path") return "";
    if (key === "deck.agora.product") return "BTC-USD";
    return "";
  });
  marketSource.getBook.mockResolvedValue(FAKE_BOOK);
  marketSource.getTrades.mockResolvedValue(FAKE_TRADES);
  marketSource.getCrypto.mockResolvedValue(FAKE_CRYPTO);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Always restore real timers to prevent state leaking between tests
  vi.useRealTimers();
});

describe("AgoraDeck — probe resolves (reachable)", () => {
  it("renders iframe with testid agora-deck-iframe", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-deck-iframe")).not.toBeNull();
    });
  });

  it("iframe sandbox='allow-scripts allow-same-origin allow-forms'", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const iframe = screen.getByTestId("agora-deck-iframe") as HTMLIFrameElement;
      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    });
  });

  it("iframe title='AGORA Exchange'", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const iframe = screen.getByTestId("agora-deck-iframe") as HTMLIFrameElement;
      expect(iframe.getAttribute("title")).toBe("AGORA Exchange");
    });
  });

  it("interact=true → pointerEvents 'auto' on iframe", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const iframe = screen.getByTestId("agora-deck-iframe") as HTMLIFrameElement;
      expect(iframe.style.pointerEvents).toBe("auto");
    });
  });

  it("interact=false → pointerEvents 'none' on iframe", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={false} />);

    await waitFor(() => {
      const iframe = screen.getByTestId("agora-deck-iframe") as HTMLIFrameElement;
      expect(iframe.style.pointerEvents).toBe("none");
    });
  });
});

describe("AgoraDeck — probe rejects (unreachable)", () => {
  it("renders offline card with testid agora-offline-card", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-offline-card")).not.toBeNull();
    });
  });

  it("offline card has 'THE EXCHANGE IS DARK' text", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByText("THE EXCHANGE IS DARK")).not.toBeNull();
    });
  });

  it("offline card has RETRY button with testid agora-retry-btn", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-retry-btn")).not.toBeNull();
    });
  });

  it("does NOT render iframe when unreachable", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-offline-card")).not.toBeNull();
    });
    expect(screen.queryByTestId("agora-deck-iframe")).toBeNull();
  });
});

describe("AgoraDeck — initial state", () => {
  it("shows probing card initially (testid agora-probing)", async () => {
    // Use a fetch that never resolves so we can catch the probing state
    let resolveFetch!: () => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = () => resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingFetch));

    render(<AgoraDeck interact={false} />);

    // Should show probing immediately
    expect(screen.getByTestId("agora-probing")).not.toBeNull();

    // Clean up — resolve the pending fetch
    resolveFetch();
    await waitFor(() => {
      expect(screen.queryByTestId("agora-probing")).toBeNull();
    });
  });
});

describe("AgoraDeck — no command listener", () => {
  it("does NOT register loom-deck-command listener", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    const addEventSpy = vi.spyOn(window, "addEventListener");

    render(<AgoraDeck interact={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-offline-card")).not.toBeNull();
    });

    const callArgs = addEventSpy.mock.calls.map((c) => c[0]);
    expect(callArgs).not.toContain("loom-deck-command");
  });
});

describe("AgoraDeck — RETRY button re-probes", () => {
  it("clicking RETRY re-runs the probe", async () => {
    const fetchMock = makeRejectingFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<AgoraDeck interact={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-retry-btn")).not.toBeNull();
    });

    const retryBtn = screen.getByTestId("agora-retry-btn");
    await userEvent.click(retryBtn);

    // fetch should have been called at least twice (initial probe + retry)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("AgoraDeck — health strip renders when reachable", () => {
  it("health strip is present when reachable", async () => {
    // web probe resolves; engine probe will be called after
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-health-strip")).not.toBeNull();
    });
  });

  it("WEB chip is present when reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-health-web")).not.toBeNull();
    });
  });

  it("ENGINE chip is present when reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-health-engine")).not.toBeNull();
    });
  });

  it("health strip is NOT present when unreachable", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-offline-card")).not.toBeNull();
    });
    expect(screen.queryByTestId("agora-health-strip")).toBeNull();
  });
});

describe("AgoraDeck — engine health probe (HTTP /health)", () => {
  it("engine dot shows healthy when engine returns ok:true", async () => {
    // Both the web probe and engine probe resolve with ok:true
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const dot = screen.getByTestId("agora-health-engine").querySelector("[data-health]");
      expect(dot?.getAttribute("data-health")).toBe("healthy");
    });
  });

  it("engine dot shows down when engine fetch rejects", async () => {
    // Web probe (localhost:3000) resolves; engine probe (localhost:8080) rejects
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("8080")) {
          return Promise.reject(new Error("ECONNREFUSED"));
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const dot = screen.getByTestId("agora-health-engine").querySelector("[data-health]");
      expect(dot?.getAttribute("data-health")).toBe("down");
    });
  });

  it("engine dot shows down when engine returns ok:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("8080")) {
          return Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 200 }));
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const dot = screen.getByTestId("agora-health-engine").querySelector("[data-health]");
      expect(dot?.getAttribute("data-health")).toBe("down");
    });
  });
});

describe("AgoraDeck — engine interval lifecycle", () => {
  it("re-probes engine after 60s", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<AgoraDeck interact={true} />);
    });

    // Wait for web probe + initial engine probe to settle
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsBefore = fetchMock.mock.calls.length;

    // Advance 60s to trigger the interval
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);

    vi.useRealTimers();
  });

  it("clears engine interval on unmount", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = render(<AgoraDeck interact={true} />));
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => { unmount(); });

    const callsAfterUnmount = fetchMock.mock.calls.length;

    // Advance well past 60s; no additional calls should fire
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterUnmount);

    vi.useRealTimers();
  });
});

// ── New tests: START button, ignition, STOP chip, Postgres note ──────────────

describe("AgoraDeck — START button", () => {
  it("offline card has START button with testid agora-start-btn", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-start-btn")).not.toBeNull();
    });
  });

  it("clicking START invokes agora_start", async () => {
    const { agoraStart } = await import("../../lib/core");
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-start-btn")).not.toBeNull();
    });

    const startBtn = screen.getByTestId("agora-start-btn");
    await userEvent.click(startBtn);

    await waitFor(() => {
      expect(agoraStart).toHaveBeenCalledWith("");
    });
  });

  it("after START shows 'IGNITING THE EXCHANGE'", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-start-btn")).not.toBeNull();
    });

    const startBtn = screen.getByTestId("agora-start-btn");
    await userEvent.click(startBtn);

    // After click, the igniting overlay should appear synchronously via setState
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("agora-igniting")).not.toBeNull();
    expect(screen.getByText("IGNITING THE EXCHANGE")).not.toBeNull();
  });
});

describe("AgoraDeck — bounded ignition probe", () => {
  it("after 45s of failed probes shows 'still dark' with RETRY and STOP", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", makeRejectingFetch());

    act(() => {
      render(<AgoraDeck interact={true} />);
    });

    // Flush the initial probe (which rejects)
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // After initial probe rejects, offline card + start btn should be visible
    const startBtn = screen.getByTestId("agora-start-btn");

    // Click START with fireEvent (no internal setTimeout — works with fake timers)
    act(() => {
      fireEvent.click(startBtn);
    });

    // Flush the agoraStart mock promise
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Advance 46s past the 45s timeout
    await act(async () => {
      vi.advanceTimersByTime(46_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Should show still-dark state: offline card with RETRY and STOP
    expect(screen.getByTestId("agora-retry-btn")).not.toBeNull();
    expect(screen.getByTestId("agora-stop-btn-still-dark")).not.toBeNull();

    vi.useRealTimers();
  });
});

describe("AgoraDeck — spawn rejection (agora_start rejects)", () => {
  it("rejection skips the probe loop entirely — no igniting, no intervals", async () => {
    const { agoraStart, agoraLogs } = await import("../../lib/core");
    vi.mocked(agoraStart).mockRejectedValueOnce({
      kind: "not_found",
      message: "not found: AGORA path does not exist: /nope",
    });

    vi.useFakeTimers();
    const fetchMock = makeRejectingFetch();
    vi.stubGlobal("fetch", fetchMock);

    act(() => {
      render(<AgoraDeck interact={true} />);
    });

    // Flush the initial probe (which rejects)
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const startBtn = screen.getByTestId("agora-start-btn");
    act(() => {
      fireEvent.click(startBtn);
    });

    // Flush the rejected agoraStart promise
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Straight to failure — no igniting overlay
    expect(screen.queryByTestId("agora-igniting")).toBeNull();
    expect(screen.getByTestId("agora-spawn-error")).not.toBeNull();

    // No probe/log intervals were set up — advancing time fires nothing
    const fetchCallsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBe(fetchCallsBefore);
    expect(agoraLogs).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("failure copy surfaces the rejection reason", async () => {
    const { agoraStart } = await import("../../lib/core");
    vi.mocked(agoraStart).mockRejectedValueOnce({
      kind: "not_found",
      message: "not found: AGORA path has no package.json: /Users/x/empty",
    });

    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-start-btn")).not.toBeNull();
    });

    await userEvent.click(screen.getByTestId("agora-start-btn"));

    await waitFor(() => {
      const el = screen.getByTestId("agora-spawn-error");
      expect(el.textContent).toContain("COULD NOT IGNITE");
      expect(el.textContent).toContain("AGORA path has no package.json");
    });
  });

  it("starting again after a rejection clears the failure copy", async () => {
    const { agoraStart } = await import("../../lib/core");
    vi.mocked(agoraStart).mockRejectedValueOnce({
      kind: "not_found",
      message: "not found: nope",
    });

    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-start-btn")).not.toBeNull();
    });

    await userEvent.click(screen.getByTestId("agora-start-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("agora-spawn-error")).not.toBeNull();
    });

    // Second START resolves (default mock) — igniting proceeds, copy is gone
    await userEvent.click(screen.getByTestId("agora-start-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("agora-igniting")).not.toBeNull();
    });
    expect(screen.queryByTestId("agora-spawn-error")).toBeNull();
  });
});

describe("AgoraDeck — STOP chip when reachable", () => {
  it("stop chip (agora-stop-btn) present when reachable", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-stop-btn")).not.toBeNull();
    });
  });

  it("clicking STOP invokes agora_stop", async () => {
    const { agoraStop } = await import("../../lib/core");
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-stop-btn")).not.toBeNull();
    });

    const stopBtn = screen.getByTestId("agora-stop-btn");
    await userEvent.click(stopBtn);

    await waitFor(() => {
      expect(agoraStop).toHaveBeenCalled();
    });
  });
});

describe("AgoraDeck — Postgres note", () => {
  it("offline card has Postgres note text", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByText("Postgres must be running (Postgres.app).")).not.toBeNull();
    });
  });
});

// ── THE FLOOR — pure helpers ─────────────────────────────────────────────────

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
});

// ── THE FLOOR — anatomy while unreachable ────────────────────────────────────

describe("AgoraDeck — THE FLOOR renders when AGORA is unreachable", () => {
  it("floor and launch strip render together — the deck is never a lone card", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-floor")).not.toBeNull();
    });
    // The old offline card lives on, compressed to the strip at the top.
    expect(screen.getByTestId("agora-offline-card")).not.toBeNull();
    expect(screen.getByText("THE EXCHANGE IS DARK")).not.toBeNull();
  });

  it("renders the three product chips with the persisted product selected", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-floor-chip-BTC-USD")).not.toBeNull();
    });
    expect(screen.getByTestId("agora-floor-chip-ETH-USD")).not.toBeNull();
    expect(screen.getByTestId("agora-floor-chip-SOL-USD")).not.toBeNull();
    expect(screen.getByTestId("agora-floor-chip-BTC-USD").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("agora-floor-chip-ETH-USD").getAttribute("data-selected")).toBe("false");
  });

  it("ladder: asks above, bids below, cumulative sizes max-normalized per side", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("agora-floor-ask-row")).toHaveLength(2);
    });
    const askRows = screen.getAllByTestId("agora-floor-ask-row");
    const bidRows = screen.getAllByTestId("agora-floor-bid-row");
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
    const book = screen.getByTestId("agora-floor-book");
    const order = Array.from(book.querySelectorAll("[data-testid$='-row']")).map((el) =>
      el.getAttribute("data-testid")
    );
    expect(order).toEqual([
      "agora-floor-ask-row",
      "agora-floor-ask-row",
      "agora-floor-bid-row",
      "agora-floor-bid-row",
      "agora-floor-bid-row",
    ]);
  });

  it("header readout: spot, 24h delta, mid and spread (abs + bps)", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-floor-spot").textContent).toBe("100.25");
    });
    expect(screen.getByTestId("agora-floor-delta").textContent).toBe("24H +5.53%");
    expect(screen.getByTestId("agora-floor-mid").textContent).toBe("100.00");
    expect(screen.getByTestId("agora-floor-spread").textContent).toBe("2.00 · 200.0bps");
  });

  it("tape: newest-first rows tinted by TAKER side (maker sell = taker bought)", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("agora-floor-trade-row")).toHaveLength(3);
    });
    const rows = screen.getAllByTestId("agora-floor-trade-row");
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
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("agora-floor-trade-row")).toHaveLength(20);
    });
  });

  it("floor does NOT render when reachable — the iframe takes over exactly as today", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-deck-iframe")).not.toBeNull();
    });
    expect(screen.queryByTestId("agora-floor")).toBeNull();
  });
});

describe("AgoraDeck — floor panel errors are calm, never deck-blank", () => {
  it("book failure states itself while the tape stays live", async () => {
    marketSource.getBook.mockRejectedValue(new Error("feed down"));
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-floor-book-copy").textContent).toBe(
        "the book is dark — retrying"
      );
    });
    // The rest of the floor is untouched — never deck-blank.
    expect(screen.getAllByTestId("agora-floor-trade-row").length).toBeGreaterThan(0);
    expect(screen.getByTestId("agora-floor-spot").textContent).toBe("100.25");
  });

  it("tape failure states itself while the book stays live", async () => {
    marketSource.getTrades.mockRejectedValue(new Error("feed down"));
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-floor-tape-copy").textContent).toBe(
        "the tape is dark — retrying"
      );
    });
    expect(screen.getAllByTestId("agora-floor-bid-row").length).toBeGreaterThan(0);
  });

  it("ticker failure states itself; spot degrades to a dash", async () => {
    marketSource.getCrypto.mockRejectedValue(new Error("feed down"));
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-floor-spot-copy").textContent).toBe(
        "the ticker is dark — retrying"
      );
    });
    expect(screen.getByTestId("agora-floor-spot").textContent).toBe("—");
  });

  it("a failed poll keeps polling — the poll IS the retry", async () => {
    vi.useFakeTimers();
    marketSource.getBook.mockRejectedValue(new Error("feed down"));
    vi.stubGlobal("fetch", makeRejectingFetch());

    act(() => {
      render(<AgoraDeck interact={true} />);
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

describe("AgoraDeck — product chips switch and persist", () => {
  it("clicking a chip persists the setting and restarts polls on the new product", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-floor-chip-ETH-USD")).not.toBeNull();
    });

    await userEvent.click(screen.getByTestId("agora-floor-chip-ETH-USD"));

    expect(settingsMock.setSetting).toHaveBeenCalledWith("deck.agora.product", "ETH-USD");
    await waitFor(() => {
      expect(screen.getByTestId("agora-floor-chip-ETH-USD").getAttribute("data-selected")).toBe("true");
    });
    // The remounted floor polls the NEW product immediately.
    await waitFor(() => {
      expect(marketSource.getBook).toHaveBeenCalledWith("ETH-USD", expect.any(Number), expect.anything());
    });
  });

  it("product switch restarts polls cleanly — old-product polling stops (fake timers)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", makeRejectingFetch());

    act(() => {
      render(<AgoraDeck interact={true} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      fireEvent.click(screen.getByTestId("agora-floor-chip-SOL-USD"));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    marketSource.getBook.mockClear();
    marketSource.getTrades.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });

    // Every post-switch call targets the new product only.
    expect(marketSource.getBook.mock.calls.length).toBeGreaterThan(0);
    for (const call of marketSource.getBook.mock.calls) expect(call[0]).toBe("SOL-USD");
    for (const call of marketSource.getTrades.mock.calls) expect(call[0]).toBe("SOL-USD");
  });
});

describe("AgoraDeck — floor poll lifecycle (fake timers)", () => {
  it("polls at the documented cadences: book 2s, tape 3s, spot 30s", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", makeRejectingFetch());

    act(() => {
      render(<AgoraDeck interact={true} />);
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
    vi.stubGlobal("fetch", makeRejectingFetch());

    let unmount!: () => void;
    act(() => {
      ({ unmount } = render(<AgoraDeck interact={true} />));
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

  it("becoming reachable unmounts the floor and stops ALL polls; the iframe takes over", async () => {
    vi.useFakeTimers();
    // First probe rejects (unreachable → floor); after RETRY it resolves.
    let reachable = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        reachable
          ? Promise.resolve(new Response(null, { status: 200 }))
          : Promise.reject(new Error("ECONNREFUSED"))
      )
    );

    act(() => {
      render(<AgoraDeck interact={true} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("agora-floor")).not.toBeNull();

    reachable = true;
    act(() => {
      fireEvent.click(screen.getByTestId("agora-retry-btn"));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("agora-floor")).toBeNull();
    expect(screen.getByTestId("agora-deck-iframe")).not.toBeNull();

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
      vi.stubGlobal("fetch", makeRejectingFetch());

      act(() => {
        render(<AgoraDeck interact={true} />);
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

describe("AgoraDeck — igniting strip rides over the live floor", () => {
  it("while igniting the floor stays mounted with the igniting strip on top", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-start-btn")).not.toBeNull();
    });
    await userEvent.click(screen.getByTestId("agora-start-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("agora-igniting")).not.toBeNull();
    });
    // The floor is still there — igniting is a strip, not a takeover.
    expect(screen.getByTestId("agora-floor")).not.toBeNull();
    expect(screen.queryByTestId("agora-offline-card")).toBeNull();
  });
});
