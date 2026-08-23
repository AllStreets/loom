import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import Notices from "./Notices";
import { mintNotifyToken } from "../../lib/organs/notifyGate";
import { makeLoomApi } from "../../lib/organs/api";
import { makeLedger } from "../../lib/organs/budgets";

// Controllable reduced-motion — flipped per test.
let mockRm = false;
vi.mock("framer-motion", async (importOriginal) => {
  const mod = await importOriginal<typeof import("framer-motion")>();
  return { ...mod, useReducedMotion: () => mockRm };
});

// Notices only renders events stamped with a live notifyGate token — mint one
// for the test dispatcher, exactly as makeLoomApi does per mount.
const TEST_TOKEN = mintNotifyToken("notices-test");

function notify(title: string, body?: string, id = "btc") {
  act(() => {
    window.dispatchEvent(new CustomEvent("loom-notify", { detail: { id, title, body, token: TEST_TOKEN } }));
  });
}

beforeEach(() => {
  mockRm = false;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Notices", () => {
  it("renders nothing before any notice arrives", () => {
    render(<Notices />);
    expect(screen.queryByTestId("notices-stack")).toBeNull();
  });

  it("shows a toast with title and body on loom-notify", () => {
    render(<Notices />);
    notify("BTC alert", "down 5% in the hour");
    expect(screen.getByTestId("notices-stack")).toBeTruthy();
    expect(screen.getByText("BTC alert")).toBeTruthy();
    expect(screen.getByText("down 5% in the hour")).toBeTruthy();
  });

  it("ignores malformed events without a title", () => {
    render(<Notices />);
    act(() => {
      window.dispatchEvent(new CustomEvent("loom-notify", { detail: { token: TEST_TOKEN } }));
      window.dispatchEvent(new CustomEvent("loom-notify"));
    });
    expect(screen.queryByTestId("notices-stack")).toBeNull();
  });

  it("legit path: api.notify (grant + budget + token) renders a toast", () => {
    render(<Notices />);
    const api = makeLoomApi("legit-organ", ["notify"], { ledger: makeLedger(() => 0) });
    act(() => {
      api.notify("From the api", "with a minted token");
    });
    expect(screen.getByText("From the api")).toBeTruthy();
    expect(screen.getByText("with a minted token")).toBeTruthy();
  });

  it("honesty gate: a forged tokenless dispatch is ignored", () => {
    render(<Notices />);
    act(() => {
      // What a misbehaving same-realm organ could do around the grant + budget.
      window.dispatchEvent(new CustomEvent("loom-notify", { detail: { id: "rogue", title: "forged" } }));
    });
    expect(screen.queryByTestId("notices-stack")).toBeNull();
  });

  it("honesty gate: a guessed token that was never minted is ignored", () => {
    render(<Notices />);
    act(() => {
      window.dispatchEvent(new CustomEvent("loom-notify", { detail: { id: "rogue", title: "forged", token: "not-a-real-token" } }));
    });
    expect(screen.queryByTestId("notices-stack")).toBeNull();
  });

  it("dismiss ✕ removes the notice", () => {
    render(<Notices />);
    notify("one");
    fireEvent.click(screen.getByTestId("notice-dismiss"));
    expect(screen.queryByTestId("notices-stack")).toBeNull();
  });

  it("caps visible notices at 3 with a +N chip for the rest", () => {
    render(<Notices />);
    notify("n1");
    notify("n2");
    notify("n3");
    expect(screen.getAllByTestId("notice")).toHaveLength(3);
    expect(screen.queryByTestId("notices-overflow-chip")).toBeNull();
    notify("n4");
    notify("n5");
    expect(screen.getAllByTestId("notice")).toHaveLength(3);
    expect(screen.getByTestId("notices-overflow-chip").textContent).toBe("+2 more");
    // Newest are the visible ones
    expect(screen.getByText("n5")).toBeTruthy();
    expect(screen.queryByText("n1")).toBeNull();
  });

  it("auto-dims a notice after 12s", () => {
    render(<Notices />);
    notify("fading");
    const el = screen.getByTestId("notice");
    expect(el.getAttribute("data-dimmed")).toBeNull();
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByTestId("notice").getAttribute("data-dimmed")).toBe("true");
  });

  it("reduced motion: static — never auto-dims", () => {
    mockRm = true;
    render(<Notices />);
    notify("steady");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("notice").getAttribute("data-dimmed")).toBeNull();
  });

  it("dismissing one notice leaves the others standing", () => {
    render(<Notices />);
    notify("a");
    notify("b");
    const dismissBtns = screen.getAllByTestId("notice-dismiss");
    // Newest first: index 0 is "b"
    fireEvent.click(dismissBtns[0]);
    expect(screen.queryByText("b")).toBeNull();
    expect(screen.getByText("a")).toBeTruthy();
  });
});
