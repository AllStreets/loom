import { describe, it, expect, vi } from "vitest";
import { classifyByRules, classifyIntent } from "./intent";

// ---- classifyByRules -------------------------------------------------------

describe("classifyByRules — edit_organ", () => {
  it("returns edit_organ when utterance has an organ mention and a change verb", () => {
    const result = classifyByRules(
      "add a delete button to the water tracker",
      ["water-tracker"]
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("edit_organ");
    expect(result!.confidence).toBe(0.9);
    expect(result!.organId).toBe("water-tracker");
    expect(result!.source).toBe("rules");
  });

  it("matches organ id with dashes replaced by spaces", () => {
    const result = classifyByRules("update the habit tracker layout", [
      "habit-tracker",
    ]);
    expect(result?.intent).toBe("edit_organ");
    expect(result?.organId).toBe("habit-tracker");
  });

  it("matches organ id literally (no dash replacement needed)", () => {
    const result = classifyByRules("fix the water-tracker crash", [
      "water-tracker",
    ]);
    expect(result?.intent).toBe("edit_organ");
    expect(result?.organId).toBe("water-tracker");
  });

  it("uses 'change' verb for edit_organ", () => {
    const result = classifyByRules("change the water tracker color", [
      "water-tracker",
    ]);
    expect(result?.intent).toBe("edit_organ");
  });

  it("uses 'rename' verb for edit_organ", () => {
    const result = classifyByRules("rename the water tracker", ["water-tracker"]);
    expect(result?.intent).toBe("edit_organ");
  });

  it("uses 'set' verb for edit_organ", () => {
    const result = classifyByRules("set the water tracker goal to 8 cups", [
      "water-tracker",
    ]);
    expect(result?.intent).toBe("edit_organ");
  });

  it("uses 'remove' verb for edit_organ", () => {
    const result = classifyByRules("remove the chart from water tracker", [
      "water-tracker",
    ]);
    expect(result?.intent).toBe("edit_organ");
  });
});

describe("classifyByRules — build_organ", () => {
  it("returns build_organ for 'build me a habit tracker' with no matching organ", () => {
    const result = classifyByRules("build me a habit tracker", ["water-tracker"]);
    expect(result?.intent).toBe("build_organ");
    expect(result?.confidence).toBe(0.85);
    expect(result?.source).toBe("rules");
  });

  it("returns build_organ for 'create a new expense organ'", () => {
    const result = classifyByRules("create a new expense organ", []);
    expect(result?.intent).toBe("build_organ");
  });

  it("returns build_organ for 'i want a sleep tracker'", () => {
    const result = classifyByRules("i want a sleep tracker", []);
    expect(result?.intent).toBe("build_organ");
  });

  it("returns build_organ for 'i need a workout log'", () => {
    const result = classifyByRules("i need a workout log", []);
    expect(result?.intent).toBe("build_organ");
  });

  it("returns build_organ for 'new organ for tracking books'", () => {
    const result = classifyByRules("new organ for tracking books", []);
    expect(result?.intent).toBe("build_organ");
  });

  it("'make me a habit tracker' routes to build_organ when 'habit-tracker' is NOT in organIds", () => {
    // 'make' is also an edit verb, but edit_organ requires an organ mention —
    // 'habit-tracker' is not in the organ list so no organ is mentioned.
    const result = classifyByRules("make me a habit tracker", ["water-tracker"]);
    expect(result?.intent).toBe("build_organ");
  });

  it("does NOT return build_organ if an existing organ is mentioned", () => {
    // 'build' verb + existing organ mention => should NOT be build_organ;
    // edit_organ takes precedence when an organ IS mentioned with a change verb.
    // 'build' is not in the edit-verb list, so without a change verb it falls to act_on_organ.
    const result = classifyByRules("build the water tracker faster", [
      "water-tracker",
    ]);
    // build verb present but so is organ mention — build_organ requires NO organ mention
    // result should be act_on_organ (organ mention, no change verb from the edit list)
    expect(result?.intent).not.toBe("build_organ");
  });
});

describe("classifyByRules — act_on_organ", () => {
  it("returns act_on_organ for bare organ mention with no change verb", () => {
    const result = classifyByRules("water tracker", ["water-tracker"]);
    expect(result?.intent).toBe("act_on_organ");
    expect(result?.confidence).toBe(0.7);
    expect(result?.source).toBe("rules");
  });

  it("returns act_on_organ for 'open the water tracker'", () => {
    const result = classifyByRules("open the water tracker", ["water-tracker"]);
    expect(result?.intent).toBe("act_on_organ");
  });

  it("returns act_on_organ for 'show the water tracker'", () => {
    const result = classifyByRules("show me the water tracker", ["water-tracker"]);
    expect(result?.intent).toBe("act_on_organ");
  });

  it("returns act_on_organ for 'use the water tracker'", () => {
    const result = classifyByRules("use the water tracker", ["water-tracker"]);
    expect(result?.intent).toBe("act_on_organ");
  });
});

describe("classifyByRules — converse", () => {
  it("returns converse for 'hello there'", () => {
    const result = classifyByRules("hello there", []);
    expect(result?.intent).toBe("converse");
    expect(result?.confidence).toBe(0.8);
    expect(result?.source).toBe("rules");
  });

  it("returns converse for 'hi'", () => {
    const result = classifyByRules("hi", []);
    expect(result?.intent).toBe("converse");
  });

  it("returns converse for 'hey there'", () => {
    const result = classifyByRules("hey there", []);
    expect(result?.intent).toBe("converse");
  });

  it("returns converse for 'thanks'", () => {
    const result = classifyByRules("thanks", []);
    expect(result?.intent).toBe("converse");
  });

  it("returns converse for a question without organ/build markers", () => {
    const result = classifyByRules("what time is it?", []);
    expect(result?.intent).toBe("converse");
  });

  it("returns converse for a question ending with ?", () => {
    const result = classifyByRules("how are you?", []);
    expect(result?.intent).toBe("converse");
  });
});

describe("classifyByRules — null (rules unsure)", () => {
  it("returns null for an ambiguous short phrase with no organ and no clear verb", () => {
    const result = classifyByRules("something strange here", []);
    expect(result).toBeNull();
  });

  it("returns null for random text", () => {
    const result = classifyByRules("blorp fizzle quux", []);
    expect(result).toBeNull();
  });
});

// ---- classifyIntent (with model fallback) ----------------------------------

describe("classifyIntent — rules path", () => {
  it("returns rules result without calling askModel when rules match", async () => {
    const askModel = vi.fn();
    const result = await classifyIntent(
      "add a delete button to the water tracker",
      ["water-tracker"],
      askModel
    );
    expect(result.intent).toBe("edit_organ");
    expect(result.source).toBe("rules");
    expect(askModel).not.toHaveBeenCalled();
  });
});

describe("classifyIntent — model fallback", () => {
  it("calls askModel when rules return null and uses valid model response", async () => {
    const askModel = vi
      .fn()
      .mockResolvedValue('{"intent":"build_organ","organId":null}');
    const result = await classifyIntent("something strange here", [], askModel);
    expect(askModel).toHaveBeenCalledOnce();
    expect(result.intent).toBe("build_organ");
    expect(result.source).toBe("model");
  });

  it("tolerantly parses model reply with surrounding prose", async () => {
    const askModel = vi
      .fn()
      .mockResolvedValue(
        'Sure thing! {"intent":"converse","organId":null} Hope that helps.'
      );
    const result = await classifyIntent("blorp fizzle quux", [], askModel);
    expect(result.intent).toBe("converse");
    expect(result.source).toBe("model");
  });

  it("falls back to converse at 0.3 when model reply is garbage", async () => {
    const askModel = vi.fn().mockResolvedValue("I have no idea what you mean.");
    const result = await classifyIntent("blorp fizzle quux", [], askModel);
    expect(result.intent).toBe("converse");
    expect(result.confidence).toBe(0.3);
    expect(result.source).toBe("model");
  });

  it("falls back to converse at 0.3 when model returns invalid intent value", async () => {
    const askModel = vi
      .fn()
      .mockResolvedValue('{"intent":"do_the_thing","organId":null}');
    const result = await classifyIntent("blorp fizzle quux", [], askModel);
    expect(result.intent).toBe("converse");
    expect(result.confidence).toBe(0.3);
    expect(result.source).toBe("model");
  });

  it("falls back to converse at 0.3 when model returns empty string", async () => {
    const askModel = vi.fn().mockResolvedValue("");
    const result = await classifyIntent("blorp fizzle quux", [], askModel);
    expect(result.intent).toBe("converse");
    expect(result.confidence).toBe(0.3);
    expect(result.source).toBe("model");
  });
});
