/**
 * Tests for the pre-compile recovery guard (scripts/kernel-preboot.mjs).
 *
 * Runs under vitest (picked up by the default `**\/*.test.mjs` glob). Pure Node:
 * builds a real temp git repo, writes a mirror sentinel, and asserts the guard
 * resets HEAD to prevSha and marks the mirror `healed` — and that absent /
 * corrupt / confirmed mirrors are honest no-ops that never block the build.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runGuard } from "./kernel-preboot.mjs";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function head(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("kernel-preboot guard", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-preboot-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.name", "Test"]);
    git(dir, ["config", "user.email", "test@localhost"]);
    writeFileSync(join(dir, "core.rs"), "// v1\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "good"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMirror(status, prevSha, extra = {}) {
    writeFileSync(
      join(dir, ".loom-boot.json"),
      JSON.stringify(
        { prevSha, appliedSha: "deadbeef", status, source_root: dir, ...extra },
        null,
        2,
      ),
    );
  }

  it("ARMS (not resets) an `applied` edit on the first restart — Finding 3", () => {
    // round-1 review, Finding 3 (CRITICAL): a freshly-applied GOOD edit seen at
    // pre-compile must be ARMED (allowed to boot once), NOT rolled back.
    const prev = head(dir);
    writeFileSync(join(dir, "core.rs"), "// v2 (good edit)\n");
    git(dir, ["commit", "-aqm", "self: good edit"]);
    const applied = head(dir);
    expect(applied).not.toBe(prev);

    writeMirror("applied", prev, { appliedSha: applied });

    const res = runGuard(dir, () => {});
    expect(res.action).toBe("armed");
    // HEAD UNCHANGED — the good edit survives its first restart.
    expect(head(dir)).toBe(applied);
    expect(readFileSync(join(dir, "core.rs"), "utf8")).toContain("// v2");

    const mirror = JSON.parse(readFileSync(join(dir, ".loom-boot.json"), "utf8"));
    expect(mirror.status).toBe("booting");
    expect(mirror.armedBy).toBe("guard");
  });

  it("HEALS a `booting` edit that never confirmed — second restart", () => {
    // The armed edit panicked → it is STILL booting on the NEXT pre-compile →
    // reset to prevSha + healed.
    const prev = head(dir);
    writeFileSync(join(dir, "core.rs"), "// v2 (panics)\n");
    git(dir, ["commit", "-aqm", "self: bad edit"]);
    const applied = head(dir);
    expect(applied).not.toBe(prev);

    writeMirror("booting", prev, { appliedSha: applied, armedBy: "guard" });

    const res = runGuard(dir, () => {});
    expect(res.action).toBe("healed");
    expect(head(dir)).toBe(prev);
    expect(readFileSync(join(dir, "core.rs"), "utf8")).toContain("// v1");

    const mirror = JSON.parse(readFileSync(join(dir, ".loom-boot.json"), "utf8"));
    expect(mirror.status).toBe("healed");
  });

  it("full trace: applied → arm → still booting → heal (two restarts)", () => {
    // The end-to-end gap closure. Restart 1 arms the (bad) edit; the binary
    // panics so it never confirms; restart 2 heals.
    const prev = head(dir);
    writeFileSync(join(dir, "core.rs"), "// v2 (panics)\n");
    git(dir, ["commit", "-aqm", "self: bad edit"]);
    const applied = head(dir);
    writeMirror("applied", prev, { appliedSha: applied });

    // Restart 1: arm — HEAD stays at applied.
    const r1 = runGuard(dir, () => {});
    expect(r1.action).toBe("armed");
    expect(head(dir)).toBe(applied);
    let m = JSON.parse(readFileSync(join(dir, ".loom-boot.json"), "utf8"));
    expect(m.status).toBe("booting");

    // Restart 2: still booting (never confirmed) → heal.
    const r2 = runGuard(dir, () => {});
    expect(r2.action).toBe("healed");
    expect(head(dir)).toBe(prev);
    m = JSON.parse(readFileSync(join(dir, ".loom-boot.json"), "utf8"));
    expect(m.status).toBe("healed");
  });

  it("no-ops when the mirror's sourceRoot != cwd — Finding 7", () => {
    // A mirror belonging to ANOTHER repo (source_root differs from cwd) must
    // NEVER trigger a reset here — don't roll back another checkout.
    const before = head(dir);
    writeMirror("booting", before, {
      appliedSha: "deadbeef",
      source_root: "/some/other/repo/root",
      armedBy: "guard",
    });
    const res = runGuard(dir, () => {});
    expect(res.action).toBe("noop");
    expect(res.reason).toBe("foreign-root");
    expect(head(dir)).toBe(before);
  });

  it("no-ops when the mirror is absent", () => {
    const before = head(dir);
    const res = runGuard(dir, () => {});
    expect(res.action).toBe("noop");
    expect(res.reason).toBe("absent");
    expect(head(dir)).toBe(before);
  });

  it("no-ops (never throws) on a corrupt mirror", () => {
    const before = head(dir);
    writeFileSync(join(dir, ".loom-boot.json"), "{ not json ]");
    const res = runGuard(dir, () => {});
    expect(res.action).toBe("noop");
    expect(res.reason).toBe("corrupt");
    expect(head(dir)).toBe(before);
  });

  it("no-ops on a confirmed (healed/ok) mirror", () => {
    const before = head(dir);
    writeMirror("healed", before);
    const res = runGuard(dir, () => {});
    expect(res.action).toBe("noop");
    expect(res.reason).toBe("confirmed");
    expect(head(dir)).toBe(before);
  });

  it("no-ops when unconfirmed but no prevSha to return to", () => {
    const before = head(dir);
    writeMirror("booting", "");
    const res = runGuard(dir, () => {});
    expect(res.action).toBe("noop");
    expect(res.reason).toBe("no-prev-sha");
    expect(head(dir)).toBe(before);
  });

  it("marks rollback-failed (does not loop/block) when the sha is gone", () => {
    writeMirror("booting", "0".repeat(40));
    const res = runGuard(dir, () => {});
    expect(res.action).toBe("rollback-failed");
    const mirror = JSON.parse(readFileSync(join(dir, ".loom-boot.json"), "utf8"));
    expect(mirror.status).toBe("rollback-failed");
    // A second run is now a no-op — no retry loop.
    const res2 = runGuard(dir, () => {});
    expect(res2.action).toBe("noop");
    expect(res2.reason).toBe("confirmed");
  });
});
