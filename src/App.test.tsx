import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import App from "./App";

describe("App boot shell", () => {
  it("renders the LOOM shell", () => {
    render(<App />);
    expect(screen.getByTestId("loom-shell")).toBeTruthy();
    expect(screen.getAllByText(/LOOM/i).length).toBeGreaterThan(0);
  });
});
