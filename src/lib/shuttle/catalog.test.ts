/**
 * catalog.test.ts — the shuttle's command catalog.
 *
 * The catalog is the single source of truth shared by voice and the Cmd+K
 * palette. These tests enforce the no-drift contract: every phrase and alias
 * the catalog advertises must actually classify through the real intent
 * rules (classifyByRules) — anything sayable is
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

const ORGANS = [
  { id: "water-tracker", title: "Water Tracker" },
  { id: "settings", title: "Settings" },
];

function catalog(): CatalogEntry[] {
  return buildCatalog({ organs: ORGANS });
}

// ── shape ────────────────────────────────────────────────────────────────────

describe("buildCatalog — shape", () => {
  it("returns entries in all three groups when organs are present", () => {
    const groups = new Set(catalog().map((e) => e.group));
    for (const g of ["build", "organs", "system"] as const) {
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
    // system + build still present
    expect(entries.some((e) => e.group === "system")).toBe(true);
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

// ── no-drift: the retired Cockpit left no catalog trace ──────────────────────

describe("buildCatalog — no Cockpit residue (Rebirth)", () => {
  it("advertises no deck, globe, terminal, or briefing phrase", () => {
    for (const e of catalog()) {
      for (const phrase of [e.phrase, ...e.aliases]) {
        expect(phrase, `"${phrase}" must not name a retired surface`).not.toMatch(/globe|deck|terminal|brief|watch|ember|floor|market/i);
      }
      expect(String(e.group)).not.toMatch(/decks|watch/);
    }
  });
});

// ── no-drift: help / organs / system classify through intent rules ───────────

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

// ── no-drift: rebirth entries (Phase 23) route through the rebirth rules ─────

describe("buildCatalog — rebirth entries derive from the intent phrase tables", () => {
  const expected: [string, string][] = [
    ["system-reweave", "reweave"],
    ["system-thread", "thread"],
    ["system-identity", "identity"],
    ["system-generation-return", "generation_return"],
  ];

  for (const [id, intent] of expected) {
    it(`${id} is a system utterance whose phrase and aliases classify as ${intent}`, () => {
      const entry = buildCatalog({}).find((e) => e.id === id);
      expect(entry, `${id} must exist even without organs`).toBeDefined();
      expect(entry!.group).toBe("system");
      expect(entry!.kind).toBe("utterance");
      for (const phrase of [entry!.phrase, ...entry!.aliases]) {
        expect(classifyByRules(phrase, [])?.intent, `"${phrase}" must classify as ${intent}`).toBe(intent);
      }
    });
  }

  it("hints obey the copy law — lowercase sentences, no exclamation marks", () => {
    for (const [id] of expected) {
      const entry = catalog().find((e) => e.id === id)!;
      expect(entry.hint).not.toMatch(/!/);
      expect(entry.hint.charAt(0)).toBe(entry.hint.charAt(0).toLowerCase());
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

  it("phrase prefix matches ('open s' → open settings first)", () => {
    const out = fuzzyFilter("open s", entries);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].phrase).toBe("open settings");
  });

  it("word-prefix matches across words ('op sett' → open settings)", () => {
    const out = fuzzyFilter("op sett", entries);
    expect(out.some((e) => e.phrase === "open settings")).toBe(true);
  });

  it("subsequence matches ('opnstt' → open settings)", () => {
    const out = fuzzyFilter("opnstt", entries);
    expect(out.some((e) => e.phrase === "open settings")).toBe(true);
  });

  it("matches aliases ('water-tracker' finds open water tracker)", () => {
    const out = fuzzyFilter("water-tracker", entries);
    expect(out.some((e) => e.phrase === "open water tracker")).toBe(true);
  });

  it("no match returns empty array", () => {
    expect(fuzzyFilter("zqxjv", entries)).toEqual([]);
  });

  it("is case-insensitive", () => {
    const out = fuzzyFilter("OPEN SETTINGS", entries);
    expect(out[0]?.phrase).toBe("open settings");
  });

  it("preserves group order and is stable within a group", () => {
    const out = fuzzyFilter("open", entries);
    // group-contiguous, respecting GROUP_ORDER
    const seen: string[] = [];
    for (const e of out) {
      if (seen[seen.length - 1] !== e.group) seen.push(e.group);
    }
    expect(seen).toEqual(GROUP_ORDER.filter((g) => seen.includes(g)));
    // stable: relative order of equal-score siblings matches catalog order
    const sysOut = out.filter((e) => e.group === "system").map((e) => e.id);
    const sysIn = entries
      .filter((e) => e.group === "system" && sysOut.includes(e.id))
      .map((e) => e.id);
    // every kept entry appears; ordering within score ties follows catalog
    expect(sysOut).toEqual(sysIn);
  });

  it("does not mutate the input array", () => {
    const before = [...entries];
    fuzzyFilter("open", entries);
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
    expect(text).toContain('"build me a …"');
    expect(text).toContain('"open water tracker"');
    expect(text).toContain('"open settings"');
  });

  it("omits groups with no entries (no organs → no organs group)", () => {
    const text = helpText(buildCatalog({}));
    expect(text.toLowerCase()).not.toContain("organs");
  });

  it("caps at two examples per group", () => {
    // system has three entries (settings, help, self-edit); only two are spoken
    const text = helpText(catalog());
    const systemSegment = text.split(/\bsystem\b/i)[1] ?? "";
    const quoted = systemSegment.match(/"[^"]+"/g) ?? [];
    expect(quoted.length).toBe(2);
  });
});
