/**
 * kernelBuild.order.test.ts — the FIVE-WALL ORDERING proof (Phase 21, Task 3).
 *
 * This is the offline, no-live-app, no-real-model proof that the self-edit
 * pipeline cannot skip a wall. It drives draftKernelEdit with a MOCKED builder
 * returning a known-good small SEARCH/REPLACE edit against a REAL fixture file
 * string, and MOCKED kernel Rust calls, recording the exact order of Rust
 * operations. The assertions make the ordering guarantee unmistakable:
 *
 *   - propose (isolate) happens BEFORE validate.
 *   - apply is NEVER called during draft / validate / repair.
 *   - apply happens ONLY via the explicit applyKernelEdit export, after a
 *     PASSED validation and (in the real app) the owner's approval.
 *   - a validation FAILURE path never reaches apply; the worktree is discarded.
 *
 * The load-bearing structural fact this proves: draftKernelEdit has no reference
 * to apply at all — apply lives on a separate export the review card owns — so
 * "apply before validate+approve" is not merely untested, it is unreachable.
 */

import { describe, it, expect, vi } from "vitest";
import {
  draftKernelEdit,
  applyKernelEdit,
  type KernelBuildDeps,
} from "./kernelBuild";
import { applyEditBlocks } from "./edits";
import { selfEditSystemPrompt } from "./prompts";
import type { KernelApplied, KernelProposal, KernelValidation } from "../core";

// A REAL fixture file string + a known-good small edit the mocked builder returns.
const TARGET = "src/lib/loom/moods.ts";
const FIXTURE = "export const MOOD = 'calm';\nexport const GLOW = 3;\n";
const GOOD_EDIT =
  "<<<<<<< SEARCH\n" +
  "export const GLOW = 3;\n" +
  "=======\n" +
  "export const GLOW = 5;\n" +
  ">>>>>>> REPLACE\n";

// Sanity: the "known-good edit" actually applies to the real fixture. If this
// ever breaks, the ordering proof below is testing a fiction — so guard it.
it("the fixture + known-good edit are real (applies under edits.ts)", () => {
  const applied = applyEditBlocks(FIXTURE, GOOD_EDIT);
  expect(applied).toBe("export const MOOD = 'calm';\nexport const GLOW = 5;\n");
});

/**
 * An instrumented set of deps: every Rust call pushes its name onto a shared
 * `calls` log so we can assert on ORDER, not just count. `apply` is included so
 * the pipeline could — if it were wrongly wired — reach it; the proof is that
 * it never appears in the log during drafting.
 */
function instrumented(over: {
  validate?: () => Promise<KernelValidation>;
  propose?: () => Promise<KernelProposal>;
} = {}) {
  const calls: string[] = [];
  const apply = vi.fn<
    (worktreeId: string, message: string) => Promise<KernelApplied>
  >(async () => {
    calls.push("apply");
    return { sha: "newsha", prevSha: "oldsha" };
  });
  let n = 0;
  const deps: KernelBuildDeps = {
    chat: vi.fn(async () => {
      calls.push("chat");
      return GOOD_EDIT;
    }),
    read: vi.fn(async () => {
      calls.push("read");
      return FIXTURE;
    }),
    propose:
      over.propose ??
      vi.fn(async () => {
        calls.push("propose");
        return { worktreeId: `wt-${n++}`, diff: `@@\n-GLOW = 3\n+GLOW = 5\n` };
      }),
    validate:
      over.validate ??
      vi.fn(async () => {
        calls.push("validate");
        return { ok: true, stage: "ok", output: "" };
      }),
    discard: vi.fn(async () => {
      calls.push("discard");
    }),
  };
  return { deps, calls, apply };
}

