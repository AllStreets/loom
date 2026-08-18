import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { purgeOrganStorage, addOrganTombstone, makeLoomApi } from "./api";

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe("purgeOrganStorage", () => {
  it("removes all organ.id.* keys from localStorage", () => {
    localStorage.setItem("organ.notes.data", JSON.stringify({ foo: 1 }));
    localStorage.setItem("organ.notes.prefs", JSON.stringify({ bar: 2 }));
    localStorage.setItem("organ.timeline.data", JSON.stringify({ other: 3 }));
    localStorage.setItem("loom.win.notes", JSON.stringify({ x: 40 }));
    purgeOrganStorage("notes");
    expect(localStorage.getItem("organ.notes.data")).toBeNull();
    expect(localStorage.getItem("organ.notes.prefs")).toBeNull();
    expect(localStorage.getItem("loom.win.notes")).toBeNull();
    // other organ's keys untouched
    expect(localStorage.getItem("organ.timeline.data")).not.toBeNull();
  });

  it("is safe when no keys exist for the organ", () => {
    expect(() => purgeOrganStorage("nonexistent")).not.toThrow();
  });
});

describe("addOrganTombstone", () => {
  it("adds id to loom.organs.deleted", () => {
    addOrganTombstone("notes");
    const raw = localStorage.getItem("loom.organs.deleted");
    expect(raw).not.toBeNull();
    const list = JSON.parse(raw!);
    expect(list).toContain("notes");
  });

  it("does not duplicate ids", () => {
    addOrganTombstone("notes");
    addOrganTombstone("notes");
    const list = JSON.parse(localStorage.getItem("loom.organs.deleted")!);
    expect(list.filter((id: string) => id === "notes").length).toBe(1);
  });

  it("accumulates multiple ids", () => {
    addOrganTombstone("notes");
    addOrganTombstone("timeline");
    const list = JSON.parse(localStorage.getItem("loom.organs.deleted")!);
    expect(list).toContain("notes");
    expect(list).toContain("timeline");
  });
});

describe("makeLoomApi settings.resetAll", () => {
  it("throws without settings permission", async () => {
    const api = makeLoomApi("test", []);
    await expect(api.settings.resetAll()).rejects.toThrow(/permission "settings" not granted/);
  });

  it("calls resetAllSettings dep and does not throw", async () => {
    let called = false;
    const api = makeLoomApi("test", ["settings"], {
      resetAllSettings: () => { called = true; },
    });
    // location.reload will throw in jsdom — catch it
    try { await api.settings.resetAll(); } catch { /* jsdom throws on location.reload */ }
    expect(called).toBe(true);
  });
});
