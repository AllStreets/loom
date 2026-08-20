/**
 * WatchPanel.test.tsx
 *
 * Tests for the WatchPanel component:
 * - Panel list renders scored items with score bars + reasons
 * - Engagement actions call store functions (recordEngagement, addWatchlistEntry)
 * - Dismiss hides the row
 * - Watchlist add/remove via chips row
 * - Empty state shown when no items
 * - Panel does not render when open=false
 */

import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import type { ScoredEvent } from "../lib/watch/types";

// ── Store mocks ───────────────────────────────────────────────────────────────

const mockRecordEngagement = vi.fn();
const mockAddWatchlistEntry = vi.fn().mockReturnValue([]);
const mockRemoveWatchlistEntry = vi.fn().mockReturnValue([]);
const mockGetWatchlist = vi.fn().mockReturnValue([]);
const mockGetSignals = vi.fn().mockReturnValue([]);
const mockClearSignals = vi.fn();
const mockGetSalient = vi.fn().mockReturnValue([]);
const mockSendDeckCommands = vi.fn();

vi.mock("../lib/watch/store", () => ({
  recordEngagement: (...args: unknown[]) => mockRecordEngagement(...args),
  addWatchlistEntry: (...args: unknown[]) => mockAddWatchlistEntry(...args),
  removeWatchlistEntry: (...args: unknown[]) => mockRemoveWatchlistEntry(...args),
  getWatchlist: (...args: unknown[]) => mockGetWatchlist(...args),
  getSignals: (...args: unknown[]) => mockGetSignals(...args),
  clearSignals: (...args: unknown[]) => mockClearSignals(...args),
}));

vi.mock("../lib/watch/runtime", () => ({
  getSalient: (...args: unknown[]) => mockGetSalient(...args),
}));

vi.mock("./decks/GlobeDeck", () => ({
  sendDeckCommands: (...args: unknown[]) => mockSendDeckCommands(...args),
}));

// matchMedia mock
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWatchlist.mockReturnValue([]);
  mockGetSignals.mockReturnValue([]);
  mockGetSalient.mockReturnValue([]);
  mockAddWatchlistEntry.mockReturnValue([]);
  mockRemoveWatchlistEntry.mockReturnValue([]);
  mockSendDeckCommands.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<ScoredEvent> = {}): ScoredEvent {
  return {
    id: "test-1",
    title: "Major earthquake strikes coastal region",
    source: "quakes",
    category: "seismic",
    publishedAt: new Date(Date.now() - 300_000).toISOString(), // 5 mins ago
    score: 0.75,
    reasons: ["High magnitude seismic event", "Coastal population affected"],
    url: "https://example.com/quake-1",
    ...overrides,
  };
}

function makePanel(open = true, items: ScoredEvent[] = [makeItem()]) {
  mockGetSalient.mockReturnValue(items);
  const onClose = vi.fn();
  return { result: render(<WatchPanel open={open} onClose={onClose} />), onClose };
}

