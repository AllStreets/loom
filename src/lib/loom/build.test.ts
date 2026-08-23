import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildOrgan } from "./build";
import * as experienceModule from "./experience";

// Minimal localStorage mock so experience.ts can operate
const _lsStore: Record<string, string> = {};
const _lsMock = {
  getItem: (k: string) => _lsStore[k] ?? null,
  setItem: (k: string, v: string) => { _lsStore[k] = v; },
  removeItem: (k: string) => { delete _lsStore[k]; },
  clear: () => { for (const k of Object.keys(_lsStore)) delete _lsStore[k]; },
};
vi.stubGlobal("localStorage", _lsMock);
vi.stubGlobal("window", { __loomExportCorpus: undefined });

const MANIFEST = JSON.stringify({ id: "runs", name: "Runs", description: "d", version: 1, permissions: ["storage"] });
const RENDERED_HTML = `<div data-action="new-item"><input data-action="new-item"></div><button data-action="add">Add</button><ul></ul>`;

function mkDeps(overrides: Partial<Parameters<typeof buildOrgan>[1]> = {}) {
  const chat = vi.fn()
    .mockResolvedValueOnce("```json\n" + MANIFEST + "\n```")
    .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='hi'; } }\n```")
    .mockResolvedValueOnce("```js\nexport const tests = [];\n```");
  const write = vi.fn().mockResolvedValue("sha123");
  const gate = vi.fn().mockResolvedValue({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } });
  const renderProbe = vi.fn().mockResolvedValue({ ok: true, renderedHtml: RENDERED_HTML });
  return { chat, write, gate, renderProbe, ...overrides };
}

describe("buildOrgan", () => {
  it("happy path: manifest -> code -> probe -> tests -> gate -> write, committing with the organ id", async () => {
    const deps = mkDeps();
    const r = await buildOrgan("track my runs", deps);
    expect(r.ok).toBe(true);
    expect(r.organId).toBe("runs");
    expect(r.sha).toBe("sha123");
    expect(deps.chat).toHaveBeenCalledTimes(3);
    expect(deps.renderProbe).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith("runs",
      expect.arrayContaining([expect.objectContaining({ name: "manifest.json" })]),
      expect.stringContaining("runs"));
  });

  it("tests-gen user prompt contains the probed renderedHtml", async () => {
    const deps = mkDeps();
    await buildOrgan("track my runs", deps);
    // The 3rd chat call is tests generation (index 2)
    const testsCall = deps.chat.mock.calls[2];
    const testsUserMsg = testsCall[1][1].content as string;
    expect(testsUserMsg).toContain(RENDERED_HTML);
    expect(testsUserMsg).toContain("ACTUAL rendered HTML");
  });

  it("probe fail → one code repair → re-probe → return fail on second probe failure", async () => {
    const renderProbe = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "render crashed" })
      .mockResolvedValueOnce({ ok: false, error: "still broken" });
    const deps = mkDeps({ renderProbe });
    // 4th chat call is the probe repair
    deps.chat.mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='repaired'; } }\n```");
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("render");
    expect(deps.renderProbe).toHaveBeenCalledTimes(2);
    expect(deps.chat).toHaveBeenCalledTimes(3); // manifest, code, probe-repair (tests never reached)
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("probe fail → code repair → re-probe ok → continues to tests and gate", async () => {
    const renderProbe = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "render crashed" })
      .mockResolvedValueOnce({ ok: true, renderedHtml: RENDERED_HTML });
    const deps = mkDeps({ renderProbe });
    // Provide probe-repair + tests generation responses
    deps.chat
      .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='repaired'; } }\n```")
      .mockResolvedValueOnce("```js\nexport const tests = [];\n```");
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(true);
    expect(deps.renderProbe).toHaveBeenCalledTimes(2);
    expect(deps.chat).toHaveBeenCalledTimes(4); // manifest, code, probe-repair, tests
    const testsCall = deps.chat.mock.calls[3];
    expect(testsCall[1][1].content).toContain(RENDERED_HTML);
  });

  it("attempts THREE repair rounds on gate failure, then fails without writing if still red", async () => {
    const deps = mkDeps({ gate: vi.fn().mockResolvedValue({ ok: false, verdict: { ok: false, stage: "render", errors: ["boom"], testResults: [], renderedHtml: RENDERED_HTML } }) });
    // 4th + 5th + 6th chat calls = three repair rounds
    deps.chat
      .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='fix1'; } }\n```")
      .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='fix2'; } }\n```")
      .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='fix3'; } }\n```");
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("render");
    expect(deps.chat).toHaveBeenCalledTimes(6);      // manifest, code, tests, repair x3
    expect(deps.gate).toHaveBeenCalledTimes(4);      // initial + 3 revalidations
    expect(deps.write).not.toHaveBeenCalled();
    expect(r.error).toContain("boom");
    // the repair prompt carried the error and the target file
    const repairCall = deps.chat.mock.calls[3];
    expect(repairCall[1][1].content).toContain("boom");
    expect(repairCall[1][1].content).toContain("organ.js");
  });

  it("tests-stage failure: r1→organ.js, r2→test.js, r3→organ.js (three rounds)", async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["e1"], testResults: [{ name: "t1", ok: false, error: "e1" }], renderedHtml: RENDERED_HTML } })
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["e2"], testResults: [{ name: "t1", ok: false, error: "e2" }], renderedHtml: RENDERED_HTML } })
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["e3"], testResults: [{ name: "t1", ok: false, error: "e3" }], renderedHtml: RENDERED_HTML } })
      .mockResolvedValueOnce({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } });
    const deps = mkDeps({ gate });
    deps.chat
      .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='r1'; } }\n```") // round 1: organ.js
      .mockResolvedValueOnce("```js\nexport const tests = [{ name: 'sane', fn: async ({assert}) => assert(true) }];\n```")  // round 2: test.js
      .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='r3'; } }\n```"); // round 3: organ.js
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(true);
    // Round 1: organ.js
    const r1Call = deps.chat.mock.calls[3];
    expect(r1Call[1][1].content).toContain("organ.js");
    // Round 2: test.js
    const r2Call = deps.chat.mock.calls[4];
    expect(r2Call[1][1].content).toContain("test.js");
    // Round 3: organ.js again
    const r3Call = deps.chat.mock.calls[5];
    expect(r3Call[1][1].content).toContain("organ.js");
  });

  it("repair prompts include renderedHtml and per-test failure lines", async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["should have 2 movies"], testResults: [{ name: "adds two movies", ok: false, error: "expected 2, got 1" }], renderedHtml: RENDERED_HTML } })
      .mockResolvedValueOnce({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } });
    const deps = mkDeps({ gate });
    deps.chat
      .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='fixed'; } }\n```");
    await buildOrgan("x", deps);
    const repairCall = deps.chat.mock.calls[3];
    const repairUser = repairCall[1][1].content as string;
    // Must include the DOM
    expect(repairUser).toContain(RENDERED_HTML);
    // Must include per-test failure line
    expect(repairUser).toContain("adds two movies");
    expect(repairUser).toContain("expected 2, got 1");
  });

  it("tests-stage failure repairs the CODE first (tests are the spec), then writes on green", async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["should not add empty movie"], testResults: [], renderedHtml: RENDERED_HTML } })
      .mockResolvedValueOnce({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } });
    const deps = mkDeps({ gate });
    deps.chat.mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='guarded'; } }\n```");
    const r = await buildOrgan("track water", deps);
    expect(r.ok).toBe(true);
    expect(deps.chat).toHaveBeenCalledTimes(4);
    // round 1 targeted organ.js — the REPAIRED code is what gets written
    const repairCall = deps.chat.mock.calls[3];
    expect(repairCall[1][1].content).toContain("fix organ.js so it satisfies them");
    const written = deps.write.mock.calls[0][1].find((f: { name: string }) => f.name === "organ.js");
    expect(written.content).toContain("guarded");
  });

  it("tests-stage failure falls back to repairing test.js on round 2", async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["e1"], testResults: [], renderedHtml: RENDERED_HTML } })
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["e2"], testResults: [], renderedHtml: RENDERED_HTML } })
      .mockResolvedValueOnce({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } });
    const deps = mkDeps({ gate });
    deps.chat
      .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='try'; } }\n```")   // round 1: organ.js
      .mockResolvedValueOnce("```js\nexport const tests = [{ name: 'sane', fn: async ({assert}) => assert(true) }];\n```"); // round 2: test.js
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(true);
    const round2Call = deps.chat.mock.calls[4];
    expect(round2Call[1][1].content).toContain("test.js");
    const written = deps.write.mock.calls[0][1].find((f: { name: string }) => f.name === "test.js");
    expect(written.content).toContain("sane");
  });

  it("review gate: declining discards without writing; approving writes", async () => {
    const declined = await buildOrgan("a", mkDeps({ review: vi.fn().mockResolvedValue(false) }));
    expect(declined.ok).toBe(false);
    expect(declined.stage).toBe("review");
    expect(declined.error).toContain("discarded");

    const deps = mkDeps({ review: vi.fn().mockResolvedValue(true) });
    const approved = await buildOrgan("b", deps);
    expect(approved.ok).toBe(true);
    expect(deps.review).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "organ.js" })]));
    expect(deps.write).toHaveBeenCalled();
  });

  it("never writes when the manifest is invalid", async () => {
    const deps = mkDeps({ chat: vi.fn().mockResolvedValue("not json at all") });
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(false);
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("returns ok:false with stage 'error' when chat throws", async () => {
    const write = vi.fn();
    const deps = mkDeps({
      chat: vi.fn().mockRejectedValue(new Error("network down")),
      write,
    });
    const result = await buildOrgan("track my runs", deps);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("error");
    expect(result.error).toContain("network down");
    expect(write).not.toHaveBeenCalled();
    // flight must be cleared — a subsequent build should not be busy-blocked
    const deps2 = mkDeps();
    const result2 = await buildOrgan("second build", deps2);
    expect(result2.ok).toBe(true);
  });

  it("rejects a concurrent build", async () => {
    const slowGate = vi.fn().mockImplementation(() => new Promise((res) => setTimeout(() => res({ ok: false, verdict: { ok: false, stage: "load", errors: ["x"], testResults: [], renderedHtml: undefined } }), 50)));
    const deps = mkDeps({ gate: slowGate });
    const first = buildOrgan("a", deps);
    const second = await buildOrgan("b", mkDeps());
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already running/i);
    await first;
  });

  // ── Experience recording tests ──────────────────────────────────────────────

  describe("experience recording", () => {
    beforeEach(() => { _lsMock.clear(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it("recordExperience is called on build success", async () => {
      const spy = vi.spyOn(experienceModule, "recordExperience");
      const deps = mkDeps();
      const r = await buildOrgan("track my runs", deps);
      expect(r.ok).toBe(true);
      expect(spy).toHaveBeenCalledOnce();
      const [record] = spy.mock.calls[0];
      expect(record.ok).toBe(true);
      expect(record.organId).toBe("runs");
    });

    it("recordExperience is called on gate failure", async () => {
      const spy = vi.spyOn(experienceModule, "recordExperience");
      const failGate = vi.fn().mockResolvedValue({
        ok: false,
        verdict: { ok: false, stage: "tests", errors: ["boom"], testResults: [], renderedHtml: RENDERED_HTML },
      });
      const deps = mkDeps({ gate: failGate });
      deps.chat
        .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='r1'; } }\n```")
        .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='r2'; } }\n```")
        .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='r3'; } }\n```");
      const r = await buildOrgan("track my runs", deps);
      expect(r.ok).toBe(false);
      expect(spy).toHaveBeenCalledOnce();
      const [record] = spy.mock.calls[0];
      expect(record.ok).toBe(false);
      expect(record.repairRounds).toBe(3);
    });

    it("recordExperience is called on probe (render) failure", async () => {
      const spy = vi.spyOn(experienceModule, "recordExperience");
      const renderProbe = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: "render crashed" })
        .mockResolvedValueOnce({ ok: false, error: "still broken" });
      const deps = mkDeps({ renderProbe });
      deps.chat.mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='fix'; } }\n```");
      const r = await buildOrgan("track my runs", deps);
      expect(r.ok).toBe(false);
      expect(r.stage).toBe("render");
      expect(spy).toHaveBeenCalledOnce();
      const [record] = spy.mock.calls[0];
      expect(record.ok).toBe(false);
      expect(record.stage).toBe("render");
    });

    it("retrieveExemplars is called before code gen and exemplar block appears in code-phase system prompt", async () => {
      // Seed one successful build record so retrieveExemplars returns something
      experienceModule.recordExperience({
        ts: Date.now(), kind: "build", request: "track my runs", organId: "runs", ok: true,
        repairRounds: 0,
        manifest: MANIFEST,
        code: 'export default { id: "runs", render(el){ el.textContent = "hi"; } }',
      });
      const retrieveSpy = vi.spyOn(experienceModule, "retrieveExemplars");
      const deps = mkDeps();
      await buildOrgan("track my runs", deps);
      // retrieveExemplars must be called before code generation
      expect(retrieveSpy).toHaveBeenCalled();
      // The 2nd chat call is code generation (index 1); its system message must contain the EXPERIENCE block
      const codeCall = deps.chat.mock.calls[1];
      const codeSystemMsg = codeCall[1][0].content as string;
      expect(codeSystemMsg).toContain("EXPERIENCE — PAST SUCCESSFUL BUILDS");
    });

    it("QW-1: invalid manifest → one repair chat → valid → build continues", async () => {
      const INVALID_MANIFEST = "not json";
      const deps = mkDeps({
        chat: vi.fn()
          .mockResolvedValueOnce("```json\n" + INVALID_MANIFEST + "\n```")   // first attempt — bad
          .mockResolvedValueOnce("```json\n" + MANIFEST + "\n```")            // repair — good
          .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='hi'; } }\n```")
          .mockResolvedValueOnce("```js\nexport const tests = [];\n```"),
      });
      const r = await buildOrgan("track my runs", deps);
      expect(r.ok).toBe(true);
      expect(r.organId).toBe("runs");
      // Repair call must be temperature 0.0
      const repairCall = deps.chat.mock.calls[1];
      expect(repairCall[2]).toMatchObject({ temperature: 0.0 });
    });

    it("QW-1: invalid manifest → repair → still invalid → hard fail", async () => {
      const deps = mkDeps({
        chat: vi.fn()
          .mockResolvedValueOnce("```json\nnot json\n```")   // bad
          .mockResolvedValueOnce("```json\nstill bad\n```"), // repair — still bad
      });
      const r = await buildOrgan("track my runs", deps);
      expect(r.ok).toBe(false);
      expect(deps.write).not.toHaveBeenCalled();
    });
  });

  // ── Powers flow: request → manifest → gate → write ──────────────────────────

  describe("powers flow", () => {
    const POWERED_REQUEST = "alert me when btc drops 5% in an hour";
    const POWERED_MANIFEST = JSON.stringify({
      id: "btc-drop-alert", name: "BTC Drop Alert", description: "d", version: 1,
      permissions: ["storage"], powers: ["market", "notify", "pulse"],
    });

    function mkPoweredDeps() {
      return mkDeps({
        chat: vi.fn()
          .mockResolvedValueOnce("```json\n" + POWERED_MANIFEST + "\n```")
          .mockResolvedValueOnce("```js\nexport default { id: 'btc-drop-alert', render(el){ el.textContent='hi'; } }\n```")
          .mockResolvedValueOnce("```js\nexport const tests = [];\n```"),
        gate: vi.fn().mockResolvedValue({ ok: true, manifest: JSON.parse(POWERED_MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } }),
      });
    }

    it("declared powers survive intact from manifest through gate to the written manifest.json", async () => {
      const deps = mkPoweredDeps();
      const r = await buildOrgan(POWERED_REQUEST, deps);
      expect(r.ok).toBe(true);
      expect(r.organId).toBe("btc-drop-alert");
      // The gate saw the powers exactly as declared
      const [gateFiles] = deps.gate.mock.calls[0];
      expect(JSON.parse(gateFiles.manifest).powers).toEqual(["market", "notify", "pulse"]);
      // The written manifest.json still carries them
      const [, writtenFiles] = deps.write.mock.calls[0];
      const manifestFile = (writtenFiles as { name: string; content: string }[]).find((f) => f.name === "manifest.json");
      expect(manifestFile).toBeDefined();
      expect(JSON.parse(manifestFile!.content).powers).toEqual(["market", "notify", "pulse"]);
    });

    it("a powered request injects the POWERS block into every builder system prompt", async () => {
      const deps = mkPoweredDeps();
      await buildOrgan(POWERED_REQUEST, deps);
      expect(deps.chat.mock.calls.length).toBe(3); // manifest, code, tests
      for (const call of deps.chat.mock.calls) {
        const system = call[1][0].content as string;
        expect(system).toContain("POWERS — six gated capabilities");
        expect(system).toContain("loom.pulse.every(ms, fn)");
      }
    });

    it("a plain widget request keeps every builder prompt power-free", async () => {
      const deps = mkDeps();
      await buildOrgan("track my runs", deps);
      for (const call of deps.chat.mock.calls) {
        const system = call[1][0].content as string;
        expect(system).not.toContain("POWERS — six gated capabilities");
      }
    });
  });
});
