import { describe, it, expect, vi } from "vitest";
import { makeSpacePttHandlers } from "./useVoice";

describe("Space PTT guards (makeSpacePttHandlers)", () => {
  it("calls start() and prevents default on Space keydown (body target)", () => {
    const voice = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const { onKeyDown } = makeSpacePttHandlers(voice);

    const e = new KeyboardEvent("keydown", { code: "Space", bubbles: true });
    const preventSpy = vi.spyOn(e, "preventDefault");
    Object.defineProperty(e, "target", { value: document.body, configurable: true });

    onKeyDown(e);
    expect(voice.start).toHaveBeenCalledTimes(1);
    expect(preventSpy).toHaveBeenCalled();
  });

  it("ignores repeated Space keydown (e.repeat = true)", () => {
    const voice = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const { onKeyDown } = makeSpacePttHandlers(voice);

    const e = new KeyboardEvent("keydown", { code: "Space", repeat: true, bubbles: true });
    Object.defineProperty(e, "target", { value: document.body, configurable: true });

    onKeyDown(e);
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("ignores Space keydown when target is a TEXTAREA", () => {
    const voice = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const { onKeyDown } = makeSpacePttHandlers(voice);

    const textarea = document.createElement("textarea");
    const e = new KeyboardEvent("keydown", { code: "Space", bubbles: true });
    Object.defineProperty(e, "target", { value: textarea, configurable: true });

    onKeyDown(e);
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("ignores Space keydown when target is an INPUT", () => {
    const voice = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const { onKeyDown } = makeSpacePttHandlers(voice);

    const input = document.createElement("input");
    const e = new KeyboardEvent("keydown", { code: "Space", bubbles: true });
    Object.defineProperty(e, "target", { value: input, configurable: true });

    onKeyDown(e);
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("ignores Space keydown when target is contenteditable", () => {
    const voice = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const { onKeyDown } = makeSpacePttHandlers(voice);

    const div = document.createElement("div");
    div.contentEditable = "true";
    const e = new KeyboardEvent("keydown", { code: "Space", bubbles: true });
    Object.defineProperty(e, "target", { value: div, configurable: true });

    onKeyDown(e);
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("calls stop() on Space keyup", () => {
    const voice = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const { onKeyUp } = makeSpacePttHandlers(voice);

    const e = new KeyboardEvent("keyup", { code: "Space", bubbles: true });
    onKeyUp(e);
    expect(voice.stop).toHaveBeenCalledTimes(1);
  });

  it("ignores keyup for non-Space keys", () => {
    const voice = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const { onKeyUp } = makeSpacePttHandlers(voice);

    const e = new KeyboardEvent("keyup", { code: "KeyA", bubbles: true });
    onKeyUp(e);
    expect(voice.stop).not.toHaveBeenCalled();
  });
});
