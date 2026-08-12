import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Orb } from "./Orb";
import { VERT, FRAG } from "./shaders";

// Stub GL component for tests - never actually mounts OrbGL/Canvas
function StubGL() {
  return <div data-testid="stub-gl">gl</div>;
}
function ThrowingGL(): never {
  throw new Error("WebGL crash");
}

describe("shaders.ts content checks", () => {
  it("VERT contains snoise", () => {
    expect(VERT).toContain("snoise");
  });
  it("VERT contains uAmp", () => {
    expect(VERT).toContain("uAmp");
  });
  it("VERT contains uBreath", () => {
    expect(VERT).toContain("uBreath");
  });
  it("FRAG contains fresnel pow(", () => {
    expect(FRAG).toContain("pow(");
  });
  it("FRAG contains 1.6 for rim push above bloom threshold", () => {
    expect(FRAG).toContain("1.6");
  });
});

describe("Orb renders Orb2D when tier is flat", () => {
  it("shows orb-2d when tierOverride=flat", () => {
    render(<Orb mood="idle" tierOverride="flat" />);
    expect(screen.getByTestId("orb")).toBeInTheDocument();
    expect(screen.getByTestId("orb-2d")).toBeInTheDocument();
  });

  it("does NOT render stub-gl when tier is flat", () => {
    render(<Orb mood="idle" tierOverride="flat" glComponent={StubGL} />);
    expect(screen.queryByTestId("stub-gl")).not.toBeInTheDocument();
  });
});

describe("Orb2D mood color changes", () => {
  it("idle mood uses cyan color in background style", () => {
    render(<Orb mood="idle" tierOverride="flat" />);
    const orb2d = screen.getByTestId("orb-2d");
    expect(orb2d.getAttribute("style")).toContain("#22d3ee");
  });

  it("offline mood uses slate color in background style", () => {
    render(<Orb mood="offline" tierOverride="flat" />);
    const orb2d = screen.getByTestId("orb-2d");
    expect(orb2d.getAttribute("style")).toContain("#5f6f8c");
    // ensure idle and offline have distinct colors
    expect(orb2d.getAttribute("style")).not.toContain("#22d3ee");
  });
});

describe("Error boundary falls back to Orb2D and sets localStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    // Suppress console.error for the expected React error boundary output
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders orb-2d when glComponent throws", async () => {
    render(
      <Orb
        mood="idle"
        tierOverride="gl"
        glComponent={ThrowingGL}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId("orb-2d")).toBeInTheDocument();
    });
  });

  it("sets localStorage loom.orb=flat when glComponent throws", async () => {
    render(
      <Orb
        mood="idle"
        tierOverride="gl"
        glComponent={ThrowingGL}
      />
    );
    await waitFor(() => {
      expect(localStorage.getItem("loom.orb")).toBe("flat");
    });
  });
});
