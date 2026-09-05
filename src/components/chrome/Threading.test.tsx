/**
 * Threading.test.tsx — the threading card: six stations, one network trip,
 * a stop button.
 *
 * Proves: absent until a ceremony speaks; every station state per step; the
 * streamed tail and the elapsed clock; the network line said BEFORE the
 * network is used and gone once it has been; CANCEL wired to `threadCancel`
 * with the honest note about resuming; the calm answer when the core says
 * nothing is being threaded; the done and failed endings with DISMISS; copy
 * law (no exclamation marks, uppercase-mono station labels).
 */

import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom";
import Threading from "./Threading";
import type { ThreadEvent, ThreadStatus } from "../../lib/core";
import { STATIONS, NETWORK_ONCE, CANCEL_MEANS, NOTHING_TO_CANCEL, type ThreadFeedMsg } from "../../lib/loom/threading";

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

function status(over: Partial<ThreadStatus> = {}): ThreadStatus {
  return {
    threaded: false,
    tools: [],
    missing: [],
    drifted: [],
    steps: { seed: false, deps: false, vendor: false, warm: false, register: false },
    needsNetwork: true,
    sherpaCache: null,
    ...over,
  };
}

function ev(over: Partial<ThreadEvent> = {}): ThreadEvent {
  return { step: "seed", detail: "cloning the bundled genome into source/", tail: [], ...over };
}

/** A hand-cranked feed: the test pushes messages through `push`. */
function makeFeed() {
  let deliver: ((m: ThreadFeedMsg) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    deliver = null;
  });
  const feed = vi.fn((onMsg: (m: ThreadFeedMsg) => void) => {
    deliver = onMsg;
    return unsubscribe;
  });
  return {
    feed,
    unsubscribe,
    seed(s: ThreadStatus) {
      act(() => deliver?.({ kind: "seed", status: s }));
    },
    push(e: ThreadEvent) {
      act(() => deliver?.({ kind: "event", event: e }));
    },
  };
}

function stationStates(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of STATIONS) {
    out[s] = screen.getByTestId(`threading-station-${s}`).getAttribute("data-state");
  }
  return out;
}

const okCancel = () => vi.fn().mockResolvedValue({ ok: true } as const);

afterEach(() => vi.clearAllMocks());

describe("Threading — presence", () => {
  it("is absent while nothing is threading", () => {
    const { feed, seed } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    expect(screen.queryByTestId("threading-card")).not.toBeInTheDocument();
    // Even a seed that says the loom is half-threaded shows nothing: a
    // completion marker is not a ceremony in flight.
    seed(status({ steps: { seed: true, deps: true, vendor: false, warm: false, register: false } }));
    expect(screen.queryByTestId("threading-card")).not.toBeInTheDocument();
  });

  it("appears on the first event, however the ceremony was started", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "seed" }));
    expect(screen.getByTestId("threading-card")).toBeInTheDocument();
    expect(screen.getByTestId("threading-card")).toHaveAttribute("data-step", "seed");
  });

  it("ignores a malformed event and stays absent", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push({ step: "elsewhere", detail: "", tail: [] } as unknown as ThreadEvent);
    expect(screen.queryByTestId("threading-card")).not.toBeInTheDocument();
  });

  it("unsubscribes on unmount", () => {
    const { feed, unsubscribe } = makeFeed();
    const { unmount } = render(<Threading feed={feed} cancel={okCancel()} />);
    expect(feed).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("Threading — the six stations", () => {
  it("names the stations in order, uppercase mono", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "seed" }));
    const rail = screen.getByTestId("threading-rail");
    const labels = Array.from(rail.querySelectorAll("[data-testid^='threading-station-']")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["SEED", "DEPS", "VENDOR", "WARM", "REGISTER", "STAMP"]);
    for (const el of rail.querySelectorAll("[data-testid^='threading-station-']")) {
      expect((el as HTMLElement).style.fontFamily).toBe("var(--f-mono)");
    }
  });

  it("seed: the first station active, the rest pending", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "seed" }));
    expect(stationStates()).toEqual({
      seed: "active",
      deps: "pending",
      vendor: "pending",
      warm: "pending",
      register: "pending",
      stamp: "pending",
    });
  });

  it("warm: the three before it done, the two after it pending", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "seed" }));
    push(ev({ step: "warm", detail: "compiling the core — native deps compile once" }));
    expect(stationStates()).toEqual({
      seed: "done",
      deps: "done",
      vendor: "done",
      warm: "active",
      register: "pending",
      stamp: "pending",
    });
  });

  it("failed marks the station the ceremony died at", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "deps", detail: "npm ci — this is the step that needs the network" }));
    push(ev({ step: "failed", detail: NETWORK_ONCE, tail: ["npm error ENOTFOUND registry.npmjs.org"] }));
    expect(stationStates()).toMatchObject({ seed: "done", deps: "failed", vendor: "pending" });
  });

  it("done marks every station", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "stamp", detail: "writing threads.json" }));
    push(ev({ step: "done", detail: "the loom is threaded — it weaves offline from here." }));
    expect(Object.values(stationStates())).toEqual(new Array(6).fill("done"));
  });
});

