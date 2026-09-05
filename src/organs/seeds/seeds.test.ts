// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { manifestGuard } from "../../lib/loom/validate";
import { ShellUnavailableError } from "../../lib/core";
import { files as notesFiles } from "./notes";
import { files as timelineFiles } from "./timeline";
import { files as settingsFiles } from "./settings";
import { installSeeds } from "./install";
import { version as pkgVersion } from "../../../package.json";
import { buildUiKit } from "../../lib/organs/uikit";
import { KIT_TOKENS } from "../../lib/organs/uikitSrc";

beforeEach(() => { if (typeof localStorage !== "undefined") localStorage.clear(); });
afterEach(() => { if (typeof localStorage !== "undefined") localStorage.clear(); });

// ── helpers ───────────────────────────────────────────────────────────────────

function getFile(files: { name: string; content: string }[], name: string): string {
  const f = files.find((x) => x.name === name);
  if (!f) throw new Error(`file "${name}" not found`);
  return f.content;
}

function syntaxCheck(src: string): void {
  // Strip module-level export syntax the same way the selftest does, then
  // verify new Function() does not throw a SyntaxError.
  const stripped = src
    .replace(/^export\s+default\s+/m, "const __x = ")
    .replace(/^export\s+const\s+tests\s*=/m, "const tests =")
    .replace(/^\s*import\b[^\n]*\n?/gm, "");
  new Function(stripped);
}

// ── seed data snapshots ───────────────────────────────────────────────────────

const ALL_SEEDS = [
  { id: "notes", files: notesFiles },
  { id: "timeline", files: timelineFiles },
  { id: "settings", files: settingsFiles },
];

// ── installSeeds unit tests ───────────────────────────────────────────────────

