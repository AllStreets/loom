/**
 * Reweave.test.tsx — the reweave card: five stations, honest countdown.
 *
 * Proves: absent while idle; every station state per stage (active luminous,
 * completed dimmed, pending faint); the live tail (last 6 lines) and the
 * elapsed clock; CANCEL only while cancellable; the point-of-return line on
 * swap; the outcome + DISMISS on failed; the outcome alone on dev done;
 * copy law (no exclamation marks, uppercase-mono station labels).
 */

import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom";
import Reweave, { formatElapsed, POINT_OF_RETURN, APPROACHING_RETURN } from "./Reweave";
import type { ReweaveState } from "../../lib/core";
import { STATIONS } from "../../lib/loom/reweave";

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

function state(over: Partial<ReweaveState> = {}): ReweaveState {
  return {
    stage: "idle",
    targetSha: "3f2a1c9deadbeef",
    startedAt: "2026-09-02T10:00:00Z",
    elapsedMs: 0,
    tail: [],
    outcome: null,
    cancellable: true,
    mode: "packaged",
    ...over,
  };
}

/** A hand-cranked feed: the test pushes states through `push`. */
function makeFeed() {
  let deliver: ((s: ReweaveState) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    deliver = null;
  });
  const feed = vi.fn((onState: (s: ReweaveState) => void) => {
    deliver = onState;
    return unsubscribe;
  });
  return {
    feed,
    unsubscribe,
    push(s: ReweaveState) {
      act(() => deliver?.(s));
    },
  };
}

function stationStates(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of STATIONS) {
    out[s] = screen.getByTestId(`reweave-station-${s}`).getAttribute("data-state");
  }
  return out;
}

afterEach(() => vi.clearAllMocks());

describe("Reweave — presence", () => {
  it("is absent while the job is idle", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    expect(screen.queryByTestId("reweave-card")).not.toBeInTheDocument();
    push(state({ stage: "idle" }));
    expect(screen.queryByTestId("reweave-card")).not.toBeInTheDocument();
  });

  it("tolerates a malformed initial state (no stage) and stays absent", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push([] as unknown as ReweaveState);
    expect(screen.queryByTestId("reweave-card")).not.toBeInTheDocument();
  });

  it("unsubscribes on unmount", () => {
    const { feed, unsubscribe } = makeFeed();
    const { unmount } = render(<Reweave feed={feed} cancel={vi.fn()} />);
    expect(feed).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("Reweave — the five stations", () => {
  it("names the stations in order, uppercase mono", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "assets" }));
    const rail = screen.getByTestId("reweave-rail");
    const labels = Array.from(rail.querySelectorAll("[data-testid^='reweave-station-']")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["ASSETS", "CORE", "STAGE", "SWAP", "RELAUNCH"]);
    for (const el of rail.querySelectorAll("[data-testid^='reweave-station-']")) {
      expect((el as HTMLElement).style.fontFamily).toBe("var(--f-mono)");
    }
  });

  it("assets: the first station active, the rest pending", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "assets" }));
    expect(stationStates()).toEqual({
      assets: "active",
      core: "pending",
      stage: "pending",
      swap: "pending",
      relaunch: "pending",
    });
  });

  it("core: assets completed, core active", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "core" }));
    expect(stationStates()).toEqual({
      assets: "done",
      core: "active",
      stage: "pending",
      swap: "pending",
      relaunch: "pending",
    });
    // The active station is luminous; completed dimmed; pending faint.
    expect(screen.getByTestId("reweave-station-core").style.color).toBe("var(--accent)");
    expect(screen.getByTestId("reweave-station-assets").style.color).toBe("var(--t2)");
    expect(screen.getByTestId("reweave-station-stage").style.color).toBe("var(--t3)");
  });

  it("relaunch: everything before it completed", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "relaunch", cancellable: false }));
    expect(stationStates()).toEqual({
      assets: "done",
      core: "done",
      stage: "done",
      swap: "done",
      relaunch: "active",
    });
  });

  it("done (dev): the stations it reached read completed; the rest stay pending", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "stage", mode: "dev" }));
    push(
      state({
        stage: "done",
        mode: "dev",
        cancellable: false,
        outcome: "in dev, restart `tauri dev` to load the core.",
      }),
    );
    expect(stationStates()).toEqual({
      assets: "done",
      core: "done",
      stage: "done",
      swap: "pending",
      relaunch: "pending",
    });
  });

  it("failed: the station it failed at is marked, the earlier ones completed", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "core" }));
    push(state({ stage: "failed", cancellable: false, outcome: "the core would not build — see the tail" }));
    expect(stationStates()).toEqual({
      assets: "done",
      core: "failed",
      stage: "pending",
      swap: "pending",
      relaunch: "pending",
    });
    expect(screen.getByTestId("reweave-station-core").style.color).toBe("var(--danger)");
  });
});

