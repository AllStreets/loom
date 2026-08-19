import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgoraDeck from "./AgoraDeck";

// Mock framer-motion so reducedMotion=true (no fade, simpler assertions)
vi.mock("framer-motion", () => ({
  useReducedMotion: () => true,
}));

// Mock settings
vi.mock("../../lib/voice/settings", () => ({
  getSetting: () => "http://localhost:3000",
}));

// Helper to create a fetch that resolves (reachable)
function makeResolvingFetch() {
  return vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
}

// Helper to create a fetch that rejects (unreachable)
function makeRejectingFetch() {
  return vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgoraDeck — probe resolves (reachable)", () => {
  it("renders iframe with testid agora-deck-iframe", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-deck-iframe")).not.toBeNull();
    });
  });

  it("iframe sandbox='allow-scripts allow-same-origin allow-forms'", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const iframe = screen.getByTestId("agora-deck-iframe") as HTMLIFrameElement;
      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    });
  });

  it("iframe title='AGORA Exchange'", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const iframe = screen.getByTestId("agora-deck-iframe") as HTMLIFrameElement;
      expect(iframe.getAttribute("title")).toBe("AGORA Exchange");
    });
  });

  it("interact=true → pointerEvents 'auto' on iframe", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const iframe = screen.getByTestId("agora-deck-iframe") as HTMLIFrameElement;
      expect(iframe.style.pointerEvents).toBe("auto");
    });
  });

  it("interact=false → pointerEvents 'none' on iframe", async () => {
    vi.stubGlobal("fetch", makeResolvingFetch());
    render(<AgoraDeck interact={false} />);

    await waitFor(() => {
      const iframe = screen.getByTestId("agora-deck-iframe") as HTMLIFrameElement;
      expect(iframe.style.pointerEvents).toBe("none");
    });
  });
});

describe("AgoraDeck — probe rejects (unreachable)", () => {
  it("renders offline card with testid agora-offline-card", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-offline-card")).not.toBeNull();
    });
  });

  it("offline card has 'THE EXCHANGE IS DARK' text", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByText("THE EXCHANGE IS DARK")).not.toBeNull();
    });
  });

  it("offline card has RETRY button with testid agora-retry-btn", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-retry-btn")).not.toBeNull();
    });
  });

  it("does NOT render iframe when unreachable", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-offline-card")).not.toBeNull();
    });
    expect(screen.queryByTestId("agora-deck-iframe")).toBeNull();
  });
});

describe("AgoraDeck — initial state", () => {
  it("shows probing card initially (testid agora-probing)", async () => {
    // Use a fetch that never resolves so we can catch the probing state
    let resolveFetch!: () => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = () => resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingFetch));

    render(<AgoraDeck interact={false} />);

    // Should show probing immediately
    expect(screen.getByTestId("agora-probing")).not.toBeNull();

    // Clean up — resolve the pending fetch
    resolveFetch();
    await waitFor(() => {
      expect(screen.queryByTestId("agora-probing")).toBeNull();
    });
  });
});

describe("AgoraDeck — no command listener", () => {
  it("does NOT register loom-deck-command listener", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    const addEventSpy = vi.spyOn(window, "addEventListener");

    render(<AgoraDeck interact={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-offline-card")).not.toBeNull();
    });

    const callArgs = addEventSpy.mock.calls.map((c) => c[0]);
    expect(callArgs).not.toContain("loom-deck-command");
  });
});

describe("AgoraDeck — RETRY button re-probes", () => {
  it("clicking RETRY re-runs the probe", async () => {
    const fetchMock = makeRejectingFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<AgoraDeck interact={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-retry-btn")).not.toBeNull();
    });

    const retryBtn = screen.getByTestId("agora-retry-btn");
    await userEvent.click(retryBtn);

    // fetch should have been called at least twice (initial probe + retry)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("AgoraDeck — health strip renders when reachable", () => {
  it("health strip is present when reachable", async () => {
    // web probe resolves; engine probe will be called after
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-health-strip")).not.toBeNull();
    });
  });

  it("WEB chip is present when reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-health-web")).not.toBeNull();
    });
  });

  it("ENGINE chip is present when reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-health-engine")).not.toBeNull();
    });
  });

  it("health strip is NOT present when unreachable", async () => {
    vi.stubGlobal("fetch", makeRejectingFetch());
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("agora-offline-card")).not.toBeNull();
    });
    expect(screen.queryByTestId("agora-health-strip")).toBeNull();
  });
});

describe("AgoraDeck — engine health probe (HTTP /health)", () => {
  it("engine dot shows healthy when engine returns ok:true", async () => {
    // Both the web probe and engine probe resolve with ok:true
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const dot = screen.getByTestId("agora-health-engine").querySelector("[data-health]");
      expect(dot?.getAttribute("data-health")).toBe("healthy");
    });
  });

  it("engine dot shows down when engine fetch rejects", async () => {
    // Web probe (localhost:3000) resolves; engine probe (localhost:8080) rejects
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("8080")) {
          return Promise.reject(new Error("ECONNREFUSED"));
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const dot = screen.getByTestId("agora-health-engine").querySelector("[data-health]");
      expect(dot?.getAttribute("data-health")).toBe("down");
    });
  });

  it("engine dot shows down when engine returns ok:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("8080")) {
          return Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 200 }));
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      })
    );
    render(<AgoraDeck interact={true} />);

    await waitFor(() => {
      const dot = screen.getByTestId("agora-health-engine").querySelector("[data-health]");
      expect(dot?.getAttribute("data-health")).toBe("down");
    });
  });
});

describe("AgoraDeck — engine interval lifecycle", () => {
  it("re-probes engine after 60s", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<AgoraDeck interact={true} />);
    });

    // Wait for web probe + initial engine probe to settle
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsBefore = fetchMock.mock.calls.length;

    // Advance 60s to trigger the interval
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);

    vi.useRealTimers();
  });

  it("clears engine interval on unmount", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = render(<AgoraDeck interact={true} />));
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => { unmount(); });

    const callsAfterUnmount = fetchMock.mock.calls.length;

    // Advance well past 60s; no additional calls should fire
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterUnmount);

    vi.useRealTimers();
  });
});
