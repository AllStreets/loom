import { describe, it, expect, vi } from "vitest";

// Simulate the Space PTT guard logic as it appears in Shell
function makeSpaceHandler(start: () => void, stop: () => void) {
  function onKeyDown(e: KeyboardEvent) {
    if (e.code !== "Space" || e.repeat) return;
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable ||
      target.contentEditable === "true"
    ) return;
    e.preventDefault();
    start();
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.code !== "Space") return;
    stop();
  }
  return { onKeyDown, onKeyUp };
}

describe("Space PTT guards", () => {
  it("calls start() and prevents default on Space keydown (body target)", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const { onKeyDown } = makeSpaceHandler(start, stop);

    const e = new KeyboardEvent("keydown", { code: "Space", bubbles: true });
    const preventSpy = vi.spyOn(e, "preventDefault");
    Object.defineProperty(e, "target", { value: document.body, configurable: true });

    onKeyDown(e);
    expect(start).toHaveBeenCalledTimes(1);
    expect(preventSpy).toHaveBeenCalled();
  });

  it("ignores repeated Space keydown (e.repeat = true)", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const { onKeyDown } = makeSpaceHandler(start, stop);

    const e = new KeyboardEvent("keydown", { code: "Space", repeat: true, bubbles: true });
    Object.defineProperty(e, "target", { value: document.body, configurable: true });

    onKeyDown(e);
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores Space keydown when target is a TEXTAREA", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const { onKeyDown } = makeSpaceHandler(start, stop);

    const textarea = document.createElement("textarea");
    const e = new KeyboardEvent("keydown", { code: "Space", bubbles: true });
    Object.defineProperty(e, "target", { value: textarea, configurable: true });

    onKeyDown(e);
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores Space keydown when target is an INPUT", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const { onKeyDown } = makeSpaceHandler(start, stop);

    const input = document.createElement("input");
    const e = new KeyboardEvent("keydown", { code: "Space", bubbles: true });
    Object.defineProperty(e, "target", { value: input, configurable: true });

    onKeyDown(e);
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores Space keydown when target is contenteditable", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const { onKeyDown } = makeSpaceHandler(start, stop);

    const div = document.createElement("div");
    div.contentEditable = "true";
    const e = new KeyboardEvent("keydown", { code: "Space", bubbles: true });
    Object.defineProperty(e, "target", { value: div, configurable: true });

    onKeyDown(e);
    expect(start).not.toHaveBeenCalled();
  });

  it("calls stop() on Space keyup", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const { onKeyUp } = makeSpaceHandler(start, stop);

    const e = new KeyboardEvent("keyup", { code: "Space", bubbles: true });
    onKeyUp(e);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ignores keyup for non-Space keys", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const { onKeyUp } = makeSpaceHandler(start, stop);

    const e = new KeyboardEvent("keyup", { code: "KeyA", bubbles: true });
    onKeyUp(e);
    expect(stop).not.toHaveBeenCalled();
  });
});
