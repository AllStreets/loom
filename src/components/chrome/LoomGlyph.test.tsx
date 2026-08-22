import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom";

import LoomGlyph from "./LoomGlyph";

describe("LoomGlyph", () => {
  it("renders warp, weft, and the under-crossing", () => {
    render(<LoomGlyph />);
    const svg = screen.getByTestId("loom-glyph");
    // three path elements: warp trio, weft, crossing
    expect(svg.querySelectorAll("path")).toHaveLength(3);
    const weft = screen.getByTestId("loom-glyph-weft");
    expect(weft.getAttribute("stroke")).toBe("var(--accent)");
  });

  it("sizes via the size prop (default 18)", () => {
    const { unmount } = render(<LoomGlyph />);
    expect(screen.getByTestId("loom-glyph").getAttribute("width")).toBe("18");
    unmount();

    render(<LoomGlyph size={64} />);
    expect(screen.getByTestId("loom-glyph").getAttribute("width")).toBe("64");
  });

  it("draw adds the weft-draw animation class to the weft only", () => {
    render(<LoomGlyph draw />);
    const weft = screen.getByTestId("loom-glyph-weft");
    expect(weft).toHaveClass("loom-weft-draw");
    // pathLength normalizes the dash animation to 0-100
    expect(weft.getAttribute("pathLength")).toBe("100");
  });

  it("static by default — no draw class, no animation style tag", () => {
    render(<LoomGlyph />);
    const svg = screen.getByTestId("loom-glyph");
    expect(screen.getByTestId("loom-glyph-weft")).not.toHaveClass("loom-weft-draw");
    expect(svg.querySelector("style")).toBeNull();
  });
});