describe("installSeeds", () => {
  let list: ReturnType<typeof vi.fn>;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    list = vi.fn();
    write = vi.fn().mockResolvedValue("sha");
  });

  it("installs all seeds when none exist", async () => {
    list.mockResolvedValue([]);
    const installed = await installSeeds({ list, write });
    expect(write).toHaveBeenCalledTimes(3);
    expect(installed).toEqual(["notes", "timeline", "settings"]);
  });

  it("skips an existing organ and installs the missing ones", async () => {
    list.mockResolvedValue([
      { id: "notes", manifest: "{}", granted: null },
    ]);
    const installed = await installSeeds({ list, write });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(
      "timeline",
      timelineFiles,
      "loom: seed timeline",
    );
    expect(write).toHaveBeenCalledWith(
      "settings",
      settingsFiles,
      "loom: seed settings",
    );
    expect(installed).toEqual(["timeline", "settings"]);
  });

  it("never overwrites — write failure on one seed does not prevent the others", async () => {
    list.mockResolvedValue([]);
    write.mockImplementation(async (id: string) => {
      if (id === "notes") throw new Error("disk full");
      return "sha";
    });
    const installed = await installSeeds({ list, write });
    // notes failed; timeline and settings should still be installed
    expect(installed).toEqual(["timeline", "settings"]);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("returns empty array without throw when list() fails", async () => {
    list.mockRejectedValue(new Error("backend unavailable"));
    const installed = await installSeeds({ list, write });
    expect(installed).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

// ── installSeeds failure logging ──────────────────────────────────────────────

describe("installSeeds failure logging", () => {
  it("console.debug when write fails with ShellUnavailableError", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const write = vi.fn().mockRejectedValue(new ShellUnavailableError());
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await installSeeds({ list, write });
    expect(debugSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("console.warn when write fails with a non-ShellUnavailableError", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const write = vi.fn().mockRejectedValue(new Error("disk full"));
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await installSeeds({ list, write });
    expect(warnSpy).toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ── content validity ──────────────────────────────────────────────────────────

describe("seed content validity", () => {
  for (const seed of ALL_SEEDS) {
    describe(`seed: ${seed.id}`, () => {
      it("manifest passes manifestGuard", () => {
        const raw = getFile(seed.files, "manifest.json");
        const result = manifestGuard(raw, seed.id);
        expect(result.ok, result.ok ? "" : (result as { ok: false; error: string }).error).toBe(true);
      });

      it("organ.js passes syntax check", () => {
        const src = getFile(seed.files, "organ.js");
        expect(() => syntaxCheck(src)).not.toThrow();
      });

      it("test.js passes syntax check", () => {
        const src = getFile(seed.files, "test.js");
        expect(() => syntaxCheck(src)).not.toThrow();
      });

      it("test.js contains no import statements", () => {
        const src = getFile(seed.files, "test.js");
        expect(/^\s*import\b/m.test(src)).toBe(false);
      });
    });
  }

  it("notes manifest permissions are exactly [\"storage\"]", () => {
    const raw = getFile(notesFiles, "manifest.json");
    const parsed = JSON.parse(raw);
    expect(parsed.permissions).toEqual(["storage"]);
  });

  it("timeline manifest permissions are exactly []", () => {
    const raw = getFile(timelineFiles, "manifest.json");
    const parsed = JSON.parse(raw);
    expect(parsed.permissions).toEqual([]);
  });

  it("settings manifest permissions are exactly [\"settings\"]", () => {
    const raw = getFile(settingsFiles, "manifest.json");
    const parsed = JSON.parse(raw);
    expect(parsed.permissions).toEqual(["settings"]);
  });

  it("settings manifest declares exactly the self power", () => {
    const raw = getFile(settingsFiles, "manifest.json");
    const parsed = JSON.parse(raw);
    expect(parsed.powers).toEqual(["self"]);
  });

  it("install includes settings seed", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const write = vi.fn().mockResolvedValue("sha");
    const installed = await installSeeds({ list, write });
    expect(installed).toContain("settings");
    expect(write).toHaveBeenCalledWith("settings", settingsFiles, "loom: seed settings");
  });

  it("settings organ carries the ABOUT strip with the package version", () => {
    const organJs = getFile(settingsFiles, "organ.js");
    expect(organJs).toContain("settings-about");
    expect(organJs).toContain("a computer that weaves itself");
    // Version is interpolated from package.json at seed-build time
    expect(organJs).toContain(`v${pkgVersion}`);
  });
});

// ── tombstone tests ───────────────────────────────────────────────────────────

describe("installSeeds tombstones", () => {
  it("skips seed ids in loom.organs.deleted tombstone list", async () => {
    // Put notes in the tombstone list
    localStorage.setItem("loom.organs.deleted", JSON.stringify(["notes"]));

    const list = vi.fn(async () => []);
    const write = vi.fn(async () => "sha");

    const installed = await installSeeds({ list, write });

    // notes must NOT be installed
    expect(write).not.toHaveBeenCalledWith("notes", expect.anything(), expect.anything());
    // notes must not appear in returned list
    expect(installed).not.toContain("notes");
  });

  it("installs seeds not in tombstone list", async () => {
    // Only notes is tombstoned
    localStorage.setItem("loom.organs.deleted", JSON.stringify(["notes"]));

    const list = vi.fn(async () => []);
    const write = vi.fn(async () => "sha");

    const installed = await installSeeds({ list, write });

    // timeline and settings should be installed (not tombstoned)
    expect(write).toHaveBeenCalledWith("timeline", expect.anything(), expect.anything());
    expect(write).toHaveBeenCalledWith("settings", expect.anything(), expect.anything());
    expect(installed).toContain("timeline");
    expect(installed).toContain("settings");
  });

  it("skips seeds already in the organ list (existing behavior)", async () => {
    const list = vi.fn(async () => [
      { id: "notes", manifest: "{}", granted: null },
    ]);
    const write = vi.fn(async () => "sha");

    await installSeeds({ list, write });

    expect(write).not.toHaveBeenCalledWith("notes", expect.anything(), expect.anything());
  });
});

// ── Settings → LOOM (Rebirth) — the seed rendered under jsdom ─────────────────

type TEvent = { step: string; detail: string; tail: string[] };
type SelfMock = {
  identity: () => Promise<Record<string, unknown>>;
  threads: () => Promise<Record<string, unknown>>;
  generations: () => Promise<Record<string, unknown>[]>;
  thread: (onEvent?: (e: TEvent) => void) => Promise<void>;
  reweave: () => Promise<{ ok: boolean; reason?: string }>;
  returnTo: (sha: string) => Promise<void>;
  setAutoReweave: (on: boolean) => Promise<void>;
};

const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_B = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";

const TOOL = (name: string, over: Partial<{ path: string | null; version: string | null; install: string }> = {}) => ({
  name,
  path: "/opt/homebrew/bin/" + name,
  version: name + " 1.0.0",
  requiredFor: "everything",
  install: "brew install " + name,
  ...over,
});

/**
 * The steady state (round-3 review, Finding 1): the body's baked sha, the
 * ledger's current, and the genome's HEAD all agree — threading makes them
 * agree and every successful weave re-establishes it. Nothing to weave.
 * Overriding `generation` alone still reads as "ahead" because HEAD stays at
 * SHA_A; overriding `genomeHead` is how a self-edit is spelled.
 */
function threadedDev(over: Record<string, unknown> = {}) {
  return { mode: "dev", genomeSha: SHA_A, genomeHead: SHA_A, generation: SHA_A, threaded: true, loomhome: "/home/loom", loomhomeBytes: 2_300_000_000, canSwap: false, ...over };
}

/** Packaged on macOS: the one body that actually closes and returns. */
function swappable(over: Record<string, unknown> = {}) {
  return threadedDev({ mode: "packaged", canSwap: true, ...over });
}

function selfMock(over: Partial<SelfMock> = {}): SelfMock {
  return {
    identity: async () => threadedDev(),
    threads: async () => ({
      threaded: true,
      tools: [TOOL("git"), TOOL("cargo"), TOOL("cmake", { path: null, version: null })],
      missing: ["cmake"],
      drifted: [],
      steps: { seed: true, deps: true, vendor: true, warm: true, register: true },
      needsNetwork: false,
    }),
    generations: async () => [],
    thread: async () => {},
    reweave: async () => ({ ok: true }),
    returnTo: async () => {},
    setAutoReweave: async () => {},
    ...over,
  };
}

function loadOrgan(src: string): { render(el: HTMLElement, loom: unknown): Promise<void> } {
  const stripped = src
    .replace(/^export\s+default\s+/m, "const __x = ")
    .replace(/^\s*import\b[^\n]*\n?/gm, "");
  return new Function(stripped + "\nreturn __x;")();
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function renderSettings(self: SelfMock, opts: { autoKnown?: boolean } = {}) {
  const organ = loadOrgan(getFile(settingsFiles, "organ.js"));
  const store = new Map<string, string>();
  const settings = {
    get(k: string) {
      // Until the store learns the key, the real api throws — the seed must read that as "off".
      if (k === "kernel.autoReweave" && !opts.autoKnown) throw new Error(`Unknown settings key: "${k}"`);
      return store.has(k) ? store.get(k)! : "";
    },
    set(k: string, v: string) { store.set(k, v); },
    voices: async () => [],
    audition: async () => {},
    micTest: async () => "ok",
    voiceStatus: async () => ({ ready: false, whisper: false, voices: [], missing_bytes_hint: null }),
    setup: async () => {},
    models: async () => [],
    setModel: async () => ({ ok: true }),
    resetAll: async () => {},
  };
  const loom = { ui: buildUiKit(KIT_TOKENS), settings, self };
  const el = document.createElement("div");
  document.body.appendChild(el);
  await organ.render(el, loom);
  await tick();
  return { el, store };
}

function toRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("settings seed — LOOM page", () => {
  it("LOOM is first in the nav and is the page shown at open", async () => {
    const { el } = await renderSettings(selfMock());
    const navBtns = el.querySelectorAll('[data-action^="page-"]');
    expect(navBtns[0].getAttribute("data-action")).toBe("page-loom");
    expect(navBtns[0].textContent).toBe("LOOM");
    const page = el.querySelector('[data-testid="loom-page"]') as HTMLElement;
    expect(page).not.toBeNull();
    expect(page.style.display).not.toBe("none");
  });

  it("the identity block shows mode, generation sha7, genome sha7", async () => {
    const { el } = await renderSettings(selfMock({ identity: async () => threadedDev({ mode: "packaged", generation: SHA_B }) }));
    const id = el.querySelector('[data-testid="loom-identity"]') as HTMLElement;
    expect(id.textContent).toContain("packaged");
    expect(id.textContent).toContain(SHA_B.slice(0, 7));
    expect(id.textContent).toContain(SHA_A.slice(0, 7));
    expect(id.textContent).not.toContain(SHA_A.slice(0, 12));
  });

  it("the tool table lists name · version · path, and a missing tool shows its install line in --warn", async () => {
    const { el } = await renderSettings(selfMock());
    const git = el.querySelector('[data-testid="loom-tool-git"]') as HTMLElement;
    expect(git.textContent).toContain("git");
    expect(git.textContent).toContain("git 1.0.0");
    expect(git.textContent).toContain("/opt/homebrew/bin/git");
    const cmake = el.querySelector('[data-testid="loom-tool-cmake"]') as HTMLElement;
    expect(cmake.textContent).toContain("brew install cmake");
    const installEl = cmake.querySelector('[data-testid="loom-tool-install"]') as HTMLElement;
    expect(installEl).not.toBeNull();
    expect(installEl.style.color).toBe(toRgb(KIT_TOKENS.warn));
    expect(cmake.textContent).not.toContain("/opt/homebrew/bin/cmake");
  });

  it("THREAD THE LOOM is hidden when threaded", async () => {
    const { el } = await renderSettings(selfMock());
    expect(el.querySelector('[data-action="self-thread"]')).toBeNull();
  });

  it("THREAD THE LOOM streams loom-thread lines inline when unthreaded", async () => {
    let emit: ((e: TEvent) => void) | undefined;
    let resolveThread: (() => void) | undefined;
    const thread = vi.fn((onEvent?: (e: TEvent) => void) => { emit = onEvent; return new Promise<void>((r) => { resolveThread = r; }); });
    const { el } = await renderSettings(selfMock({
      identity: async () => threadedDev({ threaded: false, generation: null }),
      threads: async () => ({ threaded: false, tools: [TOOL("git")], missing: [], drifted: [], steps: { seed: false, deps: false, vendor: false, warm: false, register: false }, needsNetwork: true }),
      thread,
    }));
    const btn = el.querySelector('[data-action="self-thread"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("THREAD THE LOOM");
    // The honest line about the network sits beside the action.
    expect(el.querySelector('[data-testid="loom-page"]')!.textContent).toContain("threading needs the network once");
    btn.click();
    await tick();
    expect(thread).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    emit!({ step: "seed", detail: "cloning the genome", tail: [] });
    emit!({ step: "warm", detail: "cargo build --release --offline", tail: ["Compiling tauri v2.0.0", "Compiling loom v0.1.0"] });
    const log = el.querySelector('[data-testid="loom-thread-log"]') as HTMLElement;
    expect(log.textContent).toContain("SEED");
    expect(log.textContent).toContain("cloning the genome");
    expect(log.textContent).toContain("Compiling loom v0.1.0");
    emit!({ step: "done", detail: "the loom is threaded", tail: [] });
    resolveThread!();
    await tick();
    expect(log.textContent).toContain("the loom is threaded");
  });

  it("a failed ceremony is stated in the log and the action returns", async () => {
    const thread = vi.fn(async () => { throw new Error("threading needs the network once — after that LOOM weaves offline."); });
    const { el } = await renderSettings(selfMock({ identity: async () => threadedDev({ threaded: false, generation: null }), thread }));
    const btn = el.querySelector('[data-action="self-thread"]') as HTMLButtonElement;
    btn.click();
    await tick();
    const log = el.querySelector('[data-testid="loom-thread-log"]') as HTMLElement;
    expect(log.textContent).toContain("needs the network once");
    expect(btn.disabled).toBe(false);
  });

  it("REWEAVE is hidden when the body already matches the genome", async () => {
    const { el } = await renderSettings(selfMock());
    expect(el.querySelector('[data-action="self-reweave"]')).toBeNull();
    expect(el.querySelector('[data-testid="loom-page"]')!.textContent).toContain("the body matches the genome");
  });

  /**
   * Round-3 review, Finding 1, at the surface that hid the button.
   *
   * A packaged LOOM lives with `generation === genomeSha` forever — threading
   * sets the ledger's current to the baked sha, and every weave re-establishes
   * it. Settings compared exactly those two, so once the first weave landed
   * the REWEAVE button never came back. What a self-edit moves is the genome's
   * HEAD, and nothing else.
   */
  it("REWEAVE appears after a self-edit moves HEAD, though the ledger still matches the running body", async () => {
    const { el } = await renderSettings(
      selfMock({
        identity: async () =>
          threadedDev({ mode: "packaged", genomeSha: SHA_A, generation: SHA_A, genomeHead: SHA_B }),
      }),
    );
    expect(el.querySelector('[data-action="self-reweave"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="loom-page"]')!.textContent).not.toContain(
      "the body matches the genome",
    );
  });

  it("REWEAVE stays hidden when HEAD is the running body, whatever the ledger says", async () => {
    const { el } = await renderSettings(
      selfMock({
        identity: async () =>
          threadedDev({ mode: "packaged", genomeSha: SHA_A, generation: SHA_B, genomeHead: SHA_A }),
      }),
    );
    expect(el.querySelector('[data-action="self-reweave"]')).toBeNull();
  });

  /**
   * Round-4 review, Finding 1, at the surface that hid the button.
   *
   * The swap writes the ledger before the new body has ever booted, so a swap
   * that died at its last step leaves `generation` naming the new sha while
   * the OLD body still runs. Settings compared HEAD with the ledger and hid
   * REWEAVE, the note said the body matched the genome, and the RETURN the
   * failure message pointed at is refused by the core for the same reason.
   * The comparison is against the running body — `genomeSha` — as the core's
   * own `check_start` does it.
   */
  it("REWEAVE appears when the ledger led the body and the swap died", async () => {
    const { el } = await renderSettings(
      selfMock({
        identity: async () =>
          threadedDev({ mode: "packaged", genomeSha: SHA_A, generation: SHA_B, genomeHead: SHA_B }),
      }),
    );
    expect(el.querySelector('[data-action="self-reweave"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="loom-page"]')!.textContent).not.toContain(
      "the body matches the genome",
    );
  });

  it("the identity block names the body, the ledger and the genome's head apart", async () => {
    const { el } = await renderSettings(
      selfMock({
        identity: async () =>
          threadedDev({ mode: "packaged", genomeSha: SHA_A, generation: SHA_A, genomeHead: SHA_B }),
      }),
    );
    const id = el.querySelector('[data-testid="loom-identity"]')!;
    expect(id.textContent).toContain("body");
    expect(id.textContent).toContain("generation");
    expect(id.textContent).toContain("genome head");
    expect(id.textContent).toContain(SHA_B.slice(0, 7));
  });

  /**
   * Round-4 review, findings 3 and 4, at the shelf.
   *
   * The warden's heal writes `{ current: prev, previous: <the failed sha> }`,
   * so after a heal the ledger's PREVIOUS is the body that would not boot.
   * Badging it as the way home invites the owner to go back to it.
   */
  it("a generation that failed to be born is badged as such, and is not the PREVIOUS one", async () => {
    const { el } = await renderSettings(
      selfMock({
        identity: async () => threadedDev({ mode: "packaged", generation: SHA_A, genomeSha: SHA_A }),
        generations: async () => [
          { sha: SHA_B, wovenAt: new Date().toISOString(), sizeBytes: 42, reason: "reweave", commitSubject: "b", isCurrent: false, isPrevious: true, failedToBoot: true, failedReason: "crashed" },
          { sha: SHA_A, wovenAt: new Date().toISOString(), sizeBytes: 41, reason: "reweave", commitSubject: "a", isCurrent: true, isPrevious: false, failedToBoot: false, failedReason: null },
        ],
      }),
    );
    await tick();
    const failed = el.querySelector('[data-testid="loom-generation-' + SHA_B.slice(0, 7) + '"]') as HTMLElement;
    expect(failed.textContent).toContain("DIDN'T BOOT");
    expect(failed.textContent).not.toContain("PREVIOUS");
    // It stays on the shelf with its RETURN: a deliberate, named choice is
    // still the owner's to make — what is withdrawn is the invitation.
    expect(failed.querySelector('[data-action^="self-return-"]')).not.toBeNull();
  });

  /** And the note above REWEAVE says so before the owner presses it. */
  it("the reweave note says when the head is the weave that did not hold", async () => {
    const { el } = await renderSettings(
      selfMock({
        identity: async () =>
          threadedDev({ mode: "packaged", genomeSha: SHA_A, generation: SHA_A, genomeHead: SHA_B }),
        generations: async () => [
          { sha: SHA_B, wovenAt: new Date().toISOString(), sizeBytes: 42, reason: "reweave", commitSubject: "b", isCurrent: false, isPrevious: true, failedToBoot: true, failedReason: "crashed" },
          { sha: SHA_A, wovenAt: new Date().toISOString(), sizeBytes: 41, reason: "reweave", commitSubject: "a", isCurrent: true, isPrevious: false, failedToBoot: false, failedReason: null },
        ],
      }),
    );
    await tick();
    expect(el.querySelector('[data-action="self-reweave"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="loom-reweave-note"]')!.textContent).toContain(
      "didn't boot last time",
    );
  });

  /**
   * Round-3 review, Finding 4. Threading shelves generation 0 under the sha
   * the binary baked — which is the literal string "unknown" for a body built
   * outside the genome. `generations_return` refuses that name before it can
   * become a path component, so the row can be listed but its RETURN can only
   * ever fail.
   */
  it("a generation that is not named by a sha is listed without a RETURN", async () => {
    const { el } = await renderSettings(
      selfMock({
        identity: async () => threadedDev({ mode: "packaged", generation: SHA_A }),
        generations: async () => [
          { sha: SHA_A, wovenAt: new Date().toISOString(), sizeBytes: 42, reason: "reweave", commitSubject: "b", isCurrent: true, isPrevious: false },
          { sha: "unknown", wovenAt: new Date().toISOString(), sizeBytes: 41, reason: "threading", commitSubject: "a", isCurrent: false, isPrevious: true },
        ],
      }),
    );
    await tick();
    const row = el.querySelector('[data-testid="loom-generation-unknown"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-action^="self-return-"]')).toBeNull();
    expect(row.textContent).toContain("no way back");
  });

  it("REWEAVE appears when threaded and the genome is ahead; pressing it ASKS, it does not weave", async () => {
    // Round-1 finding 1: Settings is an organ, so its REWEAVE only ever asks —
    // `self.reweave()` dispatches a body request and the SHELL's consent card
    // carries the sentence. The organ no longer holds a second confirm strip
    // that would ask the same question twice in the same words.
    const reweave = vi.fn(async () => ({ ok: true }));
    const { el } = await renderSettings(selfMock({ identity: async () => threadedDev({ mode: "packaged", genomeHead: SHA_B }), reweave }));
    const btn = el.querySelector('[data-action="self-reweave"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("REWEAVE");
    expect(el.querySelector('[data-testid="loom-reweave-confirm"]')).toBeNull();
    btn.click();
    await tick();
    expect(reweave).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid="loom-reweave-note"]')!.textContent).toContain(
      "the weave has started",
    );
  });

  it("a refused reweave states the reason inline", async () => {
    const reweave = vi.fn(async () => ({ ok: false, reason: "a weave is already under way" }));
    const { el } = await renderSettings(selfMock({ identity: async () => threadedDev({ mode: "packaged", genomeHead: SHA_B }), reweave }));
    (el.querySelector('[data-action="self-reweave"]') as HTMLButtonElement).click();
    await tick();
    expect(el.querySelector('[data-testid="loom-reweave-note"]')!.textContent).toContain("a weave is already under way");
  });

  it("a declined reweave states the owner's own answer, not a failure", async () => {
    const reweave = vi.fn(async () => { throw new Error("you said not now — the body stays as it is"); });
    const { el } = await renderSettings(selfMock({ identity: async () => threadedDev({ mode: "packaged", genomeHead: SHA_B }), reweave }));
    (el.querySelector('[data-action="self-reweave"]') as HTMLButtonElement).click();
    await tick();
    const note = el.querySelector('[data-testid="loom-reweave-note"]') as HTMLElement;
    expect(note.textContent).toContain("you said not now");
    // Round-2 finding 7: the owner's own choice is not a fault, so it is not
    // painted in the warn token.
    expect(note.style.color).toBe(toRgb(KIT_TOKENS.t2));
  });

  it("generations list rows with the current marked and RETURN on the others; RETURN only asks", async () => {
    const returnTo = vi.fn(async () => {});
    const { el } = await renderSettings(selfMock({
      identity: async () => swappable({ generation: SHA_A }),
      generations: async () => [
        { sha: SHA_A, wovenAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), sizeBytes: 42, reason: "reweave", commitSubject: "feat: second weave", isCurrent: true, isPrevious: false },
        { sha: SHA_B, wovenAt: new Date(Date.now() - 26 * 3_600_000).toISOString(), sizeBytes: 41, reason: "threading", commitSubject: "feat: first weave", isCurrent: false, isPrevious: true },
      ],
      returnTo,
    }));
    const rowA = el.querySelector('[data-testid="loom-generation-' + SHA_A.slice(0, 7) + '"]') as HTMLElement;
    const rowB = el.querySelector('[data-testid="loom-generation-' + SHA_B.slice(0, 7) + '"]') as HTMLElement;
    expect(rowA.textContent).toContain("CURRENT");
    expect(rowA.textContent).toContain("2h ago");
    expect(rowA.textContent).toContain("feat: second weave");
    expect(rowA.querySelector('[data-action^="self-return-"]')).toBeNull();
    expect(rowB.textContent).toContain("PREVIOUS");
    expect(rowB.textContent).toContain("1d ago");
    const ret = rowB.querySelector('[data-action="self-return-' + SHA_B.slice(0, 7) + '"]') as HTMLButtonElement;
    expect(ret.textContent).toBe("RETURN");
    expect(rowB.querySelector('[data-testid="loom-return-confirm"]')).toBeNull();
    ret.click();
    await tick();
    expect(returnTo).toHaveBeenCalledWith(SHA_B);
    expect(rowB.querySelector('[data-testid="loom-return-note-' + SHA_B.slice(0, 7) + '"]')!.textContent)
      .toContain("returning to " + SHA_B.slice(0, 7));
  });

  it("a declined return leaves the row as it was and says why", async () => {
    const returnTo = vi.fn(async () => { throw new Error("you said not now — the body stays as it is"); });
    const { el } = await renderSettings(selfMock({
      identity: async () => threadedDev({ mode: "packaged", generation: SHA_A }),
      generations: async () => [
        { sha: SHA_A, wovenAt: new Date().toISOString(), sizeBytes: 42, reason: "reweave", commitSubject: "b", isCurrent: true, isPrevious: false },
        { sha: SHA_B, wovenAt: new Date().toISOString(), sizeBytes: 41, reason: "threading", commitSubject: "a", isCurrent: false, isPrevious: true },
      ],
      returnTo,
    }));
    const rowB = el.querySelector('[data-testid="loom-generation-' + SHA_B.slice(0, 7) + '"]') as HTMLElement;
    (rowB.querySelector('[data-action="self-return-' + SHA_B.slice(0, 7) + '"]') as HTMLButtonElement).click();
    await tick();
    const note = rowB.querySelector('[data-testid="loom-return-note-' + SHA_B.slice(0, 7) + '"]') as HTMLElement;
    expect(note.textContent).toContain("you said not now");
    expect(note.style.color).toBe(toRgb(KIT_TOKENS.t2));
  });

  /**
   * Round-2 finding 7: the row said "the reweave card carries the rail" on a
   * body that had just been told it would not move.
   */
  it("a return on a body that cannot swap says the genome moved and the body stayed", async () => {
    const { el } = await renderSettings(selfMock({
      identity: async () => threadedDev({ generation: SHA_A }),
      generations: async () => [
        { sha: SHA_A, wovenAt: new Date().toISOString(), sizeBytes: 42, reason: "reweave", commitSubject: "b", isCurrent: true, isPrevious: false },
        { sha: SHA_B, wovenAt: new Date().toISOString(), sizeBytes: 41, reason: "threading", commitSubject: "a", isCurrent: false, isPrevious: true },
      ],
    }));
    const rowB = el.querySelector('[data-testid="loom-generation-' + SHA_B.slice(0, 7) + '"]') as HTMLElement;
    (rowB.querySelector('[data-action="self-return-' + SHA_B.slice(0, 7) + '"]') as HTMLButtonElement).click();
    await tick();
    expect(rowB.querySelector('[data-testid="loom-return-note-' + SHA_B.slice(0, 7) + '"]')!.textContent)
      .toBe("returned to " + SHA_B.slice(0, 7) + " — the genome moved; the body stays.");
  });

  it("an empty ledger says so plainly", async () => {
    const { el } = await renderSettings(selfMock());
    expect(el.querySelector('[data-testid="loom-generations"]')!.textContent).toContain("no generations yet");
  });

  it("the autoReweave toggle carries the exact copy on a body that can swap, and arms through the self power", async () => {
    const setAutoReweave = vi.fn(async () => {});
    const { el, store } = await renderSettings(selfMock({ identity: async () => swappable(), setAutoReweave }));
    const toggle = el.querySelector('[data-action="self-autoreweave"]') as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toContain("reweave automatically after an approved core edit — LOOM will close and return each time");
    toggle.click();
    await tick();
    expect(setAutoReweave).toHaveBeenLastCalledWith(true);
    toggle.click();
    await tick();
    expect(setAutoReweave).toHaveBeenLastCalledWith(false);
    // The key is the body's, not a plain setting — the seed never writes it there.
    expect(store.has("kernel.autoReweave")).toBe(false);
  });

  /**
   * Round-2 finding 5: the toggle promised "LOOM will close and return each
   * time" on every body. In dev nothing happens at all, and a packaged build
   * off macOS builds without swapping. The consent lines read `canSwap` from
   * the core; so does this label now.
   */
  it("in dev the toggle does not promise a close and return", async () => {
    const { el } = await renderSettings(selfMock());
    const toggle = el.querySelector('[data-action="self-autoreweave"]') as HTMLElement;
    expect(toggle.textContent).toContain(
      "reweave automatically after an approved core edit — in dev the body stays; restart tauri dev to become it",
    );
  });

  it("off macOS the toggle says the swap is not there", async () => {
    const { el } = await renderSettings(selfMock({ identity: async () => threadedDev({ mode: "packaged", canSwap: false }) }));
    const toggle = el.querySelector('[data-action="self-autoreweave"]') as HTMLElement;
    expect(toggle.textContent).toContain(
      "reweave automatically after an approved core edit — the swap is macOS-only in this generation; the build and the ledger still work, the body stays",
    );
  });

  it("a preference the body refuses is stated, not swallowed", async () => {
    const setAutoReweave = vi.fn(async () => { throw new Error('permission "self" not granted'); });
    const { el } = await renderSettings(selfMock({ identity: async () => swappable(), setAutoReweave }));
    (el.querySelector('[data-action="self-autoreweave"]') as HTMLElement).click();
    await tick();
    expect(el.querySelector('[data-testid="loom-autoreweave-note"]')!.textContent)
      .toContain("the self power isn't granted");
  });

  it("the autoReweave toggle reflects a stored on", async () => {
    const organ = loadOrgan(getFile(settingsFiles, "organ.js"));
    const settings = {
      get: (k: string) => (k === "kernel.autoReweave" ? "on" : ""),
      set: () => {},
      voices: async () => [], audition: async () => {}, micTest: async () => "ok",
      voiceStatus: async () => ({ ready: false, whisper: false, voices: [], missing_bytes_hint: null }),
      setup: async () => {}, models: async () => [], setModel: async () => ({ ok: true }), resetAll: async () => {},
    };
    const el = document.createElement("div");
    await organ.render(el, { ui: buildUiKit(KIT_TOKENS), settings, self: selfMock() });
    await tick();
    const toggle = el.querySelector('[data-action="self-autoreweave"]') as HTMLElement;
    const track = toggle.firstElementChild as HTMLElement;
    expect(track.style.background).toBe(toRgb(KIT_TOKENS.accent));
  });

  it("the storage line is honest about loomhome's size", async () => {
    const { el } = await renderSettings(selfMock());
    expect(el.querySelector('[data-testid="loom-storage"]')!.textContent).toBe("loomhome uses 2.3 GB (vendor + warm build)");
  });

  it("without the self power the page says so and offers the remedy", async () => {
    const organ = loadOrgan(getFile(settingsFiles, "organ.js"));
    const settings = {
      get: () => "", set: () => {},
      voices: async () => [], audition: async () => {}, micTest: async () => "ok",
      voiceStatus: async () => ({ ready: false, whisper: false, voices: [], missing_bytes_hint: null }),
      setup: async () => {}, models: async () => [], setModel: async () => ({ ok: true }), resetAll: async () => {},
    };
    const denied = () => Promise.reject(new Error('permission "self" not granted'));
    const el = document.createElement("div");
    await organ.render(el, { ui: buildUiKit(KIT_TOKENS), settings, self: { identity: denied, threads: denied, generations: denied, thread: denied, reweave: denied, returnTo: denied } });
    await tick();
    const page = el.querySelector('[data-testid="loom-page"]')!;
    expect(page.textContent).toContain("the self power isn't granted — approve it in the organ's POWERS row");
  });

  it("the LOOM page copy has no exclamation marks", () => {
    const organJs = getFile(settingsFiles, "organ.js");
    const a = organJs.indexOf("PAGE: LOOM");
    const b = organJs.indexOf("PAGE: Voice");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    // Comments first: an apostrophe in prose ("the ceremony's archive") reads as
    // a string delimiter to the scanner below and swallows the code after it,
    // operators and all. Strip them, then scan what is actually copy.
    const loomPage = organJs
      .slice(a, b)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    // Any "!" that is not a `!==`/`!=`/`!x` operator is copy. Strings hold no `!`.
    for (const m of loomPage.matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g)) expect(m[0]).not.toContain("!");
  });
});
