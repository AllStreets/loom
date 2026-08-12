import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "./App";

describe("App boot shell", () => {
  it("renders the LOOM shell", () => {
    render(<App />);
    expect(screen.getByTestId("loom-shell")).toBeTruthy();
    expect(screen.getByText(/LOOM/i)).toBeTruthy();
  });
});
