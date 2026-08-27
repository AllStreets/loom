/**
 * KernelDiff.test.tsx — the diff-review card (third wall, made visible).
 *
 * Proves: the card appears only on a validated `loom-kernel-review` event;
 * Approve applies via the injected api and shows the reload note; Discard
 * cleans up the worktree; only one card at a time; diff lines are token-tinted.
 */

import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom";
import KernelDiff, { type KernelReviewProposal } from "./KernelDiff";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

const DIFF =
  "--- a/src/lib/loom/moods.ts\n" +
  "+++ b/src/lib/loom/moods.ts\n" +
  "@@ -1 +1 @@\n" +
  "-export const mood = 'calm';\n" +
  "+export const mood = 'bright';\n";

function sampleProposal(over: Partial<KernelReviewProposal> = {}): KernelReviewProposal {
  return {
    worktreeId: "wt-good",
    diff: DIFF,
    targetPaths: ["src/lib/loom/moods.ts"],
    request: "make the mood bright",
    ...over,
  };
}

function dispatchReview(proposal: KernelReviewProposal) {
  window.dispatchEvent(new CustomEvent("loom-kernel-review", { detail: { proposal } }));
}

/** A full KernelDiffApi mock (approve + apply + discard). */
function mockApi(
  over: Partial<{
    approve: ReturnType<typeof vi.fn>;
    apply: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    approve: over.approve ?? vi.fn(async () => {}),
    apply: over.apply ?? vi.fn(),
    discard: over.discard ?? vi.fn(),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("KernelDiff", () => {
  it("does not render until a validated proposal arrives", () => {
    const api = mockApi();
    render(<KernelDiff api={api} />);
    expect(screen.queryByTestId("kernel-diff-card")).not.toBeInTheDocument();
  });

  it("shows the brand header, target path, and token-tinted diff on review", () => {
    const api = mockApi();
    render(<KernelDiff api={api} />);
    act(() => dispatchReview(sampleProposal()));

    expect(screen.getByTestId("kernel-diff-card")).toBeInTheDocument();
    expect(screen.getByText(/LOOM WANTS TO CHANGE ITSELF/i)).toBeInTheDocument();
    expect(screen.getByTestId("kernel-diff-target")).toHaveTextContent("src/lib/loom/moods.ts");

    // added / removed lines are classified for token tinting
    const body = screen.getByTestId("kernel-diff-body");
    expect(body.querySelector('[data-diff-kind="add"]')).not.toBeNull();
    expect(body.querySelector('[data-diff-kind="del"]')).not.toBeNull();
    expect(body.querySelector('[data-diff-kind="hunk"]')).not.toBeNull();
  });

  it("Approve approves THEN applies via the injected api, then shows the reload note", async () => {
    const order: string[] = [];
    const api = mockApi({
      approve: vi.fn(async () => {
        order.push("approve");
      }),
      apply: vi.fn(async () => {
        order.push("apply");
        return { sha: "abc1234", prevSha: "def5678" };
      }),
      discard: vi.fn(async () => {}),
    });
    render(<KernelDiff api={api} />);
    act(() => dispatchReview(sampleProposal()));

    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });

    // approve MUST run before apply — the Rust-enforced gate.
    expect(order).toEqual(["approve", "apply"]);
    expect(api.approve).toHaveBeenCalledWith("wt-good");
    expect(api.apply).toHaveBeenCalledWith("wt-good", "make the mood bright");
    expect(api.discard).not.toHaveBeenCalled();
    // the calm "changed — reloading" note replaces the action buttons
    expect(screen.getByTestId("kernel-diff-applied")).toHaveTextContent(/changed — reloading/i);
    expect(screen.queryByTestId("kernel-diff-approve")).not.toBeInTheDocument();
  });

  it("discards the worktree when apply throws after approve (no orphan)", async () => {
    const api = mockApi({
      approve: vi.fn(async () => {}),
      apply: vi.fn(async () => {
        throw new Error("apply failed late");
      }),
      discard: vi.fn(async () => {}),
    });
    render(<KernelDiff api={api} />);
    act(() => dispatchReview(sampleProposal()));

    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });

    // approve + apply were attempted; apply threw; the worktree must be discarded
    expect(api.apply).toHaveBeenCalled();
    expect(api.discard).toHaveBeenCalledWith("wt-good");
    // the card closed honestly (no "changed" note, since apply never succeeded)
    expect(screen.queryByTestId("kernel-diff-applied")).not.toBeInTheDocument();
  });

  it("Discard cleans up the worktree and closes without applying", async () => {
    const api = mockApi({ discard: vi.fn(async () => {}) });
    render(<KernelDiff api={api} />);
    act(() => dispatchReview(sampleProposal()));

    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-discard"));
    });

    expect(api.discard).toHaveBeenCalledWith("wt-good");
    expect(api.apply).not.toHaveBeenCalled();
    expect(api.approve).not.toHaveBeenCalled();
    // discard removes the worktree without ever writing the live tree
  });

  it("shows only one card at a time (a live review ignores further proposals)", () => {
    const api = mockApi();
    render(<KernelDiff api={api} />);
    act(() => dispatchReview(sampleProposal({ targetPaths: ["src/lib/loom/moods.ts"] })));
    act(() => dispatchReview(sampleProposal({ worktreeId: "wt-2", targetPaths: ["src/lib/other.ts"] })));

    // still the first proposal's target
    expect(screen.getAllByTestId("kernel-diff-target")).toHaveLength(1);
    expect(screen.getByTestId("kernel-diff-target")).toHaveTextContent("src/lib/loom/moods.ts");
  });
});
