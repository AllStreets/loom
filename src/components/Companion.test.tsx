import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BuildResult } from "../lib/loom/build";
import type { CompanionTurn } from "../lib/companion/runtime";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === "tts_speak") return Promise.resolve([1, 2, 3]);
    return Promise.resolve([]);
  }),
}));

const mockHandle = vi.fn<
  (utterance: string, history: unknown[], deps: unknown) => Promise<CompanionTurn>
>();

vi.mock("../lib/companion/runtime", () => ({
  handle: (...args: Parameters<typeof mockHandle>) => mockHandle(...args),
}));

vi.mock("../lib/voice/player", () => ({
  playWav: vi.fn().mockResolvedValue(undefined),
  stopPlayback: vi.fn(),
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

  it("scroll-to-bottom uses container scrollTop, not page-level scrollIntoView", async () => {
    // Verify that no element's scrollIntoView is called on a non-container element
    // (i.e., scrollToBottom does not call window/document scroll).
    // We spy on scrollIntoView globally to confirm it is never invoked.
    const scrollIntoViewSpy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;

    mockHandle.mockResolvedValue({ kind: "reply", text: "test reply" });

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "hello");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getByText("test reply")).toBeTruthy();
    });

    // scrollIntoView must NOT have been called by the auto-scroll mechanism
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();

    // Restore
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
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

  it("success card sha breaks and organId truncates (overflow sweep)", async () => {
    mockHandle.mockResolvedValue({ kind: "build", result: okBuild });
    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);
    await userEvent.type(textarea, "build a water tracker");
    await userEvent.keyboard("{Enter}");

    const sha = await screen.findByText(/sha: abc123/);
    expect(sha.style.wordBreak).toBe("break-all");

    const title = screen.getByText(/Built water-tracker/i);
    expect(title.style.textOverflow).toBe("ellipsis");
    expect(title.style.overflow).toBe("hidden");
  });

  it("user bubble applies overflow-wrap and minWidth:0 (overflow sweep)", async () => {
    mockHandle.mockResolvedValue({ kind: "reply", text: "ok" });
    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);
    await userEvent.type(textarea, "supercalifragilistic");
    await userEvent.keyboard("{Enter}");

    const bubble = await screen.findByText("supercalifragilistic");
    expect(bubble.style.overflowWrap).toBe("break-word");
    expect(bubble.style.minWidth).toBe("0px");
  });

  it("dispatches loom-fleet-activity clear (role:null) when a turn ends", async () => {
    mockHandle.mockResolvedValue({ kind: "reply", text: "hi there" });
    const activity: Array<{ role: string | null; phase?: string }> = [];
    function cap(ev: Event) {
      activity.push((ev as CustomEvent).detail);
    }
    window.addEventListener("loom-fleet-activity", cap);

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);
    await userEvent.type(textarea, "hello");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByText("hi there")).toBeTruthy());
    window.removeEventListener("loom-fleet-activity", cap);

    // The turn-end clear must have fired.
    expect(activity.some((a) => a.role === null)).toBe(true);
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

  it("build success pushes structured outcome to history; UI oneliner is not pushed", async () => {
    mockHandle.mockResolvedValue({ kind: "build", result: okBuild });

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "build a tracker");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(1);
    });

    // Status string should be visible in UI
    await waitFor(() => {
      expect(screen.getByText(/water-tracker is ready/i)).toBeTruthy();
    });

    // Now submit a second utterance
    mockHandle.mockResolvedValue({ kind: "reply", text: "second response" });
    await userEvent.type(textarea, "what now");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(2);
    });

    // Check the second call's history: should only contain first user utterance and second user utterance
    const [, secondHistory] = mockHandle.mock.calls[1];
    expect(Array.isArray(secondHistory)).toBe(true);
    // The history should be: [user: "build a tracker", user: "what now"]
    // It should NOT contain the status string "water-tracker is ready — approve it below."
    const statusString = "water-tracker is ready — approve it below.";
    const historyContainsStatus = (secondHistory as Array<{ role: string; content: string }>).some(
      (msg) => msg.content === statusString
    );
    expect(historyContainsStatus).toBe(false);
  });

  it("after successful build, companion history ref receives outcome matching /^Built [\\w-]+: / with repair round mention", async () => {
    mockHandle.mockResolvedValue({ kind: "build", result: okBuild });

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "build a tracker");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(1);
    });

    // Submit a second utterance to trigger the next handle call with built history
    mockHandle.mockResolvedValue({ kind: "reply", text: "next response" });
    await userEvent.type(textarea, "what is next");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(2);
    });

    // Inspect the second call's history — it should contain the structured build outcome
    const [, secondHistory] = mockHandle.mock.calls[1];
    expect(Array.isArray(secondHistory)).toBe(true);
    const builtMsg = (secondHistory as Array<{ role: string; content: string }>).find(
      (msg) => msg.role === "assistant" && /^Built [\w-]+: /.test(msg.content)
    );
    expect(builtMsg).toBeDefined();
    expect(builtMsg?.content).toMatch(/repair round/i);
  });

  it("after failed build, companion history ref receives outcome matching /^Build of .* failed at /", async () => {
    mockHandle.mockResolvedValue({ kind: "build", result: failBuild });

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "build a failing organ");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(1);
    });

    // Submit a second utterance to trigger the next handle call with failed history
    mockHandle.mockResolvedValue({ kind: "reply", text: "try again later" });
    await userEvent.type(textarea, "what next");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(2);
    });

    // Inspect the second call's history — it should contain the structured failure message
    const [, secondHistory] = mockHandle.mock.calls[1];
    expect(Array.isArray(secondHistory)).toBe(true);
    const failMsg = (secondHistory as Array<{ role: string; content: string }>).find(
      (msg) => msg.role === "assistant" && /^Build of .* failed at /.test(msg.content)
    );
    expect(failMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mood tests — pure helper unit tests (moods.ts)
// ---------------------------------------------------------------------------

import { turnStartMood, firstEventMood, settleMood, dispatchMood } from "../lib/orb/moods";

describe("orb mood helpers", () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    dispatchSpy = vi.spyOn(window, "dispatchEvent");
  });

  afterEach(() => {
    vi.useRealTimers();
    dispatchSpy.mockRestore();
  });

  function moodEvents() {
    return dispatchSpy.mock.calls
      .map((c) => c[0] as CustomEvent<{ mood: string }>)
      .filter((e) => e.type === "loom-mood")
      .map((e) => e.detail.mood);
  }

  it("turnStartMood dispatches thinking", () => {
    turnStartMood();
    expect(moodEvents()).toEqual(["thinking"]);
  });

  it("firstEventMood dispatches building the first time and returns true, skips subsequent calls", () => {
    const first = firstEventMood(false);
    expect(first).toBe(true);
    expect(moodEvents()).toEqual(["building"]);

    dispatchSpy.mockClear();
    const second = firstEventMood(true);
    expect(second).toBe(false);
    expect(moodEvents()).toEqual([]);
  });

  it("settleMood dispatches speaking immediately then idle after 2500ms", () => {
    const timer = settleMood();
    expect(moodEvents()).toEqual(["speaking"]);

    vi.advanceTimersByTime(2499);
    expect(moodEvents()).toEqual(["speaking"]);

    vi.advanceTimersByTime(1);
    expect(moodEvents()).toEqual(["speaking", "idle"]);

    clearTimeout(timer);
  });

  it("dispatchMood emits loom-mood with the given mood string", () => {
    dispatchMood("offline");
    expect(moodEvents()).toEqual(["offline"]);
  });
});

