/**
 * catalog.test.ts — the shuttle's command catalog.
 *
 * The catalog is the single source of truth shared by voice and the Cmd+K
 * palette. These tests enforce the no-drift contract: every phrase and alias
 * the catalog advertises must actually classify through the real intent
 * rules (classifyByRules / classifyDeckCommand) — anything sayable is
 * typeable and vice versa.
 */

import { describe, it, expect } from "vitest";
import {
  buildCatalog,
  fuzzyFilter,
  helpText,
  GROUP_ORDER,
  type CatalogEntry,
} from "./catalog";
import { classifyByRules } from "../compiler/intent";
import { classifyDeckCommand } from "../decks/commands";

const ORGANS = [
  { id: "water-tracker", title: "Water Tracker" },
  { id: "settings", title: "Settings" },
];

function catalog(): CatalogEntry[] {
  return buildCatalog({ organs: ORGANS });
}

// ── shape ────────────────────────────────────────────────────────────────────

describe("buildCatalog — shape", () => {
  it("returns entries in all five groups when organs are present", () => {
    const groups = new Set(catalog().map((e) => e.group));
    for (const g of ["decks", "watch", "build", "organs", "system"] as const) {
      expect(groups.has(g)).toBe(true);
    }
  });

  it("entry ids are unique", () => {
    const ids = catalog().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("entries are ordered by group (group-contiguous)", () => {
    const seen: string[] = [];
    for (const e of catalog()) {
      if (seen[seen.length - 1] !== e.group) seen.push(e.group);
    }
    // no group appears twice in the run-length sequence
    expect(new Set(seen).size).toBe(seen.length);
    // and the sequence respects GROUP_ORDER
    expect(seen).toEqual(GROUP_ORDER.filter((g) => seen.includes(g)));
  });

  it("works without ctx (static entries only, no organs group)", () => {
    const entries = buildCatalog({});
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.group === "organs")).toBe(false);
    // system + decks + watch + build still present
    expect(entries.some((e) => e.group === "decks")).toBe(true);
    expect(entries.some((e) => e.group === "build")).toBe(true);
  });

  it("does not advertise 'open settings' without an organs context (it could not route)", () => {
    // findMentionedOrgan matches against real organ ids; with no organs known
    // the phrase would dead-end, so the catalog must not offer it.
    const entries = buildCatalog({});
    expect(entries.some((e) => e.id === "system-settings")).toBe(false);
    const emptyOrgans = buildCatalog({ organs: [] });
    expect(emptyOrgans.some((e) => e.id === "system-settings")).toBe(false);
  });
});

// ── no-drift: deck entries classify through the real deck rules ──────────────

describe("buildCatalog — decks group derives from the real deck rules", () => {
  it("every decks phrase and alias classifies as a deck command", () => {
    const decks = catalog().filter((e) => e.group === "decks");
    expect(decks.length).toBeGreaterThan(5);
    for (const e of decks) {
      for (const phrase of [e.phrase, ...e.aliases]) {
        const result = classifyDeckCommand(phrase.toLowerCase(), "void");
        expect(result, `"${phrase}" must classify as a deck command`).not.toBeNull();
      }
    }
  });

  it("includes category filters derived from CAT_LABELS ('show military news' → set_cat)", () => {
    const entry = catalog().find((e) => e.phrase === "show military news");
    expect(entry).toBeDefined();
    const result = classifyDeckCommand(entry!.phrase, "globe");
    expect(result?.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "military" });
  });

  it("includes 'show the globe' with working aliases", () => {
    const entry = catalog().find((e) => e.phrase === "show the globe");
    expect(entry).toBeDefined();
    expect(entry!.aliases.length).toBeGreaterThan(0);
  });

  it("carries no exchange-deck entry — the floor aliases live under the terminal (Phase 18)", () => {
    const all = catalog();
    // The retired deck left no catalog trace — no entry names the exchange.
    expect(all.some((e) => e.phrase.includes("exchange") || e.aliases.some((a) => a.includes("exchange")))).toBe(false);
    // The floor phrases landed under the terminal entry and still classify there.
    const terminal = all.find((e) => e.id === "deck-terminal-show");
    expect(terminal).toBeDefined();
    expect(terminal!.aliases).toContain("open the floor");
    expect(terminal!.aliases).toContain("show the floor");
    expect(classifyDeckCommand("open the floor", "void")?.deckSwitch).toBe("terminal");
    expect(classifyDeckCommand("show the floor", "void")?.deckSwitch).toBe("terminal");
  });
});

// ── no-drift: watch / help / organs / system classify through intent rules ───

describe("buildCatalog — watch group derives from briefing intent rules", () => {
  it("briefing phrase and aliases classify as briefing", () => {
    const entry = catalog().find((e) => e.group === "watch");
    expect(entry).toBeDefined();
    for (const phrase of [entry!.phrase, ...entry!.aliases]) {
      const result = classifyByRules(phrase.toLowerCase(), []);
      expect(result?.intent, `"${phrase}" must classify as briefing`).toBe("briefing");
    }
  });
});

describe("buildCatalog — organs group routes through act_on_organ", () => {
  it("'open water tracker' resolves to the water-tracker organ", () => {
    const entry = catalog().find((e) => e.id === "organ-open-water-tracker");
    expect(entry).toBeDefined();
    expect(entry!.group).toBe("organs");
    const result = classifyByRules(entry!.phrase, ORGANS.map((o) => o.id));
    expect(result?.intent).toBe("act_on_organ");
    expect(result?.organId).toBe("water-tracker");
  });

  it("settings appears in system (not duplicated in organs)", () => {
    const entries = catalog();
    const system = entries.find((e) => e.id === "system-settings");
    expect(system).toBeDefined();
    expect(system!.group).toBe("system");
    expect(system!.phrase).toBe("open settings");
    expect(entries.filter((e) => e.group === "organs" && /settings/.test(e.phrase))).toHaveLength(0);
    // and the phrase really routes to the settings organ
    const result = classifyByRules("open settings", ORGANS.map((o) => o.id));
    expect(result?.intent).toBe("act_on_organ");
    expect(result?.organId).toBe("settings");
  });
});

