/**
 * BodyRequest.test.tsx — the organ asks, the owner decides, chrome acts.
 *
 * Round-1 finding 1: `loom.self.reweave()` reached the protected orchestration
 * directly. These tests hold the new shape: nothing runs until the owner
 * presses the affirmative on the shell's own consent card, the card names who
 * asked, and the line it shows is composed from chrome's reading of the body —
 * never from anything the organ sent.
 */

import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import BodyRequest from "./BodyRequest";
import {
  BODY_REQUEST_EVENT,
  BodyRequestDeclined,
  LINE_BUSY,
  LINE_NO_CHROME,
  pendingBodyRequests,
  requestBody,
} from "../../lib/organs/bodyGate";

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

const SHA = "3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a";
const PREV = "9b8c7d9b8c7d9b8c7d9b8c7d9b8c7d9b8c7d9b8c";

const PACKAGED = async () => ({
  mode: "packaged" as const,
  genomeSha: SHA,
  generation: PREV,
  threaded: true,
  loomhome: "/l",
  loomhomeBytes: 0,
  canSwap: true,
});

function acts(over: Partial<{
  thread: ReturnType<typeof vi.fn>;
  reweave: ReturnType<typeof vi.fn>;
  returnTo: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    thread: over.thread ?? vi.fn(async () => {}),
    reweave: over.reweave ?? vi.fn(async () => ({ ok: true as const })),
    returnTo: over.returnTo ?? vi.fn(async () => {}),
  };
}

/** Mount the card and let the identity read settle. */
async function mount(a = acts(), canSwap = true) {
  const id = async () => ({ ...(await PACKAGED()), canSwap });
  render(<BodyRequest identity={id} acts={a} />);
  await act(async () => {});
  return a;
}

/**
 * Ask as an organ would, with a handler attached in the same breath — an
 * unhandled rejection here is a test artefact, not a finding.
 */
function ask(kind: "thread" | "reweave" | "return", organId: string, sha?: string) {
  const out: { settled: boolean; error: unknown } = { settled: false, error: undefined };
  const p = requestBody(kind, organId, sha);
  p.then(
    () => { out.settled = true; },
    (e) => { out.settled = true; out.error = e; },
  );
  return { p, out };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BodyRequest — nothing happens until the owner says yes", () => {
  it("a reweave request renders the card, names the organ, and starts nothing", async () => {
    const a = await mount();
    const { out } = ask("reweave", "notes");
    await act(async () => {});

    expect(screen.getByTestId("consent-reweave_consent")).toBeInTheDocument();
    expect(screen.getByTestId("consent-note")).toHaveTextContent("notes asked");
    expect(a.reweave).not.toHaveBeenCalled();
    expect(out.settled).toBe(false);
  });

  it("REWEAVE runs the protected orchestration once and settles the organ's promise", async () => {
    const a = await mount();
    const { p } = ask("reweave", "notes");
    await act(async () => {});
    await userEvent.click(screen.getByRole("button", { name: "REWEAVE" }));
    await expect(p).resolves.toBeUndefined();
    expect(a.reweave).toHaveBeenCalledTimes(1);
    // A second press cannot reach the orchestration — the request is answered
    // and gone. (AnimatePresence keeps a frozen exit snapshot in jsdom, so the
    // card's absence is not asserted; see the same note in KernelDiff.test.)
    await userEvent.click(screen.getByRole("button", { name: "REWEAVE" }));
    expect(a.reweave).toHaveBeenCalledTimes(1);
  });

  it("NOT NOW rejects with the calm refusal and touches nothing", async () => {
    const a = await mount();
    const { p } = ask("reweave", "notes");
    await act(async () => {});
    await userEvent.click(screen.getByRole("button", { name: "NOT NOW" }));
    await expect(p).rejects.toBeInstanceOf(BodyRequestDeclined);
    expect(a.reweave).not.toHaveBeenCalled();
  });

  it("a refused start comes back as the core's own reason, not silence", async () => {
    const a = await mount(acts({ reweave: vi.fn(async () => ({ ok: false, reason: "a weave is already under way" })) }));
    const { p } = ask("reweave", "notes");
    await act(async () => {});
    await userEvent.click(screen.getByRole("button", { name: "REWEAVE" }));
    await expect(p).rejects.toThrow("a weave is already under way");
    expect(a.reweave).toHaveBeenCalledTimes(1);
  });

  it("THREAD runs the ceremony; the card carries the network line first", async () => {
    const a = await mount();
    const { p } = ask("thread", "settings");
    await act(async () => {});
    expect(screen.getByTestId("consent-thread_consent")).toHaveTextContent(
      "threading needs the network once — after that LOOM weaves offline",
    );
    expect(a.thread).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "THREAD" }));
    await expect(p).resolves.toBeUndefined();
    expect(a.thread).toHaveBeenCalledTimes(1);
  });

  it("RETURN passes the sha the organ asked for", async () => {
    const a = await mount();
    const { p } = ask("return", "settings", PREV);
    await act(async () => {});
    expect(screen.getByTestId("consent-generation_return_consent")).toHaveTextContent(
      "return to generation 9b8c7d — LOOM will close and return",
    );
    await userEvent.click(screen.getByRole("button", { name: "RETURN" }));
    await expect(p).resolves.toBeUndefined();
    expect(a.returnTo).toHaveBeenCalledWith(PREV);
  });
});

