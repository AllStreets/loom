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
});

describe("buildHarnessSrc", () => {
  it("embeds the nonce, both modules, and the postMessage report", () => {
    const src = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce");
    expect(src).toContain("n0nce");
    expect(src).toContain("postMessage");
    expect(src).toContain("Blob");
    expect(src).toContain("unhandledrejection");
  });
});