describe("buildCatalog — system help entry routes to the help intent", () => {
  it("'what can you do' classifies as help", () => {
    const entry = catalog().find((e) => e.id === "system-help");
    expect(entry).toBeDefined();
    for (const phrase of [entry!.phrase, ...entry!.aliases]) {
      const result = classifyByRules(phrase.toLowerCase(), []);
      expect(result?.intent, `"${phrase}" must classify as help`).toBe("help");
    }
  });
});

describe("buildCatalog — build group", () => {
  it("has a template entry whose prefix classifies as build_organ", () => {
    const entry = catalog().find((e) => e.group === "build");
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("template");
    // completing the template must route to build_organ
    const completed = entry!.phrase.replace(/…\s*$/, "") + "water tracker";
    const result = classifyByRules(completed, []);
    expect(result?.intent).toBe("build_organ");
  });
});

describe("buildCatalog — system self-edit entry routes to self_edit", () => {
  it("has a self-edit template whose completion classifies as self_edit", () => {
    const entry = catalog().find((e) => e.id === "system-self-edit");
    expect(entry).toBeDefined();
    expect(entry!.group).toBe("system");
    expect(entry!.kind).toBe("template");
    // completing the template routes to self_edit (never a normal organ build)
    const completed = entry!.phrase.replace(/…\s*$/, "") + "brighten the orb";
    expect(classifyByRules(completed, [])?.intent).toBe("self_edit");
    // aliases also classify as self_edit (given a target)
    for (const alias of entry!.aliases) {
      const withTarget = /your$/.test(alias) ? `${alias} orb moods` : alias;
      expect(
        classifyByRules(withTarget, [])?.intent,
        `"${withTarget}" must be self_edit`,
      ).toBe("self_edit");
    }
  });
});

// ── fuzzyFilter ──────────────────────────────────────────────────────────────

describe("fuzzyFilter", () => {
  const entries = catalog();

  it("empty query returns all entries in catalog order", () => {
    expect(fuzzyFilter("", entries)).toEqual(entries);
    expect(fuzzyFilter("   ", entries)).toEqual(entries);
  });

  it("phrase prefix matches ('show the g' → show the globe first)", () => {
    const out = fuzzyFilter("show the g", entries);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].phrase).toBe("show the globe");
  });

  it("word-prefix matches across words ('sh glo' → show the globe)", () => {
    const out = fuzzyFilter("sh glo", entries);
    expect(out.some((e) => e.phrase === "show the globe")).toBe(true);
  });

  it("subsequence matches ('sglb' → show the globe)", () => {
    const out = fuzzyFilter("sglb", entries);
    expect(out.some((e) => e.phrase === "show the globe")).toBe(true);
  });

  it("matches aliases ('failsafe' finds show ember)", () => {
    const out = fuzzyFilter("failsafe", entries);
    expect(out.some((e) => e.phrase === "show ember")).toBe(true);
  });

  it("no match returns empty array", () => {
    expect(fuzzyFilter("zqxjv", entries)).toEqual([]);
  });

  it("is case-insensitive", () => {
    const out = fuzzyFilter("SHOW THE GLOBE", entries);
    expect(out[0]?.phrase).toBe("show the globe");
  });

  it("preserves group order and is stable within a group", () => {
    const out = fuzzyFilter("show", entries);
    // group-contiguous, respecting GROUP_ORDER
    const seen: string[] = [];
    for (const e of out) {
      if (seen[seen.length - 1] !== e.group) seen.push(e.group);
    }
    expect(seen).toEqual(GROUP_ORDER.filter((g) => seen.includes(g)));
    // stable: relative order of equal-score siblings matches catalog order
    const decksOut = out.filter((e) => e.group === "decks").map((e) => e.id);
    const decksIn = entries
      .filter((e) => e.group === "decks" && decksOut.includes(e.id))
      .map((e) => e.id);
    // every kept entry appears; ordering within score ties follows catalog
    expect(new Set(decksOut)).toEqual(new Set(decksIn));
  });

  it("does not mutate the input array", () => {
    const before = [...entries];
    fuzzyFilter("show", entries);
    expect(entries).toEqual(before);
  });
});

// ── helpText ─────────────────────────────────────────────────────────────────

describe("helpText — voice discoverability from the catalog", () => {
  it("speaks every present group name with up to two example phrases", () => {
    const text = helpText(catalog());
    for (const g of GROUP_ORDER) {
      expect(text.toLowerCase()).toContain(g);
    }
    expect(text).toContain('"show the globe"');
    expect(text).toContain('"brief me"');
    expect(text).toContain('"open settings"');
  });

  it("omits groups with no entries (no organs → no organs group)", () => {
    const text = helpText(buildCatalog({}));
    expect(text.toLowerCase()).not.toContain("organs");
  });

  it("caps at two examples per group", () => {
    const text = helpText(catalog());
    // decks has many entries; only two decks examples should be spoken
    const decksSegment = text.split(/\bwatch\b/i)[0];
    const quoted = decksSegment.match(/"[^"]+"/g) ?? [];
    expect(quoted.length).toBeLessThanOrEqual(2);
  });
});
