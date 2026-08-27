/**
 * kernelBuild.ts — the self-edit pipeline orchestrator (Phase 21, Task 2/3).
 *
 * HONESTY NOTE: the branches below (draft → propose → validate → repair, and the
 * separate applyKernelEdit) are proven headlessly by mocked-Rust tests, and the
 * five-wall ORDERING is proven by kernelBuild.order.test.ts. The LIVE HMR
 * self-edit loop — a REAL model drafting against the RUNNING app, hot-reloading
 * an approved edit — is owner-verified in dev; it cannot be captured in headless
 * CI. What CI proves: the ordering and every branch. What the owner proves in
 * dev: the loop actually reloads a live app. Do not claim the live loop is
 * CI-proven.
 *
 * LOOM editing its own TypeScript kernel travels through five ordered walls
 * (spec §"five walls"). This module owns the FIRST THREE steps of that path
 * and — critically — NOTHING MORE:
 *
 *   1. ISOLATION   — the builder reads the REAL current file (kernelRead),
 *                    drafts a SEARCH/REPLACE edit, and kernelPropose applies it
 *                    to an isolated git worktree. The live tree is untouched.
 *   2. VALIDATION  — kernelValidate runs tsc + vitest in that worktree. On
 *                    failure the builder gets one bounded repair round (temp
 *                    0.0), the failed worktree is DISCARDED (no orphans), and
 *                    a fresh proposal is re-validated.
 *   3. (returns)   — on success this returns { worktreeId, diff, targetPaths }
 *                    for REVIEW. It DOES NOT APPLY.
 *
 * The load-bearing invariant: `draftKernelEdit` NEVER calls kernelApply. The
 * live tree write (wall 4) is a SEPARATE exported function `applyKernelEdit`,
 * which the diff-review card's Approve handler calls — and only after this
 * function has returned a validated proposal AND the owner approved the diff.
 * Making apply a different function that this pipeline cannot reach is what
 * makes "apply before validate+approve" structurally impossible here.
 *
 * Dependency-injected (the kernel* calls + chat) so every branch is tested
 * offline with mocked Rust.
 */

import { extractCode } from "./edits";
import { selfEditSystemPrompt } from "./prompts";
import type {
  KernelEdit,
  KernelProposal,
  KernelValidation,
  KernelApplied,
  Msg,
  ChatOpts,
} from "../core";

// ── Events (mirrors build.ts BuildEvent) ──────────────────────────────────────

export type KernelBuildEvent = {
  ts: number;
  phase: string;
  detail: string;
  role?: "builder";
};

// ── Injected surfaces ─────────────────────────────────────────────────────────

export type KernelBuildDeps = {
  /** The builder brain. Same signature build.ts uses (deps.chat). */
  chat: (role: string, messages: Msg[], opts?: ChatOpts) => Promise<string>;
  /** Read the REAL current contents of an editable kernel file. */
  read: (path: string) => Promise<string>;
  /** Isolate: create a worktree, apply the edits, return the unified diff. */
  propose: (edits: KernelEdit[]) => Promise<KernelProposal>;
  /** Validate: tsc then vitest in the worktree; first failure wins. */
  validate: (worktreeId: string) => Promise<KernelValidation>;
  /** Discard a proposal and remove its worktree (no live-tree effect). */
  discard: (worktreeId: string) => Promise<void>;
  onEvent?: (e: KernelBuildEvent) => void;
};

// ── Result ────────────────────────────────────────────────────────────────────

export type KernelDraft =
  | {
      ok: true;
      worktreeId: string;
      diff: string;
      targetPaths: string[];
      repairRounds: number;
      log: KernelBuildEvent[];
    }
  | {
      ok: false;
      stage: string;
      error: string;
      log: KernelBuildEvent[];
    };

/** How many repair rounds before we give up and abort (mirrors organ builds). */
const MAX_REPAIR_ROUNDS = 2;

// ── Parse SEARCH/REPLACE blocks → KernelEdit[] ────────────────────────────────
//
// Reuses the edits.ts block grammar (<<<<<<< SEARCH … ======= … >>>>>>> REPLACE)
// but produces {path, search, replace} triples for kernel_propose. Every block
// targets the single target file (v1 favors small, single-file bounded edits —
// spec Non-goals: "multi-file sweeping refactors").

const BLOCK_RE =
  /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n?={5,}\s*\r?\n([\s\S]*?)\r?\n?>{5,}\s*REPLACE/g;

/**
 * Parse the model's raw output into KernelEdit[] for one target path.
 * Returns null if no well-formed block is present.
 */
export function parseKernelEdits(path: string, raw: string): KernelEdit[] | null {
  const blocks = [...raw.matchAll(BLOCK_RE)];
  if (blocks.length === 0) return null;
  return blocks.map((b) => ({
    path,
    search: b[1].replace(/\r/g, ""),
    replace: b[2].replace(/\r/g, ""),
  }));
}

