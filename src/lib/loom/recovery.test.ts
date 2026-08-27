/**
 * recovery.test.ts — the boot beacon + recovery check (fifth wall, TS side).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runBootCheck, markBootOk, RECOVERY_EVENT } from "./recovery";

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
  it("calls the boot-ok beacon", async () => {
    const ok = vi.fn(async () => {});
    await markBootOk(ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("swallows errors so recovery never becomes a boot hazard", async () => {
    const ok = vi.fn(async () => {
      throw new Error("no sentinel");
    });
    await expect(markBootOk(ok)).resolves.toBeUndefined();
  });
});
