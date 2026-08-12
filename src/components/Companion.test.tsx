import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BuildResult } from "../lib/loom/build";
import type { CompanionTurn } from "../lib/companion/runtime";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

const mockHandle = vi.fn<
  (utterance: string, history: unknown[], deps: unknown) => Promise<CompanionTurn>
>();

vi.mock("../lib/companion/runtime", () => ({
  handle: (...args: Parameters<typeof mockHandle>) => mockHandle(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const okBuild: BuildResult = {
  ok: true,
  organId: "water-tracker",
  sha: "abc123",
  log: [],
};

const failBuild: BuildResult = {
  ok: false,
  stage: "code",
  error: "syntax error on line 5",
  log: [],
};

beforeEach(() => {
  mockHandle.mockReset();
  vi.clearAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import Companion from "./Companion";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Companion", () => {
  it("renders the input textarea and LOOM header", () => {
    render(<Companion />);
    expect(
      screen.getByPlaceholderText(/Talk to LOOM/i)
    ).toBeTruthy();
    expect(screen.getByText("LOOM")).toBeTruthy();
    expect(screen.getByText(/Review code before saving/i)).toBeTruthy();
  });

  it("typing and pressing Enter submits, calls handle, and renders user + reply bubbles", async () => {
    mockHandle.mockResolvedValue({ kind: "reply", text: "hello from loom" });

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "what can you do");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(1);
    });

    const [utterance] = mockHandle.mock.calls[0];
    expect(utterance).toBe("what can you do");

    await waitFor(() => {
      expect(screen.getByText("what can you do")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("hello from loom")).toBeTruthy();
    });
  });

  it("Shift+Enter inserts a newline and does NOT call handle", async () => {
    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i) as HTMLTextAreaElement;

    await userEvent.type(textarea, "line one");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

    expect(mockHandle).not.toHaveBeenCalled();
    // Textarea should still have content (newline appended)
    expect(textarea.value).toContain("line one");
  });

  it("input is disabled while a slow handle is pending", async () => {
    let resolveHandle!: (turn: CompanionTurn) => void;
    mockHandle.mockReturnValue(
      new Promise<CompanionTurn>((res) => {
        resolveHandle = res;
      })
    );

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i) as HTMLTextAreaElement;

    await userEvent.type(textarea, "build me something");
    await userEvent.keyboard("{Enter}");

    // Input should be disabled while pending
    await waitFor(() => {
      expect(textarea.disabled).toBe(true);
    });

    // Resolve to unblock
    await act(async () => {
      resolveHandle({ kind: "reply", text: "done" });
    });

    await waitFor(() => {
      expect(textarea.disabled).toBe(false);
    });
  });

  it("build turn ok renders success card and dispatches organs-changed", async () => {
    mockHandle.mockResolvedValue({ kind: "build", result: okBuild });

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "build a water tracker");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByText(/Built water-tracker/i)).toBeTruthy();
    });

    await waitFor(() => {
      const calls = dispatchSpy.mock.calls.map((c) => (c[0] as Event).type);
      expect(calls).toContain("organs-changed");
    });

    // sha visible
    expect(screen.getByText(/abc123/)).toBeTruthy();
    // one-liner assistant bubble
    await waitFor(() => {
      expect(screen.getByText(/water-tracker is ready/i)).toBeTruthy();
    });
  });

  it("failure turn renders the failure card with stage and Retry button, clicking Retry calls handle again with same utterance", async () => {
    // First call: fail; second call: reply
    mockHandle
      .mockResolvedValueOnce({ kind: "build", result: failBuild })
      .mockResolvedValueOnce({ kind: "reply", text: "retried ok" });

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "build a failing organ");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByText(/stage: code/i)).toBeTruthy();
    });
    expect(screen.getByText(/syntax error on line 5/i)).toBeTruthy();

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    await userEvent.click(retryBtn);

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(2);
    });

    // Second call uses same utterance
    const [secondUtterance] = mockHandle.mock.calls[1];
    expect(secondUtterance).toBe("build a failing organ");

    await waitFor(() => {
      expect(screen.getByText("retried ok")).toBeTruthy();
    });
  });
});
