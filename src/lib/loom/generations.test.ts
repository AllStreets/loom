/**
 * generations.test.ts — the owner-facing ledger of bodies (PROTECTED, see generations.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const core = vi.hoisted(() => ({
  generationsList: vi.fn(),
  generationsReturn: vi.fn(),
}));
vi.mock("../core", () => core);

import type { Generation } from "../core";
import {
  listGenerations,
  returnToGeneration,
  describe as describeGeneration,
  relativeTime,
} from "./generations";

const gen = (over: Partial<Generation> = {}): Generation => ({
  sha: "3f2a1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b",
  wovenAt: "2026-09-02T10:00:00Z",
  sizeBytes: 41,
  reason: "reweave",
  commitSubject: "fix the orb pulse",
  isCurrent: true,
  isPrevious: false,
  ...over,
});

beforeEach(() => {
  core.generationsList.mockReset();
  core.generationsReturn.mockReset();
});

describe("listGenerations", () => {
  it("returns the ledger from the core", async () => {
    core.generationsList.mockResolvedValue([gen()]);
    const rows = await listGenerations();
    expect(core.generationsList).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].isCurrent).toBe(true);
  });
});

describe("returnToGeneration", () => {
  it("asks the core to return to the sha", async () => {
    core.generationsReturn.mockResolvedValue(undefined);
    await returnToGeneration("3f2a1c9d");
    expect(core.generationsReturn).toHaveBeenCalledWith("3f2a1c9d");
  });
});

describe("describe", () => {
  it("formats a generation", () => {
    const now = Date.parse("2026-09-02T12:00:00Z");
    expect(describeGeneration(gen(), now)).toBe(
      "3f2a1c · woven 2h ago · reweave · fix the orb pulse",
    );
  });

  it("keeps a short sha short", () => {
    const now = Date.parse("2026-09-02T12:00:00Z");
    expect(describeGeneration(gen({ sha: "3f2a" }), now)).toMatch(/^3f2a · /);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");
  it("just now within the first minute", () => {
    expect(relativeTime("2026-09-02T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-02T12:00:00Z", now)).toBe("just now");
  });
  it("minutes under an hour", () => {
    expect(relativeTime("2026-09-02T11:45:00Z", now)).toBe("15m ago");
  });
  it("hours under a day", () => {
    expect(relativeTime("2026-09-02T10:00:00Z", now)).toBe("2h ago");
  });
  it("days beyond that", () => {
    expect(relativeTime("2026-08-30T12:00:00Z", now)).toBe("3d ago");
  });
  it("a future or unreadable stamp does not pretend", () => {
    expect(relativeTime("2026-09-02T13:00:00Z", now)).toBe("just now");
    expect(relativeTime("not a date", now)).toBe("at an unknown time");
  });
});
