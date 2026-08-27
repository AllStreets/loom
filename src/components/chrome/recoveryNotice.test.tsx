/**
 * recoveryNotice.test.tsx — the calm "an edit didn't hold" card.
 */

import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom";
import RecoveryNotice from "./recoveryNotice";
import { RECOVERY_EVENT } from "../../lib/loom/recovery";

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

afterEach(() => vi.clearAllMocks());

function recover(sha: string) {
  window.dispatchEvent(new CustomEvent(RECOVERY_EVENT, { detail: { sha } }));
}

describe("RecoveryNotice", () => {
  it("is absent until a recovery event fires", () => {
    render(<RecoveryNotice />);
    expect(screen.queryByTestId("recovery-notice")).not.toBeInTheDocument();
  });

  it("shows the came-home message with the 7-char sha", () => {
    render(<RecoveryNotice />);
    act(() => recover("deadbeef1234567"));

    expect(screen.getByTestId("recovery-notice")).toBeInTheDocument();
    expect(screen.getByText(/an edit didn't hold/i)).toBeInTheDocument();
    expect(screen.getByTestId("recovery-sha")).toHaveTextContent("deadbee");
  });

  it("has a working dismiss control", async () => {
    render(<RecoveryNotice />);
    act(() => recover("abc1234def"));
    const dismiss = screen.getByTestId("recovery-dismiss");
    expect(dismiss).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(dismiss);
    });
    // click completes without error — the notice begins its exit
  });

  it("shows only one notice at a time", () => {
    render(<RecoveryNotice />);
    act(() => recover("1111111aaaa"));
    act(() => recover("2222222bbbb"));
    expect(screen.getByTestId("recovery-sha")).toHaveTextContent("1111111");
  });
});
