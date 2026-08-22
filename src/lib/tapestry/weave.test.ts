/**
 * weave.test.ts — the Tapestry's pure loom, tested before it exists.
 *
 * weaveModel maps LOOM's lived history onto a woven band. Everything here is
 * pure: same inputs → identical cloth. No Math.random, no Date.now — age
 * arrives via inputs.now, jitter is seeded from ids/shas.
 */

import { describe, it, expect } from "vitest";
import {
  weaveModel,
  formatAge,
  WARP_CAP,
  WEFT_CAP,
  type WeaveInputs,
} from "./weave";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_755_000_000_000; // fixed epoch — determinism is the whole point

function makeInputs(overrides: Partial<WeaveInputs> = {}): WeaveInputs {
  return {
    commits: [],
    organs: [],
    deletedOrganIds: [],
    experiences: [],
    learnedTop: [],
    decksUsed: [],
    now: NOW,
    ...overrides,
  };
}

describe("weaveModel — empty life", () => {
  it("returns empty warp and weft for empty inputs", () => {
    const model = weaveModel(makeInputs());
    expect(model.warp).toEqual([]);
    expect(model.weft).toEqual([]);
  });
});

describe("weaveModel — warp (commits)", () => {
  const commits = [
    { sha: "a0cee82ffffffff", message: "stage 6 ships — command" },
    { sha: "b1def93eeeeeeee", message: "older commit" },
    { sha: "c2efa04ddddddd0", message: "oldest commit" },
  ];

  it("weaves one warp thread per commit", () => {
    const model = weaveModel(makeInputs({ commits }));
    expect(model.warp).toHaveLength(3);
  });

  it("newest commit is brightest", () => {
    const model = weaveModel(makeInputs({ commits }));
    expect(model.warp[0].opacity).toBeGreaterThan(model.warp[1].opacity);
    expect(model.warp[1].opacity).toBeGreaterThan(model.warp[2].opacity);
  });

  it("newest commit sits furthest right (weaving advances rightward)", () => {
    const model = weaveModel(makeInputs({ commits }));
    expect(model.warp[0].x).toBeGreaterThan(model.warp[1].x);
    expect(model.warp[1].x).toBeGreaterThan(model.warp[2].x);
  });

  it("x positions stay within (0,1)", () => {
    const model = weaveModel(makeInputs({ commits }));
    for (const t of model.warp) {
      expect(t.x).toBeGreaterThan(0);
      expect(t.x).toBeLessThan(1);
    }
  });

  it("labels carry short sha and message", () => {
    const model = weaveModel(makeInputs({ commits }));
    expect(model.warp[0].label).toBe("commit a0cee82 · stage 6 ships — command");
  });

  it("long commit messages are truncated with an ellipsis", () => {
    const long = "x".repeat(100);
    const model = weaveModel(
      makeInputs({ commits: [{ sha: "abcdef012345", message: long }] })
    );
    expect(model.warp[0].label.length).toBeLessThan(80);
    expect(model.warp[0].label.endsWith("…")).toBe(true);
  });

  it("actions carry the full commit sha", () => {
    const model = weaveModel(makeInputs({ commits }));
    expect(model.warp[0].action).toEqual({ kind: "commit", sha: "a0cee82ffffffff" });
  });

  it("caps warp at WARP_CAP threads", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      sha: `sha${i}0000000`,
      message: `commit ${i}`,
    }));
    const model = weaveModel(makeInputs({ commits: many }));
    expect(model.warp).toHaveLength(WARP_CAP);
  });

  it("warp uses a color token name, never raw hex", () => {
    const model = weaveModel(makeInputs({ commits }));
    for (const t of model.warp) {
      expect(t.colorToken.startsWith("--")).toBe(true);
    }
  });
});

