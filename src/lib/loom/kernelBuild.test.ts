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
  isRustCorePath,
  touchesCore,
  type KernelBuildDeps,
  type KernelBuildEvent,
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
    // A pure-TS edit hot-reloads — no restart, not the core.
    expect(result.isCore).toBe(false);
    expect(result.needsRestart).toBe(false);

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
  it("approves THEN applies (the review card's Approve carries the owner's gate)", async () => {
    const order: string[] = [];
    const approve = vi.fn(async () => {
      order.push("approve");
    });
    const apply = vi.fn<
      (worktreeId: string, message: string) => Promise<KernelApplied>
    >(async () => {
      order.push("apply");
      return { sha: "abc123", prevSha: "def456" };
    });

    const applied = await applyKernelEdit(
      "wt-good",
      "self: brighten the mood",
      apply,
      approve,
    );

    // approve MUST precede apply — Rust refuses apply without approved=true.
    expect(order).toEqual(["approve", "apply"]);
    expect(approve).toHaveBeenCalledWith("wt-good");
    expect(apply).toHaveBeenCalledWith("wt-good", "self: brighten the mood");
    expect(applied).toEqual({ sha: "abc123", prevSha: "def456" });
  });

  it("does NOT apply if approve throws (Rust refused the gate)", async () => {
    const approve = vi.fn(async () => {
      throw new Error("cannot approve: proposal has not passed validation");
    });
    const apply = vi.fn<
      (worktreeId: string, message: string) => Promise<KernelApplied>
    >(async () => ({ sha: "x", prevSha: "y" }));

    await expect(
      applyKernelEdit("wt-good", "msg", apply, approve),
    ).rejects.toThrow(/cannot approve/);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("discardKernelEdit — cleanup", () => {
  it("removes the worktree when the owner discards", async () => {
    const discard = vi.fn(async () => {});
    await discardKernelEdit("wt-good", discard);
    expect(discard).toHaveBeenCalledWith("wt-good");
  });
});

// ── Rust core (Phase 22 — the builder reaches the marrow) ─────────────────────

const RUST_TARGET = "src-tauri/src/fleet.rs";
const RUST_CURRENT = "const TIMEOUT_MS: u64 = 45_000;\n";
const RUST_DRAFT =
  "<<<<<<< SEARCH\n" +
  "const TIMEOUT_MS: u64 = 45_000;\n" +
  "=======\n" +
  "const TIMEOUT_MS: u64 = 60_000;\n" +
  ">>>>>>> REPLACE\n";

function rustProposal(id: string): KernelProposal {
  return {
    worktreeId: id,
    diff: `--- a/${RUST_TARGET}\n+++ b/${RUST_TARGET}\n@@\n-45_000\n+60_000\n`,
  };
}

function cargoOk(): KernelValidation {
  return { ok: true, stage: "ok", output: "" };
}
function cargoFail(
  stage: "cargo-check" | "cargo-test",
  output: string,
): KernelValidation {
  return { ok: false, stage, output };
}

function makeRustDeps(over: Partial<KernelBuildDeps> = {}) {
  const log: KernelBuildEvent[] = [];
  const deps: KernelBuildDeps = {
    chat: vi.fn(async () => RUST_DRAFT),
    read: vi.fn(async () => RUST_CURRENT),
    propose: vi.fn(async () => rustProposal("wt-r1")),
    validate: vi.fn(async () => cargoOk()),
    discard: vi.fn(async () => {}),
    onEvent: (e) => log.push(e),
    ...over,
  };
  return { deps, log };
}

describe("isRustCorePath / touchesCore", () => {
  it("recognizes src-tauri/…​.rs as the core and nothing else", () => {
    expect(isRustCorePath("src-tauri/src/fleet.rs")).toBe(true);
    expect(isRustCorePath("src-tauri/src/organs.rs")).toBe(true);
    expect(isRustCorePath("src/lib/loom/moods.ts")).toBe(false);
    expect(isRustCorePath("src-tauri/Cargo.toml")).toBe(false); // not a .rs
    expect(touchesCore(["src/a.ts", "src-tauri/src/fleet.rs"])).toBe(true);
    expect(touchesCore(["src/a.ts", "src/b.tsx"])).toBe(false);
  });
});

describe("draftKernelEdit — Rust core, validate passes", () => {
  it("carries isCore + needsRestart on success and emits the compile progress", async () => {
    const { deps, log } = makeRustDeps();
    const result = await draftKernelEdit("give the fleet more time", RUST_TARGET, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.targetPaths).toEqual([RUST_TARGET]);
    // The load-bearing new flags: the core needs a restart to load.
    expect(result.isCore).toBe(true);
    expect(result.needsRestart).toBe(true);

    // The honest slow-UX progress fired — the pipeline never appears hung.
    const compiling = log.find((e) => e.detail.includes("compiling the core"));
    expect(compiling, "a 'compiling the core…' progress event fires for .rs").toBeTruthy();
    expect(deps.validate).toHaveBeenCalledTimes(1);
  });

  it("drafts against the .rs file it was handed", async () => {
    const { deps } = makeRustDeps();
    await draftKernelEdit("x", RUST_TARGET, deps);
    expect(deps.read).toHaveBeenCalledWith(RUST_TARGET);
  });
});

describe("draftKernelEdit — Rust cargo-stage failure repairs", () => {
  it("feeds the cargo stage back and re-validates the fix", async () => {
    let n = 0;
    const propose = vi
      .fn<() => Promise<KernelProposal>>()
      .mockResolvedValueOnce(rustProposal("wt-bad"))
      .mockResolvedValueOnce(rustProposal("wt-good"));
    const validate = vi.fn(async () => {
      n++;
      return n === 1
        ? cargoFail("cargo-check", "error[E0308]: mismatched types")
        : cargoOk();
    });
    const chat = vi.fn(async () => RUST_DRAFT);
    const { deps } = makeRustDeps({ propose, validate, chat });

    const result = await draftKernelEdit("fix the core", RUST_TARGET, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.worktreeId).toBe("wt-good");
    expect(result.repairRounds).toBe(1);
    expect(result.isCore).toBe(true);
    expect(result.needsRestart).toBe(true);

    // The failed worktree was discarded before re-proposing (no orphans).
    expect(deps.discard).toHaveBeenCalledWith("wt-bad");
    // The repair turn carried cargo's own output back to the builder.
    const repairCall = (chat as ReturnType<typeof vi.fn>).mock.calls[1];
    const repairUser = (repairCall[1] as { role: string; content: string }[]).find(
      (m) => m.role === "user",
    );
    expect(repairUser?.content).toContain("cargo-check");
    expect(repairUser?.content).toContain("E0308");
  });

  it("aborts after the cargo repair budget, reporting the cargo stage", async () => {
    const validate = vi.fn(async () => cargoFail("cargo-test", "test kernel::tests::x ... FAILED"));
    const { deps } = makeRustDeps({ validate });

    const result = await draftKernelEdit("break the core", RUST_TARGET, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.stage).toBe("cargo-test");
    expect(result.error).toContain("FAILED");
  });
});
