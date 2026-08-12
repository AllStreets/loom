import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { fleetStatus, fleetChat } from "./core";

beforeEach(() => invoke.mockReset());

describe("core wrappers", () => {
  it("fleetStatus calls the right command and returns typed rows", async () => {
    invoke.mockResolvedValue([{ role: "companion", model: "gpt-oss:20b", present: true }]);
    const rows = await fleetStatus();
    expect(invoke).toHaveBeenCalledWith("fleet_status");
    expect(rows[0].role).toBe("companion");
  });
  it("fleetChat passes role and messages", async () => {
    invoke.mockResolvedValue("hi");
    const out = await fleetChat("companion", [{ role: "user", content: "hey" }]);
    expect(invoke).toHaveBeenCalledWith("fleet_chat", { role: "companion", messages: [{ role: "user", content: "hey" }] });
    expect(out).toBe("hi");
  });
});
