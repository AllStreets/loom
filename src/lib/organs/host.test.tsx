import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { makeLoomApi } from "./api";

beforeEach(() => { invoke.mockReset(); localStorage.clear(); });

describe("makeLoomApi", () => {
  it("namespaces storage and enforces grants", async () => {
    const api = makeLoomApi("runs", ["storage"]);
    api.storage.set("count", 3);
    expect(JSON.parse(localStorage.getItem("organ.runs.count")!)).toBe(3);
    expect(api.storage.get("count", 0)).toBe(3);
    await expect(api.model.chat([{ role: "user", content: "x" }])).rejects.toThrow(/not granted/);
  });
  it("model.chat routes to the companion when granted", async () => {
    const chat = vi.fn().mockResolvedValue("hello");
    const api = makeLoomApi("runs", ["model"], { chat });
    await expect(api.model.chat([{ role: "user", content: "x" }])).resolves.toBe("hello");
    expect(chat).toHaveBeenCalledWith("companion", [{ role: "user", content: "x" }]);
  });
  it("returns fallback for corrupt JSON in storage.get", () => {
    const api = makeLoomApi("runs", ["storage"]);
    localStorage.setItem("organ.runs.bad", "{not json");
    expect(api.storage.get("bad", 42)).toBe(42);
  });
});