describe("BodyRequest — the line is chrome's, not the organ's", () => {
  it("names the genome sha chrome read, whatever the organ sent", async () => {
    await mount();
    ask("reweave", "notes");
    await act(async () => {});
    expect(screen.getByTestId("consent-reweave_consent")).toHaveTextContent(
      "weave generation 3f2a1c — LOOM will close and return",
    );
  });

  it("off macOS it never promises a close and return", async () => {
    await mount(acts(), false);
    ask("reweave", "notes");
    await act(async () => {});
    expect(screen.getByTestId("consent-reweave_consent")).toHaveTextContent(
      /the swap is macOS-only in this generation/,
    );
  });

  it("outside the shell the identity read fails and the dev framing stands", async () => {
    const failing = vi.fn(async () => {
      throw new Error("This surface needs the desktop shell.");
    });
    render(<BodyRequest identity={failing} acts={acts()} />);
    await act(async () => {});
    ask("reweave", "notes");
    await act(async () => {});
    expect(screen.getByTestId("consent-reweave_consent")).toHaveTextContent(
      /in dev the body stays/,
    );
  });
});

describe("BodyRequest — one card at a time", () => {
  it("a second request while one is open is refused, not stacked", async () => {
    await mount();
    const first = ask("reweave", "notes");
    const second = ask("thread", "clock");
    await act(async () => {});
    await expect(second.p).rejects.toThrow(LINE_BUSY);
    // Only the first organ's card is on screen — the second never rendered.
    expect(screen.getByTestId("consent-reweave_consent")).toBeInTheDocument();
    expect(screen.queryByTestId("consent-thread_consent")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "NOT NOW" }));
    await expect(first.p).rejects.toBeInstanceOf(BodyRequestDeclined);
  });
});

/**
 * Round-2 finding 1: the event detail carried the whole request, and chrome
 * read `kind` / `sha` / `organId` off that same mutable object at CLICK time —
 * long after the sentence was composed. Organs share the shell's realm, so any
 * of them can listen for `loom-body-request`, hold the reference, and change it
 * between the reading and the act. The card and the act both come from the
 * claimed record now, which nothing outside this module can reach.
 */
describe("BodyRequest — the card and the act read the same claimed record", () => {
  /** An organ that keeps the event's detail and edits it later. */
  function eavesdrop() {
    const held: { detail: Record<string, unknown> | null } = { detail: null };
    const on = (ev: Event) => {
      held.detail = (ev as CustomEvent).detail as Record<string, unknown>;
    };
    window.addEventListener(BODY_REQUEST_EVENT, on);
    return { held, off: () => window.removeEventListener(BODY_REQUEST_EVENT, on) };
  }

  it("a kind swapped after the card is drawn cannot turn a THREAD into a weave", async () => {
    const a = await mount();
    const spy = eavesdrop();
    const { p } = ask("thread", "notes");
    await act(async () => {});
    expect(screen.getByTestId("consent-thread_consent")).toBeInTheDocument();
    // The owner is reading "threading needs the network once" above a THREAD
    // button. The organ swaps the kind underneath it.
    if (spy.held.detail) spy.held.detail.kind = "reweave";
    await userEvent.click(screen.getByRole("button", { name: "THREAD" }));
    await expect(p).resolves.toBeUndefined();
    expect(a.thread).toHaveBeenCalledTimes(1);
    expect(a.reweave).not.toHaveBeenCalled();
    spy.off();
  });

  it("a sha swapped after the card is drawn cannot redirect the return", async () => {
    const a = await mount();
    const spy = eavesdrop();
    const { p } = ask("return", "settings", PREV);
    await act(async () => {});
    expect(screen.getByTestId("consent-generation_return_consent")).toHaveTextContent("9b8c7d");
    if (spy.held.detail) spy.held.detail.sha = SHA;
    await userEvent.click(screen.getByRole("button", { name: "RETURN" }));
    await expect(p).resolves.toBeUndefined();
    expect(a.returnTo).toHaveBeenCalledWith(PREV);
    spy.off();
  });

  it("the organ that asked cannot make the card name another one", async () => {
    await mount();
    // Mutated in the same breath as the dispatch — before the card renders.
    const on = (ev: Event) => {
      const d = (ev as CustomEvent).detail as Record<string, unknown>;
      if (d) d.organId = "clock";
    };
    window.addEventListener(BODY_REQUEST_EVENT, on);
    ask("reweave", "notes");
    await act(async () => {});
    expect(screen.getByTestId("consent-note")).toHaveTextContent("notes asked");
    window.removeEventListener(BODY_REQUEST_EVENT, on);
  });

  it("a synthetic event with an id nobody issued raises no card", async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(BODY_REQUEST_EVENT, {
          detail: { id: "body-999-forged", kind: "reweave", organId: "loom", sha: SHA },
        }),
      );
    });
    expect(screen.queryByTestId("body-request")).not.toBeInTheDocument();
  });
});

