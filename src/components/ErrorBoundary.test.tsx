import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Bomb(): never {
  throw new Error("test render error");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.error).mockRestore();
  });

  it("catches a thrown child and shows the fallback", () => {
    render(
      <ErrorBoundary zone="test">
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByTestId("error-boundary-fallback")).toBeTruthy();
  });

  it("zone label appears in the fallback", () => {
    render(
      <ErrorBoundary zone="content">
        <Bomb />
      </ErrorBoundary>
    );
    const fallback = screen.getByTestId("error-boundary-fallback");
    expect(fallback.getAttribute("data-zone")).toBe("content");
  });

  it("fallback contains a RELOAD button", () => {
    render(
      <ErrorBoundary zone="test">
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByRole("button", { name: "RELOAD" })).toBeTruthy();
  });

  it("console.debug is called with the zone on error", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    render(
      <ErrorBoundary zone="content">
        <Bomb />
      </ErrorBoundary>
    );

    expect(debugSpy).toHaveBeenCalled();
    const firstArg = debugSpy.mock.calls[0][0] as string;
    expect(firstArg).toContain("content");

    debugSpy.mockRestore();
  });
});