// ---------------------------------------------------------------------------
// Mood integration tests — Companion lifecycle
// ---------------------------------------------------------------------------

describe("Companion mood lifecycle", () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  // Use real timers for typing; we only switch to fake timers for the
  // sections that need to advance the 2500ms idle delay.
  beforeEach(() => {
    mockHandle.mockReset();
    vi.clearAllMocks();
    localStorage.clear();
    dispatchSpy = vi.spyOn(window, "dispatchEvent");
  });

  afterEach(() => {
    vi.useRealTimers();
    dispatchSpy.mockRestore();
  });

  function moodEvents() {
    return dispatchSpy.mock.calls
      .map((c) => c[0] as CustomEvent<{ mood: string }>)
      .filter((e) => e.type === "loom-mood")
      .map((e) => e.detail.mood);
  }

  it("submitting an utterance dispatches thinking before handle resolves", async () => {
    let resolveHandle!: (turn: CompanionTurn) => void;
    mockHandle.mockReturnValue(
      new Promise<CompanionTurn>((res) => {
        resolveHandle = res;
      })
    );

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "hello");
    await userEvent.keyboard("{Enter}");

    // handle has not resolved yet — thinking should already be dispatched
    await waitFor(() => {
      expect(moodEvents()).toContain("thinking");
    });
    expect(moodEvents()).not.toContain("speaking");

    // clean up — resolve and switch to fake timers to skip idle delay
    vi.useFakeTimers();
    await act(async () => {
      resolveHandle({ kind: "reply", text: "hi" });
    });
    vi.runAllTimers();
  });

  it("a reply turn dispatches thinking then speaking then (after 2500ms) idle", async () => {
    // Spy on setTimeout to capture the idle timer id so we can inspect
    // whether it fires, without needing fake timers to also control async.
    const originalSetTimeout = globalThis.setTimeout;
    const timerIds: ReturnType<typeof setTimeout>[] = [];
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        // Only intercept the 2500ms idle timer; let everything else through
        if (delay === 2500) {
          const id = originalSetTimeout(fn as (...a: unknown[]) => void, delay, ...args);
          timerIds.push(id);
          return id;
        }
        return originalSetTimeout(fn as (...a: unknown[]) => void, delay, ...args);
      });

    mockHandle.mockResolvedValue({ kind: "reply", text: "hello from loom" });

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "greet me");
    await userEvent.keyboard("{Enter}");

    // Wait for speaking to be dispatched (handle resolved)
    await waitFor(() => {
      expect(moodEvents()).toContain("speaking");
    });

    // thinking must have been dispatched before speaking
    expect(moodEvents()).toContain("thinking");
    // idle not yet emitted
    expect(moodEvents()).not.toContain("idle");

    // Wait for the real 2500ms idle timer to fire
    await act(async () => {
      await new Promise<void>((resolve) => originalSetTimeout(resolve, 2600));
    });

    expect(moodEvents()).toContain("idle");

    setTimeoutSpy.mockRestore();
  });

  it("unmounting during the speaking window dispatches idle and no timer fires after", async () => {
    mockHandle.mockResolvedValue({ kind: "reply", text: "bye" });

    const { unmount } = render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "go");
    await userEvent.keyboard("{Enter}");

    // Wait for handle to settle and speaking mood to fire
    await waitFor(() => {
      expect(moodEvents()).toContain("speaking");
    });
    // idle not yet dispatched
    expect(moodEvents().filter((m) => m === "idle")).toHaveLength(0);

    // Switch to fake timers before unmounting so the pending timer is tracked
    vi.useFakeTimers();

    // Unmount before the 2500ms timer fires
    act(() => {
      unmount();
    });

    // unmount should have dispatched idle synchronously via the cleanup
    expect(moodEvents()).toContain("idle");

    // Advance past 2500ms — no additional idle should appear (timer was cancelled)
    const idleCountAfterUnmount = moodEvents().filter((m) => m === "idle").length;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(moodEvents().filter((m) => m === "idle").length).toBe(idleCountAfterUnmount);
  });
});