import WatchPanel from "./WatchPanel";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WatchPanel — render control", () => {
  it("does not render when open=false", () => {
    render(<WatchPanel open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId("watch-panel")).not.toBeInTheDocument();
  });

  it("renders when open=true", () => {
    makePanel();
    expect(screen.getByTestId("watch-panel")).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const { onClose } = makePanel();
    fireEvent.click(screen.getByTestId("watch-panel-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders THE WATCH header", () => {
    makePanel();
    const panel = screen.getByTestId("watch-panel");
    // textTransform:uppercase renders "THE WATCH"; content stays title-cased
    expect(panel.textContent).toContain("The Watch");
  });
});

describe("WatchPanel — list renders scored items", () => {
  it("renders a watch row for each item", () => {
    const items = [makeItem({ id: "a" }), makeItem({ id: "b", title: "Second event" })];
    makePanel(true, items);
    const rows = screen.getAllByTestId("watch-row");
    expect(rows).toHaveLength(2);
  });

  it("renders the item title (overflow-safe: in title attr)", () => {
    makePanel();
    const row = screen.getByTestId("watch-row");
    // Title appears as text content or title attr
    expect(row.textContent).toContain("Major earthquake strikes coastal region");
  });

  it("renders the item source", () => {
    makePanel();
    const row = screen.getByTestId("watch-row");
    expect(row.textContent).toContain("quakes");
  });

  it("renders a score bar element per row", () => {
    makePanel();
    const bars = screen.getAllByTestId("score-bar");
    expect(bars).toHaveLength(1);
  });

  it("score bar inner div has correct width reflecting score", () => {
    makePanel(true, [makeItem({ score: 0.75 })]);
    const bar = screen.getByTestId("score-bar");
    const inner = bar.firstElementChild as HTMLElement;
    expect(inner.style.width).toBe("75%");
  });

  it("renders expand button when reasons exist", () => {
    makePanel();
    expect(screen.getByTestId("watch-expand-btn")).toBeInTheDocument();
  });

  it("expands reasons list on expand click", () => {
    makePanel();
    expect(screen.queryByTestId("watch-reasons-list")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("watch-expand-btn"));
    const reasonsList = screen.getByTestId("watch-reasons-list");
    expect(within(reasonsList).getByText("High magnitude seismic event")).toBeInTheDocument();
    expect(within(reasonsList).getByText("Coastal population affected")).toBeInTheDocument();
  });

  it("renders overflow-safe styles on title (ellipsis)", () => {
    makePanel();
    const row = screen.getByTestId("watch-row");
    // Find the element with overflow:hidden / textOverflow:ellipsis
    const titleEl = row.querySelector('[style*="ellipsis"]');
    expect(titleEl).toBeTruthy();
  });
});

describe("WatchPanel — empty state", () => {
  it("shows empty state text when no items", () => {
    makePanel(true, []);
    expect(screen.getByTestId("watch-empty-state")).toBeInTheDocument();
    expect(screen.getByText("the watch is quiet")).toBeInTheDocument();
  });

  it("does not show rows when empty", () => {
    makePanel(true, []);
    expect(screen.queryAllByTestId("watch-row")).toHaveLength(0);
  });
});

describe("WatchPanel — engagement actions", () => {
  it("clicking open button calls recordEngagement with action='open'", () => {
    makePanel();
    fireEvent.click(screen.getByTestId("watch-open-btn"));
    expect(mockRecordEngagement).toHaveBeenCalledWith(
      expect.objectContaining({ action: "open", eventKey: "test-1" })
    );
  });

  it("clicking dismiss calls recordEngagement with action='dismiss'", () => {
    makePanel();
    fireEvent.click(screen.getByTestId("watch-dismiss-btn"));
    expect(mockRecordEngagement).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dismiss", eventKey: "test-1" })
    );
  });

  it("engagement signals carry the feature snapshot the learner needs", () => {
    makePanel();
    fireEvent.click(screen.getByTestId("watch-dismiss-btn"));
    const call = mockRecordEngagement.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(typeof call.category).toBe("string");
    expect((call.category as string).length).toBeGreaterThan(0);
    expect(typeof call.source).toBe("string");
    expect(Array.isArray(call.titleTokens)).toBe(true);
    expect((call.titleTokens as string[]).length).toBeGreaterThan(0);
  });

  it("clicking watch+ calls recordEngagement with action='act'", () => {
    makePanel();
    fireEvent.click(screen.getByTestId("watch-plus-btn"));
    expect(mockRecordEngagement).toHaveBeenCalledWith(
      expect.objectContaining({ action: "act", eventKey: "test-1" })
    );
  });

  it("clicking watch+ calls addWatchlistEntry with a topic derived from title", () => {
    makePanel();
    fireEvent.click(screen.getByTestId("watch-plus-btn"));
    expect(mockAddWatchlistEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "topic" })
    );
  });
});

describe("WatchPanel — dismiss hides row", () => {
  it("dismissed item disappears from the list", async () => {
    makePanel();
    expect(screen.getByTestId("watch-row")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("watch-dismiss-btn"));
    });

    expect(screen.queryByTestId("watch-row")).not.toBeInTheDocument();
  });

  it("shows empty state after all items are dismissed", async () => {
    makePanel(true, [makeItem()]);

    await act(async () => {
      fireEvent.click(screen.getByTestId("watch-dismiss-btn"));
    });

    expect(screen.getByTestId("watch-empty-state")).toBeInTheDocument();
  });

  it("only hides the dismissed item when multiple exist", async () => {
    const items = [
      makeItem({ id: "a", title: "First event" }),
      makeItem({ id: "b", title: "Second event" }),
    ];
    makePanel(true, items);

    const rows = screen.getAllByTestId("watch-dismiss-btn");
    await act(async () => {
      fireEvent.click(rows[0]);
    });

    const remaining = screen.getAllByTestId("watch-row");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].textContent).toContain("Second event");
  });
});

