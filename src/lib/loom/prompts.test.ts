import { describe, it, expect, vi } from "vitest";
import { ctxFor, ORGAN_CONTRACT, PERMISSIONS, POWERS_CONTRACT, POWERS_FEWSHOT, organSystemPrompt, requestImpliesPowers } from "./prompts";
import { manifestGuard, POWERS } from "./validate";
import { buildUiKit } from "../organs/uikit";
import { KIT_TOKENS } from "../organs/uikitSrc";

describe("ctxFor", () => {
  it("floors at 8192 and caps at 32768, stepping by 2048", () => {
    expect(ctxFor(900)).toBe(8192);
    expect(ctxFor(46000)).toBe(32768);
    expect(ctxFor(90000)).toBe(32768);
    expect(ctxFor(20000) % 2048).toBe(0);
  });
});

describe("contract", () => {
  it("documents the organ files and permission catalog", () => {
    for (const f of ["manifest.json", "organ.js", "test.js"]) expect(ORGAN_CONTRACT).toContain(f);
    for (const p of PERMISSIONS) expect(ORGAN_CONTRACT).toContain(p);
    expect(ORGAN_CONTRACT).toContain("export default");
  });

  it("documents the loom.ui design kit factories", () => {
    expect(ORGAN_CONTRACT).toContain("loom.ui");
    expect(ORGAN_CONTRACT).toContain("card");
    expect(ORGAN_CONTRACT).toContain("design");
  });

  it("documents the six powers next to the permission catalog", () => {
    for (const p of POWERS) expect(ORGAN_CONTRACT).toContain(`"${p}"`);
    expect(ORGAN_CONTRACT).toContain('"powers"');
    expect(ORGAN_CONTRACT).toContain("owner-approved and budgeted");
  });

  it("documents loom.settings api and whitelisted keys", () => {
    expect(ORGAN_CONTRACT).toContain("loom.settings");
    expect(ORGAN_CONTRACT).toContain("voice.default");
    expect(ORGAN_CONTRACT).toContain("voice.speakReplies");
    expect(ORGAN_CONTRACT).toContain("orb.tier");
    expect(ORGAN_CONTRACT).toContain("loom.reviewBeforeSave");
    expect(ORGAN_CONTRACT).toContain("settings-type organs");
  });
});

describe("organSystemPrompt", () => {
  it("exemplars and lessons are injected between the contract and the task instruction", () => {
    const exemplarText = "PAST SUCCESSFUL BUILD (request: \"track my runs\", passed in 0 repair rounds):\nexport default { id: \"run-tracker\" }";
    const lessonText = "A similar past build (\"track my runs\") failed at stage tests with: querySelector returned null. Avoid that failure mode.";
    const prompt = organSystemPrompt("code", { exemplars: exemplarText, lessons: lessonText });

    // Both blocks must appear
    expect(prompt).toContain("EXPERIENCE — PAST SUCCESSFUL BUILDS");
    expect(prompt).toContain("LESSONS FROM PAST FAILURES");
    expect(prompt).toContain(exemplarText);
    expect(prompt).toContain(lessonText);

    // Experience block must come BEFORE the task instruction line
    const expPos = prompt.indexOf("EXPERIENCE — PAST SUCCESSFUL BUILDS");
    const taskPos = prompt.indexOf("Now output organ.js only");
    expect(expPos).toBeGreaterThan(-1);
    expect(taskPos).toBeGreaterThan(-1);
    expect(expPos).toBeLessThan(taskPos);

    // The experience block must come AFTER the contract (ORGAN_CONTRACT content check)
    const contractPos = prompt.indexOf("An ORGAN is a small self-contained tool");
    expect(contractPos).toBeGreaterThan(-1);
    expect(expPos).toBeGreaterThan(contractPos);
  });

  it("prompt without exemplars/lessons does not contain EXPERIENCE block", () => {
    const prompt = organSystemPrompt("code");
    expect(prompt).not.toContain("EXPERIENCE — PAST SUCCESSFUL BUILDS");
    expect(prompt).not.toContain("LESSONS FROM PAST FAILURES");
  });

  it("empty exemplars string does not inject EXPERIENCE block", () => {
    const prompt = organSystemPrompt("code", { exemplars: "", lessons: "" });
    expect(prompt).not.toContain("EXPERIENCE — PAST SUCCESSFUL BUILDS");
  });
});