// ── The draft/validate/repair pipeline (walls 1–2, then hands off) ────────────

/**
 * Draft, isolate, and validate a self-edit — WITHOUT applying it.
 *
 * @param request     the owner's self-edit request ("change yourself: …")
 * @param targetPath  the editable kernel file to edit (the target hint)
 * @param deps        injected kernel* calls + chat (mocked in tests)
 *
 * On success returns { worktreeId, diff, targetPaths } for the review card.
 * On failure the worktree (if any) is always discarded before returning.
 *
 * NOTE: this function contains NO reference to kernelApply — apply is a
 * separate export the review card calls after approval.
 */
export async function draftKernelEdit(
  request: string,
  targetPath: string,
  deps: KernelBuildDeps,
): Promise<KernelDraft> {
  const log: KernelBuildEvent[] = [];
  function emit(phase: string, detail: string): void {
    const e: KernelBuildEvent = { ts: Date.now(), phase, detail, role: "builder" };
    log.push(e);
    deps.onEvent?.(e);
  }

  try {
    // ── Read the REAL current file ────────────────────────────────────────────
    emit("read", `reading ${targetPath}...`);
    const current = await deps.read(targetPath);
    emit("read", "ok");

    // ── Draft the initial edit ────────────────────────────────────────────────
    // The rich SELF-EDIT contract (whitelist, five walls, SEARCH/REPLACE format,
    // worked example) is injected here and ONLY here — never into organ builds.
    emit("draft", "drafting a self-edit...");
    const draftSystem = selfEditSystemPrompt();
    const draftUser =
      `TARGET FILE: ${targetPath}\n\nCURRENT CONTENTS:\n${current}\n\n` +
      `SELF-EDIT REQUEST: ${request}\n\n` +
      `Output ONLY SEARCH/REPLACE edit blocks (no prose, no full file).`;
    const draftRaw = await deps.chat(
      "builder",
      [
        { role: "system", content: draftSystem },
        { role: "user", content: draftUser },
      ],
      { temperature: 0.2 },
    );

    let edits = parseKernelEdits(targetPath, draftRaw);
    if (edits === null) {
      emit("draft", "no edit blocks in the draft — aborting");
      return {
        ok: false,
        stage: "draft",
        error: "the builder did not return a well-formed SEARCH/REPLACE edit",
        log,
      };
    }
    emit("draft", `ok — ${edits.length} block(s)`);

    // ── Propose → validate → bounded repair ───────────────────────────────────
    let worktreeId: string | null = null;
    let lastValidation: KernelValidation | null = null;

    for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
      // Isolate: propose to a fresh worktree. Any prior (failed) worktree was
      // already discarded at the bottom of the previous iteration.
      emit("propose", round === 0 ? "isolating in a worktree..." : `re-isolating (round ${round})...`);
      let proposal: KernelProposal;
      try {
        proposal = await deps.propose(edits);
      } catch (err) {
        // Protected-path / non-editable / mismatch rejections surface here,
        // BEFORE any worktree exists (kernel_propose self-protects first).
        emit("propose", `refused: ${errText(err)}`);
        return {
          ok: false,
          stage: "propose",
          error: errText(err),
          log,
        };
      }
      worktreeId = proposal.worktreeId;
      emit("propose", "ok — worktree isolated");

      // Validate: tsc + vitest in the worktree.
      emit("validate", "type-checking and testing in isolation...");
      const validation = await deps.validate(worktreeId);
      lastValidation = validation;
      if (validation.ok) {
        emit("validate", "passed — tsc + vitest green");
        return {
          ok: true,
          worktreeId,
          diff: proposal.diff,
          targetPaths: [targetPath],
          repairRounds: round,
          log,
        };
      }

      emit("validate", `failed at ${validation.stage}`);

      // Out of repair budget → abort. Discard the failed worktree first.
      if (round === MAX_REPAIR_ROUNDS) {
        await safeDiscard(deps, worktreeId, emit);
        worktreeId = null;
        emit("abort", `still failing after ${round} repair round(s) — worktree discarded`);
        return {
          ok: false,
          stage: validation.stage,
          error: validation.output,
          log,
        };
      }

      // Repair round: feed {stage, output} back to the builder (temp 0.0).
      emit("repair", `round ${round + 1}: asking the builder to fix the ${validation.stage} failure...`);
      const repairUser =
        `TARGET FILE: ${targetPath}\n\nCURRENT CONTENTS:\n${current}\n\n` +
        `Your previous edit FAILED validation.\n` +
        `STAGE: ${validation.stage}\n` +
        `OUTPUT:\n${validation.output}\n\n` +
        `SELF-EDIT REQUEST: ${request}\n\n` +
        `Output a corrected set of SEARCH/REPLACE edit blocks (no prose, no full file).`;
      const repairRaw = await deps.chat(
        "builder",
        [
          { role: "system", content: selfEditSystemPrompt({ repair: true }) },
          { role: "user", content: repairUser },
        ],
        { temperature: 0.0 },
      );
      const repaired = parseKernelEdits(targetPath, repairRaw);

      // Discard the failed worktree BEFORE re-proposing — no orphans.
      await safeDiscard(deps, worktreeId, emit);
      worktreeId = null;

      if (repaired === null) {
        emit("repair", "no edit blocks in the repair — aborting");
        return {
          ok: false,
          stage: validation.stage,
          error: validation.output,
          log,
        };
      }
      edits = repaired;
    }

    // Unreachable (the loop returns on every path) — defensive.
    return {
      ok: false,
      stage: lastValidation?.stage ?? "validate",
      error: lastValidation?.output ?? "validation did not complete",
      log,
    };
  } catch (err) {
    emit("error", errText(err));
    return { ok: false, stage: "error", error: errText(err), log };
  }
}