describe("WatchPanel — watchlist chips", () => {
  it("renders the watchlist chips row", () => {
    makePanel();
    expect(screen.getByTestId("watchlist-chips")).toBeInTheDocument();
  });

  it("renders the kind select", () => {
    makePanel();
    expect(screen.getByTestId("watchlist-kind-select")).toBeInTheDocument();
  });

  it("renders the add input", () => {
    makePanel();
    expect(screen.getByTestId("watchlist-input")).toBeInTheDocument();
  });

  it("clicking + with a value calls addWatchlistEntry", async () => {
    makePanel();
    const input = screen.getByTestId("watchlist-input");
    fireEvent.change(input, { target: { value: "climate" } });
    fireEvent.click(screen.getByTestId("watchlist-add-btn"));
    expect(mockAddWatchlistEntry).toHaveBeenCalledWith(
      expect.objectContaining({ value: "climate", kind: "topic" })
    );
  });

  it("pressing Enter on input triggers add", async () => {
    makePanel();
    const input = screen.getByTestId("watchlist-input");
    fireEvent.change(input, { target: { value: "flood" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockAddWatchlistEntry).toHaveBeenCalledWith(
      expect.objectContaining({ value: "flood" })
    );
  });

  it("renders existing watchlist chips", () => {
    mockGetWatchlist.mockReturnValue([
      { kind: "topic", value: "earthquake" },
      { kind: "place", value: "Pacific Rim" },
    ]);
    makePanel();
    const chips = screen.getAllByTestId("watchlist-chip");
    expect(chips).toHaveLength(2);
  });

  it("clicking chip remove button calls removeWatchlistEntry", async () => {
    mockGetWatchlist.mockReturnValue([{ kind: "topic", value: "earthquake" }]);
    makePanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("watchlist-chip-remove"));
    });
    expect(mockRemoveWatchlistEntry).toHaveBeenCalledWith("topic", "earthquake");
  });
});

describe("WatchPanel — loom-salience event updates list", () => {
  it("updates items when loom-salience fires new data", async () => {
    // Start with no items
    mockGetSalient.mockReturnValue([]);
    render(<WatchPanel open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId("watch-empty-state")).toBeInTheDocument();

    // Fire salience event with items
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-salience", {
          detail: {
            items: [makeItem({ id: "x", title: "Breaking: Market Crash" })],
          },
        })
      );
    });

    expect(screen.queryByTestId("watch-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("watch-row")).toBeInTheDocument();
  });
});

describe("WatchPanel — badge count (integration hint)", () => {
  it("watch-panel renders feed with correct count of items", () => {
    const items = [
      makeItem({ id: "a" }),
      makeItem({ id: "b", title: "Item B" }),
      makeItem({ id: "c", title: "Item C" }),
    ];
    makePanel(true, items);
    expect(screen.getAllByTestId("watch-row")).toHaveLength(3);
  });
});

