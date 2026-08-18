import { render, screen, act, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom";
import type { RoleStatus } from "../lib/core";

// Control reduced-motion for pulse-ring rendering assertions.
let _reducedMotion = false;
vi.mock("framer-motion", async (importActual) => {
  const actual = await importActual<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: () => _reducedMotion,
  };
});

import FleetHUD from "./FleetHUD";

const ROLES: RoleStatus[] = [
  { role: "builder", model: "qwen3-coder:30b-a3b-q4_K_M", present: true },
  { role: "companion", model: "gpt-oss:20b", present: true },
  { role: "rewriter", model: "qwen3:1.7b", present: true },
];

afterEach(() => {
  cleanup();
  _reducedMotion = false;
});

function fireActivity(role: string | null, phase?: string) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("loom-fleet-activity", { detail: { role, phase } }),
    );
  });
}

describe("FleetHUD", () => {
  it("renders all three roles with names and model tags", () => {
    render(<FleetHUD roles={ROLES} />);
    expect(screen.getByTestId("fleet-role-builder")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-role-companion")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-role-rewriter")).toBeInTheDocument();
    // Model tag text present
    expect(screen.getByText("gpt-oss:20b")).toBeInTheDocument();
  });

  it("model tag has ellipsis truncation with full tag in title", () => {
    render(<FleetHUD roles={ROLES} />);
    const tag = screen.getByText("qwen3-coder:30b-a3b-q4_K_M");
    expect(tag.style.textOverflow).toBe("ellipsis");
    expect(tag.style.overflow).toBe("hidden");
    expect(tag.style.whiteSpace).toBe("nowrap");
    expect(tag).toHaveAttribute("title", "qwen3-coder:30b-a3b-q4_K_M");
    // maxWidth constrained (chip fits the segmented top-bar pill height)
    expect(tag.style.maxWidth).toBe("120px");
  });

  it("presence dot uses role color when present", () => {
    render(<FleetHUD roles={ROLES} />);
    const dot = screen.getByTestId("fleet-dot-builder");
    // builder color #7dd3fc -> rgb(125, 211, 252)
    expect(dot.style.background).toBe("rgb(125, 211, 252)");
  });

  it("presence dot uses danger color when a role is absent", () => {
    const roles: RoleStatus[] = [
      { role: "builder", model: "x", present: false },
      { role: "companion", model: "y", present: true },
      { role: "rewriter", model: "z", present: true },
    ];
    render(<FleetHUD roles={roles} />);
    const dot = screen.getByTestId("fleet-dot-builder");
    expect(dot.style.background).toBe("var(--danger)");
  });

  it("shows fleet offline when no roles present", () => {
    const roles: RoleStatus[] = [
      { role: "builder", model: "", present: false },
      { role: "companion", model: "", present: false },
      { role: "rewriter", model: "", present: false },
    ];
    render(<FleetHUD roles={roles} />);
    expect(screen.getByTestId("fleet-offline")).toHaveTextContent("fleet offline");
  });

  it("shows fleet offline when roles array is empty", () => {
    render(<FleetHUD roles={[]} />);
    expect(screen.getByTestId("fleet-offline")).toBeInTheDocument();
  });

  it("marks a role active and shows phase on loom-fleet-activity", () => {
    render(<FleetHUD roles={ROLES} />);
    expect(screen.getByTestId("fleet-role-builder")).toHaveAttribute("data-active", "false");

    fireActivity("builder", "code");
    expect(screen.getByTestId("fleet-role-builder")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("fleet-phase-builder")).toHaveTextContent("code");

    // Clearing sets it back to inactive
    fireActivity(null);
    expect(screen.getByTestId("fleet-role-builder")).toHaveAttribute("data-active", "false");
  });

  it("renders an animated pulse ring for the active role (motion enabled)", () => {
    _reducedMotion = false;
    render(<FleetHUD roles={ROLES} />);
    fireActivity("rewriter", "rewrite");
    expect(screen.getByTestId("fleet-pulse-rewriter")).toBeInTheDocument();
  });

  it("still renders a static ring under reduced motion", () => {
    _reducedMotion = true;
    render(<FleetHUD roles={ROLES} />);
    fireActivity("companion", "converse");
    expect(screen.getByTestId("fleet-pulse-companion")).toBeInTheDocument();
  });
});
