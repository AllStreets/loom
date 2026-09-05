import { describe, it, expect } from "vitest";
import { manifestGuard, POWERS, KERNEL_POWERS, POWER_LABELS } from "./validate";
import { buildHarnessSrc } from "./sandbox";

describe("manifestGuard", () => {
  const good = JSON.stringify({ id: "runs", name: "Runs", description: "d", version: 1, permissions: ["storage"] });
  it("accepts a valid manifest", () => {
    const r = manifestGuard(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.id).toBe("runs");
  });
  it("rejects invalid JSON, bad ids, unknown permissions, and id mismatch", () => {
    expect(manifestGuard("{not json").ok).toBe(false);
    expect(manifestGuard(JSON.stringify({ id: "Bad Id", name: "x", description: "d", version: 1, permissions: [] })).ok).toBe(false);
    expect(manifestGuard(JSON.stringify({ id: "ok", name: "x", description: "d", version: 1, permissions: ["filesystem"] })).ok).toBe(false);
    expect(manifestGuard(good, "other-id").ok).toBe(false);
  });
  it("rejects missing required fields", () => {
    expect(manifestGuard(JSON.stringify({ id: "ok", permissions: [] })).ok).toBe(false);
  });
  it("rejects version as a string", () => {
    expect(manifestGuard(JSON.stringify({ id: "ok", name: "x", description: "d", version: "1", permissions: [] })).ok).toBe(false);
  });
  it("rejects name as a number", () => {
    expect(manifestGuard(JSON.stringify({ id: "ok", name: 123, description: "d", version: 1, permissions: [] })).ok).toBe(false);
  });
});

