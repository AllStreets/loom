/**
 * Shell.bootbeacon.test.tsx — the boot beacon must fire under StrictMode.
 *
 * Round-4 finding 1 (CRITICAL, and the inverse of a wall): `main.tsx` wraps the
 * app in `<React.StrictMode>`, which in development double-invokes effects —
 * mount, cleanup, mount. The confirm effect guarded itself with a ref that meant
 * "we have SCHEDULED the beacon once": the first mount set the ref and scheduled
 * rAF → rAF → setTimeout(400) → markBootOk, the cleanup cancelled it, and the
 * second mount early-returned on the ref. markBootOk never ran. It is the only
 * caller of `kernel_boot_ok` in the product, so `kernel_apply`'s pending
 * sentinel was never confirmed and the NEXT `tauri dev` start hard-reset the
 * source tree to the pre-edit sha — throwing away a self-edit that WORKED, and
 * telling the owner "an edit didn't hold".
 *
 * The guard now means "the beacon has actually FIRED". Every mount schedules
 * freshly; every cleanup cancels cleanly; the confirmation happens exactly once.
 */

import { render, act } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";

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
    if (cmd === "organ_list") return [];
    if (cmd === "fleet_status") return [];
    return [];
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const recovery = vi.hoisted(() => ({
  markBootOk: vi.fn(async () => true),
  runBootCheck: vi.fn(async () => null),
}));
vi.mock("../lib/loom/recovery", async (importActual) => ({
  ...(await importActual<typeof import("../lib/loom/recovery")>()),
  markBootOk: recovery.markBootOk,
  runBootCheck: recovery.runBootCheck,
}));

import Shell from "./Shell";

/** Two animation frames plus the 400ms settle timer, in real time. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 500));
  });
}

beforeEach(() => {
  recovery.markBootOk.mockClear();
  recovery.runBootCheck.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("the boot beacon (fifth wall)", () => {
  it("fires exactly once under <StrictMode> double-invoked effects", async () => {
    render(
      <StrictMode>
        <Shell />
      </StrictMode>,
    );
    await settle();
    // Before the fix this was 0 — every good self-edit was rolled back on the
    // next dev start.
    expect(recovery.markBootOk).toHaveBeenCalledTimes(1);
    // The early check is fire-and-forget and dispatches the recovery notice —
    // it must not be dispatched twice by the double mount either.
    expect(recovery.runBootCheck).toHaveBeenCalledTimes(1);
  });

  it("fires exactly once outside StrictMode (a single mount still confirms once)", async () => {
    render(<Shell />);
    await settle();
    expect(recovery.markBootOk).toHaveBeenCalledTimes(1);
    expect(recovery.runBootCheck).toHaveBeenCalledTimes(1);
  });

  it("does not fire after the shell unmounts before the settle timer", async () => {
    const { unmount } = render(
      <StrictMode>
        <Shell />
      </StrictMode>,
    );
    unmount();
    await settle();
    expect(recovery.markBootOk).not.toHaveBeenCalled();
  });
});