/**
 * Round-2 finding 2: identity was read once at mount, so after a packaged
 * self-edit moved the genome head — the sequence this phase exists for — the
 * card still named the OLD sha, and `canSwap` was stale with it.
 */
describe("BodyRequest — the body is read when the request is claimed", () => {
  it("a second request names the genome as it is now, not as it was at mount", async () => {
    const heads = [SHA, PREV];
    let n = 0;
    const identity = async () => ({
      ...(await PACKAGED()),
      genomeSha: heads[Math.min(n++, heads.length - 1)],
    });
    render(<BodyRequest identity={identity} acts={acts()} />);
    await act(async () => {});

    const first = ask("reweave", "notes");
    await act(async () => {});
    expect(screen.getByTestId("consent-reweave_consent")).toHaveTextContent("weave generation 3f2a1c");
    await userEvent.click(screen.getByRole("button", { name: "NOT NOW" }));
    await expect(first.p).rejects.toBeInstanceOf(BodyRequestDeclined);

    ask("reweave", "notes");
    await act(async () => {});
    expect(screen.getByTestId("consent-reweave_consent")).toHaveTextContent("weave generation 9b8c7d");
  });

  it("a body that became swappable is not still described as one that cannot swap", async () => {
    const swaps = [false, true];
    let n = 0;
    const identity = async () => ({
      ...(await PACKAGED()),
      canSwap: swaps[Math.min(n++, swaps.length - 1)],
    });
    render(<BodyRequest identity={identity} acts={acts()} />);
    await act(async () => {});

    const first = ask("reweave", "notes");
    await act(async () => {});
    expect(screen.getByTestId("consent-reweave_consent")).toHaveTextContent(/macOS-only/);
    await userEvent.click(screen.getByRole("button", { name: "NOT NOW" }));
    await expect(first.p).rejects.toBeInstanceOf(BodyRequestDeclined);

    ask("reweave", "notes");
    await act(async () => {});
    expect(screen.getByTestId("consent-reweave_consent")).toHaveTextContent(
      "weave generation 3f2a1c — LOOM will close and return",
    );
  });
});

/**
 * Round-2 finding 3: the double-fire guard was state, and three clicks inside
 * one React tick all read the same stale `false`. The Companion documents this
 * exact hazard and guards with a ref; so does this card now.
 */
describe("BodyRequest — one press, one act", () => {
  it("three clicks in a single tick run the orchestration once", async () => {
    const a = await mount();
    const { p } = ask("reweave", "notes");
    await act(async () => {});
    const btn = screen.getByRole("button", { name: "REWEAVE" });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    await expect(p).resolves.toBeUndefined();
    expect(a.reweave).toHaveBeenCalledTimes(1);
  });
});

/**
 * Round-2 finding 4: unmounting with a card open removed the listener without
 * answering, so the organ's promise never settled and the pending entry leaked
 * — reachable from any render throw inside the surrounding ErrorBoundary.
 */
describe("BodyRequest — an unmount answers the card it is taking away", () => {
  it("the organ hears the no-chrome line instead of waiting forever", async () => {
    const a = acts();
    const { unmount } = render(<BodyRequest identity={PACKAGED} acts={a} />);
    await act(async () => {});
    const { p } = ask("reweave", "notes");
    await act(async () => {});
    expect(screen.getByTestId("body-request")).toBeInTheDocument();
    unmount();
    await expect(p).rejects.toThrow(LINE_NO_CHROME);
    expect(pendingBodyRequests()).toBe(0);
    expect(a.reweave).not.toHaveBeenCalled();
  });
});
