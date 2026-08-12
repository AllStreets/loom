import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { fleetStatus, fleetChat, organWrite } from "./core";

beforeEach(() => invoke.mockReset());

describe("core wrappers", () => {
  it("fleetStatus calls the right command and returns typed rows", async () => {
    invoke.mockResolvedValue([{ role: "companion", model: "gpt-oss:20b", present: true }]);
    const rows = await fleetStatus();
    expect(invoke).toHaveBeenCalledWith("fleet_status");
    expect(rows[0].role).toBe("companion");
  });
  it("fleetChat passes role, messages and snake_case opts", async () => {
    invoke.mockResolvedValue("hi");
    const out = await fleetChat("builder", [{ role: "user", content: "hey" }], { numCtx: 8192, temperature: 0.2 });
    expect(invoke).toHaveBeenCalledWith("fleet_chat", {
      role: "builder",
      messages: [{ role: "user", content: "hey" }],
      opts: { num_ctx: 8192, temperature: 0.2 },
    });
    expect(out).toBe("hi");
  });
  it("organWrite passes id, files and message", async () => {
    invoke.mockResolvedValue("abc123");
    const files = [{ name: "organ.js", content: "export default {}" }];
    const sha = await organWrite("runs", files, "organ: runs");
    expect(invoke).toHaveBeenCalledWith("organ_write", { id: "runs", files, message: "organ: runs" });
    expect(sha).toBe("abc123");
  });
});
