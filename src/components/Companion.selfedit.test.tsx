/**
 * Companion.selfedit.test.tsx — the self-edit entry surface (Phase 21).
 *
 * Covers Companion's routing of a `self_edit` turn:
 * - DEV-ONLY guard: packaged (import.meta.env.DEV false) → honest "needs dev
 *   mode" state, no pipeline call.
 * - Dev + validated draft → dispatches loom-kernel-review (the diff-review
 *   card owns the only live-tree write; Companion never applies).
 * - Never applies (kernel_apply is never invoked from this path).
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import type { CompanionTurn } from "../lib/companion/runtime";

// ── invoke mock: per-command kernel responses ────────────────────────────────
const GOOD_DRAFT =
  "<<<<<<< SEARCH\nconst mood = 'calm';\n=======\nconst mood = 'bright';\n>>>>>>> REPLACE\n";

async function baseInvoke(cmd: string): Promise<unknown> {
  switch (cmd) {
    case "kernel_editable":
      return { root: "/repo", protected: [] };
    case "kernel_read":
      return "const mood = 'calm';\n";
    case "fleet_chat":
      // used by resolveSelfEditTarget (names a file) then draft (returns blocks)
      // the first call names the file, subsequent calls draft — return a path
      // that also happens to contain a block-free string; kernelBuild's target
      // step reads the path, the draft step returns GOOD_DRAFT. We disambiguate
      // by returning a value that satisfies both: extractPath finds the path,
      // parseKernelEdits finds the block. Simplest: return both.
      return `src/lib/orb/moods.ts\n${GOOD_DRAFT}`;
    case "kernel_propose":
      return { worktreeId: "wt-1", diff: "--- a\n+++ b\n@@\n-calm\n+bright\n" };
    case "kernel_validate":
      return { ok: true, stage: "ok", output: "" };
    case "kernel_apply":
      return { sha: "new", prevSha: "old" };
    case "kernel_discard":
      return undefined;
    case "tts_speak":
      return [1, 2, 3];
    default:
      return [];
  }
}

const invokeMock = vi.fn(baseInvoke);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [string])),
}));

const mockHandle = vi.fn<
  (utterance: string, history: unknown[], deps: unknown) => Promise<CompanionTurn>
>();
vi.mock("../lib/companion/runtime", () => ({
  handle: (...args: Parameters<typeof mockHandle>) => mockHandle(...args),
}));

vi.mock("../lib/voice/player", () => ({
  playWav: vi.fn().mockResolvedValue(undefined),
  stopPlayback: vi.fn(),
}));

beforeEach(() => {
  mockHandle.mockReset();
  // Reset to the base implementation so a per-test override never leaks.
  invokeMock.mockReset();
  invokeMock.mockImplementation(baseInvoke);
  localStorage.clear();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

import Companion from "./Companion";

async function submit(text: string) {
  const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);
  await userEvent.type(textarea, text);
  await userEvent.keyboard("{Enter}");
}

describe("Companion — self-edit routing", () => {
  it("no source repo (kernelEditable throws) shows the honest 'needs dev mode' state and never proposes", async () => {
    // Simulate a packaged build / no source repo: kernel_editable rejects.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "kernel_editable") throw new Error("not a git work dir");
      if (cmd === "tts_speak") return [1, 2, 3];
      return [];
    });
    mockHandle.mockResolvedValue({ kind: "self_edit", request: "brighten the orb" });

    render(<Companion />);
    await submit("change yourself: brighten the orb");

    await waitFor(() => {
      expect(screen.getByTestId("self-edit-blocked")).toBeInTheDocument();
    });
    // The pipeline never isolated or applied.
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("kernel_propose");
    expect(calls).not.toContain("kernel_apply");
  });

  it("dev + validated draft dispatches loom-kernel-review and NEVER applies", async () => {
    vi.stubEnv("DEV", true);
    mockHandle.mockResolvedValue({ kind: "self_edit", request: "brighten the orb" });

    const reviews: unknown[] = [];
    const onReview = (e: Event) =>
      reviews.push((e as CustomEvent<{ proposal: unknown }>).detail.proposal);
    window.addEventListener("loom-kernel-review", onReview);

    render(<Companion />);
    await act(async () => {
      await submit("change yourself: brighten the orb");
    });

    await waitFor(() => {
      expect(reviews.length).toBe(1);
    });
    expect(reviews[0]).toMatchObject({
      worktreeId: "wt-1",
      targetPaths: ["src/lib/orb/moods.ts"],
      request: "brighten the orb",
    });

    // The pipeline proposed + validated, but Companion NEVER applied.
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("kernel_propose");
    expect(calls).toContain("kernel_validate");
    expect(calls).not.toContain("kernel_apply");

    window.removeEventListener("loom-kernel-review", onReview);
  });
});
