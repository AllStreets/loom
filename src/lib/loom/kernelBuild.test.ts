/**
 * kernelBuild.test.ts — the self-edit pipeline, every branch, mocked Rust.
 *
 * The load-bearing assertion running through the whole file: NO kernelApply
 * call exists anywhere in the draft/validate/repair path. Apply is a separate
 * export the review card owns.
 */

import { describe, it, expect, vi } from "vitest";
import {
  draftKernelEdit,
  applyKernelEdit,
  discardKernelEdit,
  parseKernelEdits,
  type KernelBuildDeps,
} from "./kernelBuild";
import type { KernelApplied, KernelProposal, KernelValidation } from "../core";

const TARGET = "src/lib/loom/moods.ts";
const CURRENT = "export const mood = 'calm';\n";

/** A well-formed SEARCH/REPLACE draft against CURRENT. */
const GOOD_DRAFT =
  "<<<<<<< SEARCH\n" +
  "export const mood = 'calm';\n" +
  "=======\n" +
  "export const mood = 'bright';\n" +
  ">>>>>>> REPLACE\n";

function okValidation(): KernelValidation {
  return { ok: true, stage: "ok", output: "" };
}
function failValidation(stage: "tsc" | "vitest", output: string): KernelValidation {
  return { ok: false, stage, output };
}
function proposal(id: string): KernelProposal {
  return { worktreeId: id, diff: `--- a/${TARGET}\n+++ b/${TARGET}\n@@\n-calm\n+bright\n` };
}

/**
 * Build injected deps. `apply` is provided as a spy so tests can assert it is
 * NEVER invoked by the pipeline (it lives only on the separate export).
 */
function makeDeps(over: Partial<KernelBuildDeps> = {}) {
  const applySpy = vi.fn<
    (worktreeId: string, message: string) => Promise<KernelApplied>
  >(async () => ({ sha: "newsha", prevSha: "oldsha" }));
  const deps: KernelBuildDeps = {
    chat: vi.fn(async () => GOOD_DRAFT),
    read: vi.fn(async () => CURRENT),
    propose: vi.fn(async () => proposal("wt-1")),
    validate: vi.fn(async () => okValidation()),
    discard: vi.fn(async () => {}),
    ...over,
  };
  return { deps, applySpy };
}

describe("parseKernelEdits", () => {
  it("parses SEARCH/REPLACE blocks into {path, search, replace}", () => {
    const edits = parseKernelEdits(TARGET, GOOD_DRAFT);
    expect(edits).not.toBeNull();
    expect(edits).toHaveLength(1);
    expect(edits![0]).toEqual({
      path: TARGET,
      search: "export const mood = 'calm';",
      replace: "export const mood = 'bright';",
    });
  });

  it("returns null when there is no well-formed block", () => {
    expect(parseKernelEdits(TARGET, "sorry, I cannot do that")).toBeNull();
  });
});

describe("draftKernelEdit — validate passes first try", () => {
  it("returns the proposal for review and NEVER applies", async () => {
    const { deps, applySpy } = makeDeps();
    const result = await draftKernelEdit("make the mood bright", TARGET, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.worktreeId).toBe("wt-1");
    expect(result.diff).toContain("+bright");
    expect(result.targetPaths).toEqual([TARGET]);
    expect(result.repairRounds).toBe(0);

    // The walls: proposed and validated exactly once; NEVER applied.
    expect(deps.propose).toHaveBeenCalledTimes(1);
    expect(deps.validate).toHaveBeenCalledTimes(1);
    expect(deps.discard).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("reads the REAL current file before drafting", async () => {
    const { deps } = makeDeps();
    await draftKernelEdit("x", TARGET, deps);
    expect(deps.read).toHaveBeenCalledWith(TARGET);
  });
});

describe("draftKernelEdit — fail then repair passes", () => {
  it("discards the failed worktree, re-proposes, and returns the good one", async () => {
    let validateCall = 0;
    const propose = vi
      .fn<() => Promise<KernelProposal>>()
      .mockResolvedValueOnce(proposal("wt-bad"))
      .mockResolvedValueOnce(proposal("wt-good"));
    const validate = vi.fn(async () => {
      validateCall++;
      return validateCall === 1
        ? failValidation("tsc", "TS2322: type mismatch")
        : okValidation();
    });
    const { deps, applySpy } = makeDeps({ propose, validate });

    const result = await draftKernelEdit("fix it", TARGET, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.worktreeId).toBe("wt-good");
    expect(result.repairRounds).toBe(1);

    // The failed worktree was discarded before re-proposing (no orphans).
    expect(deps.discard).toHaveBeenCalledWith("wt-bad");
    expect(deps.discard).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledTimes(2);
    // A repair round asked the builder again (temp 0.0 on the second call).
    expect(deps.chat).toHaveBeenCalledTimes(2);
    // Never applied.
    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe("draftKernelEdit — fail exhausted → abort + worktree discarded", () => {
  it("aborts after the repair budget and leaves no orphan worktree", async () => {
    let n = 0;
    const propose = vi.fn(async () => proposal(`wt-${n++}`));
    const validate = vi.fn(async () => failValidation("vitest", "1 test failed"));
    const { deps, applySpy } = makeDeps({ propose, validate });

    const result = await draftKernelEdit("break it", TARGET, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.stage).toBe("vitest");
    expect(result.error).toContain("test failed");

    // Every worktree that was proposed got discarded — including the last one.
    expect(deps.discard).toHaveBeenCalledTimes(propose.mock.calls.length);
    // Never applied on the abort path.
    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe("draftKernelEdit — protected-path error surfaced calmly", () => {
  it("returns a calm failure and never creates or applies a worktree", async () => {
    const propose = vi.fn(async () => {
      throw new Error("path is not editable: src/lib/loom/kernelBuild.ts");
    });
    const { deps, applySpy } = makeDeps({ propose });

    const result = await draftKernelEdit(
      "edit your own pipeline",
      "src/lib/loom/kernelBuild.ts",
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.stage).toBe("propose");
    expect(result.error).toContain("not editable");
    // Refused before isolation — nothing to discard, nothing applied.
    expect(deps.discard).not.toHaveBeenCalled();
    expect(deps.validate).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe("draftKernelEdit — malformed draft", () => {
  it("aborts when the builder returns no SEARCH/REPLACE block", async () => {
    const { deps } = makeDeps({ chat: vi.fn(async () => "I refuse.") });
    const result = await draftKernelEdit("x", TARGET, deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.stage).toBe("draft");
    // Never even reached isolation.
    expect(deps.propose).not.toHaveBeenCalled();
  });
});

describe("applyKernelEdit — the only live-tree write", () => {
  it("applies only when explicitly called (the review card's Approve)", async () => {
    const apply = vi.fn<
      (worktreeId: string, message: string) => Promise<KernelApplied>
    >(async () => ({ sha: "abc123", prevSha: "def456" }));

    const applied = await applyKernelEdit("wt-good", "self: brighten the mood", apply);

    expect(apply).toHaveBeenCalledWith("wt-good", "self: brighten the mood");
    expect(applied).toEqual({ sha: "abc123", prevSha: "def456" });
  });
});

describe("discardKernelEdit — cleanup", () => {
  it("removes the worktree when the owner discards", async () => {
    const discard = vi.fn(async () => {});
    await discardKernelEdit("wt-good", discard);
    expect(discard).toHaveBeenCalledWith("wt-good");
  });
});
