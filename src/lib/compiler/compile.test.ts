import { describe, it, expect, vi } from "vitest";
import { compile } from "./compile";

describe("compile — happy path (rules-based)", () => {
  it("returns Compiled with edit_organ intent when rules match", async () => {
    const askModel = vi.fn();
    const utterance = "add a delete button to the water tracker";
    const result = await compile(utterance, ["water-tracker"], askModel);

    expect(result.intent).toBe("edit_organ");
    expect(result.confidence).toBe(0.9);
    expect(result.source).toBe("rules");
    expect(result.organId).toBe("water-tracker");
    expect(result.request).toBe("add a delete button to the water tracker");
    expect(result.utterance).toBe(utterance);
    expect(askModel).not.toHaveBeenCalled();
  });

  it("returns Compiled with build_organ intent when rules match", async () => {
    const askModel = vi.fn();
    const utterance = "build me a habit tracker";
    const result = await compile(utterance, ["water-tracker"], askModel);

    expect(result.intent).toBe("build_organ");
    expect(result.confidence).toBe(0.85);
    expect(result.source).toBe("rules");
    expect(result.organId).toBeUndefined();
    expect(result.request).toBe("build me a habit tracker");
    expect(result.utterance).toBe(utterance);
    expect(askModel).not.toHaveBeenCalled();
  });

  it("returns Compiled with act_on_organ intent when rules match", async () => {
    const askModel = vi.fn();
    const utterance = "open the water tracker";
    const result = await compile(utterance, ["water-tracker"], askModel);

    expect(result.intent).toBe("act_on_organ");
    expect(result.confidence).toBe(0.7);
    expect(result.source).toBe("rules");
    expect(result.organId).toBe("water-tracker");
    expect(result.request).toBe("open the water tracker");
    expect(result.utterance).toBe(utterance);
    expect(askModel).not.toHaveBeenCalled();
  });

  it("returns Compiled with converse intent when rules match", async () => {
    const askModel = vi.fn();
    const utterance = "hello there";
    const result = await compile(utterance, [], askModel);

    expect(result.intent).toBe("converse");
    expect(result.confidence).toBe(0.8);
    expect(result.source).toBe("rules");
    expect(result.organId).toBeUndefined();
    expect(result.request).toBe("hello there");
    expect(result.utterance).toBe(utterance);
    expect(askModel).not.toHaveBeenCalled();
  });
});

describe("compile — organId propagation", () => {
  it("propagates organId from intent result when present", async () => {
    const askModel = vi.fn();
    const utterance = "change the water tracker color";
    const result = await compile(utterance, ["water-tracker"], askModel);

    expect(result.organId).toBe("water-tracker");
  });

  it("omits organId when intent result does not include it", async () => {
    const askModel = vi.fn();
    const utterance = "build me a new expense tracker";
    const result = await compile(utterance, ["water-tracker"], askModel);

    expect(result.organId).toBeUndefined();
  });
});

describe("compile — normalized request with original utterance", () => {
  it("preserves original utterance and normalizes request", async () => {
    const askModel = vi.fn();
    const utterance = "  build   me a    thing  ";
    const result = await compile(utterance, [], askModel);

    // Original utterance preserved as-is
    expect(result.utterance).toBe(utterance);
    // Request is normalized (whitespace collapsed)
    expect(result.request).toBe("build me a thing");
    expect(askModel).not.toHaveBeenCalled();
  });

  it("normalizes request for model fallback and passes normalized form to askModel", async () => {
    const askModel = vi
      .fn()
      .mockResolvedValue('{"intent":"converse","organId":null}');
    const utterance = "  something   strange   here  ";
    const result = await compile(utterance, [], askModel);

    // Original utterance preserved
    expect(result.utterance).toBe(utterance);
    // Request normalized
    expect(result.request).toBe("something strange here");
    // askModel called with normalized form (not the original)
    expect(askModel).toHaveBeenCalled();
    const callArg = askModel.mock.calls[0]?.[0];
    expect(callArg).toContain("something strange here");
    expect(callArg).not.toContain("  ");
  });
});

describe("compile — model fallback path", () => {
  it("calls askModel with normalized utterance when rules cannot decide", async () => {
    const askModel = vi
      .fn()
      .mockResolvedValue('{"intent":"build_organ","organId":null}');
    const utterance = "  something   ambiguous  ";
    const result = await compile(utterance, [], askModel);

    expect(result.source).toBe("model");
    expect(result.intent).toBe("build_organ");
    expect(askModel).toHaveBeenCalledOnce();
    // Verify askModel receives the normalized form
    const prompt = askModel.mock.calls[0]?.[0] || "";
    expect(prompt).toContain("something ambiguous");
  });

  it("returns Compiled with model-sourced intent when rules fail", async () => {
    const askModel = vi
      .fn()
      .mockResolvedValue('{"intent":"converse","organId":null}');
    const utterance = "blorp fizzle quux";
    const result = await compile(utterance, [], askModel);

    expect(result.intent).toBe("converse");
    expect(result.confidence).toBe(0.6);
    expect(result.source).toBe("model");
    expect(result.request).toBe("blorp fizzle quux");
    expect(result.utterance).toBe(utterance);
  });

  it("propagates organId from model result", async () => {
    const askModel = vi
      .fn()
      .mockResolvedValue('{"intent":"edit_organ","organId":"water-tracker"}');
    const utterance = "change color";
    const result = await compile(utterance, ["water-tracker"], askModel);

    expect(result.source).toBe("model");
    expect(result.organId).toBe("water-tracker");
  });
});