describe("Threading — the tail and the clock", () => {
  it("shows the streamed tail, last lines last", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "warm", tail: ["Compiling serde v1.0.0", "Compiling loom v0.1.0"] }));
    const lines = screen.getAllByTestId("threading-tail-line").map((el) => el.textContent);
    expect(lines).toEqual(["Compiling serde v1.0.0", "Compiling loom v0.1.0"]);
  });

  it("keeps the tail from the last event that carried one", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "warm", tail: ["Compiling loom v0.1.0"] }));
    push(ev({ step: "warm", detail: "compiling the core", tail: [] }));
    expect(screen.getAllByTestId("threading-tail-line").map((el) => el.textContent)).toEqual([
      "Compiling loom v0.1.0",
    ]);
  });

  it("drops the tail when a new station starts", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "deps", tail: ["added 812 packages"] }));
    push(ev({ step: "vendor", detail: "vendoring the crates", tail: [] }));
    expect(screen.queryByTestId("threading-tail")).not.toBeInTheDocument();
  });

  it("shows an elapsed clock that starts at the first event", () => {
    vi.useFakeTimers();
    try {
      const { feed, push } = makeFeed();
      render(<Threading feed={feed} cancel={okCancel()} />);
      push(ev({ step: "seed" }));
      expect(screen.getByTestId("threading-elapsed").textContent).toBe("0:00");
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(screen.getByTestId("threading-elapsed").textContent).toBe("1:05");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Threading — the network line", () => {
  it("says the network line before the network is used", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "seed" }));
    expect(screen.getByTestId("threading-network-line")).toHaveTextContent(NETWORK_ONCE);
  });

  it("stops saying it once vendoring is behind the ceremony", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "seed" }));
    push(ev({ step: "warm" }));
    expect(screen.queryByTestId("threading-network-line")).not.toBeInTheDocument();
  });

  it("does not promise a network trip a resumed ceremony will not take", () => {
    const { feed, seed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    seed(status({ needsNetwork: false, steps: { seed: true, deps: true, vendor: true, warm: false, register: false } }));
    push(ev({ step: "seed", detail: "already seeded" }));
    expect(screen.queryByTestId("threading-network-line")).not.toBeInTheDocument();
  });
});

describe("Threading — cancel", () => {
  it("carries CANCEL while the ceremony runs, wired to threadCancel", async () => {
    const cancel = okCancel();
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={cancel} />);
    push(ev({ step: "warm" }));
    fireEvent.click(screen.getByTestId("threading-cancel"));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("says what cancelling means — the ceremony resumes, it does not restart", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "warm" }));
    expect(screen.getByTestId("threading-cancel-note")).toHaveTextContent(CANCEL_MEANS);
  });

  it("handles the nothing-to-cancel refusal calmly, with no raw error", async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: false, reason: NOTHING_TO_CANCEL } as const);
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={cancel} />);
    push(ev({ step: "warm" }));
    fireEvent.click(screen.getByTestId("threading-cancel"));
    await waitFor(() =>
      expect(screen.getByTestId("threading-cancel-note")).toHaveTextContent(NOTHING_TO_CANCEL),
    );
    expect(screen.queryByTestId("threading-cancel")).not.toBeInTheDocument();
  });

  it("survives a cancel seam that throws", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("boom"));
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={cancel} />);
    push(ev({ step: "warm" }));
    fireEvent.click(screen.getByTestId("threading-cancel"));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(screen.getByTestId("threading-card")).toBeInTheDocument();
  });

  it("has no CANCEL once the ceremony is over", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "stamp" }));
    push(ev({ step: "done", detail: "the loom is threaded — it weaves offline from here." }));
    expect(screen.queryByTestId("threading-cancel")).not.toBeInTheDocument();
  });
});

