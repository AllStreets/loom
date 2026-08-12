import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { makeLoomApi } from "./api";
import OrganHost from "./host";

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

describe("OrganHost", () => {
  it("shows a permission card for an unapproved organ and grants on approve", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [{
        id: "runs",
        manifest: JSON.stringify({ id: "runs", name: "Run Tracker", description: "d", version: 1, permissions: ["storage"] }),
        granted: null,
      }];
      if (cmd === "organ_grant") return "sha";
      if (cmd === "organ_read") return "export default { id: 'runs', render(el){ el.textContent = 'ok'; } }";
      return null;
    });
    render(<OrganHost />);
    expect(await screen.findByText("Run Tracker")).toBeTruthy();
    expect(screen.getByText("storage")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("organ_grant",
      expect.objectContaining({ id: "runs", grantedJson: JSON.stringify(["storage"]) })));
  });
  it("renders an empty state when there are no organs", async () => {
    invoke.mockResolvedValue([]);
    render(<OrganHost />);
    expect(await screen.findByText(/No organs yet/i)).toBeTruthy();
  });
});
