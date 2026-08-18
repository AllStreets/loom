import { describe, it, expect } from "vitest";
import { classifyDeckCommand } from "./commands";

// ── Deck show/hide ────────────────────────────────────────────────────────────

describe("classifyDeckCommand — deck show", () => {
  it("'show the globe' → deckSwitch:globe, no bridgeCmds", () => {
    const r = classifyDeckCommand("show the globe", "void");
    expect(r).not.toBeNull();
    expect(r!.deckSwitch).toBe("globe");
    expect(r!.bridgeCmds).toHaveLength(0);
    expect(r!.confirmation).toMatch(/globe up/i);
  });

  it("'open the world' → deckSwitch:globe", () => {
    const r = classifyDeckCommand("open the world", "void");
    expect(r!.deckSwitch).toBe("globe");
    expect(r!.bridgeCmds).toHaveLength(0);
  });

  it("'show the map' → deckSwitch:globe", () => {
    const r = classifyDeckCommand("show the map", "void");
    expect(r!.deckSwitch).toBe("globe");
  });

  it("'open globe' (already on globe) → deckSwitch:globe still", () => {
    const r = classifyDeckCommand("open globe", "globe");
    expect(r!.deckSwitch).toBe("globe");
    expect(r!.bridgeCmds).toHaveLength(0);
  });
});

describe("classifyDeckCommand — deck hide", () => {
  it("'hide the globe' → deckSwitch:void, no bridgeCmds", () => {
    const r = classifyDeckCommand("hide the globe", "globe");
    expect(r).not.toBeNull();
    expect(r!.deckSwitch).toBe("void");
    expect(r!.bridgeCmds).toHaveLength(0);
    expect(r!.confirmation).toMatch(/void/i);
  });

  it("'back to the void' → deckSwitch:void", () => {
    const r = classifyDeckCommand("back to the void", "globe");
    expect(r!.deckSwitch).toBe("void");
  });

  it("'back to void' (no 'the') → deckSwitch:void", () => {
    const r = classifyDeckCommand("back to void", "globe");
    expect(r!.deckSwitch).toBe("void");
  });

  it("'close the world' → deckSwitch:void", () => {
    const r = classifyDeckCommand("close the world", "globe");
    expect(r!.deckSwitch).toBe("void");
  });
});

// ── Category filter ───────────────────────────────────────────────────────────

describe("classifyDeckCommand — category filters (AUSPEX ids verbatim)", () => {
  it("'show military' → set_cat military, globe deck active", () => {
    const r = classifyDeckCommand("show military", "globe");
    expect(r).not.toBeNull();
    expect(r!.bridgeCmds).toHaveLength(1);
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "military" });
    expect(r!.deckSwitch).toBeUndefined();
    expect(r!.confirmation).toMatch(/military/i);
  });

  it("'show military news' → set_cat military", () => {
    const r = classifyDeckCommand("show military news", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "military" });
  });

  it("'show geopolitical' → set_cat geo (AUSPEX id)", () => {
    const r = classifyDeckCommand("show geopolitical", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "geo" });
  });

  it("'show geopolitical news' → set_cat geo", () => {
    const r = classifyDeckCommand("show geopolitical news", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "geo" });
  });

  it("'show finance' → set_cat finance", () => {
    const r = classifyDeckCommand("show finance", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "finance" });
  });

  it("'show financial news' → set_cat finance", () => {
    const r = classifyDeckCommand("show financial news", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "finance" });
  });

  it("'show climate' → set_cat climate", () => {
    const r = classifyDeckCommand("show climate", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "climate" });
  });

  it("'show climate news' → set_cat climate", () => {
    const r = classifyDeckCommand("show climate news", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "climate" });
  });

  it("'show tech' → set_cat tech", () => {
    const r = classifyDeckCommand("show tech", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "tech" });
  });

  it("'show technology news' → set_cat tech", () => {
    const r = classifyDeckCommand("show technology news", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "tech" });
  });

  it("'filter military' → set_cat military", () => {
    const r = classifyDeckCommand("filter military", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "military" });
  });
});

// ── Vessels ───────────────────────────────────────────────────────────────────

describe("classifyDeckCommand — vessels overlay", () => {
  it("'show vessels' → toggle_overlay vessels, globe active", () => {
    const r = classifyDeckCommand("show vessels", "globe");
    expect(r).not.toBeNull();
    expect(r!.bridgeCmds[0]).toEqual({ type: "toggle_overlay", overlay: "vessels" });
    expect(r!.deckSwitch).toBeUndefined();
  });

  it("'show ships' → toggle_overlay vessels", () => {
    const r = classifyDeckCommand("show ships", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "toggle_overlay", overlay: "vessels" });
  });

  it("'toggle vessels' → toggle_overlay vessels", () => {
    const r = classifyDeckCommand("toggle vessels", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "toggle_overlay", overlay: "vessels" });
  });
});

