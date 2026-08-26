import { describe, it, expect, beforeEach, vi } from "vitest";
import { getInitiativeState, markProposed, addNever } from "./store";

beforeEach(() => {
  localStorage.clear();
});

describe("initiative store", () => {
  it("fresh state: lastProposalTs 0, empty neverList", () => {
    const s = getInitiativeState();
    expect(s.lastProposalTs).toBe(0);
    expect(s.neverList).toEqual([]);
  });

  it("markProposed persists the timestamp", () => {
    markProposed(1_700_000_000_000);
    expect(getInitiativeState().lastProposalTs).toBe(1_700_000_000_000);
  });

  it("addNever appends an id and persists it", () => {
    addNever("price-alert:BTC-USD");
    expect(getInitiativeState().neverList).toEqual(["price-alert:BTC-USD"]);
  });

  it("addNever dedupes", () => {
    addNever("morning-brief");
    addNever("morning-brief");
    expect(getInitiativeState().neverList).toEqual(["morning-brief"]);
  });

  it("addNever preserves lastProposalTs, markProposed preserves neverList", () => {
    markProposed(123);
    addNever("topic-digest:science");
    const s = getInitiativeState();
    expect(s.lastProposalTs).toBe(123);
    expect(s.neverList).toEqual(["topic-digest:science"]);
  });

  it("round-trips through localStorage", () => {
    markProposed(999);
    addNever("morning-brief");
    addNever("price-alert:ETH-USD");
    const s = getInitiativeState();
    expect(s.lastProposalTs).toBe(999);
    expect(s.neverList).toEqual(["morning-brief", "price-alert:ETH-USD"]);
  });

  it("tolerates corrupt JSON — returns fresh state", () => {
    localStorage.setItem("loom.initiative.v1", "{broken");
    const s = getInitiativeState();
    expect(s.lastProposalTs).toBe(0);
    expect(s.neverList).toEqual([]);
  });

  it("tolerates a partial object — fills missing fields", () => {
    localStorage.setItem("loom.initiative.v1", JSON.stringify({ lastProposalTs: 5 }));
    const s = getInitiativeState();
    expect(s.lastProposalTs).toBe(5);
    expect(s.neverList).toEqual([]);
  });

  it("tolerates a non-array neverList", () => {
    localStorage.setItem("loom.initiative.v1", JSON.stringify({ neverList: "nope" }));
    expect(getInitiativeState().neverList).toEqual([]);
  });

  it("never throws when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => markProposed(1)).not.toThrow();
    expect(() => addNever("x")).not.toThrow();
    spy.mockRestore();
  });
});
