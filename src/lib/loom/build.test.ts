import { describe, it, expect, vi } from "vitest";
import { buildOrgan } from "./build";

const MANIFEST = JSON.stringify({ id: "runs", name: "Runs", description: "d", version: 1, permissions: ["storage"] });

function mkDeps(overrides: Partial<Parameters<typeof buildOrgan>[1]> = {}) {
  const chat = vi.fn()
    .mockResolvedValueOnce("```json\n" + MANIFEST + "\n```")
    .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='hi'; } }\n```")
    .mockResolvedValueOnce("```js\nexport const tests = [];\n```");
  const write = vi.fn().mockResolvedValue("sha123");
  const gate = vi.fn().mockResolvedValue({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [] } });
  return { chat, write, gate, ...overrides };
}

describe("buildOrgan", () => {
  it("happy path: manifest -> code -> tests -> gate -> write, committing with the organ id", async () => {
    const deps = mkDeps();
    const r = await buildOrgan("track my runs", deps);
    expect(r.ok).toBe(true);
    expect(r.organId).toBe("runs");
    expect(r.sha).toBe("sha123");
    expect(deps.chat).toHaveBeenCalledTimes(3);
    expect(deps.write).toHaveBeenCalledWith("runs",
      expect.arrayContaining([expect.objectContaining({ name: "manifest.json" })]),
      expect.stringContaining("runs"));
  });
  it("never writes when the gate fails, and surfaces the errors", async () => {
    const deps = mkDeps({ gate: vi.fn().mockResolvedValue({ ok: false, verdict: { ok: false, stage: "render", errors: ["boom"], testResults: [] } }) });
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(false);
    expect(deps.write).not.toHaveBeenCalled();
    expect(r.error).toContain("boom");
  });
  it("never writes when the manifest is invalid", async () => {
    const deps = mkDeps({ chat: vi.fn().mockResolvedValue("not json at all") });
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(false);
    expect(deps.write).not.toHaveBeenCalled();
  });
  it("rejects a concurrent build", async () => {
    const slowGate = vi.fn().mockImplementation(() => new Promise((res) => setTimeout(() => res({ ok: false, verdict: { ok: false, stage: "load", errors: ["x"], testResults: [] } }), 50)));
    const deps = mkDeps({ gate: slowGate });
    const first = buildOrgan("a", deps);
    const second = await buildOrgan("b", mkDeps());
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already running/i);
    await first;
  });
});
