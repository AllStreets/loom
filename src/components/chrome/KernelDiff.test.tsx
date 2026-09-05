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

  it("a TS edit frames as CHANGE ITSELF and the applied note reads 'reloading'", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "a", prevSha: "b" })),
    });
    render(<KernelDiff api={api} />);
    act(() => dispatchReview(sampleProposal())); // targetPaths = a .ts file

    expect(screen.getByText(/LOOM WANTS TO CHANGE ITSELF/i)).toBeInTheDocument();
    expect(screen.queryByTestId("kernel-diff-core-banner")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    expect(screen.getByTestId("kernel-diff-applied")).toHaveTextContent(/changed — reloading/i);
    expect(screen.getByTestId("kernel-diff-applied")).not.toHaveTextContent(/restart/i);
  });

  it("a RUST-CORE edit frames as the core + restart, and the applied note says restart to load", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "a", prevSha: "b" })),
    });
    render(<KernelDiff api={api} />);
    act(() =>
      dispatchReview(
        sampleProposal({
          worktreeId: "wt-rust",
          targetPaths: ["src-tauri/src/fleet.rs"],
          isCore: true,
        }),
      ),
    );

    // The weight is heavier and unmistakably about the core + a restart.
    expect(screen.getByText(/LOOM WANTS TO CHANGE ITS CORE/i)).toBeInTheDocument();
    const banner = screen.getByTestId("kernel-diff-core-banner");
    expect(banner).toHaveTextContent(/RUST CORE/i);
    expect(banner).toHaveTextContent(/does not hot-reload/i);
    expect(banner).toHaveTextContent(/RESTART LOOM/i);

    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    expect(screen.getByTestId("kernel-diff-applied")).toHaveTextContent(
      /changed — restart LOOM to load the core/i,
    );
  });

  it("derives the core framing from a Rust target path even if isCore is unset", () => {
    const api = mockApi();
    render(<KernelDiff api={api} />);
    // No isCore flag — the path alone must not let the framing downgrade.
    act(() =>
      dispatchReview(sampleProposal({ targetPaths: ["src-tauri/src/organs.rs"] })),
    );
    expect(screen.getByText(/LOOM WANTS TO CHANGE ITS CORE/i)).toBeInTheDocument();
    expect(screen.getByTestId("kernel-diff-core-banner")).toBeInTheDocument();
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

// ── Phase 23 (Rebirth): packaged framing ──────────────────────────────────────

const PACKAGED = async () => ({
  mode: "packaged" as const,
  genomeSha: "3f2a1c9deadbeef",
  generation: "8b91e0abcdef",
  threaded: true,
  loomhome: "/tmp/loomhome",
});
const DEV = async () => ({
  mode: "dev" as const,
  genomeSha: "3f2a1c9deadbeef",
  generation: null,
  threaded: false,
  loomhome: "/tmp/loomhome",
});

describe("KernelDiff — packaged framing (Rebirth)", () => {
  it("packaged: the applied outcome reads 'woven into source — reweave to become it' with a REWEAVE button", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    const reweave = vi.fn(async () => ({ ok: true as const }));
    render(<KernelDiff api={api} identity={PACKAGED} reweave={reweave} />);
    act(() => dispatchReview(sampleProposal()));
    // let the identity resolve
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });

    expect(screen.getByTestId("kernel-diff-applied")).toHaveTextContent(
      "woven into source — reweave to become it",
    );
    expect(screen.getByTestId("kernel-diff-applied")).not.toHaveTextContent(/reloading|restart/i);
    const btn = screen.getByTestId("kernel-diff-reweave");
    expect(btn).toHaveTextContent("REWEAVE");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(reweave).toHaveBeenCalledTimes(1);
    // the card then closes (reset) — the reweave card takes over. AnimatePresence
    // keeps a frozen snapshot of the exiting node in jsdom, so presence is not
    // asserted here (the Discard test has the same shape).
  });

  it("packaged: a core edit also reads woven-into-source (no 'restart' framing) and the banner says reweave", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    render(<KernelDiff api={api} identity={PACKAGED} reweave={vi.fn(async () => ({ ok: true as const }))} />);
    act(() =>
      dispatchReview(sampleProposal({ targetPaths: ["src-tauri/src/moods.rs"], isCore: true })),
    );
    await act(async () => {});
    expect(screen.getByTestId("kernel-diff-core-banner")).toHaveTextContent(/reweave/i);
    expect(screen.getByTestId("kernel-diff-core-banner")).not.toHaveTextContent(/restart/i);

    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    expect(screen.getByTestId("kernel-diff-applied")).toHaveTextContent(
      "woven into source — reweave to become it",
    );
    expect(screen.getByTestId("kernel-diff-reweave")).toBeInTheDocument();
  });

  it("dev: framing unchanged — no REWEAVE button, the reload note stands", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    render(<KernelDiff api={api} identity={DEV} reweave={vi.fn(async () => ({ ok: true as const }))} />);
    act(() => dispatchReview(sampleProposal()));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    expect(screen.getByTestId("kernel-diff-applied")).toHaveTextContent(/changed — reloading/i);
    expect(screen.queryByTestId("kernel-diff-reweave")).not.toBeInTheDocument();
  });

  it("an unreachable identity (browser mode) falls back to the dev framing", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    const identity = vi.fn(async () => {
      throw new Error("this surface needs the desktop shell");
    });
    render(<KernelDiff api={api} identity={identity} />);
    act(() => dispatchReview(sampleProposal()));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    expect(screen.getByTestId("kernel-diff-applied")).toHaveTextContent(/changed — reloading/i);
  });

  it("reports the applied outcome through onApplied with the mode (the autoReweave seam)", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    const onApplied = vi.fn();
    render(<KernelDiff api={api} identity={PACKAGED} onApplied={onApplied} />);
    act(() => dispatchReview(sampleProposal({ targetPaths: ["src-tauri/src/moods.rs"] })));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    expect(onApplied).toHaveBeenCalledWith({ mode: "packaged", isCore: true, sha: "abc1234" });
  });
});