// ── Target resolution ─────────────────────────────────────────────────────────
//
// A self-edit request ("edit your companion prompt") names intent, not a path.
// This asks the builder to name ONE editable file to touch, then verifies it is
// readable (kernelRead rejects protected / non-editable paths in Rust, so a
// successful read proves the target is inside the whitelist). Bounded: one ask,
// one verification. Task 3 enriches the prompt with the whitelist listing.

/**
 * Resolve the single target file for a self-edit request. Returns the path, or
 * null when the builder names nothing usable / the named file is not editable.
 */
export async function resolveSelfEditTarget(
  request: string,
  deps: Pick<KernelBuildDeps, "chat" | "read">,
): Promise<string | null> {
  const system =
    "You are the Loom, about to edit LOOM's own TypeScript kernel. Given a " +
    "change request, name the ONE source file most likely to hold the code to " +
    "change. Reply with ONLY the repo-relative path (e.g. src/lib/orb/moods.ts) " +
    "and nothing else. It must be a src/ .ts or .tsx file.";
  const raw = await deps.chat(
    "builder",
    [
      { role: "system", content: system },
      { role: "user", content: `Change request: ${request}` },
    ],
    { temperature: 0.0 },
  );
  const path = extractPath(raw);
  if (!path) return null;
  // Verify it is actually editable + present by reading it. kernelRead throws
  // for protected / non-editable / missing paths — that is the honest gate.
  try {
    await deps.read(path);
    return path;
  } catch {
    return null;
  }
}

/** Pull the first plausible src/ .ts(x) path out of a model reply. */
export function extractPath(raw: string): string | null {
  const cleaned = extractCode(raw).trim();
  const m = cleaned.match(/(?:^|[\s"'`(])((?:src\/)[\w./-]+\.tsx?)/);
  return m ? m[1] : null;
}

// ── Wall 4 & discard — SEPARATE exports, called only by the review card ───────

/**
 * Apply a validated proposal to the LIVE tree + commit (wall 4).
 *
 * This is the ONLY function in the self-edit surface that touches the live
 * tree. It is intentionally NOT reachable from draftKernelEdit — the review
 * card's Approve handler calls it, and only after a successful draft (which
 * proves tsc+vitest passed) and the owner's explicit approval of the diff.
 *
 * The owner's approval is carried into Rust FIRST: `approve` flips the Rust-side
 * `approved` flag (which Rust refuses unless the proposal already validated),
 * and only then does `apply` run — Rust refuses apply unless BOTH validated AND
 * approved. So the wall ordering is enforced structurally in Rust; this function
 * simply wires the KernelDiff "approve the change" click to that gate.
 */
export async function applyKernelEdit(
  worktreeId: string,
  message: string,
  apply: (worktreeId: string, message: string) => Promise<KernelApplied>,
  approve: (worktreeId: string) => Promise<void>,
): Promise<KernelApplied> {
  await approve(worktreeId);
  return apply(worktreeId, message);
}

/** Discard a validated-but-unapproved proposal (the review card's Discard). */
export async function discardKernelEdit(
  worktreeId: string,
  discard: (worktreeId: string) => Promise<void>,
): Promise<void> {
  return discard(worktreeId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Discard a worktree, swallowing (but logging) any cleanup error. */
async function safeDiscard(
  deps: KernelBuildDeps,
  worktreeId: string,
  emit: (phase: string, detail: string) => void,
): Promise<void> {
  try {
    await deps.discard(worktreeId);
  } catch (err) {
    emit("discard", `cleanup warning: ${errText(err)}`);
  }
}