describe("Threading — the ending", () => {
  it("says plainly when the ceremony is over, and offers DISMISS", async () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "done", detail: "the loom is threaded — it weaves offline from here." }));
    expect(screen.getByTestId("threading-eyebrow")).toHaveTextContent(/threaded/i);
    expect(screen.getByTestId("threading-outcome")).toHaveTextContent(
      "the loom is threaded — it weaves offline from here.",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("threading-dismiss"));
    });
    await waitFor(() =>
      expect(screen.queryByTestId("threading-card")).not.toBeInTheDocument(),
    );
  });

  it("stops speaking in the present tense once the ceremony has stopped", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "warm" }));
    expect(screen.getByTestId("threading-heading")).toHaveTextContent("preparing the loom to weave");
    push(ev({ step: "failed", detail: "cargo build failed (exit 101)" }));
    expect(screen.getByTestId("threading-heading")).not.toHaveTextContent("preparing");
  });

  it("states a failure as fact — hinge — remedy, and keeps the evidence", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "deps" }));
    push(
      ev({
        step: "failed",
        detail: NETWORK_ONCE,
        tail: ["npm error code ENOTFOUND"],
      }),
    );
    expect(screen.getByTestId("threading-outcome")).toHaveTextContent(NETWORK_ONCE);
    expect(screen.getByTestId("threading-outcome").style.color).toBe("var(--danger)");
    expect(screen.getAllByTestId("threading-tail-line").map((e) => e.textContent)).toEqual([
      "npm error code ENOTFOUND",
    ]);
  });

  it("a new ceremony after a dismissed one brings the card back", async () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "done", detail: "the loom is threaded — it weaves offline from here." }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("threading-dismiss"));
    });
    push(ev({ step: "seed" }));
    expect(screen.getByTestId("threading-card")).toBeInTheDocument();
    expect(stationStates()).toMatchObject({ seed: "active", deps: "pending" });
  });
});

describe("Threading — copy law", () => {
  it("shows no exclamation mark anywhere on the card", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "deps", tail: ["npm warn deprecated"] }));
    expect(screen.getByTestId("threading-card").textContent).not.toMatch(/!/);
  });

  it("renders in tokens only — no raw hex on the card", () => {
    const { feed, push } = makeFeed();
    render(<Threading feed={feed} cancel={okCancel()} />);
    push(ev({ step: "warm" }));
    expect(screen.getByTestId("threading-card").outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("Threading — a heading must not point at nothing", () => {
  it("a card whose first event is failed does not claim a station is marked", () => {
    // A shell reload during a long ceremony that then dies: the card has never
    // seen a station, so the rail marks nothing. Saying "stopped at the station
    // marked above" would be pointing at an empty rail.
    const f = makeFeed();
    render(<Threading feed={f.feed} />);
    f.push(ev({ step: "failed", detail: "npm ci: ENOTFOUND registry.npmjs.org" }));

    const card = screen.getByTestId("threading-card");
    expect(card).toHaveTextContent("the ceremony stopped before this card saw where");
    expect(card).not.toHaveTextContent("the station marked above");
    // The evidence for the remedy is still there.
    expect(card).toHaveTextContent("ENOTFOUND");
  });

  it("still points at the rail when it has actually seen a station", () => {
    const f = makeFeed();
    render(<Threading feed={f.feed} />);
    f.push(ev({ step: "vendor", detail: "cargo vendor" }));
    f.push(ev({ step: "failed", detail: "cargo vendor failed" }));
    expect(screen.getByTestId("threading-card")).toHaveTextContent(
      "the ceremony stopped at the station marked above",
    );
  });
});
