/**
 * EmberDeck.test.tsx — render and prop tests for the EMBER offline deck.
 *
 * EMBER has no command bridge and no pending-command queue: voice only
 * switches to it. Tests verify the iframe renders correctly and that no
 * loom-deck-command listener is registered.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import EmberDeck from "./EmberDeck";

vi.mock("framer-motion", () => ({
  useReducedMotion: () => true,
}));

afterEach(() => {
  cleanup();
});

describe("EmberDeck", () => {
  it("renders iframe with data-testid='ember-deck-iframe'", () => {
    const { getByTestId } = render(<EmberDeck interact={false} />);
    expect(getByTestId("ember-deck-iframe")).toBeTruthy();
  });

  it("iframe src contains 'ember'", () => {
    const { getByTestId } = render(<EmberDeck interact={false} />);
    const iframe = getByTestId("ember-deck-iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toContain("ember");
  });

  it("iframe has sandbox='allow-scripts allow-same-origin'", () => {
    const { getByTestId } = render(<EmberDeck interact={false} />);
    const iframe = getByTestId("ember-deck-iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  });

  it("iframe has title='EMBER Survival Console'", () => {
    const { getByTestId } = render(<EmberDeck interact={false} />);
    const iframe = getByTestId("ember-deck-iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("title")).toBe("EMBER Survival Console");
  });

  it("interact=true → pointerEvents 'auto' on iframe", () => {
    const { getByTestId } = render(<EmberDeck interact={true} />);
    const iframe = getByTestId("ember-deck-iframe") as HTMLIFrameElement;
    expect(iframe.style.pointerEvents).toBe("auto");
  });

  it("interact=false → pointerEvents 'none' on iframe", () => {
    const { getByTestId } = render(<EmberDeck interact={false} />);
    const iframe = getByTestId("ember-deck-iframe") as HTMLIFrameElement;
    expect(iframe.style.pointerEvents).toBe("none");
  });

  it("does NOT register a loom-deck-command listener (no command queue)", () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    render(<EmberDeck interact={false} />);

    const loomDeckCommandCalls = addEventListenerSpy.mock.calls.filter(
      ([event]) => event === "loom-deck-command"
    );
    expect(loomDeckCommandCalls).toHaveLength(0);

    addEventListenerSpy.mockRestore();
  });
});
