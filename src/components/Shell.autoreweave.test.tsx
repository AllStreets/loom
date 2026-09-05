/**
 * Shell.autoreweave.test.tsx — what an approved packaged edit does on its own.
 *
 * Two round-1 findings live here:
 *   - `kernel.autoReweave` fired on ANY packaged apply. The toggle says "after
 *     an approved CORE edit", so a TypeScript-only edit must never close and
 *     relaunch the app.
 *   - a refused `startReweave` returns `{ ok: false, reason }` rather than
 *     throwing, and the shell discarded it with `void` — the owner asked LOOM
 *     to rebuild itself and got silence. The reason is now a notice.
 */

import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import type { KernelReviewProposal } from "./chrome/KernelDiff";

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "kernel_identity") {
      return {
        mode: "packaged",
        genomeSha: "3f2a1c93f2a1c93f2a1c93f2a1c93f2a1c93f2a1",
        generation: "8b91e08b91e08b91e08b91e08b91e08b91e08b91",
        threaded: true,
        loomhome: "/tmp/loomhome",
        loomhomeBytes: 0,
      };
    }
    if (cmd === "organ_list") return [];
    if (cmd === "fleet_status") return [];
    return [];
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const kernelBuild = vi.hoisted(() => ({
  applyKernelEdit: vi.fn(async () => ({ sha: "abc1234", prevSha: "def5678" })),
  discardKernelEdit: vi.fn(async () => {}),
}));
vi.mock("../lib/loom/kernelBuild", async (importActual) => ({
  ...(await importActual<typeof import("../lib/loom/kernelBuild")>()),
  ...kernelBuild,
}));

const reweave = vi.hoisted(() => ({
  startReweave: vi.fn(async () => ({ ok: true as const })),
  /** The reweave feed, captured so a test can push a stage through it. */
  feed: [] as ((s: unknown) => void)[],
}));
vi.mock("../lib/loom/reweave", async (importActual) => ({
  ...(await importActual<typeof import("../lib/loom/reweave")>()),
  startReweave: reweave.startReweave,
  subscribe: (on: (s: unknown) => void) => {
    reweave.feed.push(on);
    return () => {
      reweave.feed = reweave.feed.filter((f) => f !== on);
    };
  },
}));

import Shell from "./Shell";

const DIFF =
  "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";

function proposal(over: Partial<KernelReviewProposal> = {}): KernelReviewProposal {
  return {
    worktreeId: "wt-1",
    diff: DIFF,
    targetPaths: ["src/lib/loom/moods.ts"],
    request: "brighten the mood",
    ...over,
  };
}

/** Dispatch a validated proposal, approve it, and let every promise settle. */
async function approve(p: KernelReviewProposal) {
  render(<Shell />);
  await act(async () => {});
  act(() => {
    window.dispatchEvent(new CustomEvent("loom-kernel-review", { detail: { proposal: p } }));
  });
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByTestId("kernel-diff-approve"));
  });
  await act(async () => {});
}

beforeEach(() => {
  localStorage.setItem("loom.orb", "flat");
  localStorage.setItem("kernel.autoReweave", "on");
  reweave.startReweave.mockResolvedValue({ ok: true });
  reweave.feed = [];
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("Shell — autoReweave honours isCore", () => {
  it("a packaged TypeScript edit does NOT start a weave, even with the toggle on", async () => {
    await approve(proposal());
    expect(reweave.startReweave).not.toHaveBeenCalled();
  });

  it("a packaged CORE edit starts the weave", async () => {
    await approve(proposal({ targetPaths: ["src-tauri/src/moods.rs"], isCore: true }));
    expect(reweave.startReweave).toHaveBeenCalledTimes(1);
  });

  it("the toggle off never starts a weave", async () => {
    localStorage.setItem("kernel.autoReweave", "off");
    await approve(proposal({ targetPaths: ["src-tauri/src/moods.rs"], isCore: true }));
    expect(reweave.startReweave).not.toHaveBeenCalled();
  });
});

describe("Shell — a refused auto-weave is spoken", () => {
  it("renders the reason as a notice instead of swallowing it", async () => {
    reweave.startReweave.mockResolvedValue({ ok: false, reason: "a weave is already under way" });
    await approve(proposal({ targetPaths: ["src-tauri/src/moods.rs"], isCore: true }));
    expect(screen.getByText("the weave did not start")).toBeInTheDocument();
    expect(screen.getByText("a weave is already under way")).toBeInTheDocument();
  });
});

/**
 * Round-3 review. The generations strand refreshed on a window event
 * (`loom-generations-changed`) that nothing in LOOM ever dispatched. A
 * packaged weave hid it — the relaunched body refetches at boot — but a dev
 * weave ends at `stage`, having shelved a real generation, and the Tapestry's
 * strand stayed stale until the app was restarted. The strand follows the
 * reweave feed now, which has an emitter.
 */
describe("Shell — the generations strand follows the reweave feed", () => {
  const listCalls = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return (invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => c[0] === "generations_list",
    ).length;
  };

  it("refetches the shelf when a weave finishes, and not when one fails", async () => {
    render(<Shell />);
    await act(async () => {});
    const atBoot = await listCalls();
    expect(atBoot).toBe(1);
    expect(reweave.feed.length).toBeGreaterThan(0);

    // A stage nobody shelved anything for changes nothing to refetch.
    await act(async () => {
      reweave.feed.forEach((f) => f({ stage: "core" }));
      reweave.feed.forEach((f) => f({ stage: "failed" }));
    });
    expect(await listCalls()).toBe(atBoot);

    // `done` put a body on the shelf: the strand asks again.
    await act(async () => {
      reweave.feed.forEach((f) => f({ stage: "done" }));
    });
    expect(await listCalls()).toBe(atBoot + 1);
  });
});
