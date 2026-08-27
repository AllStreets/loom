/**
 * recovery.test.ts — the boot beacon + recovery check (fifth wall, TS side).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runBootCheck,
  markBootOk,
  noteBootError,
  bootHadError,
  RECOVERY_EVENT,
} from "./recovery";

afterEach(() => vi.clearAllMocks());

describe("runBootCheck", () => {
  it("returns the sha and dispatches the recovery event when a rollback happened", async () => {
    const check = vi.fn(async () => ({ rolledBackTo: "deadbeef12345" }));
    const events: string[] = [];
    const listener = (e: Event) =>
      events.push((e as CustomEvent<{ sha: string }>).detail.sha);
    window.addEventListener(RECOVERY_EVENT, listener);

    const sha = await runBootCheck(check);

    expect(sha).toBe("deadbeef12345");
    expect(events).toEqual(["deadbeef12345"]);
    window.removeEventListener(RECOVERY_EVENT, listener);
  });

  it("returns null and dispatches nothing when nothing rolled back", async () => {
    const check = vi.fn(async () => ({ rolledBackTo: null }));
    const listener = vi.fn();
    window.addEventListener(RECOVERY_EVENT, listener);

    const sha = await runBootCheck(check);

    expect(sha).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(RECOVERY_EVENT, listener);
  });

  it("swallows errors (no shell / no source repo) and returns null", async () => {
    const check = vi.fn(async () => {
      throw new Error("this surface needs the desktop shell");
    });
    await expect(runBootCheck(check)).resolves.toBeNull();
  });
});

describe("markBootOk", () => {
  it("calls the boot-ok beacon on a clean boot", async () => {
    const ok = vi.fn(async () => {});
    // Explicit hadError=false → a clean boot confirms.
    const confirmed = await markBootOk(ok, () => false);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(confirmed).toBe(true);
  });

  it("swallows errors so recovery never becomes a boot hazard", async () => {
    const ok = vi.fn(async () => {
      throw new Error("no sentinel");
    });
    await expect(markBootOk(ok, () => false)).resolves.toBe(false);
  });

  it("does NOT confirm when an ErrorBoundary caught during boot (sentinel stays pending)", async () => {
    // Finding 2: a boundaried crash is still a broken boot. The beacon must be
    // suppressed so the NEXT boot rolls back.
    const ok = vi.fn(async () => {});
    const confirmed = await markBootOk(ok, () => true);
    expect(ok).not.toHaveBeenCalled();
    expect(confirmed).toBe(false);
  });
});

describe("boot-health flag (Finding 2)", () => {
  it("noteBootError flips bootHadError, and markBootOk reads it to veto confirmation", async () => {
    // Uses the real module flag: before any note it is false; after a note the
    // default markBootOk path suppresses the beacon.
    // (No reset API by design — the flag is a one-way boot-window veto.)
    const okBefore = vi.fn(async () => {});
    // Drive the real default reader path when nothing has errored yet.
    if (!bootHadError()) {
      const confirmed = await markBootOk(okBefore);
      expect(okBefore).toHaveBeenCalledTimes(1);
      expect(confirmed).toBe(true);
    }

    noteBootError();
    expect(bootHadError()).toBe(true);

    const okAfter = vi.fn(async () => {});
    const confirmed = await markBootOk(okAfter);
    expect(okAfter).not.toHaveBeenCalled();
    expect(confirmed).toBe(false);
  });
});