describe("requestImpliesPowers", () => {
  it("matches every keyword class the powers cover", () => {
    const powered = [
      "alert me when BTC drops 5% in an hour",   // market + notify
      "show the price of ethereum",              // market
      "a market dashboard for stocks",           // market
      "speak the time on the hour",              // voice
      "remind me to stretch",                    // pulse
      "check the feed every ten minutes",        // pulse + watch
      "schedule a daily standup note",           // pulse
      "what's in the news right now",            // watch
      "watch the launch window for me",          // watch
      "show my recent commits",                  // timeline
      "a changelog viewer for the weave",        // timeline
      "read my build history",                   // timeline
    ];
    for (const r of powered) expect(requestImpliesPowers(r), r).toBe(true);
  });

  it("never fires on plain widget requests", () => {
    const plain = [
      "water tracker",
      "a todo list",
      "notes with folders",
      "a word count tool",
      "pomodoro timer",
      "track my runs",
      "build me a habit tracker",
    ];
    for (const r of plain) expect(requestImpliesPowers(r), r).toBe(false);
  });

  it("respects word boundaries and ignores case", () => {
    expect(requestImpliesPowers("build a stopwatch")).toBe(false);   // no bare "watch"
    expect(requestImpliesPowers("an essay grader")).toBe(false);     // no bare "say"
    expect(requestImpliesPowers("ALERT ME LOUDLY")).toBe(true);
  });
});

describe("POWERS_CONTRACT", () => {
  it("names all six powers and the manifest declaration requirement", () => {
    for (const p of POWERS) expect(POWERS_CONTRACT).toContain(`"${p}"`);
    expect(POWERS_CONTRACT).toContain('"powers"');
    expect(POWERS_CONTRACT).toContain("MUST declare");
  });

  it("carries the exact signatures", () => {
    for (const sig of [
      "loom.market.chart(symbol)",
      "loom.market.crypto(product)",
      "loom.market.book(product, depth?)",
      "loom.market.trades(product)",
      "loom.market.fx(base, symbols)",
      "loom.watch.top(n?)",
      "loom.watch.list()",
      "loom.timeline.log(n?)",
      "loom.voice.say(text)",
      "loom.notify(title, body?)",
      "loom.pulse.every(ms, fn)",
    ]) expect(POWERS_CONTRACT).toContain(sig);
  });

  it("states the budgets and pulse limits", () => {
    expect(POWERS_CONTRACT).toContain("market <= 30 req/min");
    expect(POWERS_CONTRACT).toContain("voice <= 1 utterance/30s");
    expect(POWERS_CONTRACT).toContain("notify <= 6/hour");
    expect(POWERS_CONTRACT).toContain("min 30000ms, max 4 per organ");
  });

  it("teaches the sandbox mock hooks so generated tests are grounded", () => {
    expect(POWERS_CONTRACT).toContain("loom.notify.sent");
    expect(POWERS_CONTRACT).toContain("loom.voice.said");
    expect(POWERS_CONTRACT).toContain("loom.pulse.registered");
    expect(POWERS_CONTRACT).toContain("ONCE immediately");
    expect(POWERS_CONTRACT).toContain("changePct24h is -5.0");
  });

  it("embeds the worked BTC-drop few-shot verbatim", () => {
    expect(POWERS_CONTRACT).toContain(POWERS_FEWSHOT.manifest);
    expect(POWERS_CONTRACT).toContain(POWERS_FEWSHOT.code);
    expect(POWERS_CONTRACT).toContain(POWERS_FEWSHOT.tests);
  });
});

describe("organSystemPrompt powers injection", () => {
  const powered = "alert me when btc drops 5% in an hour";

  it("injects the POWERS block for powered requests in every builder kind", () => {
    for (const kind of ["manifest", "code", "tests", "repair"] as const) {
      const prompt = organSystemPrompt(kind, { request: powered });
      expect(prompt, kind).toContain("POWERS — six gated capabilities");
      expect(prompt, kind).toContain("loom.pulse.every(ms, fn)");
    }
  });

  it("tests-gen prompt for a powered request knows the mock hooks", () => {
    const prompt = organSystemPrompt("tests", { request: powered });
    expect(prompt).toContain("loom.notify.sent");
    expect(prompt).toContain("loom.pulse.registered");
  });

  it("omits the block for plain requests and when no request is given", () => {
    expect(organSystemPrompt("code", { request: "water tracker" })).not.toContain("POWERS — six gated capabilities");
    expect(organSystemPrompt("code")).not.toContain("POWERS — six gated capabilities");
  });

  it("sits between the contract and the experience block", () => {
    const prompt = organSystemPrompt("code", { request: powered, exemplars: "PAST SUCCESSFUL BUILD: x" });
    const contractPos = prompt.indexOf("An ORGAN is a small self-contained tool");
    const powersPos = prompt.indexOf("POWERS — six gated capabilities");
    const expPos = prompt.indexOf("EXPERIENCE — PAST SUCCESSFUL BUILDS");
    const taskPos = prompt.indexOf("Now output organ.js only");
    expect(contractPos).toBeGreaterThan(-1);
    expect(powersPos).toBeGreaterThan(contractPos);
    expect(expPos).toBeGreaterThan(powersPos);
    expect(taskPos).toBeGreaterThan(expPos);
  });
});

