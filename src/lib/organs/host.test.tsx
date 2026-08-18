import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { makeLoomApi } from "./api";
import { FLEET_DEFAULTS } from "../core";

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

// ── cloudKey permission tests ──────────────────────────────────────────────────

describe("settings.cloudKey*() permissions", () => {
  it("cloudKeyPresent throws without 'settings' permission", async () => {
    const api = makeLoomApi("x", []);
    await expect(api.settings.cloudKeyPresent()).rejects.toThrow(/not granted/);
  });

  it("cloudKeySet throws without 'settings' permission", async () => {
    const api = makeLoomApi("x", []);
    await expect(api.settings.cloudKeySet("sk-ant-test")).rejects.toThrow(/not granted/);
  });

  it("cloudKeyClear throws without 'settings' permission", async () => {
    const api = makeLoomApi("x", []);
    await expect(api.settings.cloudKeyClear()).rejects.toThrow(/not granted/);
  });

  it("cloudKeyPresent succeeds with 'settings' permission (mock invoke)", async () => {
    invoke.mockResolvedValueOnce(true);
    const api = makeLoomApi("x", ["settings"]);
    const result = await api.settings.cloudKeyPresent();
    expect(invoke).toHaveBeenCalledWith("cloud_key_present");
    expect(result).toBe(true);
  });

  it("cloudKeySet succeeds with 'settings' permission (mock invoke)", async () => {
    invoke.mockResolvedValueOnce(undefined);
    const api = makeLoomApi("x", ["settings"]);
    await api.settings.cloudKeySet("sk-ant-test");
    expect(invoke).toHaveBeenCalledWith("cloud_key_set", { key: "sk-ant-test" });
  });

  it("cloudKeyClear succeeds with 'settings' permission (mock invoke)", async () => {
    invoke.mockResolvedValueOnce(undefined);
    const api = makeLoomApi("x", ["settings"]);
    await api.settings.cloudKeyClear();
    expect(invoke).toHaveBeenCalledWith("cloud_key_clear");
  });
});

// ── settings.models() ──────────────────────────────────────────────────────────

describe("settings.models()", () => {
  it("(a) throws without 'settings' permission", async () => {
    const api = makeLoomApi("x", []);
    await expect(api.settings.models()).rejects.toThrow(/not granted/);
  });

  it("(b) fleetStatus rejection resolves with all present:false — never rejects", async () => {
    const fleetStatus = vi.fn().mockRejectedValue(new Error("Ollama not running"));
    const api = makeLoomApi("x", ["settings"], { fleetStatus });
    const entries = await api.settings.models();
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.present === false)).toBe(true);
    // shape sanity
    for (const e of entries) {
      expect(["builder", "companion", "rewriter"]).toContain(e.role);
      expect(typeof e.model).toBe("string");
      expect(typeof e.default).toBe("string");
      expect(typeof e.override).toBe("string");
    }
  });

  it("(c) valid override in settings flows to model field", async () => {
    const fleetStatus = vi.fn().mockResolvedValue([]);
    const api = makeLoomApi("x", ["settings"], { fleetStatus });
    // Write a valid override via the API before calling models()
    await api.settings.setModel("companion", "mistral:7b");
    const entries = await api.settings.models();
    const companion = entries.find((e) => e.role === "companion")!;
    expect(companion.override).toBe("mistral:7b");
    expect(companion.model).toBe("mistral:7b");
    expect(companion.default).toBe(FLEET_DEFAULTS.companion);
  });

  it("(d) invalid override tag falls back to default", async () => {
    const fleetStatus = vi.fn().mockResolvedValue([]);
    const api = makeLoomApi("x", ["settings"], { fleetStatus });
    // Write an invalid tag directly to localStorage (bypassing setSetting validation)
    localStorage.setItem("model.builder", "bad tag with spaces!");
    const entries = await api.settings.models();
    const builder = entries.find((e) => e.role === "builder")!;
    expect(builder.override).toBe("bad tag with spaces!");
    // model must fall back to fleet default when override is invalid
    expect(builder.model).toBe(FLEET_DEFAULTS.builder);
  });
});

// ── settings.setModel() ────────────────────────────────────────────────────────

describe("settings.setModel()", () => {
  it("(e) throws without 'settings' permission", async () => {
    const api = makeLoomApi("x", []);
    await expect(api.settings.setModel("builder", "qwen3:1.7b")).rejects.toThrow(/not granted/);
  });

  it("(f) unknown role returns {ok:false, error}", async () => {
    const api = makeLoomApi("x", ["settings"]);
    const result = await api.settings.setModel("janitor", "any:tag");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown role/i);
    // nothing written to localStorage for the bogus role
    expect(localStorage.getItem("model.janitor")).toBeNull();
  });

  it("(g) invalid tag returns {ok:false, error} and does NOT write", async () => {
    const api = makeLoomApi("x", ["settings"]);
    const before = localStorage.getItem("model.rewriter");
    const result = await api.settings.setModel("rewriter", "bad tag!");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // localStorage must not have changed
    expect(localStorage.getItem("model.rewriter")).toBe(before);
  });

  it("(h) valid tag writes the setting and returns {ok:true}", async () => {
    const api = makeLoomApi("x", ["settings"]);
    const result = await api.settings.setModel("builder", "qwen3:1.7b");
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(localStorage.getItem("model.builder")).toBe("qwen3:1.7b");
  });

  it("(i) empty string resets override and returns {ok:true}", async () => {
    const api = makeLoomApi("x", ["settings"]);
    // First set a real override
    await api.settings.setModel("companion", "mistral:7b");
    expect(localStorage.getItem("model.companion")).toBe("mistral:7b");
    // Now reset
    const result = await api.settings.setModel("companion", "");
    expect(result.ok).toBe(true);
    expect(localStorage.getItem("model.companion")).toBe("");
  });
});