// ── Round-1 review: a refused weave is spoken, not swallowed ──────────────────

describe("KernelDiff — a refused reweave states the reason", () => {
  it("packaged: REWEAVE refused → the calm reason renders and the card stays open", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    const reweave = vi.fn(async () => ({ ok: false as const, reason: "a weave is already under way" }));
    render(<KernelDiff api={api} identity={PACKAGED} reweave={reweave} />);
    act(() => dispatchReview(sampleProposal()));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-reweave"));
    });
    expect(screen.getByTestId("kernel-diff-reweave-reason")).toHaveTextContent(
      "a weave is already under way",
    );
    // the card is still here — the owner asked and got an answer, not silence
    expect(screen.getByTestId("kernel-diff-reweave")).toBeInTheDocument();
  });

  it("packaged: a REWEAVE that throws still states a calm reason", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    const reweave = vi.fn(async () => {
      throw new Error("the shell went away");
    });
    render(<KernelDiff api={api} identity={PACKAGED} reweave={reweave} />);
    act(() => dispatchReview(sampleProposal()));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-reweave"));
    });
    expect(screen.getByTestId("kernel-diff-reweave-reason")).toHaveTextContent(/the shell went away/);
  });
});

// ── Round-1 review: the copy never promises an approval that is not asked ─────

describe("KernelDiff — autoReweave changes what the card promises", () => {
  it("packaged core edit with autoReweave on: the banner says the weave starts on approval, no second approval promised", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    render(
      <KernelDiff
        api={api}
        identity={PACKAGED}
        autoReweave={() => true}
        reweave={vi.fn(async () => ({ ok: true as const }))}
      />,
    );
    act(() => dispatchReview(sampleProposal({ targetPaths: ["src-tauri/src/moods.rs"], isCore: true })));
    await act(async () => {});
    const banner = screen.getByTestId("kernel-diff-core-banner");
    expect(banner).toHaveTextContent(/approving starts the reweave/i);
    expect(banner).not.toHaveTextContent(/a reweave you approve/i);
  });

  it("packaged core edit with autoReweave on: the applied note says the weave has started and offers no REWEAVE", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    render(
      <KernelDiff
        api={api}
        identity={PACKAGED}
        autoReweave={() => true}
        reweave={vi.fn(async () => ({ ok: true as const }))}
      />,
    );
    act(() => dispatchReview(sampleProposal({ targetPaths: ["src-tauri/src/moods.rs"], isCore: true })));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    expect(screen.getByTestId("kernel-diff-applied")).toHaveTextContent(
      "woven into source — the weave has started",
    );
    expect(screen.queryByTestId("kernel-diff-reweave")).not.toBeInTheDocument();
  });

  it("packaged TypeScript edit with autoReweave on: nothing auto-starts, so REWEAVE is still offered", async () => {
    const api = mockApi({
      apply: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
    });
    render(
      <KernelDiff
        api={api}
        identity={PACKAGED}
        autoReweave={() => true}
        reweave={vi.fn(async () => ({ ok: true as const }))}
      />,
    );
    act(() => dispatchReview(sampleProposal()));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("kernel-diff-approve"));
    });
    expect(screen.getByTestId("kernel-diff-applied")).toHaveTextContent(
      "woven into source — reweave to become it",
    );
    expect(screen.getByTestId("kernel-diff-reweave")).toBeInTheDocument();
  });
});
