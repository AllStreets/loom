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
const mockGetSalient = vi.fn().mockReturnValue([]);

vi.mock("../lib/watch/store", () => ({
  recordEngagement: (...args: unknown[]) => mockRecordEngagement(...args),
  addWatchlistEntry: (...args: unknown[]) => mockAddWatchlistEntry(...args),
  removeWatchlistEntry: (...args: unknown[]) => mockRemoveWatchlistEntry(...args),
  getWatchlist: (...args: unknown[]) => mockGetWatchlist(...args),
}));

vi.mock("../lib/watch/runtime", () => ({
  getSalient: (...args: unknown[]) => mockGetSalient(...args),
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
  mockGetSalient.mockReturnValue([]);
  mockAddWatchlistEntry.mockReturnValue([]);
  mockRemoveWatchlistEntry.mockReturnValue([]);
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