// ── Spin ──────────────────────────────────────────────────────────────────────

describe("classifyDeckCommand — spin start/stop", () => {
  it("'start spinning' → set_spin on:true", () => {
    const r = classifyDeckCommand("start spinning", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_spin", on: true });
  });

  it("'start rotation' → set_spin on:true", () => {
    const r = classifyDeckCommand("start rotation", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_spin", on: true });
  });

  it("'stop spinning' → set_spin on:false", () => {
    const r = classifyDeckCommand("stop spinning", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_spin", on: false });
  });

  it("'stop rotation' → set_spin on:false", () => {
    const r = classifyDeckCommand("stop rotation", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_spin", on: false });
  });
});

// ── Reset view ────────────────────────────────────────────────────────────────

describe("classifyDeckCommand — reset view", () => {
  it("'reset the view' → reset_view", () => {
    const r = classifyDeckCommand("reset the view", "globe");
    expect(r).not.toBeNull();
    expect(r!.bridgeCmds[0]).toEqual({ type: "reset_view" });
    expect(r!.confirmation).toMatch(/view reset/i);
  });

  it("'reset globe' → reset_view", () => {
    const r = classifyDeckCommand("reset globe", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "reset_view" });
  });

  it("'reset camera' → reset_view", () => {
    const r = classifyDeckCommand("reset camera", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "reset_view" });
  });
});

// ── Auto-switch from void ─────────────────────────────────────────────────────

describe("classifyDeckCommand — auto-switch when void + globe-only cmd", () => {
  it("'show vessels' from void → deckSwitch:globe THEN toggle_overlay vessels", () => {
    const r = classifyDeckCommand("show vessels", "void");
    expect(r).not.toBeNull();
    expect(r!.deckSwitch).toBe("globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "toggle_overlay", overlay: "vessels" });
  });

  it("'show military' from void → deckSwitch:globe then set_cat military", () => {
    const r = classifyDeckCommand("show military", "void");
    expect(r!.deckSwitch).toBe("globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "military" });
  });

  it("'reset the view' from void → deckSwitch:globe then reset_view", () => {
    const r = classifyDeckCommand("reset the view", "void");
    expect(r!.deckSwitch).toBe("globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "reset_view" });
  });

  it("'stop spinning' from void → deckSwitch:globe then set_spin false", () => {
    const r = classifyDeckCommand("stop spinning", "void");
    expect(r!.deckSwitch).toBe("globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_spin", on: false });
  });

  it("'show geopolitical' from void → deckSwitch:globe then set_cat geo", () => {
    const r = classifyDeckCommand("show geopolitical", "void");
    expect(r!.deckSwitch).toBe("globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "geo" });
  });
});

// ── "all" category requires news context (M1 fix) ────────────────────────────

describe("classifyDeckCommand — 'all' ambiguity guard", () => {
  it("'show all news' → set_cat all", () => {
    const r = classifyDeckCommand("show all news", "globe");
    expect(r).not.toBeNull();
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "all" });
  });

  it("'show all coverage' → set_cat all", () => {
    const r = classifyDeckCommand("show all coverage", "globe");
    expect(r).not.toBeNull();
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "all" });
  });

  it("'show all categories' → set_cat all", () => {
    const r = classifyDeckCommand("show all categories", "globe");
    expect(r).not.toBeNull();
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "all" });
  });

  it("'show all my notes' → null (no news context)", () => {
    expect(classifyDeckCommand("show all my notes", "void")).toBeNull();
  });

  it("'display all' (no news context) → null", () => {
    expect(classifyDeckCommand("display all", "globe")).toBeNull();
  });
});

// ── Non-deck phrases return null ──────────────────────────────────────────────

describe("classifyDeckCommand — non-deck phrases", () => {
  it("returns null for 'build me a water tracker'", () => {
    expect(classifyDeckCommand("build me a water tracker", "void")).toBeNull();
  });

  it("returns null for 'show me a water tracker'", () => {
    // 'show' matches but 'water tracker' is not a globe/world/map/vessels/cat keyword
    // and 'water tracker' has no category match — should return null
    expect(classifyDeckCommand("show me a water tracker", "void")).toBeNull();
  });

  it("returns null for 'hello'", () => {
    expect(classifyDeckCommand("hello", "void")).toBeNull();
  });

  it("returns null for 'what can you do?'", () => {
    expect(classifyDeckCommand("what can you do?", "void")).toBeNull();
  });

  it("returns null for 'add a delete button to water-tracker'", () => {
    expect(classifyDeckCommand("add a delete button to water-tracker", "void")).toBeNull();
  });
});

