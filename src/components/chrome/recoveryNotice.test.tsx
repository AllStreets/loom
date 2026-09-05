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

// ── Phase 23 (Rebirth): the healed-generation variant ─────────────────────────

describe("RecoveryNotice — a generation that couldn't be born", () => {
  function heal(failedSha: string, prevSha: string, reason = "crashed") {
    window.dispatchEvent(
      new CustomEvent(RECOVERY_EVENT, {
        detail: { sha: prevSha, generation: { failedSha, prevSha, reason } },
      }),
    );
  }

  it("speaks the healed-generation copy exactly, with 7-char shas", () => {
    render(<RecoveryNotice />);
    act(() => heal("3f2a1c9deadbeef", "8b91e0abcdef"));
    expect(screen.getByTestId("recovery-body")).toHaveTextContent(
      "LOOM tried to become 3f2a1c9 and it stopped — it came home to 8b91e0a. The failed weave is kept under generations.",
    );
    expect(screen.getByTestId("recovery-sha")).toHaveTextContent("8b91e0a");
    expect(screen.queryByText(/an edit didn't hold/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("recovery-notice").textContent).not.toMatch(/!/);
  });

  it("says which kind of failure it was — the reason crossed the boundary to be used", () => {
    // The warden distinguishes a body that died from one that was still
    // running when the clock ran out (usually a boundaried error vetoing the
    // confirmation, not a crash). Both used to read "and couldn't".
    for (const [reason, hinge] of [
      ["crashed", "and it stopped"],
      ["never confirmed — still running when the clock ran out", "and couldn't say it was well"],
      ["never confirmed", "and couldn't"],
      ["something nobody has written yet", "and couldn't"],
    ] as const) {
      const { unmount } = render(<RecoveryNotice />);
      act(() => heal("3f2a1c9deadbeef", "8b91e0abcdef", reason));
      expect(screen.getByTestId("recovery-body")).toHaveTextContent(hinge);
      unmount();
    }
  });

  it("the plain edit variant is unchanged when no generation rides the event", () => {
    render(<RecoveryNotice />);
    act(() => recover("deadbeef1234567"));
    expect(screen.getByText(/an edit didn't hold/i)).toBeInTheDocument();
    expect(screen.queryByText(/tried to become/i)).not.toBeInTheDocument();
  });

  it("dismiss clears the generation notice", async () => {
    render(<RecoveryNotice />);
    act(() => heal("3f2a1c9deadbeef", "8b91e0abcdef", "never confirmed"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("recovery-dismiss"));
    });
    expect(screen.queryByTestId("recovery-notice")).not.toBeInTheDocument();
  });
});

describe("RecoveryNotice — when it could not come home", () => {
  it("renders the failure, which carries no sha because there is no home to name", async () => {
    render(<RecoveryNotice />);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(RECOVERY_EVENT, { detail: { sha: "", failed: true } }),
      );
    });
    const body = screen.getByTestId("recovery-body");
    expect(body).toHaveTextContent("LOOM tried to come home and couldn't");
    // fact — hinge — remedy: it says what to do next.
    expect(body).toHaveTextContent(/Return to a kept generation from Settings/);
    expect(screen.getByTestId("recovery-notice")).toHaveTextContent("couldn't come home");
    expect(body.textContent).not.toContain("!");
  });

  it("still drops an empty event that claims nothing at all", async () => {
    render(<RecoveryNotice />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(RECOVERY_EVENT, { detail: { sha: "" } }));
    });
    expect(screen.queryByTestId("recovery-notice")).not.toBeInTheDocument();
  });
});
