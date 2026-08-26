import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup, waitForElementToBeRemoved } from "@testing-library/react";
import Proposal from "./Proposal";
import type { Proposal as ProposalType } from "../../lib/initiative/propose";
import { getInitiativeState } from "../../lib/initiative/store";

// Controllable reduced-motion — flipped per test.
let mockRm = false;
vi.mock("framer-motion", async (importOriginal) => {
  const mod = await importOriginal<typeof import("framer-motion")>();
  return { ...mod, useReducedMotion: () => mockRm };
});

const SAMPLE: ProposalType = {
  id: "price-alert:btc",
  archetype: "price-alert",
  title: "a btc price alert",
  rationale: "you opened the btc floor 6 times. i could notify you when it moves more than 3% in an hour.",
  request: "Build a price-alert organ that notifies me when btc moves more than 3% in an hour.",
  powers: ["pulse", "market", "notify"],
};

function propose(p: ProposalType = SAMPLE) {
  act(() => {
    window.dispatchEvent(new CustomEvent("loom-proposal", { detail: { proposal: p } }));
  });
}

beforeEach(() => {
  mockRm = false;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("Proposal", () => {
  it("renders nothing before any proposal arrives", () => {
    render(<Proposal />);
    expect(screen.queryByTestId("proposal-card")).toBeNull();
  });

  it("floats the card on loom-proposal with title, rationale, and a plain-language powers line", () => {
    render(<Proposal />);
    propose();
    expect(screen.getByTestId("proposal-card")).toBeTruthy();
    expect(screen.getByTestId("proposal-title").textContent).toBe("a btc price alert");
    expect(screen.getByTestId("proposal-rationale").textContent).toContain("opened the btc floor 6 times");
    // Powers rendered via POWER_LABELS, dot-joined
    const powers = screen.getByTestId("proposal-powers").textContent ?? "";
    expect(powers).toContain("it will ask to:");
    expect(powers).toContain("run on a schedule");
    expect(powers).toContain("read market data");
    expect(powers).toContain("notify you");
  });

  it("ignores malformed proposals without an id/title", () => {
    render(<Proposal />);
    act(() => {
      window.dispatchEvent(new CustomEvent("loom-proposal", { detail: {} }));
      window.dispatchEvent(new CustomEvent("loom-proposal"));
    });
    expect(screen.queryByTestId("proposal-card")).toBeNull();
  });

  it("shows only ONE card at a time — a second proposal is ignored while one is live", () => {
    render(<Proposal />);
    propose(SAMPLE);
    propose({ ...SAMPLE, id: "morning-brief", title: "a morning brief" });
    expect(screen.getByTestId("proposal-title").textContent).toBe("a btc price alert");
  });

  it("first-ever proposal (empty neverList AND lastProposalTs 0) shows the calm intro line", () => {
    render(<Proposal />);
    propose();
    expect(screen.getByTestId("proposal-intro")).toBeTruthy();
    expect(screen.getByTestId("proposal-intro").textContent).toContain("Settings");
  });

  it("a non-first proposal (lastProposalTs already set) hides the intro line", () => {
    localStorage.setItem("loom.initiative.v1", JSON.stringify({ lastProposalTs: 123, neverList: [] }));
    render(<Proposal />);
    propose();
    expect(screen.queryByTestId("proposal-intro")).toBeNull();
  });

  it("weave it: dispatches the SAME loom-utterance seam a typed build uses, with initiative:true", async () => {
    render(<Proposal />);
    const utterances: Array<{ text?: string; spoken?: boolean; initiative?: boolean }> = [];
    const onUtter = (ev: Event) => {
      utterances.push((ev as CustomEvent).detail);
    };
    window.addEventListener("loom-utterance", onUtter);
    propose();
    fireEvent.click(screen.getByTestId("proposal-weave"));
    window.removeEventListener("loom-utterance", onUtter);

    expect(utterances).toHaveLength(1);
    expect(utterances[0].text).toBe(SAMPLE.request);
    expect(utterances[0].spoken).toBe(false);
    expect(utterances[0].initiative).toBe(true);
    // markProposed wrote the quiet-window timestamp
    expect(getInitiativeState().lastProposalTs).toBeGreaterThan(0);
    // Card closes (exit animation resolves)
    await waitForElementToBeRemoved(() => screen.queryByTestId("proposal-card"));
  });

  it("not now: marks proposed (24h quiet), does NOT tombstone, and closes", async () => {
    render(<Proposal />);
    propose();
    fireEvent.click(screen.getByTestId("proposal-not-now"));
    const state = getInitiativeState();
    expect(state.lastProposalTs).toBeGreaterThan(0);
    expect(state.neverList).toEqual([]);
    await waitForElementToBeRemoved(() => screen.queryByTestId("proposal-card"));
  });

  it("never: tombstones this archetype id forever, marks proposed, and closes", async () => {
    render(<Proposal />);
    propose();
    fireEvent.click(screen.getByTestId("proposal-never"));
    const state = getInitiativeState();
    expect(state.neverList).toContain("price-alert:btc");
    expect(state.lastProposalTs).toBeGreaterThan(0);
    await waitForElementToBeRemoved(() => screen.queryByTestId("proposal-card"));
  });

  it("closing dispatches loom-proposal-closed so the runtime can surface the next idea", () => {
    render(<Proposal />);
    let closed = 0;
    const onClosed = () => { closed++; };
    window.addEventListener("loom-proposal-closed", onClosed);
    propose();
    fireEvent.click(screen.getByTestId("proposal-not-now"));
    window.removeEventListener("loom-proposal-closed", onClosed);
    expect(closed).toBe(1);
  });

  it("renders the woven glyph", () => {
    render(<Proposal />);
    propose();
    expect(screen.getByTestId("loom-glyph")).toBeTruthy();
  });

  it("reduced motion: still renders the card (static, no entrance animation crash)", () => {
    mockRm = true;
    render(<Proposal />);
    propose();
    expect(screen.getByTestId("proposal-card")).toBeTruthy();
    expect(screen.getByTestId("proposal-title").textContent).toBe("a btc price alert");
  });

  it("renders the rationale as text — a crafted rationale is escaped, never HTML", () => {
    render(<Proposal />);
    propose({ ...SAMPLE, rationale: "<img src=x onerror=alert(1)> injected" });
    const el = screen.getByTestId("proposal-rationale");
    // The literal text is present; no <img> element was created.
    expect(el.textContent).toContain("injected");
    expect(el.querySelector("img")).toBeNull();
  });
});