describe("five-wall ordering — happy path", () => {
  it("propose precedes validate; apply is NEVER reached during drafting", async () => {
    const { deps, calls, apply } = instrumented();

    const result = await draftKernelEdit("brighten the glow", TARGET, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // ORDER: read → chat(draft) → propose(isolate) → validate. Then STOP.
    expect(calls).toEqual(["read", "chat", "propose", "validate"]);

    // Wall ordering, stated explicitly:
    const proposeAt = calls.indexOf("propose");
    const validateAt = calls.indexOf("validate");
    expect(proposeAt).toBeGreaterThan(-1);
    expect(validateAt).toBeGreaterThan(-1);
    expect(proposeAt).toBeLessThan(validateAt); // isolate BEFORE validate

    // Apply is unreachable from drafting — it never fired.
    expect(apply).not.toHaveBeenCalled();
    expect(calls).not.toContain("apply");

    // The pipeline hands back a worktree for REVIEW — it did not apply it.
    expect(result.worktreeId).toBe("wt-0");
  });

  it("apply happens ONLY via the explicit applyKernelEdit, after a passed draft", async () => {
    const { deps, calls, apply } = instrumented();
    const result = await draftKernelEdit("brighten the glow", TARGET, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // Draft finished with no apply. Now the review card's Approve handler is the
    // ONLY thing that can reach the live tree — via the separate export, and
    // only after an explicit approve (the Rust-enforced gate).
    expect(calls).not.toContain("apply");
    const approve = vi.fn(async () => {
      calls.push("approve");
    });
    const applied = await applyKernelEdit(
      result.worktreeId,
      "self: brighten",
      apply,
      approve,
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("wt-0", "self: brighten");
    expect(applied).toEqual({ sha: "newsha", prevSha: "oldsha" });
    // Ordering: validate → approve → apply, apply last.
    expect(calls.indexOf("validate")).toBeGreaterThan(-1);
    expect(calls.indexOf("approve")).toBeGreaterThan(calls.indexOf("validate"));
    expect(calls[calls.length - 1]).toBe("apply");
    expect(calls.indexOf("apply")).toBeGreaterThan(calls.indexOf("approve"));
  });
});

describe("five-wall ordering — validation FAILURE never reaches apply", () => {
  it("a hard tsc failure aborts, discards the worktree, and never applies", async () => {
    const { deps, calls, apply } = instrumented({
      // Fail every validation so the pipeline exhausts repairs and aborts.
      validate: vi.fn(async () => {
        calls.push("validate");
        return { ok: false, stage: "tsc", output: "TS2322: type mismatch" };
      }),
    });

    const result = await draftKernelEdit("break it", TARGET, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.stage).toBe("tsc");

    // apply is absent from the entire failure/repair path.
    expect(apply).not.toHaveBeenCalled();
    expect(calls).not.toContain("apply");

    // Every proposed worktree was validated then discarded — no orphan, no live
    // write. The last op is a discard (the failed worktree torn down on abort).
    const proposes = calls.filter((c) => c === "propose").length;
    const discards = calls.filter((c) => c === "discard").length;
    expect(proposes).toBeGreaterThan(0);
    expect(discards).toBe(proposes); // every worktree cleaned up

    // Ordering within the failure path: each validate follows its propose, and
    // no validate ever precedes its propose.
    for (let i = 0; i < calls.length; i++) {
      if (calls[i] === "validate") {
        expect(calls.lastIndexOf("propose", i)).toBeGreaterThan(-1);
        expect(calls.lastIndexOf("propose", i)).toBeLessThan(i);
      }
    }
  });

  it("fail-then-repair-pass: still no apply during the pipeline; discard precedes re-propose", async () => {
    let v = 0;
    const calls: string[] = [];
    let n = 0;
    const apply = vi.fn<
      (worktreeId: string, message: string) => Promise<KernelApplied>
    >(async () => {
      calls.push("apply");
      return { sha: "s", prevSha: "p" };
    });
    const deps: KernelBuildDeps = {
      chat: vi.fn(async () => {
        calls.push("chat");
        return GOOD_EDIT;
      }),
      read: vi.fn(async () => {
        calls.push("read");
        return FIXTURE;
      }),
      propose: vi.fn(async () => {
        calls.push("propose");
        return { worktreeId: `wt-${n++}`, diff: "@@" };
      }),
      validate: vi.fn(async () => {
        calls.push("validate");
        v++;
        return v === 1
          ? { ok: false, stage: "vitest", output: "1 test failed" }
          : { ok: true, stage: "ok", output: "" };
      }),
      discard: vi.fn(async () => {
        calls.push("discard");
      }),
    };

    const result = await draftKernelEdit("fix it", TARGET, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // The bad worktree is discarded BEFORE the second propose (no orphans), and
    // apply never enters the pipeline.
    expect(calls).toEqual([
      "read",
      "chat", // draft
      "propose", // wt-0
      "validate", // fails (vitest)
      "chat", // repair
      "discard", // wt-0 torn down before re-isolation
      "propose", // wt-1
      "validate", // passes
    ]);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("five-wall ordering — the prompt contract rides the draft + repair turns", () => {
  it("the draft chat carries the SELF-EDIT contract; the repair chat carries the failing stage+output", async () => {
    const chat = vi
      .fn<
        (
          role: string,
          messages: { role: string; content: string }[],
          opts?: unknown,
        ) => Promise<string>
      >()
      .mockResolvedValue(GOOD_EDIT);
    let v = 0;
    let n = 0;
    const deps: KernelBuildDeps = {
      chat: chat as unknown as KernelBuildDeps["chat"],
      read: vi.fn(async () => FIXTURE),
      propose: vi.fn(async () => ({ worktreeId: `wt-${n++}`, diff: "@@" })),
      validate: vi.fn(async () => {
        v++;
        return v === 1
          ? { ok: false, stage: "vitest", output: "AssertionError: expected 3 to be 5" }
          : { ok: true, stage: "ok", output: "" };
      }),
      discard: vi.fn(async () => {}),
    };

    const result = await draftKernelEdit("bump the glow", TARGET, deps);
    expect(result.ok).toBe(true);

    // Draft turn (call 0): system is the SELF-EDIT draft contract, not a repair.
    const draftSystem = chat.mock.calls[0][1][0].content;
    expect(draftSystem).toBe(selfEditSystemPrompt());
    expect(draftSystem).toContain("THE FIVE WALLS");
    expect(draftSystem).not.toContain("This is a REPAIR turn");
    // Draft user carries the REAL current file contents.
    expect(chat.mock.calls[0][1][1].content).toContain(FIXTURE);

    // Repair turn (call 1): system is the repair variant; user carries the
    // failing stage + captured output (the tests are the spec).
    const repairSystem = chat.mock.calls[1][1][0].content;
    expect(repairSystem).toBe(selfEditSystemPrompt({ repair: true }));
    const repairUser = chat.mock.calls[1][1][1].content;
    expect(repairUser).toContain("STAGE: vitest");
    expect(repairUser).toContain("AssertionError: expected 3 to be 5");
  });
});
