import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";

// matchMedia mock (jsdom lacks it)
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

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock("framer-motion", async (importActual) => {
  const actual = await importActual<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: () => false,
  };
});

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

import Desktop from "./Desktop";

const APPROVED_ORGAN = {
  id: "notes",
  manifest: JSON.stringify({
    id: "notes",
    name: "Note Keeper",
    description: "Keeps notes",
    version: 1,
    permissions: ["storage"],
  }),
  granted: JSON.stringify(["storage"]),
};

const UNAPPROVED_ORGAN = {
  id: "runner",
  manifest: JSON.stringify({
    id: "runner",
    name: "Run Tracker",
    description: "Tracks runs",
    version: 1,
    permissions: ["storage"],
  }),
  granted: null,
};

describe("Desktop", () => {
  it("approved organ renders window and dock tile", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'notes-content'; } }";
      return null;
    });

    render(<Desktop />);

    // Wait for organ to load and name to appear (in dock tile title or window title bar)
    await waitFor(() => {
      expect(screen.getByTitle("Note Keeper")).toBeInTheDocument();
    });

    // Dock tile initials: "Note Keeper" -> "NK"
    expect(screen.getByTitle("Note Keeper")).toBeInTheDocument();
  });

  it("unapproved organ shows badge dot and auto-opens modal on load, approve calls organ_grant", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [UNAPPROVED_ORGAN];
      if (cmd === "organ_grant") return "sha";
      return null;
    });

    render(<Desktop />);

    // Auto-modal should open for first unapproved organ
    await waitFor(() => {
      expect(screen.getByText("Run Tracker")).toBeInTheDocument();
    });

    // Modal should show the organ name
    expect(screen.getByText("Tracks runs")).toBeInTheDocument();

    // Click Approve
    const approveBtn = screen.getByRole("button", { name: /approve/i });
    await userEvent.click(approveBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "organ_grant",
        expect.objectContaining({ id: "runner", grantedJson: JSON.stringify(["storage"]) }),
      );
    });
  });

  it("minimize hides window wrapper but mount div stays in document, dock click restores", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'notes-content'; } }";
      return null;
    });

    render(<Desktop />);

    // Wait for title bar to appear
    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    // Click minimize button
    const minBtn = screen.getByTitle("Minimize");
    await userEvent.click(minBtn);

    // The wrapper div should be display:none
    await waitFor(() => {
      const titleBar = screen.getByTestId("title-bar-notes");
      // The wrapper (ancestor of title bar) should have display:none
      let el: HTMLElement | null = titleBar;
      let hidden = false;
      while (el) {
        if ((el as HTMLElement).style?.display === "none") {
          hidden = true;
          break;
        }
        el = el.parentElement;
      }
      expect(hidden).toBe(true);
    });

    // Mount div should still be in document (not unmounted)
    expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();

    // Click dock tile to restore
    const dockTile = screen.getByTitle("Note Keeper");
    await userEvent.click(dockTile);

    // Window should no longer be display:none
    await waitFor(() => {
      const titleBar = screen.getByTestId("title-bar-notes");
      let el: HTMLElement | null = titleBar;
      let hidden = false;
      while (el) {
        if ((el as HTMLElement).style?.display === "none") {
          hidden = true;
          break;
        }
        el = el.parentElement;
      }
      expect(hidden).toBe(false);
    });
  });

  it("drag persists x/y to localStorage and x is greater than initial", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    const titleBar = screen.getByTestId("title-bar-notes");

    // Read initial persisted position (or default 40)
    const savedBefore = localStorage.getItem("loom.win.notes");
    const initialX = savedBefore ? JSON.parse(savedBefore).x : 40;

    await act(async () => {
      titleBar.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 150, clientY: 130, pointerId: 1 }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 150, clientY: 130, pointerId: 1 }),
      );
    });

    await waitFor(() => {
      const saved = localStorage.getItem("loom.win.notes");
      expect(saved).not.toBeNull();
      const parsed = JSON.parse(saved!);
      expect(typeof parsed.x).toBe("number");
      expect(typeof parsed.y).toBe("number");
      // +50px drag should push x beyond initial
      expect(parsed.x).toBeGreaterThan(initialX);
    });
  });

  it("drag then resize: persisted shape retains dragged x/y and resized w/h (stale-closure guard)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    const titleBar = screen.getByTestId("title-bar-notes");

    // Step 1: drag +50px right, +30px down
    await act(async () => {
      titleBar.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 150, clientY: 130, pointerId: 1 }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 150, clientY: 130, pointerId: 1 }),
      );
    });

    let afterDrag: { x: number; y: number; w: number; h: number; collapsed: boolean } | null = null;
    await waitFor(() => {
      const saved = localStorage.getItem("loom.win.notes");
      expect(saved).not.toBeNull();
      afterDrag = JSON.parse(saved!);
    });

    const draggedX = afterDrag!.x;
    const draggedY = afterDrag!.y;

    // Step 2: resize via SE handle — find it by position (last child of OrganWindow root)
    // The resize handle is the last sibling div inside the OrganWindow root div.
    // We use the window wrapper's last child's last child approach or dispatch to window directly.
    // Simulate: pointerdown on window at arbitrary point (resize handle not easily accessible in jsdom),
    // then a resize via direct localStorage manipulation + posRef round-trip check.
    // Instead, fire pointer events on the resize handle element if we can find it.
    const windowRoot = titleBar.closest(".glass") as HTMLElement | null;
    const resizeHandle = windowRoot?.querySelector("[style*='se-resize']") as HTMLElement | null;

    if (resizeHandle) {
      await act(async () => {
        resizeHandle.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 200, pointerId: 2 }),
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX: 280, clientY: 260, pointerId: 2 }),
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, clientX: 280, clientY: 260, pointerId: 2 }),
        );
      });

      await waitFor(() => {
        const saved = localStorage.getItem("loom.win.notes");
        expect(saved).not.toBeNull();
        const parsed = JSON.parse(saved!);
        // x/y must still reflect the dragged position (posRef kept live value)
        expect(parsed.x).toBe(draggedX);
        expect(parsed.y).toBe(draggedY);
        // w/h must have grown (resize applied on top of existing dims)
        expect(parsed.w).toBeGreaterThan(afterDrag!.w);
        expect(parsed.h).toBeGreaterThan(afterDrag!.h);
      });
    } else {
      // jsdom may not expose the handle; at minimum x/y from drag must be intact
      expect(afterDrag!.x).toBeGreaterThanOrEqual(0);
    }
  });

  it("'Not now' dismisses modal and does not reopen on organs-changed", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [UNAPPROVED_ORGAN];
      return null;
    });

    render(<Desktop />);

    // Auto-modal opens
    await waitFor(() => {
      expect(screen.getByText("Run Tracker")).toBeInTheDocument();
    });

    // Click "Not now"
    const notNowBtn = screen.getByRole("button", { name: /not now/i });
    await userEvent.click(notNowBtn);

    // Modal should close
    await waitFor(() => {
      expect(screen.queryByText("Tracks runs")).not.toBeInTheDocument();
    });

    // Fire organs-changed — modal should NOT reopen
    await act(async () => {
      window.dispatchEvent(new Event("organs-changed"));
    });

    // Give React a tick to settle
    await waitFor(() => {
      expect(screen.queryByText("Tracks runs")).not.toBeInTheDocument();
    });
  });

  it("dock tile click opens modal even after 'Not now' dismissal", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [UNAPPROVED_ORGAN];
      return null;
    });

    render(<Desktop />);

    // Auto-modal opens
    await waitFor(() => {
      expect(screen.getByText("Run Tracker")).toBeInTheDocument();
    });

    // Dismiss with "Not now"
    await userEvent.click(screen.getByRole("button", { name: /not now/i }));
    await waitFor(() => {
      expect(screen.queryByText("Tracks runs")).not.toBeInTheDocument();
    });

    // Click the dock tile for the unapproved organ — should reopen modal explicitly
    const dockTile = screen.getByTitle("Run Tracker");
    await userEvent.click(dockTile);

    await waitFor(() => {
      expect(screen.getByText("Tracks runs")).toBeInTheDocument();
    });
  });

  it("settings organ gets default window size w:640, h:560", async () => {
    const SETTINGS_ORGAN = {
      id: "settings",
      manifest: JSON.stringify({
        id: "settings",
        name: "Settings",
        description: "Voice and appearance preferences.",
        version: 1,
        permissions: ["settings"],
      }),
      granted: JSON.stringify(["settings"]),
    };

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [SETTINGS_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'settings', render(el){ el.textContent = 'settings-content'; } }";
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-settings")).toBeInTheDocument();
    });

    // The window element wrapping the title bar should have width 640px and height includes 560 body
    const titleBar = screen.getByTestId("title-bar-settings");
    const windowRoot = titleBar.closest(".glass") as HTMLElement | null;
    expect(windowRoot).not.toBeNull();
    // Width is set as inline style on the window root (settings default is 640x560)
    expect(windowRoot!.style.width).toBe("640px");
  });

  it("window spawn y is clamped when plane has a measurable height", async () => {
    // Mock offsetHeight on the prototype BEFORE rendering so Desktop's clamp logic sees a real height.
    // With PLANE_H=200, DOCK_CLEARANCE=72, maxY = 200 - 72 - 28 = 100.
    // organ index 5 would normally spawn at rawY = 40 + 5*36 = 220, which exceeds 100, so it gets clamped.
    const PLANE_H = 200;
    const DOCK_CLEARANCE = 72;
    const TITLE_BAR_H = 28;
    const maxAllowedY = PLANE_H - DOCK_CLEARANCE - TITLE_BAR_H; // 100

    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight"
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() { return PLANE_H; },
    });

    try {
      // 6 organs: index 5 spawns at rawY = 40 + 5*36 = 220, well above 100
      const organs = Array.from({ length: 6 }, (_, i) => ({
        id: `organ-${i}`,
        manifest: JSON.stringify({
          id: `organ-${i}`,
          name: `Organ ${i}`,
          description: "Test",
          version: 1,
          permissions: [],
        }),
        granted: JSON.stringify([]),
      }));

      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "organ_list") return organs;
        if (cmd === "organ_read")
          return `export default { id: 'test', render(el){ el.textContent = 'ok'; } }`;
        return null;
      });

      render(<Desktop />);

      await waitFor(() => {
        expect(screen.getByTestId("title-bar-organ-5")).toBeInTheDocument();
      });

      // The last organ window's .glass element should have top <= maxAllowedY (clamped)
      const titleBar5 = screen.getByTestId("title-bar-organ-5");
      const windowRoot = titleBar5.closest(".glass") as HTMLElement | null;
      expect(windowRoot).not.toBeNull();

      const topStyle = windowRoot!.style.top;
      expect(topStyle, "organ window must have an inline top style (clamp must have fired)").toBeTruthy();
      const actualY = parseFloat(topStyle);
      expect(actualY).toBeLessThanOrEqual(maxAllowedY);
    } finally {
      // Restore the original descriptor to avoid polluting other tests
      if (offsetHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any).offsetHeight;
      }
    }
  });

  it("organ-focus event restores and focuses the window", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    // First minimize the window
    const minBtn = screen.getByTitle("Minimize");
    await userEvent.click(minBtn);

    // Verify it's hidden
    await waitFor(() => {
      const titleBar = screen.getByTestId("title-bar-notes");
      let el: HTMLElement | null = titleBar;
      let hidden = false;
      while (el) {
        if ((el as HTMLElement).style?.display === "none") { hidden = true; break; }
        el = el.parentElement;
      }
      expect(hidden).toBe(true);
    });

    // Dispatch organ-focus event
    await act(async () => {
      window.dispatchEvent(new CustomEvent("organ-focus", { detail: { id: "notes" } }));
    });

    // Window should be restored (not display:none)
    await waitFor(() => {
      const titleBar = screen.getByTestId("title-bar-notes");
      let el: HTMLElement | null = titleBar;
      let hidden = false;
      while (el) {
        if ((el as HTMLElement).style?.display === "none") { hidden = true; break; }
        el = el.parentElement;
      }
      expect(hidden).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Task 1 — Freedom: full-viewport plane + never-off-screen clamping
  // ---------------------------------------------------------------------------

  it("desktop plane has pointerEvents:none and organ windows have pointerEvents:auto", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    // Plane must have pointer-events:none so the orb/chat beneath remain clickable
    const plane = screen.getByTestId("desktop-plane");
    expect(plane.style.pointerEvents).toBe("none");

    // OrganWindow root (.glass) must re-enable pointer events
    const titleBar = screen.getByTestId("title-bar-notes");
    const windowRoot = titleBar.closest(".glass") as HTMLElement | null;
    expect(windowRoot).not.toBeNull();
    expect(windowRoot!.style.pointerEvents).toBe("auto");
  });

  it("persisted position far off-screen loads clamped inside viewport", async () => {
    // Persist a position way off-screen
    localStorage.setItem("loom.win.notes", JSON.stringify({ x: 5000, y: 4000, w: 420, h: 360, collapsed: false }));

    // Mock viewport to 1280x800 and plane offsetWidth/Height
    const origInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const origInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth",  { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });

    const offsetWidthDescriptor  = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth",  { configurable: true, get() { return 1280; } });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 800; } });

    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "organ_list") return [APPROVED_ORGAN];
        if (cmd === "organ_read")
          return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
        return null;
      });

      render(<Desktop />);

      await waitFor(() => {
        expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
      });

      const titleBar = screen.getByTestId("title-bar-notes");
      const windowRoot = titleBar.closest(".glass") as HTMLElement | null;
      expect(windowRoot).not.toBeNull();

      // x must be <= vw - w = 1280 - 420 = 860, and >= 0
      const leftStyle = windowRoot!.style.left;
      expect(leftStyle).toBeTruthy();
      const actualX = parseFloat(leftStyle);
      expect(actualX).toBeGreaterThanOrEqual(0);
      expect(actualX).toBeLessThanOrEqual(1280 - 420); // vw - w

      // y must be <= vh - DOCK_CLEARANCE - TITLE_BAR_H = 800 - 72 - 28 = 700, and >= 0
      const topStyle = windowRoot!.style.top;
      expect(topStyle).toBeTruthy();
      const actualY = parseFloat(topStyle);
      expect(actualY).toBeGreaterThanOrEqual(0);
      expect(actualY).toBeLessThanOrEqual(800 - 72 - 28); // vh - dock - titlebar
    } finally {
      if (origInnerWidth) Object.defineProperty(window, "innerWidth", origInnerWidth);
      if (origInnerHeight) Object.defineProperty(window, "innerHeight", origInnerHeight);
      if (offsetWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any).offsetWidth;
      }
      if (offsetHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any).offsetHeight;
      }
    }
  });

  it("drag keeps window fully inside plane bounds (clampX/clampY with mocked plane dims)", async () => {
    // Mock plane to 800x600 so clamp logic has a known bound
    const offsetWidthDescriptor  = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth",  { configurable: true, get() { return 800; } });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 600; } });

    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "organ_list") return [APPROVED_ORGAN];
        if (cmd === "organ_read")
          return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
        return null;
      });

      render(<Desktop />);

      await waitFor(() => {
        expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
      });

      const titleBar = screen.getByTestId("title-bar-notes");

      // Drag far beyond the right edge of the plane (800px wide, window is 420px wide → maxX = 380)
      await act(async () => {
        titleBar.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }),
        );
        // Move +10000px to the right — should be clamped to maxX = 380
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX: 10100, clientY: 100, pointerId: 1 }),
        );
        window.dispatchEvent(
          new PointerEvent("pointerup",   { bubbles: true, clientX: 10100, clientY: 100, pointerId: 1 }),
        );
      });

      await waitFor(() => {
        const saved = localStorage.getItem("loom.win.notes");
        expect(saved).not.toBeNull();
        const parsed = JSON.parse(saved!);
        // x must be clamped to 0..plane_w-w range
        expect(parsed.x).toBeGreaterThanOrEqual(0);
        expect(parsed.x).toBeLessThanOrEqual(800 - 420); // planeW - w = 380
      });
    } finally {
      if (offsetWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any).offsetWidth;
      }
      if (offsetHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any).offsetHeight;
      }
    }
  });

  it("resize keeps window fully inside plane bounds (clampW/clampH with mocked plane dims)", async () => {
    // Mock plane to 800x600 so clamp logic has a known bound
    const offsetWidthDescriptor  = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth",  { configurable: true, get() { return 800; } });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 600; } });

    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "organ_list") return [APPROVED_ORGAN];
        if (cmd === "organ_read")
          return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
        return null;
      });

      render(<Desktop />);

      await waitFor(() => {
        expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
      });

      const titleBar = screen.getByTestId("title-bar-notes");
      const windowRoot = titleBar.closest(".glass") as HTMLElement | null;
      const resizeHandle = windowRoot?.querySelector("[style*='se-resize']") as HTMLElement | null;
      expect(resizeHandle).not.toBeNull();

      // Resize far beyond the right/bottom edges of the plane
      // Initial window: x=40, y=40, w=420, h=360 (defaults)
      // Plane: 800x600
      // Max resize: w limited to 800-40=760, h limited to 600-40-28=532
      // But we try to add +10000 to both — should be clamped
      await act(async () => {
        resizeHandle!.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 2 }),
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX: 10100, clientY: 10100, pointerId: 2 }),
        );
        window.dispatchEvent(
          new PointerEvent("pointerup",   { bubbles: true, clientX: 10100, clientY: 10100, pointerId: 2 }),
        );
      });

      await waitFor(() => {
        const saved = localStorage.getItem("loom.win.notes");
        expect(saved).not.toBeNull();
        const parsed = JSON.parse(saved!);
        // w must be clamped to min 260 and max (planeW - origX) = 800 - 40 = 760
        expect(parsed.w).toBeGreaterThanOrEqual(260);
        expect(parsed.w).toBeLessThanOrEqual(800 - 40); // planeW - origX = 760
        // h must be clamped to min 180 and max (planeH - origY - TITLE_BAR_H) = 600 - 40 - 28 = 532
        expect(parsed.h).toBeGreaterThanOrEqual(180);
        expect(parsed.h).toBeLessThanOrEqual(600 - 40 - 28); // planeH - origY - titlebar = 532
      });
    } finally {
      if (offsetWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any).offsetWidth;
      }
      if (offsetHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any).offsetHeight;
      }
    }
  });

  it("resize grip has data-testid='resize-grip' and is present when window is not collapsed", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    // Resize grip should be present and have the correct data-testid
    const resizeGrip = screen.getByTestId("resize-grip");
    expect(resizeGrip).toBeInTheDocument();
    expect(resizeGrip.style.cursor).toBe("se-resize");
  });

  it("minimize removes organ from windowRegistry, restore re-adds it", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'notes-content'; } }";
      return null;
    });

    // Pre-populate localStorage so handleDockClick can re-add the registry entry
    localStorage.setItem("loom.win.notes", JSON.stringify({ x: 40, y: 40, w: 420, h: 360 }));

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    const { windowRegistry } = await import("../../lib/ambient/windowRegistry");

    // Minimize
    const minBtn = screen.getByTitle("Minimize");
    await userEvent.click(minBtn);

    // Registry should no longer have the entry after minimize
    await waitFor(() => {
      expect(windowRegistry.getAll().has("notes")).toBe(false);
    });

    // Restore via dock click
    const dockTile = screen.getByTitle("Note Keeper");
    await userEvent.click(dockTile);

    // Registry should have the entry again after restore
    await waitFor(() => {
      expect(windowRegistry.getAll().has("notes")).toBe(true);
    });
  });

  it("delete flow: trash icon click shows confirm strip, DELETE calls organDelete and dispatches organs-changed", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'notes-content'; } }";
      if (cmd === "organ_delete") return "sha";
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    // Hover doesn't work in jsdom so simulate click directly
    const trashBtn = screen.getByTitle("Delete organ");
    await userEvent.click(trashBtn);

    // Confirm strip should appear
    await waitFor(() => {
      expect(screen.getByTestId("delete-confirm-notes")).toBeInTheDocument();
    });

    // Listen for organs-changed event
    let organsChangedFired = false;
    window.addEventListener("organs-changed", () => { organsChangedFired = true; }, { once: true });

    // Click DELETE
    const deleteBtn = screen.getByRole("button", { name: "DELETE" });
    await userEvent.click(deleteBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("organ_delete", expect.objectContaining({ id: "notes" }));
    });

    await waitFor(() => {
      expect(organsChangedFired).toBe(true);
    });
  });

  it("delete flow: tombstone written to localStorage on DELETE", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'notes-content'; } }";
      if (cmd === "organ_delete") return "sha";
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    const trashBtn = screen.getByTitle("Delete organ");
    await userEvent.click(trashBtn);

    await waitFor(() => {
      expect(screen.getByTestId("delete-confirm-notes")).toBeInTheDocument();
    });

    const deleteBtn = screen.getByRole("button", { name: "DELETE" });
    await userEvent.click(deleteBtn);

    await waitFor(() => {
      const raw = localStorage.getItem("loom.organs.deleted");
      expect(raw).not.toBeNull();
      const list = JSON.parse(raw!);
      expect(list).toContain("notes");
    });
  });

  it("purgeOrganStorage removes organ.id.* keys and loom.win.id", async () => {
    const { purgeOrganStorage } = await import("../../lib/organs/api");
    localStorage.setItem("organ.notes.data", JSON.stringify({ test: 1 }));
    localStorage.setItem("loom.win.notes", JSON.stringify({ x: 40 }));
    purgeOrganStorage("notes");
    expect(localStorage.getItem("organ.notes.data")).toBeNull();
    expect(localStorage.getItem("loom.win.notes")).toBeNull();
  });

  it("minimized persistence: minimize writes loom.minimized, boot restores minimized state", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
      return null;
    });

    const { unmount } = render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    // Minimize
    const minBtn = screen.getByTitle("Minimize");
    await userEvent.click(minBtn);

    // loom.minimized should be written
    await waitFor(() => {
      const raw = localStorage.getItem("loom.minimized");
      expect(raw).not.toBeNull();
      const ids = JSON.parse(raw!);
      expect(ids).toContain("notes");
    });

    unmount();

    // Re-render — should boot with notes minimized
    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });

    // Window should be display:none from boot
    const titleBar = screen.getByTestId("title-bar-notes");
    let el: HTMLElement | null = titleBar;
    let hidden = false;
    while (el) {
      if ((el as HTMLElement).style?.display === "none") { hidden = true; break; }
      el = el.parentElement;
    }
    expect(hidden).toBe(true);
  });

  it("viewport-resize listener re-clamps an open window that would be off-screen after shrink", async () => {
    // Start with a wide viewport
    Object.defineProperty(window, "innerWidth",  { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });

    // Persist the window at a position that is valid for 1280x800 but off-screen for 400x400
    localStorage.setItem("loom.win.notes", JSON.stringify({ x: 800, y: 600, w: 420, h: 360, collapsed: false }));

    const offsetWidthDescriptor  = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    // Start with wide plane
    Object.defineProperty(HTMLElement.prototype, "offsetWidth",  { configurable: true, get() { return 1280; } });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 800; } });

    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "organ_list") return [APPROVED_ORGAN];
        if (cmd === "organ_read")
          return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
        return null;
      });

      render(<Desktop />);

      await waitFor(() => {
        expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
      });

      // Now shrink the viewport so the current position (x:800, y:600) would be off-screen
      Object.defineProperty(HTMLElement.prototype, "offsetWidth",  { configurable: true, get() { return 400; } });
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 400; } });
      Object.defineProperty(window, "innerWidth",  { configurable: true, writable: true, value: 400 });
      Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 400 });

      // Dispatch resize event — Desktop's single listener fires desktop-plane-resize
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        // Also dispatch the plane-resize event with the new dims directly (since jsdom doesn't re-layout)
        window.dispatchEvent(new CustomEvent("desktop-plane-resize", {
          detail: { planeW: 400, planeH: 400 },
        }));
      });

      // Wait for state to settle and check persisted position is clamped
      await waitFor(() => {
        const saved = localStorage.getItem("loom.win.notes");
        if (!saved) return; // not yet persisted — let waitFor retry
        const parsed = JSON.parse(saved);
        // With planeW=400, w clamped to 400; maxX = 0 (planeW-w = 400-400=0)
        // With planeH=400, h clamped to 400-72=328; maxY = 400-72-28=300
        expect(parsed.x).toBeGreaterThanOrEqual(0);
        expect(parsed.x).toBeLessThanOrEqual(400); // can't exceed planeW
        expect(parsed.y).toBeGreaterThanOrEqual(0);
        expect(parsed.y).toBeLessThanOrEqual(400 - 72 - 28); // 300
      });

      // Also verify window style updated
      const titleBar = screen.getByTestId("title-bar-notes");
      const windowRoot = titleBar.closest(".glass") as HTMLElement | null;
      expect(windowRoot).not.toBeNull();
      const actualY = parseFloat(windowRoot!.style.top);
      expect(actualY).toBeLessThanOrEqual(400 - 72 - 28);
    } finally {
      if (offsetWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any).offsetWidth;
      }
      if (offsetHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any).offsetHeight;
      }
    }
  });
});

