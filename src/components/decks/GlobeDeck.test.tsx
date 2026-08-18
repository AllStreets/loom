/**
 * GlobeDeck.test.tsx — mount-safe command queue (C1 fix) tests.
 *
 * Simulates the cold deck-switch race:
 *   1. deck is void → deck_command fires with deckSwitch + bridgeCmds
 *   2. sendDeckCommands() enqueues because GlobeDeck not yet mounted
 *   3. GlobeDeck mounts (and iframe fires load)
 *   4. queued commands are flushed → iframe.contentWindow.postMessage called
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { sendDeckCommands } from "./GlobeDeck";
import GlobeDeck from "./GlobeDeck";

vi.mock("framer-motion", () => ({
  useReducedMotion: () => true,
}));

// Helper: create a mock iframe contentWindow with a spy on postMessage.
function makeMockIframe() {
  const postMessage = vi.fn();
  // jsdom doesn't give iframes a real contentWindow; we stub it.
  return { postMessage };
}

beforeEach(() => {
  // Drain any leftover pending cmds between tests by rendering + unmounting GlobeDeck.
  // The module-level pendingCmds array is reset via a mount/unmount cycle below,
  // or simply reset via the exported queue draining on mount.
  // We rely on test isolation via fresh renders.
});

describe("sendDeckCommands — cold switch (C1)", () => {
  it("enqueues cmds when GlobeDeck is not mounted, then flushes on mount+iframe-load", async () => {
    // Simulate: no GlobeDeck mounted yet.
    // Call sendDeckCommands before render.
    sendDeckCommands([{ type: "set_cat", cat: "military" }]);

    // Now render GlobeDeck. The iframe's contentWindow.postMessage needs to be
    // intercepted. We do this by spying on HTMLIFrameElement.prototype to capture
    // the postMessage call via the contentWindow stub.
    const postMessageSpy = vi.fn();

    // jsdom doesn't populate contentWindow on sandboxed iframes; override via prototype.
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      "contentWindow"
    );
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      get() {
        return { postMessage: postMessageSpy, origin: window.location.origin };
      },
      configurable: true,
    });

    try {
      const { unmount, getByTestId } = render(<GlobeDeck interact={false} />);

      // Simulate the iframe load event (jsdom doesn't fire it automatically).
      const iframe = getByTestId("globe-deck-iframe") as HTMLIFrameElement;
      await act(async () => {
        iframe.dispatchEvent(new Event("load"));
      });

      // The queued command should have been posted to the iframe.
      expect(postMessageSpy).toHaveBeenCalledWith(
        { loomDeck: true, cmd: { type: "set_cat", cat: "military" } },
        window.location.origin
      );

      unmount();
    } finally {
      // Restore original descriptor.
      if (originalDescriptor) {
        Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", originalDescriptor);
      }
    }
  });

  it("dispatches immediately when GlobeDeck is already mounted", async () => {
    const postMessageSpy = vi.fn();

    const originalDescriptor = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      "contentWindow"
    );
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      get() {
        return { postMessage: postMessageSpy, origin: window.location.origin };
      },
      configurable: true,
    });

    try {
      const { unmount, getByTestId } = render(<GlobeDeck interact={false} />);

      // Fire load so the component is fully ready.
      const iframe = getByTestId("globe-deck-iframe") as HTMLIFrameElement;
      await act(async () => {
        iframe.dispatchEvent(new Event("load"));
      });

      // Now call sendDeckCommands — GlobeDeck is mounted so should dispatch immediately.
      await act(async () => {
        sendDeckCommands([{ type: "toggle_overlay", overlay: "vessels" }]);
      });

      expect(postMessageSpy).toHaveBeenCalledWith(
        { loomDeck: true, cmd: { type: "toggle_overlay", overlay: "vessels" } },
        window.location.origin
      );

      unmount();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", originalDescriptor);
      }
    }
  });
});