describe("weaveModel — weft (organs, scars, decks, builds)", () => {
  it("alive organs weave accent threads with an organ action", () => {
    const model = weaveModel(makeInputs({ organs: [{ id: "water-tracker" }] }));
    expect(model.weft).toHaveLength(1);
    const t = model.weft[0];
    expect(t.kind).toBe("organ");
    expect(t.colorToken).toBe("--accent");
    expect(t.action).toEqual({ kind: "organ", id: "water-tracker" });
  });

  it("alive organ label includes its weave age when a build record exists", () => {
    const model = weaveModel(
      makeInputs({
        organs: [{ id: "water-tracker" }],
        experiences: [
          { ts: NOW - 3 * DAY, organId: "water-tracker", ok: true, repairRounds: 0 },
        ],
      })
    );
    const organThread = model.weft.find((t) => t.kind === "organ")!;
    expect(organThread.label).toBe("organ · water-tracker · woven 3 days ago");
  });

  it("alive organ without a build record gets a plain label", () => {
    const model = weaveModel(makeInputs({ organs: [{ id: "notes" }] }));
    expect(model.weft[0].label).toBe("organ · notes");
  });

  it("deleted organs weave faint scar threads with no action", () => {
    const model = weaveModel(
      makeInputs({ organs: [{ id: "notes" }], deletedOrganIds: ["old-timer"] })
    );
    const scar = model.weft.find((t) => t.kind === "scar")!;
    const alive = model.weft.find((t) => t.kind === "organ")!;
    expect(scar.label).toBe("organ · old-timer · unwoven scar");
    expect(scar.action).toBeNull();
    expect(scar.opacity).toBeLessThan(alive.opacity);
    expect(scar.knots).toEqual([]);
  });

  it("decks used weave threads with deck labels", () => {
    const model = weaveModel(makeInputs({ decksUsed: ["globe"] }));
    const deck = model.weft.find((t) => t.kind === "deck")!;
    expect(deck.label).toBe("deck · globe");
    expect(deck.action).toBeNull();
  });

  it("a clean build pass weaves a smooth thread — no knots", () => {
    const model = weaveModel(
      makeInputs({
        experiences: [{ ts: NOW - DAY, organId: "runs", ok: true, repairRounds: 0 }],
      })
    );
    const build = model.weft.find((t) => t.kind === "build")!;
    expect(build.knots).toEqual([]);
    expect(build.label).toBe("build · runs · clean pass");
  });

  it("a repaired build shows visible knots — honesty in cloth", () => {
    const model = weaveModel(
      makeInputs({
        experiences: [{ ts: NOW - DAY, organId: "runs", ok: true, repairRounds: 2 }],
      })
    );
    const build = model.weft.find((t) => t.kind === "build")!;
    expect(build.knots.length).toBeGreaterThan(0);
    expect(build.label).toBe("build · runs · repaired ×2");
    for (const kx of build.knots) {
      expect(kx).toBeGreaterThan(0);
      expect(kx).toBeLessThan(1);
    }
  });

  it("a failed build weaves a warn-toned knotted thread", () => {
    const model = weaveModel(
      makeInputs({
        experiences: [{ ts: NOW - DAY, organId: "runs", ok: false, repairRounds: 3 }],
      })
    );
    const build = model.weft.find((t) => t.kind === "build")!;
    expect(build.colorToken).toBe("--warn");
    expect(build.label).toBe("build · runs · failed");
    expect(build.knots.length).toBeGreaterThan(0);
  });

  it("build threads for alive organs are clickable; for gone organs not", () => {
    const model = weaveModel(
      makeInputs({
        organs: [{ id: "alive" }],
        experiences: [
          { ts: NOW - DAY, organId: "alive", ok: true, repairRounds: 0 },
          { ts: NOW - DAY, organId: "gone", ok: true, repairRounds: 0 },
        ],
      })
    );
    const builds = model.weft.filter((t) => t.kind === "build");
    const aliveBuild = builds.find((t) => t.label.includes("alive"))!;
    const goneBuild = builds.find((t) => t.label.includes("gone"))!;
    expect(aliveBuild.action).toEqual({ kind: "organ", id: "alive" });
    expect(goneBuild.action).toBeNull();
  });

  it("y positions stay within (0,1) and never collide exactly", () => {
    const model = weaveModel(
      makeInputs({
        organs: [{ id: "a" }, { id: "b" }, { id: "c" }],
        deletedOrganIds: ["d"],
        decksUsed: ["globe", "terminal"],
        experiences: [{ ts: NOW, organId: "a", ok: true, repairRounds: 1 }],
      })
    );
    const ys = model.weft.map((t) => t.y);
    for (const y of ys) {
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(1);
    }
    expect(new Set(ys).size).toBe(ys.length);
  });
});

