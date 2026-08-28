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

  it("resets HEAD to prevSha and marks healed for a pending edit", () => {
    const prev = head(dir);
    // Apply a "bad" edit as a second commit → HEAD moves.
    writeFileSync(join(dir, "core.rs"), "// v2 (panics)\n");
    git(dir, ["commit", "-aqm", "self: bad edit"]);
    const applied = head(dir);
    expect(applied).not.toBe(prev);

    // A booting (Rust-flow, second sighting unconfirmed) mirror → heal.
    writeMirror("booting", prev, { appliedSha: applied });

    const res = runGuard(dir, () => {});
    expect(res.action).toBe("healed");
    expect(head(dir)).toBe(prev);
    expect(readFileSync(join(dir, "core.rs"), "utf8")).toContain("// v1");

    const mirror = JSON.parse(readFileSync(join(dir, ".loom-boot.json"), "utf8"));
    expect(mirror.status).toBe("healed");
  });

  it("heals an `applied` status too (unconfirmed)", () => {
    const prev = head(dir);
    writeFileSync(join(dir, "core.rs"), "// v2\n");
    git(dir, ["commit", "-aqm", "self: bad"]);
    writeMirror("applied", prev);

    const res = runGuard(dir, () => {});
    expect(res.action).toBe("healed");
    expect(head(dir)).toBe(prev);
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
