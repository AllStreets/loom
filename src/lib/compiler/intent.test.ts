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

  it("returns build_organ even when an existing organ substring appears (BUILD_PHRASE precedence)", () => {
    // BUILD_PHRASE_RE takes priority over organ-mention detection to prevent
    // misfires like "make me something like notes but for tasks" → edit_organ.
    // "build the water tracker faster" contains BUILD_PHRASE "build" and mentions
    // "water-tracker" but the user's intent is to build something, not act on it.
    const result = classifyByRules("build the water tracker faster", [
      "water-tracker",
    ]);
    expect(result?.intent).toBe("build_organ");
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

// ---- Task 2: misfire regression -------------------------------------------

describe("classifyByRules — misfire regression", () => {
  it("'make me something like notes but for tasks' → build_organ not edit_organ", () => {
    // Regression: EDIT_VERB 'make' + organ-substring 'notes' used to beat BUILD_PHRASE.
    // BUILD_PHRASE_RE must win regardless of organ id substrings in the utterance.
    const result = classifyByRules(
      "make me something like notes but for tasks",
      ["notes"]
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("build_organ");
    expect(result!.source).toBe("rules");
  });

  it("'make me a new habit tracker similar to water-tracker' → build_organ", () => {
    const result = classifyByRules(
      "make me a new habit tracker similar to water-tracker",
      ["water-tracker"]
    );
    expect(result!.intent).toBe("build_organ");
  });

  it("'i need a task list like my notes organ' → build_organ", () => {
    const result = classifyByRules(
      "i need a task list like my notes organ",
      ["notes"]
    );
    expect(result!.intent).toBe("build_organ");
  });
});

// ---- Task 2: anaphora resolution ------------------------------------------

describe("classifyByRules — anaphora resolution", () => {
  it("'make it blue' after 'Built water-tracker:...' → edit_organ targeting water-tracker", () => {
    const history = [
      { role: "assistant", content: "Built water-tracker: organ ready. Passed in 0 repair round(s)." },
    ];
    const result = classifyByRules("make it blue", [], history);
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("edit_organ");
    expect(result!.organId).toBe("water-tracker");
    expect(result!.source).toBe("rules");
    expect(result!.confidence).toBe(0.9);
  });

  it("'change that to dark mode' after 'Edited budget-tool:...' → edit_organ targeting budget-tool", () => {
    const history = [
      { role: "user", content: "add a delete button" },
      { role: "assistant", content: "Edited budget-tool: add a delete button." },
    ];
    const result = classifyByRules("change that to dark mode", [], history);
    expect(result!.intent).toBe("edit_organ");
    expect(result!.organId).toBe("budget-tool");
  });

  it("anaphora with edit verb but empty history → rules return null (fall through to model)", () => {
    const result = classifyByRules("make it blue", [], []);
    expect(result).toBeNull();
  });

  it("anaphora with edit verb but no assistant organ message in history → rules return null", () => {
    const history = [
      { role: "user", content: "build me a counter" },
    ];
    const result = classifyByRules("make it blue", [], history);
    expect(result).toBeNull();
  });

  it("'update this one' resolves to most recent built organ in history", () => {
    const history = [
      { role: "assistant", content: "Built notes: organ ready. Passed in 0 repair round(s)." },
      { role: "assistant", content: "Built water-tracker: organ ready. Passed in 0 repair round(s)." },
    ];
    // Most recent (last) assistant organ should win
    const result = classifyByRules("update this one", [], history);
    expect(result!.intent).toBe("edit_organ");
    expect(result!.organId).toBe("water-tracker");
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

  it("passes few-shot system message and history block to askModel", async () => {
    const askModel = vi
      .fn()
      .mockResolvedValue('{"intent":"edit_organ","organId":"notes"}');
    // Use anaphora with no edit verb → rules return null (anaphora without edit verb
    // falls through because step 1 requires BOTH hasAnaphora AND hasEditVerb).
    // "look at it" — "look" is not in EDIT_VERB_RE, so rules can't decide.
    const history = [
      { role: "assistant", content: "Built notes: organ ready. Passed in 0 repair round(s)." },
    ];
    await classifyIntent("show it to me", [], askModel, history);
    expect(askModel).toHaveBeenCalledOnce();
    const [systemArg, promptArg] = askModel.mock.calls[0] as [string, string];
    // System message contains few-shot examples
    expect(systemArg).toContain("build_organ");
    expect(systemArg).toContain("edit_organ");
    expect(systemArg).toContain("converse");
    // Prompt includes history context
    expect(promptArg).toContain("Built notes");
    expect(promptArg).toContain("show it to me");
  });

  it("few-shot system contains deck_command examples", async () => {
    const askModel = vi
      .fn()
      .mockResolvedValue('{"intent":"deck_command","organId":null}');
    await classifyIntent("blorp fizzle quux", [], askModel);
    const [systemArg] = askModel.mock.calls[0] as [string, string];
    expect(systemArg).toContain("deck_command");
    expect(systemArg).toContain("show the globe");
  });
});

// ── T2 deck_command intent rules ────────────────────────────────────────────

describe("classifyByRules — deck_command", () => {
  it("'show the globe' → deck_command with deckSwitch:globe", () => {
    const result = classifyByRules("show the globe", [], [], "void");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("deck_command");
    expect(result!.confidence).toBe(0.95);
    expect(result!.source).toBe("rules");
    expect(result!.deckCommandResult?.deckSwitch).toBe("globe");
    expect(result!.deckCommandResult?.bridgeCmds).toHaveLength(0);
  });

  it("'show military news' → deck_command with set_cat military", () => {
    const result = classifyByRules("show military news", [], [], "globe");
    expect(result!.intent).toBe("deck_command");
    expect(result!.deckCommandResult?.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "military" });
    expect(result!.deckCommandResult?.deckSwitch).toBeUndefined();
  });

  it("'show vessels' from void → deck_command with deckSwitch:globe + toggle_overlay vessels", () => {
    const result = classifyByRules("show vessels", [], [], "void");
    expect(result!.intent).toBe("deck_command");
    expect(result!.deckCommandResult?.deckSwitch).toBe("globe");
    expect(result!.deckCommandResult?.bridgeCmds[0]).toEqual({ type: "toggle_overlay", overlay: "vessels" });
  });

  it("'reset the view' → deck_command with reset_view", () => {
    const result = classifyByRules("reset the view", [], [], "globe");
    expect(result!.intent).toBe("deck_command");
    expect(result!.deckCommandResult?.bridgeCmds[0]).toEqual({ type: "reset_view" });
  });

  it("'stop spinning' → deck_command with set_spin false", () => {
    const result = classifyByRules("stop spinning", [], [], "globe");
    expect(result!.intent).toBe("deck_command");
    expect(result!.deckCommandResult?.bridgeCmds[0]).toEqual({ type: "set_spin", on: false });
  });

  it("deck_command fires WITHOUT calling askModel", async () => {
    const askModel = vi.fn();
    const result = await classifyIntent("show the globe", [], askModel, [], "void");
    expect(result.intent).toBe("deck_command");
    expect(askModel).not.toHaveBeenCalled();
  });
});

// ── Precedence regressions: deck does NOT steal build/edit/act phrases ───────

describe("classifyByRules — deck_command does NOT regress build/edit/act", () => {
  it("'build me a water tracker' still → build_organ (not deck_command)", () => {
    const result = classifyByRules("build me a water tracker", [], [], "void");
    expect(result!.intent).toBe("build_organ");
  });

  it("'show me a water tracker' with organ → act_on_organ (not deck_command)", () => {
    const result = classifyByRules("show me a water tracker", ["water-tracker"], [], "void");
    expect(result!.intent).toBe("act_on_organ");
    expect(result!.organId).toBe("water-tracker");
  });

  it("'make it blue' anaphora + edit verb → edit_organ (not deck_command)", () => {
    const history = [
      { role: "assistant", content: "Built water-tracker: organ ready. Passed in 0 repair round(s)." },
    ];
    const result = classifyByRules("make it blue", [], history, "void");
    expect(result!.intent).toBe("edit_organ");
    expect(result!.organId).toBe("water-tracker");
  });

  it("'make me something like notes but for tasks' → build_organ (not deck_command)", () => {
    const result = classifyByRules("make me something like notes but for tasks", ["notes"], [], "void");
    expect(result!.intent).toBe("build_organ");
  });

  it("'show me a water tracker' with no organs → null (falls to model, not deck_command)", () => {
    // Water tracker not in organ list, no organ match — but "water tracker" is not
    // a deck keyword either, so should return null (fall through to model).
    const result = classifyByRules("show me a water tracker", [], [], "void");
    expect(result).toBeNull();
  });
});

// ── Briefing intent rules ────────────────────────────────────────────────────

describe("classifyByRules — briefing intent", () => {
  it("'brief me' → briefing", () => {
    const result = classifyByRules("brief me", []);
    expect(result?.intent).toBe("briefing");
    expect(result?.confidence).toBe(0.95);
    expect(result?.source).toBe("rules");
  });

  it("'what matters' → briefing", () => {
    const result = classifyByRules("what matters", []);
    expect(result?.intent).toBe("briefing");
  });

  it("'what's happening' → briefing (case-insensitive)", () => {
    const result = classifyByRules("what's happening", []);
    expect(result?.intent).toBe("briefing");
  });

  it("'morning brief' → briefing", () => {
    const result = classifyByRules("morning brief", []);
    expect(result?.intent).toBe("briefing");
  });

  it("'since i've been gone' → briefing", () => {
    const result = classifyByRules("since i've been gone", []);
    expect(result?.intent).toBe("briefing");
  });

  it("'whats the watch' → briefing", () => {
    const result = classifyByRules("whats the watch", []);
    expect(result?.intent).toBe("briefing");
  });

  it("briefing fires without calling askModel", async () => {
    const askModel = vi.fn();
    const result = await classifyIntent("brief me", [], askModel);
    expect(result.intent).toBe("briefing");
    expect(askModel).not.toHaveBeenCalled();
  });

  it("few-shot system contains briefing examples", async () => {
    const askModel = vi.fn().mockResolvedValue('{"intent":"converse","organId":null}');
    await classifyIntent("blorp fizzle quux", [], askModel);
    const [systemArg] = askModel.mock.calls[0] as [string, string];
    expect(systemArg).toContain("briefing");
    expect(systemArg).toContain("brief me");
  });
});

// ---- Task 3 (identity): help intent ----------------------------------------

describe("classifyByRules — help", () => {
  it("returns help for 'help'", () => {
    const result = classifyByRules("help", []);
    expect(result?.intent).toBe("help");
    expect(result?.source).toBe("rules");
  });

  it("returns help for 'what can you do' and 'what can you do?'", () => {
    expect(classifyByRules("what can you do", [])?.intent).toBe("help");
    expect(classifyByRules("what can you do?", [])?.intent).toBe("help");
  });

  it("'help me build a tracker' routes to build_organ, not help", () => {
    const result = classifyByRules("help me build a tracker", []);
    expect(result?.intent).toBe("build_organ");
  });

  it("questions still route to converse ('how are you?')", () => {
    expect(classifyByRules("how are you?", [])?.intent).toBe("converse");
  });
});

// ---- self_edit (Phase 21 — LOOM editing its own kernel) --------------------

describe("classifyByRules — self_edit", () => {
  it("routes 'change yourself …' to self_edit", () => {
    expect(classifyByRules("change yourself so the orb is brighter", [])?.intent).toBe(
      "self_edit",
    );
  });

  it("routes 'edit your <x>' to self_edit", () => {
    expect(classifyByRules("edit your companion prompt", [])?.intent).toBe("self_edit");
  });

  it("routes 'rewrite your own <x>' to self_edit", () => {
    expect(classifyByRules("rewrite your own mood logic", [])?.intent).toBe("self_edit");
  });

  it("takes precedence over build/edit verbs (the possessive is unambiguous)", () => {
    // "change" is an EDIT_VERB and "make" a BUILD phrase, but "yourself"/"your"
    // must win — this is LOOM editing itself, never an organ.
    expect(classifyByRules("change your orb color", ["orb"])?.intent).toBe("self_edit");
    expect(classifyByRules("improve yourself", [])?.intent).toBe("self_edit");
  });

  it("does NOT fire for organ edits that mention no self-possessive", () => {
    expect(classifyByRules("change the water tracker color", ["water-tracker"])?.intent).toBe(
      "edit_organ",
    );
    expect(classifyByRules("build me a sleep tracker", [])?.intent).toBe("build_organ");
  });
});
