import { describe, it, expect, vi, beforeEach } from "vitest";
import { editOrgan } from "./editOrgan";

const MANIFEST = JSON.stringify({ id: "counter", name: "Counter", description: "d", version: 1, permissions: ["storage"] });
const ORGAN_JS = `export default { id: 'counter', render(el){ el.textContent='0'; } }`;
const TEST_JS = `export const tests = [];`;

const SEARCH_REPLACE_BLOCK =
  `<<<<<<< SEARCH\nel.textContent='0';\n=======\nel.textContent='1';\n>>>>>>> REPLACE`;

function mkDeps(overrides: Partial<Parameters<typeof editOrgan>[2]> = {}) {
  const read = vi.fn()
    .mockResolvedValueOnce(MANIFEST)   // manifest.json
    .mockResolvedValueOnce(ORGAN_JS)   // organ.js
    .mockResolvedValueOnce(TEST_JS);   // test.js
  const chat = vi.fn()
    .mockResolvedValueOnce(SEARCH_REPLACE_BLOCK); // edit blocks
  const write = vi.fn().mockResolvedValue("sha456");
  const gate = vi.fn().mockResolvedValue({
    ok: true,
    manifest: JSON.parse(MANIFEST),
    verdict: { ok: true, stage: "pass", errors: [], testResults: [] },
  });
  return { read, chat, write, gate, ...overrides };
}

beforeEach(() => {
  // Each test gets fresh flight state (module re-import resets busy)
});

describe("editOrgan", () => {
  it("happy path: blocks applied, gate ok, write called with correct commit msg and organId", async () => {
    const deps = mkDeps();
    const r = await editOrgan("counter", "change text to 1", deps);
    expect(r.ok).toBe(true);
    expect(r.organId).toBe("counter");
    expect(r.sha).toBe("sha456");
    // commit message contains "edit" and the id
    expect(deps.write.mock.calls[0][2]).toContain("edit");
    expect(deps.write.mock.calls[0][2]).toContain("counter");
    // organ.js was updated
    const writtenOrgan = deps.write.mock.calls[0][1].find((f: { name: string }) => f.name === "organ.js");
    expect(writtenOrgan.content).toContain("textContent='1'");
  });

  it("manifest content written equals the read manifest (never modified)", async () => {
    const deps = mkDeps();
    await editOrgan("counter", "change text to 1", deps);
    const writtenManifest = deps.write.mock.calls[0][1].find((f: { name: string }) => f.name === "manifest.json");
    expect(writtenManifest.content).toBe(MANIFEST);
  });

  it("blocks-null (no blocks returned) triggers full-rewrite fallback with 'code' system prompt", async () => {
    const newCode = `export default { id: 'counter', render(el){ el.textContent='rewritten'; } }`;
    const deps = mkDeps({
      chat: vi.fn()
        .mockResolvedValueOnce("no blocks here, just prose")  // first edit call returns no blocks
        .mockResolvedValueOnce(`\`\`\`js\n${newCode}\n\`\`\``), // full-rewrite call
    });
    const r = await editOrgan("counter", "rewrite it", deps);
    expect(r.ok).toBe(true);
    // Second chat call should use the "code" system prompt (full rewrite)
    const secondCall = deps.chat.mock.calls[1];
    expect(secondCall[1][0].content).toContain("Now output organ.js only");
  });

  it("SEARCH-mismatch throw triggers retry then fallback to full rewrite if retry also fails", async () => {
    const badBlock = `<<<<<<< SEARCH\nNOT IN FILE\n=======\nnew\n>>>>>>> REPLACE`;
    const newCode = `export default { id: 'counter', render(el){ el.textContent='fallback'; } }`;
    const deps = mkDeps({
      chat: vi.fn()
        .mockResolvedValueOnce(badBlock)   // first attempt: SEARCH mismatch
        .mockResolvedValueOnce(badBlock)   // retry: still fails
        .mockResolvedValueOnce(`\`\`\`js\n${newCode}\n\`\`\``), // full rewrite
    });
    const r = await editOrgan("counter", "fix something", deps);
    expect(r.ok).toBe(true);
    const writtenOrgan = deps.write.mock.calls[0][1].find((f: { name: string }) => f.name === "organ.js");
    expect(writtenOrgan.content).toContain("fallback");
  });

  it("gate fails after max repairs — no write, stage is surfaced", async () => {
    const failGate = vi.fn().mockResolvedValue({
      ok: false,
      verdict: { ok: false, stage: "render", errors: ["boom"], testResults: [] },
    });
    const deps = mkDeps({ gate: failGate });
    // two repair chat calls after the initial edit call
    deps.chat
      .mockResolvedValueOnce("```js\nexport default { id: 'counter', render(el){ el.textContent='fix1'; } }\n```")
      .mockResolvedValueOnce("```js\nexport default { id: 'counter', render(el){ el.textContent='fix2'; } }\n```");
    const r = await editOrgan("counter", "break something", deps);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("render");
    expect(r.error).toContain("boom");
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("review declined — no write, error surfaced", async () => {
    const deps = mkDeps({ review: vi.fn().mockResolvedValue(false) });
    const r = await editOrgan("counter", "change text", deps);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("review");
    expect(r.error).toContain("discarded");
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("returns ok:false with stage 'error' when read rejects", async () => {
    const write = vi.fn();
    const deps = mkDeps({
      read: vi.fn().mockRejectedValue(new Error("disk failure")),
      write,
    });
    const result = await editOrgan("counter", "change text to 1", deps);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("error");
    expect(result.error).toContain("disk failure");
    expect(write).not.toHaveBeenCalled();
    // flight must be cleared — a subsequent edit should not be busy-blocked
    const deps2 = mkDeps();
    const result2 = await editOrgan("counter", "second edit", deps2);
    expect(result2.ok).toBe(true);
  });

  it("busy: second concurrent call returns busy error", async () => {
    // Use a slow gate so first call doesn't finish before second starts
    const slowGate = vi.fn().mockImplementation(
      () => new Promise((res) =>
        setTimeout(() => res({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [] } }), 80)
      )
    );

    // First call needs read to be available
    const read1 = vi.fn()
      .mockResolvedValueOnce(MANIFEST)
      .mockResolvedValueOnce(ORGAN_JS)
      .mockResolvedValueOnce(TEST_JS);
    const chat1 = vi.fn().mockResolvedValueOnce(SEARCH_REPLACE_BLOCK);
    const write1 = vi.fn().mockResolvedValue("sha_first");

    const first = editOrgan("counter", "slow edit", {
      read: read1,
      chat: chat1,
      write: write1,
      gate: slowGate,
    });

    // Give the first call a tick to acquire flight lock
    await Promise.resolve();

    // Second call should be blocked
    const read2 = vi.fn()
      .mockResolvedValue(MANIFEST);
    const second = await editOrgan("counter", "concurrent edit", {
      read: read2,
      chat: vi.fn(),
      write: vi.fn(),
      gate: vi.fn(),
    });

    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already running/i);

    await first;
  });
});
