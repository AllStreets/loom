import { describe, it, expect, beforeEach } from "vitest";
import { windowRegistry, type WinRect } from "./windowRegistry";

// Reset registry between tests by deleting all entries
function clearRegistry() {
  const all = windowRegistry.getAll();
  for (const id of all.keys()) {
    windowRegistry.delete(id);
  }
}

beforeEach(() => {
  clearRegistry();
});

describe("windowRegistry", () => {
  it("set and getAll roundtrip", () => {
    const rect: WinRect = { x: 100, y: 200, w: 400, h: 300 };
    windowRegistry.set("organ-1", rect);

    const all = windowRegistry.getAll();
    expect(all.get("organ-1")).toEqual(rect);
  });

  it("delete removes an entry", () => {
    windowRegistry.set("organ-2", { x: 10, y: 20, w: 300, h: 200 });
    expect(windowRegistry.getAll().has("organ-2")).toBe(true);

    windowRegistry.delete("organ-2");
    expect(windowRegistry.getAll().has("organ-2")).toBe(false);
  });

  it("getAll returns a ReadonlyMap with all registered windows", () => {
    windowRegistry.set("a", { x: 0, y: 0, w: 100, h: 100 });
    windowRegistry.set("b", { x: 50, y: 50, w: 200, h: 150 });

    const all = windowRegistry.getAll();
    expect(all.size).toBe(2);
    expect(all.has("a")).toBe(true);
    expect(all.has("b")).toBe(true);
  });

  it("set overwrites existing entry", () => {
    windowRegistry.set("organ-1", { x: 10, y: 10, w: 300, h: 200 });
    windowRegistry.set("organ-1", { x: 99, y: 88, w: 500, h: 400 });

    const rect = windowRegistry.getAll().get("organ-1");
    expect(rect?.x).toBe(99);
    expect(rect?.y).toBe(88);
  });

  it("delete of non-existent key is a no-op", () => {
    // Should not throw
    expect(() => windowRegistry.delete("does-not-exist")).not.toThrow();
  });
});
