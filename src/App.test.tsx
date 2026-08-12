import { render, screen } from "@testing-library/react";
import { describe, it, expect, afterAll, vi } from "vitest";

// matchMedia mock (jsdom lacks it)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).matchMedia;
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

// Force flat orb tier so jsdom never tries WebGL
localStorage.setItem("loom.orb", "flat");

import App from "./App";

describe("App boot shell", () => {
  it("renders the LOOM shell with wordmark and Companion input", () => {
    render(<App />);
    // Shell renders the loom-shell testid
    expect(screen.getByTestId("loom-shell")).toBeTruthy();
    // Wordmark present
    expect(screen.getAllByText(/LOOM/i).length).toBeGreaterThan(0);
    // Companion input present
    expect(screen.getByPlaceholderText(/Talk to LOOM/i)).toBeTruthy();
    // Orb present
    expect(screen.getByTestId("orb")).toBeTruthy();
  });
});