describe("WatchPanel — learned section", () => {
  // act on finance → category +0.10 (positive); dismiss dailymail → source -0.08 (negative)
  function learnedSignals() {
    return [
      { eventKey: "a", action: "act", ts: 1, category: "finance" },
      { eventKey: "b", action: "dismiss", ts: 2, source: "dailymail" },
    ];
  }

  it("renders the LEARNED section with its toggle", () => {
    makePanel();
    expect(screen.getByTestId("learned-section")).toBeInTheDocument();
    expect(screen.getByTestId("learned-toggle")).toBeInTheDocument();
  });

  it("is collapsed by default — no chips, no empty state", () => {
    mockGetSignals.mockReturnValue(learnedSignals());
    makePanel();
    expect(screen.queryAllByTestId("learned-chip-pos")).toHaveLength(0);
    expect(screen.queryAllByTestId("learned-chip-neg")).toHaveLength(0);
    expect(screen.queryByTestId("learned-empty")).not.toBeInTheDocument();
  });

  it("expanding with no signals shows the empty state", () => {
    makePanel();
    fireEvent.click(screen.getByTestId("learned-toggle"));
    expect(screen.getByTestId("learned-empty")).toBeInTheDocument();
    expect(
      screen.getByText("nothing learned yet — open, dismiss, and act to teach the watch")
    ).toBeInTheDocument();
  });

  it("expanding with signals shows positive and negative chips", () => {
    mockGetSignals.mockReturnValue(learnedSignals());
    makePanel();
    fireEvent.click(screen.getByTestId("learned-toggle"));
    const pos = screen.getAllByTestId("learned-chip-pos");
    const neg = screen.getAllByTestId("learned-chip-neg");
    expect(pos).toHaveLength(1);
    expect(neg).toHaveLength(1);
    expect(pos[0].textContent).toContain("finance");
    expect(pos[0].textContent).toContain("+0.10");
    expect(neg[0].textContent).toContain("dailymail");
    expect(neg[0].textContent).toContain("-0.08");
  });

  it("positive chips are accent-tinted, negative danger-tinted", () => {
    mockGetSignals.mockReturnValue(learnedSignals());
    makePanel();
    fireEvent.click(screen.getByTestId("learned-toggle"));
    const pos = screen.getAllByTestId("learned-chip-pos")[0];
    const neg = screen.getAllByTestId("learned-chip-neg")[0];
    expect(pos.getAttribute("style") || "").toContain("--accent");
    expect(neg.getAttribute("style") || "").toContain("--danger");
  });

  it("caps at 5 positive and 5 negative chips", () => {
    const signals = [];
    for (let i = 0; i < 7; i++) {
      signals.push({ eventKey: `p${i}`, action: "act", ts: i, category: `cat${i}` });
      signals.push({ eventKey: `n${i}`, action: "dismiss", ts: i, source: `src${i}` });
    }
    mockGetSignals.mockReturnValue(signals);
    makePanel();
    fireEvent.click(screen.getByTestId("learned-toggle"));
    expect(screen.getAllByTestId("learned-chip-pos")).toHaveLength(5);
    expect(screen.getAllByTestId("learned-chip-neg")).toHaveLength(5);
  });

  it("no clear button when nothing learned", () => {
    makePanel();
    fireEvent.click(screen.getByTestId("learned-toggle"));
    expect(screen.queryByTestId("learned-clear-btn")).not.toBeInTheDocument();
  });

  it("CLEAR LEARNING opens the confirm strip without clearing yet", () => {
    mockGetSignals.mockReturnValue(learnedSignals());
    makePanel();
    fireEvent.click(screen.getByTestId("learned-toggle"));
    fireEvent.click(screen.getByTestId("learned-clear-btn"));
    expect(screen.getByTestId("learned-confirm-strip")).toBeInTheDocument();
    expect(mockClearSignals).not.toHaveBeenCalled();
  });

  it("confirming wipes signals and recomputes weights empty", async () => {
    mockGetSignals.mockReturnValue(learnedSignals());
    makePanel();
    fireEvent.click(screen.getByTestId("learned-toggle"));
    fireEvent.click(screen.getByTestId("learned-clear-btn"));
    // The store is now empty — the section recomputes from getSignals()
    mockGetSignals.mockReturnValue([]);
    await act(async () => {
      fireEvent.click(screen.getByTestId("learned-confirm-btn"));
    });
    expect(mockClearSignals).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("learned-confirm-strip")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("learned-chip-pos")).toHaveLength(0);
    expect(screen.getByTestId("learned-empty")).toBeInTheDocument();
  });

  it("cancel closes the strip without clearing", () => {
    mockGetSignals.mockReturnValue(learnedSignals());
    makePanel();
    fireEvent.click(screen.getByTestId("learned-toggle"));
    fireEvent.click(screen.getByTestId("learned-clear-btn"));
    fireEvent.click(screen.getByTestId("learned-cancel-btn"));
    expect(screen.queryByTestId("learned-confirm-strip")).not.toBeInTheDocument();
    expect(mockClearSignals).not.toHaveBeenCalled();
    // Chips remain
    expect(screen.getAllByTestId("learned-chip-pos")).toHaveLength(1);
  });

  it("refreshes weights when loom-salience fires", async () => {
    makePanel();
    fireEvent.click(screen.getByTestId("learned-toggle"));
    expect(screen.getByTestId("learned-empty")).toBeInTheDocument();
    mockGetSignals.mockReturnValue(learnedSignals());
    await act(async () => {
      window.dispatchEvent(new CustomEvent("loom-salience", { detail: { items: [] } }));
    });
    expect(screen.getAllByTestId("learned-chip-pos")).toHaveLength(1);
  });
});

describe("WatchPanel — locate action", () => {
  it("locate button renders only for items with lat/lng", () => {
    const withCoords = makeItem({ lat: 35.68, lng: 139.69 });
    const noCoords = makeItem({ id: "no-coords", title: "No coords item" });
    makePanel(true, [withCoords, noCoords]);
    const locateBtns = screen.queryAllByTestId("watch-locate-btn");
    expect(locateBtns).toHaveLength(1);
  });

  it("locate button not rendered when item has no coords", () => {
    makePanel(true, [makeItem()]); // makeItem has no lat/lng by default
    expect(screen.queryByTestId("watch-locate-btn")).not.toBeInTheDocument();
  });

  it("clicking locate dispatches loom-deck globe THEN sendDeckCommands fly_to", async () => {
    const deckEvents: string[] = [];
    window.addEventListener("loom-deck", (e) => {
      deckEvents.push((e as CustomEvent).detail.deck);
    });

    const item = makeItem({ lat: 35.68, lng: 139.69 });
    makePanel(true, [item]);

    await act(async () => {
      fireEvent.click(screen.getByTestId("watch-locate-btn"));
    });

    expect(deckEvents).toContain("globe");
    expect(mockSendDeckCommands).toHaveBeenCalledWith([
      { type: "fly_to", lat: 35.68, lng: 139.69 },
    ]);
  });

  it("clicking locate records engagement with action='act'", async () => {
    const item = makeItem({ lat: 35.68, lng: 139.69 });
    makePanel(true, [item]);

    await act(async () => {
      fireEvent.click(screen.getByTestId("watch-locate-btn"));
    });

    expect(mockRecordEngagement).toHaveBeenCalledWith(
      expect.objectContaining({ action: "act", eventKey: item.id })
    );
  });
});

