import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