describe("classifyDeckCommand — ember deck", () => {
  it("'show ember' → deckSwitch:ember, no bridgeCmds", () => {
    const r = classifyDeckCommand("show ember", "void");
    expect(r).not.toBeNull();
    expect(r!.deckSwitch).toBe("ember");
    expect(r!.bridgeCmds).toHaveLength(0);
    expect(r!.confirmation).toMatch(/failsafe/i);
  });

  it("'show survival' → deckSwitch:ember", () => {
    const r = classifyDeckCommand("show survival", "void");
    expect(r!.deckSwitch).toBe("ember");
  });

  it("'the failsafe' → deckSwitch:ember", () => {
    const r = classifyDeckCommand("the failsafe", "void");
    expect(r!.deckSwitch).toBe("ember");
  });

  it("'open the failsafe' → deckSwitch:ember", () => {
    const r = classifyDeckCommand("open the failsafe", "void");
    expect(r!.deckSwitch).toBe("ember");
  });

  // Regressions: globe/terminal/category rules untouched
  it("REGRESSION 'show the globe' still → globe (not ember)", () => {
    expect(classifyDeckCommand("show the globe", "void")!.deckSwitch).toBe("globe");
  });

  it("REGRESSION 'show markets' still → terminal (not ember)", () => {
    expect(classifyDeckCommand("show markets", "void")!.deckSwitch).toBe("terminal");
  });

  it("REGRESSION 'show military' still → set_cat military (not ember)", () => {
    const r = classifyDeckCommand("show military", "globe");
    expect(r!.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "military" });
  });
});

describe("classifyDeckCommand — terminal deck", () => {
  it("'show the terminal' → deckSwitch:terminal", () => {
    const r = classifyDeckCommand("show the terminal", "void");
    expect(r!.deckSwitch).toBe("terminal");
    expect(r!.bridgeCmds).toEqual([]);
    expect(r!.confirmation).toMatch(/tape|live/i);
  });

  it("'show markets' → deckSwitch:terminal", () => {
    const r = classifyDeckCommand("show markets", "void");
    expect(r!.deckSwitch).toBe("terminal");
  });

  it("'show me the markets' → deckSwitch:terminal", () => {
    const r = classifyDeckCommand("show me the markets", "void");
    expect(r!.deckSwitch).toBe("terminal");
  });

  it("'show the tape' → deckSwitch:terminal", () => {
    const r = classifyDeckCommand("show the tape", "void");
    expect(r!.deckSwitch).toBe("terminal");
  });

  it("'hide the terminal' → deckSwitch:void", () => {
    const r = classifyDeckCommand("hide the terminal", "terminal");
    expect(r!.deckSwitch).toBe("void");
  });

  it("'close markets' → deckSwitch:void", () => {
    const r = classifyDeckCommand("close markets", "terminal");
    expect(r!.deckSwitch).toBe("void");
  });

  // Regression: globe/void rules untouched by the new terminal patterns.
  it("REGRESSION 'show the globe' still → globe (not terminal)", () => {
    expect(classifyDeckCommand("show the globe", "void")!.deckSwitch).toBe("globe");
  });

  it("REGRESSION 'show the world' still → globe", () => {
    expect(classifyDeckCommand("show the world", "void")!.deckSwitch).toBe("globe");
  });

  it("REGRESSION 'show finance' still → set_cat finance (globe), not terminal", () => {
    const r = classifyDeckCommand("show finance", "globe");
    expect(r!.deckSwitch).toBeUndefined();
    expect(r!.bridgeCmds).toEqual([{ type: "set_cat", cat: "finance" }]);
  });

  it("REGRESSION 'show financial markets' → set_cat finance (NOT terminal deck switch)", () => {
    // Verbatim phrase: the category filter (CAT_RE, highest priority) must win
    // over TERMINAL_SHOW_RE's 'markets' token. deckSwitch must be absent when
    // already on globe; the only bridge command is set_cat finance.
    const r = classifyDeckCommand("show financial markets", "globe");
    expect(r).not.toBeNull();
    expect(r!.deckSwitch).toBeUndefined();
    expect(r!.bridgeCmds).toEqual([{ type: "set_cat", cat: "finance" }]);
  });

  it("REGRESSION 'back to the void' still → void", () => {
    expect(classifyDeckCommand("back to the void", "terminal")!.deckSwitch).toBe("void");
  });
});