describe("manifestGuard powers", () => {
  const base = { id: "nudge", name: "Nudge", description: "d", version: 1, permissions: ["storage"] };
  it("accepts a manifest with no powers field (unchanged path)", () => {
    const r = manifestGuard(JSON.stringify(base));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.powers).toBeUndefined();
  });
  it("accepts any subset of the four powers", () => {
    const r = manifestGuard(JSON.stringify({ ...base, powers: ["timeline", "voice", "notify", "pulse"] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.powers).toEqual(["timeline", "voice", "notify", "pulse"]);
  });
  it("accepts an empty powers array", () => {
    expect(manifestGuard(JSON.stringify({ ...base, powers: [] })).ok).toBe(true);
  });
  it("rejects an unknown power with a reason string", () => {
    const r = manifestGuard(JSON.stringify({ ...base, powers: ["pulse", "filesystem"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown power: filesystem");
  });
  it("rejects the retired market and watch powers as unknown", () => {
    for (const p of ["market", "watch"]) {
      const r = manifestGuard(JSON.stringify({ ...base, powers: [p] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(`unknown power: ${p}`);
    }
  });
  it("rejects a non-array powers field with a reason string", () => {
    const r = manifestGuard(JSON.stringify({ ...base, powers: "pulse" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("powers must be an array");
  });
});

describe("manifestGuard legacy notify normalization", () => {
  const base = { id: "old", name: "Old", description: "d", version: 1 };
  it('migrates a legacy "notify" permission into powers instead of rejecting', () => {
    const r = manifestGuard(JSON.stringify({ ...base, permissions: ["storage", "notify"] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.permissions).toEqual(["storage"]);
      expect(r.manifest.powers).toEqual(["notify"]);
    }
  });
  it("dedupes when the manifest already declares the notify power", () => {
    const r = manifestGuard(JSON.stringify({ ...base, permissions: ["notify"], powers: ["pulse", "notify"] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.permissions).toEqual([]);
      expect(r.manifest.powers).toEqual(["pulse", "notify"]);
    }
  });
  it("appends notify to existing powers that lack it", () => {
    const r = manifestGuard(JSON.stringify({ ...base, permissions: ["storage", "notify"], powers: ["pulse"] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.powers).toEqual(["pulse", "notify"]);
  });
  it("still rejects genuinely unknown permissions after the migration", () => {
    const r = manifestGuard(JSON.stringify({ ...base, permissions: ["notify", "filesystem"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown permission: filesystem");
  });
});

describe("buildHarnessSrc", () => {
  it("embeds the nonce, both modules, and the postMessage report", () => {
    const src = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce");
    expect(src).toContain("n0nce");
    expect(src).toContain("postMessage");
    expect(src).toContain("Blob");
    expect(src).toContain("unhandledrejection");
    expect(src).toContain("makeUi");
  });
  it("rewrites relative organ.js imports in tests and passes organ into the test context", () => {
    const src = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce");
    // the harness rewrites './organ.js' specifiers to the real organ blob URL
    expect(src).toContain("organUrl");
    expect(src).toContain("./organ.js");
    // and every test fn receives the organ object in its context
    expect(src).toContain("assert, organ");
  });
  it("captures renderedHtml (el.innerHTML.slice(0,9000)) in both full and probe modes", () => {
    const full = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce");
    expect(full).toContain("el.innerHTML.slice(0, 9000)");
    expect(full).toContain("renderedHtml");
    const probe = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce", { probeOnly: true });
    expect(probe).toContain("renderedHtml");
    expect(probe).toContain("el.innerHTML.slice(0, 9000)");
  });
  it("probeOnly harness contains PROBE_ONLY=true flag and skips test loading", () => {
    const probe = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce", { probeOnly: true });
    expect(probe).toContain("PROBE_ONLY");
    expect(probe).toContain('"probe"');
    // The stage reported in probeOnly mode is "probe"
    expect(probe).toContain('stage: "probe"');
  });
  it("non-probeOnly harness contains PROBE_ONLY=false", () => {
    const src = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce");
    expect(src).toContain("PROBE_ONLY");
    // default opts: probeOnly is false
    expect(src).toContain("false");
  });
});

describe("buildHarnessSrc power mocks", () => {
  const src = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce");

  it("mocks the four powers deterministically and nothing retired", () => {
    // timeline — canned commits
    expect(src).toContain("first weave");
    // the retired Cockpit powers are gone from the harness
    expect(src).not.toContain("market:");
    expect(src).not.toContain("watch:");
  });

  it("records voice.say into loom.voice.said with the 300-char cap", () => {
    expect(src).toContain("voiceApi.said.push(String(text).slice(0, 300))");
  });

  it("records notify into loom.notify.sent", () => {
    expect(src).toContain("notifyFn.sent.push");
  });

  it("pulse.every fires the callback once immediately and records the interval", () => {
    expect(src).toContain("pulseApi.registered.push(ms)");
    expect(src).toContain("try { fn(); }");
  });
});

describe("renderProbe", () => {
  it("returns {ok:false} when manifestGuard fails (bad manifest)", async () => {
    const { renderProbe } = await import("./validate");
    const files = { manifest: "{not json}", code: "export default {render(){}}", tests: "" };
    const result = await renderProbe(files);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns {ok:false} when manifestGuard fails (unknown permission)", async () => {
    const { renderProbe } = await import("./validate");
    const badManifest = JSON.stringify({ id: "x", name: "X", description: "d", version: 1, permissions: ["filesystem"] });
    const result = await renderProbe({ manifest: badManifest, code: "", tests: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown permission");
  });

  it("returns {ok:true, renderedHtml} on successful render", async () => {
    const { vi } = await import("vitest");
    const sandbox = await import("./sandbox");
    const { renderProbe } = await import("./validate");

    // Spy on sandboxRun to return a successful probe result
    const sandboxRunSpy = vi.spyOn(sandbox, "sandboxRun").mockResolvedValue({
      ok: true,
      stage: "probe",
      renderedHtml: "<div>ok</div>",
      errors: [],
      testResults: [],
    });

    const manifest = JSON.stringify({ id: "test", name: "Test", description: "d", version: 1, permissions: [] });
    const files = { manifest, code: "export default {render(){}}", tests: "" };
    const result = await renderProbe(files);

    expect(result.ok).toBe(true);
    expect(result.renderedHtml).toBe("<div>ok</div>");
    expect(result.error).toBeUndefined();

    sandboxRunSpy.mockRestore();
  });
});

describe("kernel powers (Rebirth)", () => {
  it("self is a kernel power, not one of the model-facing POWERS", () => {
    expect(KERNEL_POWERS).toEqual(["self"]);
    expect(POWERS as readonly string[]).not.toContain("self");
    expect(POWER_LABELS.self).toMatch(/reweave/);
  });

  it("manifestGuard accepts powers: [\"self\"] alongside a model power", () => {
    const raw = JSON.stringify({ id: "settings", name: "Settings", description: "d", version: 1, permissions: ["settings"], powers: ["self", "notify"] });
    const r = manifestGuard(raw, "settings");
    expect(r.ok, r.ok ? "" : (r as { ok: false; error: string }).error).toBe(true);
    if (r.ok) expect(r.manifest.powers).toEqual(["self", "notify"]);
  });
});