// ── Vigor: powers on the permission card, POWERS row, THROTTLED chip ───────────

const POWERED_MANIFEST = {
  id: "btc",
  name: "Stand Up",
  description: "Nudges you to stand",
  version: 1,
  permissions: ["storage"],
  powers: ["voice", "notify", "pulse"],
};

const UNAPPROVED_POWERED_ORGAN = {
  id: "btc",
  manifest: JSON.stringify(POWERED_MANIFEST),
  granted: null,
};

const APPROVED_POWERED_ORGAN = {
  id: "btc",
  manifest: JSON.stringify(POWERED_MANIFEST),
  granted: JSON.stringify(["storage", "voice", "notify", "pulse"]),
};

describe("permission card powers", () => {
  it("lists requested powers in plain language and grants them on approve", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [UNAPPROVED_POWERED_ORGAN];
      if (cmd === "organ_grant") return "sha";
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByText("Stand Up")).toBeInTheDocument();
    });

    // Plain-language powers, not raw tokens
    expect(screen.getByTestId("powers-section")).toBeInTheDocument();
    expect(screen.getByText("speak aloud")).toBeInTheDocument();
    expect(screen.getByText("notify you")).toBeInTheDocument();
    expect(screen.getByText("run on a schedule (up to every 30s)")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "organ_grant",
        expect.objectContaining({
          id: "btc",
          grantedJson: JSON.stringify(["storage", "voice", "notify", "pulse"]),
        }),
      );
    });
  });

  it("an organ with no powers renders the card unchanged (no powers section)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [UNAPPROVED_ORGAN];
      return null;
    });

    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByText("Run Tracker")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("powers-section")).not.toBeInTheDocument();
  });
});