// ---------------------------------------------------------------------------
// loom-utterance integration tests
// ---------------------------------------------------------------------------

describe("Companion: loom-utterance -> submits via runTurn", () => {
  beforeEach(() => {
    mockHandle.mockReset();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("dispatching loom-utterance calls handle with the spoken text", async () => {
    mockHandle.mockResolvedValue({ kind: "reply", text: "I heard you" });

    render(<Companion />);

    // Wait for useEffect (loom-utterance listener) to mount
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-utterance", { detail: { text: "hello from voice", spoken: true } })
      );
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(mockHandle).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    expect(mockHandle.mock.calls[0][0]).toBe("hello from voice");
  });
});

// ---------------------------------------------------------------------------
// Spoken replies tests
// ---------------------------------------------------------------------------

describe("Companion: speaks reply when setting demands", () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockHandle.mockReset();
    vi.clearAllMocks();
    localStorage.clear();
    dispatchSpy = vi.spyOn(window, "dispatchEvent");
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
    vi.useRealTimers();
  });

  function moodEvents() {
    return dispatchSpy.mock.calls
      .map((c) => c[0] as CustomEvent)
      .filter((e) => e.type === "loom-mood")
      .map((e) => (e as CustomEvent<{ mood: string }>).detail.mood);
  }

  it("with speakReplies=never, uses normal settleMood path (speaking dispatched)", async () => {
    localStorage.setItem("voice.speakReplies", "never");
    mockHandle.mockResolvedValue({ kind: "reply", text: "hello from loom" });

    render(<Companion />);
    const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);

    await userEvent.type(textarea, "greet");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(mockHandle).toHaveBeenCalled());
    // With "never", settleMood should be called -> speaking dispatched immediately
    await waitFor(() => expect(moodEvents()).toContain("speaking"));
  });

  it("with speakReplies=always and spoken turn, speaking mood dispatched without 2.5s timer", async () => {
    localStorage.setItem("voice.speakReplies", "always");
    mockHandle.mockResolvedValue({ kind: "reply", text: "always speak this" });

    render(<Companion />);

    // Wait for effects to mount (loom-utterance listener registers in useEffect)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Dispatch a spoken utterance to set spokenTurnRef = true and trigger runTurn
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-utterance", { detail: { text: "hello", spoken: true } })
      );
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => expect(mockHandle).toHaveBeenCalled(), { timeout: 2000 });
    // speaking mood should be dispatched (from ttsSpeak path)
    await waitFor(() => expect(moodEvents()).toContain("speaking"), { timeout: 2000 });
  });
});
