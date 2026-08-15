import { describe, it, expect } from "vitest";
import { manifestGuard } from "./validate";
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
  it("captures renderedHtml (el.innerHTML.slice(0,3000)) in both full and probe modes", () => {
    const full = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce");
    expect(full).toContain("el.innerHTML.slice(0, 3000)");
    expect(full).toContain("renderedHtml");
    const probe = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce", { probeOnly: true });
    expect(probe).toContain("renderedHtml");
    expect(probe).toContain("el.innerHTML.slice(0, 3000)");
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