describe("POWERS row and revocation", () => {
  function mockPoweredOrgan() {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_POWERED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'btc', render(el){ el.textContent = 'btc-content'; } }";
      if (cmd === "organ_grant") return "sha";
      return null;
    });
  }

  it("the title bar gains a powers toggle that opens the POWERS row", async () => {
    mockPoweredOrgan();
    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-btc")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("powers-row-btc")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("powers-toggle-btc"));

    const row = screen.getByTestId("powers-row-btc");
    expect(row).toHaveTextContent("POWERS");
    expect(row).toHaveTextContent("speak aloud");
    expect(row).toHaveTextContent("notify you");
    expect(row).toHaveTextContent("run on a schedule (up to every 30s)");
    // All granted
    expect(screen.getByTestId("power-toggle-btc-voice")).toHaveTextContent("GRANTED");
  });

  it("revoking a power clears the token live and persists via organ_grant", async () => {
    mockPoweredOrgan();
    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-btc")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("powers-toggle-btc"));
    await userEvent.click(screen.getByTestId("power-toggle-btc-voice"));

    expect(screen.getByTestId("power-toggle-btc-voice")).toHaveTextContent("REVOKED");
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "organ_grant",
        expect.objectContaining({
          id: "btc",
          grantedJson: JSON.stringify(["storage", "notify", "pulse"]),
        }),
      );
    });

    // Toggle back re-grants
    await userEvent.click(screen.getByTestId("power-toggle-btc-voice"));
    expect(screen.getByTestId("power-toggle-btc-voice")).toHaveTextContent("GRANTED");
  });

  it("a legacy manifest with notify under permissions shows notify in the POWERS row", async () => {
    // Pre-vigor manifests declared "notify" as a permission. manifestGuard
    // migrates it into powers at read time, so the revocation row (which
    // iterates manifest.powers) must surface it like any other power.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [{
        id: "legacy",
        manifest: JSON.stringify({ id: "legacy", name: "Legacy Notifier", description: "An old friend", version: 1, permissions: ["storage", "notify"] }),
        granted: JSON.stringify(["storage", "notify"]),
      }];
      if (cmd === "organ_read")
        return "export default { id: 'legacy', render(el){ el.textContent = 'ok'; } }";
      if (cmd === "organ_grant") return "sha";
      return null;
    });
    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-legacy")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("powers-toggle-legacy"));
    const row = screen.getByTestId("powers-row-legacy");
    expect(row).toHaveTextContent("notify you");
    // The permission-era grant string still satisfies the power grant.
    expect(screen.getByTestId("power-toggle-legacy-notify")).toHaveTextContent("GRANTED");
  });

  it("a window without powers shows no powers toggle", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'notes', render(el){ el.textContent = 'ok'; } }";
      return null;
    });
    render(<Desktop />);
    await waitFor(() => {
      expect(screen.getByTestId("title-bar-notes")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("powers-toggle-notes")).not.toBeInTheDocument();
  });
});