// ── POWERS few-shot — offline gate proof ──────────────────────────────────────
// The worked example the model studies is executed here for real: manifest
// through the guard, organ + tests against harness-equivalent power mocks.
// CI proves the few-shot green without any model in the room.

/** Mirror of the sandbox harness power mocks (sandbox.ts freshLoom). */
function harnessLoom() {
  const sent: { title: string; body?: string }[] = [];
  const notify = Object.assign(
    (title: string, body?: string) => {
      sent.push({ title: String(title), body: body === undefined ? undefined : String(body) });
    },
    { sent },
  );
  const said: string[] = [];
  const voice = {
    said,
    say: async (text: string) => { said.push(String(text).slice(0, 300)); },
  };
  const registered: number[] = [];
  const pulse = {
    registered,
    every: (ms: number, fn: () => void) => {
      registered.push(ms);
      try { fn(); } catch { /* a pulse must never crash the harness */ }
      return () => {};
    },
  };
  const m = new Map<string, unknown>();
  return {
    storage: {
      get: (k: string, f: unknown) => (m.has(k) ? m.get(k) : f),
      set: (k: string, v: unknown) => { m.set(k, v); },
      del: (k: string) => { m.delete(k); },
    },
    ui: buildUiKit(KIT_TOKENS),
    notify,
    voice,
    pulse,
    market: {
      crypto: async (product: string) => ({
        product: String(product), price: 61250.0, bid: 61249.5, ask: 61250.5,
        open24h: 64473.68, high24h: 64980.0, low24h: 60900.0, volume24h: 8421.5,
        changePct24h: -5.0, time: "2026-08-22T12:00:00Z",
      }),
    },
  };
}

type FixtureOrgan = { id: string; render(el: HTMLElement, loom: unknown): void | Promise<void> };
type FixtureTest = { name: string; fn(ctx: { el: HTMLElement; loom: unknown; assert(c: unknown, m?: string): void; organ: FixtureOrgan }): Promise<void> };

describe("POWERS few-shot fixture (offline gate proof)", () => {
  it("manifest passes manifestGuard with the declared powers", () => {
    const r = manifestGuard(POWERS_FEWSHOT.manifest, "btc-drop-alert");
    expect(r.ok, r.ok ? "" : (r as { ok: false; error: string }).error).toBe(true);
    if (r.ok) expect(r.manifest.powers).toEqual(["market", "notify", "pulse", "voice"]);
  });

  it("gate() carries the declared powers through to its manifest", async () => {
    const sandbox = await import("./sandbox");
    const spy = vi.spyOn(sandbox, "sandboxRun").mockResolvedValue({ ok: true, stage: "pass", errors: [], testResults: [] });
    const { gate } = await import("./validate");
    const r = await gate({ manifest: POWERS_FEWSHOT.manifest, code: POWERS_FEWSHOT.code, tests: POWERS_FEWSHOT.tests }, "btc-drop-alert");
    expect(r.ok).toBe(true);
    expect(r.manifest?.powers).toEqual(["market", "notify", "pulse", "voice"]);
    spy.mockRestore();
  });

  it("the organ renders and its tests pass against the harness power mocks", async () => {
    const organ = new Function(POWERS_FEWSHOT.code.replace(/^export\s+default\s+/m, "return "))() as FixtureOrgan;
    expect(organ.id).toBe("btc-drop-alert");
    const tests = new Function(POWERS_FEWSHOT.tests.replace(/^export\s+const\s+tests\s*=\s*/m, "return "))() as FixtureTest[];
    expect(tests.length).toBeGreaterThanOrEqual(2);
    for (const t of tests) {
      // Same semantics as the sandbox harness: fresh el + fresh loom per test.
      const el = document.createElement("div");
      const loom = harnessLoom();
      await organ.render(el, loom);
      const assert = (c: unknown, msg?: string) => { if (!c) throw new Error(`${t.name}: ${msg ?? "assertion failed"}`); };
      await t.fn({ el, loom, assert, organ });
    }
  });

  it("test.js contains no import statements (sandbox law)", () => {
    expect(/^\s*import\b/m.test(POWERS_FEWSHOT.tests)).toBe(false);
    expect(POWERS_FEWSHOT.tests).not.toContain("./organ.js");
  });
});