describe("Reweave — tail, clock, cancel", () => {
  it("shows the last six lines of the tail, mono", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    const tail = Array.from({ length: 10 }, (_, i) => `Compiling crate-${i}`);
    push(state({ stage: "core", tail }));
    const lines = screen.getAllByTestId("reweave-tail-line").map((el) => el.textContent);
    expect(lines).toEqual(tail.slice(-6));
    expect(screen.getByTestId("reweave-tail").style.fontFamily).toBe("var(--f-mono)");
  });

  it("shows elapsed as m:ss from the state's elapsedMs", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "core", elapsedMs: 754_000 }));
    expect(screen.getByTestId("reweave-elapsed")).toHaveTextContent("12:34");
  });

  it("formatElapsed pads seconds and floors", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5_999)).toBe("0:05");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_600_000)).toBe("60:00");
  });

  it("CANCEL is present while cancellable and calls the cancel seam", async () => {
    const { feed, push } = makeFeed();
    const cancel = vi.fn(async () => {});
    render(<Reweave feed={feed} cancel={cancel} />);
    push(state({ stage: "assets", cancellable: true }));
    const btn = screen.getByTestId("reweave-cancel");
    expect(btn).toHaveTextContent("CANCEL");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("CANCEL is hidden past the point of return", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "swap", cancellable: false }));
    expect(screen.queryByTestId("reweave-cancel")).not.toBeInTheDocument();
  });
});

describe("Reweave — the warning comes BEFORE the irreversible step", () => {
  it("stage (packaged, still cancellable): warns that the next station cannot be undone", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "stage", cancellable: true }));
    // CANCEL is still there — this is the last moment the owner can stop it.
    expect(screen.getByTestId("reweave-cancel")).toBeInTheDocument();
    const line = screen.getByTestId("reweave-return-line");
    expect(line).toHaveTextContent(APPROACHING_RETURN);
    expect(APPROACHING_RETURN).toMatch(/microphone/);
    expect(APPROACHING_RETURN).not.toMatch(/!/);
  });

  it("stage (dev): no warning — nothing is swapped, so nothing is irreversible", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "stage", mode: "dev", cancellable: true }));
    expect(screen.queryByTestId("reweave-return-line")).not.toBeInTheDocument();
  });

  it("assets and core: no warning yet — the irreversible step is still two stations away", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "assets", cancellable: true }));
    expect(screen.queryByTestId("reweave-return-line")).not.toBeInTheDocument();
    push(state({ stage: "core", cancellable: true }));
    expect(screen.queryByTestId("reweave-return-line")).not.toBeInTheDocument();
  });
});

describe("Reweave — the honest lines", () => {
  it("swap: says LOOM will close and return, and names the microphone", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "swap", cancellable: false }));
    const line = screen.getByTestId("reweave-return-line");
    expect(line).toHaveTextContent(
      "past the point of return — LOOM will close and return in a moment. macOS may ask for the microphone again.",
    );
    expect(POINT_OF_RETURN).not.toMatch(/!/);
  });

  it("failed: shows the outcome line and a DISMISS that hides the card", async () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "failed", cancellable: false, outcome: "the assets would not build — see the tail" }));
    expect(screen.getByTestId("reweave-outcome")).toHaveTextContent(
      "the assets would not build — see the tail",
    );
    const dismiss = screen.getByTestId("reweave-dismiss");
    expect(dismiss).toHaveTextContent("DISMISS");
    await act(async () => {
      fireEvent.click(dismiss);
    });
    expect(screen.queryByTestId("reweave-card")).not.toBeInTheDocument();
  });

  it("a dismissed card returns when a new weave starts", async () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(state({ stage: "failed", cancellable: false, outcome: "the core would not build" }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("reweave-dismiss"));
    });
    push(state({ stage: "assets" }));
    expect(screen.getByTestId("reweave-card")).toBeInTheDocument();
  });

  it("done in dev: the outcome line, no DISMISS needed but a way to close", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    push(
      state({
        stage: "done",
        mode: "dev",
        cancellable: false,
        outcome: "in dev, restart `tauri dev` to load the core.",
      }),
    );
    expect(screen.getByTestId("reweave-outcome")).toHaveTextContent(
      "in dev, restart `tauri dev` to load the core.",
    );
    expect(screen.queryByTestId("reweave-cancel")).not.toBeInTheDocument();
    expect(screen.getByTestId("reweave-dismiss")).toBeInTheDocument();
  });

  it("carries no exclamation marks anywhere", () => {
    const { feed, push } = makeFeed();
    render(<Reweave feed={feed} cancel={vi.fn()} />);
    for (const stage of ["assets", "core", "stage", "swap", "relaunch"] as const) {
      push(state({ stage, cancellable: stage === "assets" }));
      expect(screen.getByTestId("reweave-card").textContent).not.toMatch(/!/);
    }
  });
});