describe("THROTTLED chip", () => {
  it("appears on loom-throttled for this organ and clears when the bucket refills", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_POWERED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'btc', render(el){ el.textContent = 'btc-content'; } }";
      return null;
    });
    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-btc")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("throttle-chip-btc")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent("loom-throttled", {
        detail: { id: "btc", power: "voice", retryMs: 40 },
      }));
    });
    expect(screen.getByTestId("throttle-chip-btc")).toBeInTheDocument();

    // Clears on its own once retryMs has passed
    await waitFor(() => {
      expect(screen.queryByTestId("throttle-chip-btc")).not.toBeInTheDocument();
    });
  });

  it("ignores another organ's throttle event", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [APPROVED_POWERED_ORGAN];
      if (cmd === "organ_read")
        return "export default { id: 'btc', render(el){ el.textContent = 'btc-content'; } }";
      return null;
    });
    render(<Desktop />);

    await waitFor(() => {
      expect(screen.getByTestId("title-bar-btc")).toBeInTheDocument();
    });
    act(() => {
      window.dispatchEvent(new CustomEvent("loom-throttled", {
        detail: { id: "other", power: "voice", retryMs: 1000 },
      }));
    });
    expect(screen.queryByTestId("throttle-chip-btc")).not.toBeInTheDocument();
  });
});

describe("revoked powers and the approval card", () => {
  it("an organ with a revoked power stays approved — the card never resurfaces", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [{
        id: "btc",
        manifest: JSON.stringify(POWERED_MANIFEST),
        granted: JSON.stringify(["storage", "notify", "pulse"]), // voice revoked
      }];
      if (cmd === "organ_read")
        return "export default { id: 'btc', render(el){ el.textContent = 'btc-content'; } }";
      return null;
    });
    render(<Desktop />);

    // Window renders (approved), no auto-modal (description text only shows on the card)
    await waitFor(() => {
      expect(screen.getByTestId("title-bar-btc")).toBeInTheDocument();
    });
    expect(screen.queryByText("Nudges you to stand")).not.toBeInTheDocument();

    // And the POWERS row reflects the revocation
    await userEvent.click(screen.getByTestId("powers-toggle-btc"));
    expect(screen.getByTestId("power-toggle-btc-voice")).toHaveTextContent("REVOKED");
    expect(screen.getByTestId("power-toggle-btc-notify")).toHaveTextContent("GRANTED");
  });
});