describe("weaveModel — learned tint", () => {
  it("intensity is 0 everywhere when nothing has been learned", () => {
    const model = weaveModel(makeInputs({ organs: [{ id: "a" }, { id: "b" }] }));
    for (const t of model.weft) expect(t.intensity).toBe(0);
  });

  it("learned weights tint weft intensity into [0,1]", () => {
    const model = weaveModel(
      makeInputs({
        organs: [{ id: "a" }, { id: "b" }, { id: "c" }],
        learnedTop: [
          { key: "finance", weight: 0.4 },
          { key: "quakes", weight: -0.2 },
        ],
      })
    );
    let anyPositive = false;
    for (const t of model.weft) {
      expect(t.intensity).toBeGreaterThanOrEqual(0);
      expect(t.intensity).toBeLessThanOrEqual(1);
      if (t.intensity > 0) anyPositive = true;
    }
    expect(anyPositive).toBe(true);
  });
});

describe("weaveModel — perf cap and determinism", () => {
  it("never weaves more than WARP_CAP + WEFT_CAP (~64) threads total", () => {
    const model = weaveModel(
      makeInputs({
        commits: Array.from({ length: 200 }, (_, i) => ({
          sha: `sha${i}`,
          message: `m${i}`,
        })),
        organs: Array.from({ length: 50 }, (_, i) => ({ id: `organ-${i}` })),
        deletedOrganIds: Array.from({ length: 30 }, (_, i) => `dead-${i}`),
        decksUsed: ["globe", "terminal", "ember", "agora"],
        experiences: Array.from({ length: 200 }, (_, i) => ({
          ts: NOW - i * DAY,
          organId: `organ-${i % 50}`,
          ok: i % 3 !== 0,
          repairRounds: i % 4,
        })),
      })
    );
    expect(model.warp.length + model.weft.length).toBeLessThanOrEqual(
      WARP_CAP + WEFT_CAP
    );
    expect(model.warp.length).toBe(WARP_CAP);
    expect(model.weft.length).toBe(WEFT_CAP);
  });

  it("organs and scars survive the cap before builds do", () => {
    const model = weaveModel(
      makeInputs({
        organs: Array.from({ length: 10 }, (_, i) => ({ id: `organ-${i}` })),
        deletedOrganIds: ["dead-1"],
        experiences: Array.from({ length: 100 }, (_, i) => ({
          ts: NOW - i * DAY,
          organId: `organ-${i % 10}`,
          ok: true,
          repairRounds: 0,
        })),
      })
    );
    expect(model.weft.filter((t) => t.kind === "organ")).toHaveLength(10);
    expect(model.weft.filter((t) => t.kind === "scar")).toHaveLength(1);
  });

  it("newest builds survive the cap; oldest fall off first", () => {
    const experiences = Array.from({ length: 100 }, (_, i) => ({
      ts: NOW - i * DAY, // i=0 newest
      organId: `organ-${i}`,
      ok: true,
      repairRounds: 0,
    }));
    const model = weaveModel(makeInputs({ experiences }));
    const builds = model.weft.filter((t) => t.kind === "build");
    expect(builds.length).toBe(WEFT_CAP);
    expect(builds.some((t) => t.label.includes("organ-0"))).toBe(true);
    expect(builds.some((t) => t.label.includes("organ-99"))).toBe(false);
  });

  it("the same life always weaves the same cloth (deterministic)", () => {
    const inputs = makeInputs({
      commits: [{ sha: "abc1234def", message: "a commit" }],
      organs: [{ id: "water-tracker" }],
      deletedOrganIds: ["old"],
      decksUsed: ["globe"],
      experiences: [{ ts: NOW - 2 * DAY, organId: "water-tracker", ok: true, repairRounds: 1 }],
      learnedTop: [{ key: "finance", weight: 0.3 }],
    });
    const a = weaveModel(inputs);
    const b = weaveModel(makeInputs({ ...inputs }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("formatAge", () => {
  it("under a day → 'woven today'", () => {
    expect(formatAge(NOW, NOW - 60_000)).toBe("woven today");
  });

  it("one day → 'woven 1 day ago'", () => {
    expect(formatAge(NOW, NOW - DAY)).toBe("woven 1 day ago");
  });

  it("three days → 'woven 3 days ago'", () => {
    expect(formatAge(NOW, NOW - 3 * DAY)).toBe("woven 3 days ago");
  });

  it("future or same instant → 'woven today' (never negative)", () => {
    expect(formatAge(NOW, NOW + DAY)).toBe("woven today");
  });
});
