import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// organList reaches the Tauri shell in real life — mock it to a controllable
// list of installed organs so evaluation is deterministic in jsdom.
let mockOrgans: Array<{ id: string; manifest: string; granted: string | null }> = [];
vi.mock("../core", () => ({
  organList: () => Promise.resolve(mockOrgans),
}));

import { mountInitiative } from "./runtime";
import { saveUsage, emptyLedger } from "./observe";
import { setSetting } from "../voice/settings";

// A ledger with 6 btc floor opens earns the price-alert archetype (gate ≥4).
function seedEarnedLedger() {
  const l = emptyLedger(Date.now());
  l.floorOpens = { btc: 6 };
  saveUsage(l);
}

function collectProposals(): { proposals: unknown[]; stop: () => void } {
  const proposals: unknown[] = [];
  const on = (ev: Event) => proposals.push((ev as CustomEvent).detail?.proposal);
  window.addEventListener("loom-proposal", on);
  return { proposals, stop: () => window.removeEventListener("loom-proposal", on) };
}

beforeEach(() => {
  localStorage.clear();
  mockOrgans = [];
  setSetting("cockpit.initiative", "on");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("mountInitiative", () => {
  it("emits loom-proposal once on mount when an idea is earned", async () => {
    seedEarnedLedger();
    const { proposals, stop } = collectProposals();
    const unmount = mountInitiative();
    // The on-mount evaluate() is async (organList) — flush microtasks.
    await vi.runOnlyPendingTimersAsync();
    stop();
    unmount();
    expect(proposals).toHaveLength(1);
    expect((proposals[0] as { id: string }).id).toBe("price-alert:btc");
  });

  it("emits nothing when the setting is off", async () => {
    seedEarnedLedger();
    setSetting("cockpit.initiative", "off");
    const { proposals, stop } = collectProposals();
    const unmount = mountInitiative();
    await vi.runOnlyPendingTimersAsync();
    stop();
    unmount();
    expect(proposals).toHaveLength(0);
  });

  it("emits nothing when nothing is earned (silence is the common case)", async () => {
    saveUsage(emptyLedger(Date.now())); // empty — no floor opens
    const { proposals, stop } = collectProposals();
    const unmount = mountInitiative();
    await vi.runOnlyPendingTimersAsync();
    stop();
    unmount();
    expect(proposals).toHaveLength(0);
  });

  it("does not re-emit a second proposal while a card is still live", async () => {
    seedEarnedLedger();
    const { proposals, stop } = collectProposals();
    const unmount = mountInitiative();
    await vi.runOnlyPendingTimersAsync();
    expect(proposals).toHaveLength(1);

    // An activity event fires while the card is still open — debounced eval must
    // not stack a second proposal.
    window.dispatchEvent(new CustomEvent("loom-floor-open", { detail: { product: "btc" } }));
    await vi.runOnlyPendingTimersAsync();
    stop();
    unmount();
    expect(proposals).toHaveLength(1);
  });

  it("re-evaluates after the card closes (loom-proposal-closed clears the guard)", async () => {
    seedEarnedLedger();
    const { proposals, stop } = collectProposals();
    const unmount = mountInitiative();
    await vi.runOnlyPendingTimersAsync();
    expect(proposals).toHaveLength(1);

    // Card closed WITHOUT writing markProposed (e.g. programmatic close in test).
    // The guard clears; a fresh activity event should be able to re-emit since
    // the store still has lastProposalTs 0 (rate-limit not tripped).
    window.dispatchEvent(new CustomEvent("loom-proposal-closed"));
    window.dispatchEvent(new CustomEvent("loom-floor-open", { detail: { product: "btc" } }));
    await vi.runOnlyPendingTimersAsync();
    stop();
    unmount();
    expect(proposals.length).toBeGreaterThanOrEqual(2);
  });

  it("unmount removes all listeners — activity after unmount emits nothing", async () => {
    seedEarnedLedger();
    const { proposals, stop } = collectProposals();
    const unmount = mountInitiative();
    await vi.runOnlyPendingTimersAsync();
    const countAtUnmount = proposals.length;
    unmount();

    window.dispatchEvent(new CustomEvent("loom-floor-open", { detail: { product: "btc" } }));
    await vi.runOnlyPendingTimersAsync();
    stop();
    expect(proposals.length).toBe(countAtUnmount);
  });
});
