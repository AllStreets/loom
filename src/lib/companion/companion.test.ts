import { describe, it, expect, vi, beforeEach } from "vitest";
import { handle } from "./runtime";
import { windowMessages, COMPANION_SYSTEM } from "./persona";
import type { CompanionDeps } from "./runtime";
import type { Msg } from "../core";
import type { BuildResult } from "../loom/build";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const okBuild: BuildResult = { ok: true, organId: "water-tracker", sha: "abc", log: [] };

function makeDeps(overrides: Partial<CompanionDeps> = {}): CompanionDeps {
  return {
    chat: vi.fn().mockResolvedValue("Hello from LOOM"),
    build: vi.fn().mockResolvedValue(okBuild),
    edit: vi.fn().mockResolvedValue(okBuild),
    organIds: vi.fn().mockResolvedValue([]),
    askModel: vi.fn().mockResolvedValue('{"intent":"converse","organId":null}'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// COMPANION_SYSTEM constraints
// ---------------------------------------------------------------------------

describe("COMPANION_SYSTEM", () => {
  it("contains 'LOOM'", () => {
    expect(COMPANION_SYSTEM).toContain("LOOM");
  });

  it("does not contain 'As an AI'", () => {
    expect(COMPANION_SYSTEM).not.toContain("As an AI");
  });

  it("contains no emoji characters", () => {
    // Emoji Unicode ranges: most common blocks 0x1F300–0x1FAFF and 0x2600–0x27BF
    // eslint-disable-next-line no-control-regex
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    expect(emojiRe.test(COMPANION_SYSTEM)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// windowMessages
// ---------------------------------------------------------------------------

describe("windowMessages", () => {
  it("returns empty array for empty history", () => {
    expect(windowMessages([])).toEqual([]);
  });

  it("keeps system head + last N of the rest", () => {
    const sys: Msg = { role: "system", content: "sys" };
    const msgs: Msg[] = [
      sys,
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
      { role: "user", content: "5" },
    ];
    // 5 non-system messages; last 3 are "3","4","5"
    const result = windowMessages(msgs, 3);
    expect(result[0]).toEqual(sys);
    expect(result).toHaveLength(4); // 1 system + 3 trailing
    expect(result[1].content).toBe("3");
    expect(result[2].content).toBe("4");
    expect(result[3].content).toBe("5");
  });

  it("drops older messages beyond max", () => {
    const messages: Msg[] = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: String(i),
    }));
    const result = windowMessages(messages, 5);
    expect(result).toHaveLength(5);
    expect(result[0].content).toBe("15");
    expect(result[4].content).toBe("19");
  });

  it("preserves leading system and slices the rest", () => {
    const sys: Msg = { role: "system", content: "persona" };
    const rest: Msg[] = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: String(i),
    }));
    const result = windowMessages([sys, ...rest], 4);
    expect(result[0]).toEqual(sys);
    expect(result).toHaveLength(5); // 1 sys + 4 rest
    expect(result[1].content).toBe("16");
  });
});

// ---------------------------------------------------------------------------
// handle — converse
// ---------------------------------------------------------------------------

describe("handle — converse", () => {
  it("calls chat with role 'companion', system persona first, user request last", async () => {
    const deps = makeDeps({
      organIds: vi.fn().mockResolvedValue([]),
      // Force converse via askModel (rules will also return converse for "hi")
    });
    const history: Msg[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hey there" },
    ];
    const turn = await handle("hi", history, deps);

    expect(turn.kind).toBe("reply");
    expect((deps.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const [role, messages] = (deps.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(role).toBe("companion");
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe(COMPANION_SYSTEM);
    // Last message is the user utterance (normalized)
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    // The text may be normalized (lowercased) but should contain "hi"
    expect(last.content).toContain("hi");
  });

  it("returns kind 'reply' with the text from chat", async () => {
    const deps = makeDeps({ chat: vi.fn().mockResolvedValue("LOOM here.") });
    const turn = await handle("hi", [], deps);
    expect(turn.kind).toBe("reply");
    if (turn.kind === "reply") expect(turn.text).toBe("LOOM here.");
  });

  it("ensures exactly one system message at index 0 when history has system messages", async () => {
    const deps = makeDeps({
      organIds: vi.fn().mockResolvedValue([]),
    });
    const history: Msg[] = [
      { role: "system", content: "old system message" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hey there" },
    ];
    const turn = await handle("hi", history, deps);

    expect(turn.kind).toBe("reply");
    const [, messages] = (deps.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    // Exactly one system message
    const systemMessages = messages.filter((m: Msg) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    // It must be at index 0
    expect(messages[0].role).toBe("system");
    // It must be COMPANION_SYSTEM
    expect(messages[0].content).toBe(COMPANION_SYSTEM);
  });
});

// ---------------------------------------------------------------------------
// handle — build
// ---------------------------------------------------------------------------

describe("handle — build", () => {
  it("calls deps.build with the normalized request and returns kind 'build'", async () => {
    const deps = makeDeps({
      organIds: vi.fn().mockResolvedValue([]),
      build: vi.fn().mockResolvedValue(okBuild),
    });
    const turn = await handle("build me a new water tracker app", [], deps);
    expect(turn.kind).toBe("build");
    expect((deps.build as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    if (turn.kind === "build") {
      expect(turn.result).toEqual(okBuild);
    }
  });
});

// ---------------------------------------------------------------------------
// handle — edit (with resolvable organ)
// ---------------------------------------------------------------------------

describe("handle — edit with resolvable organ", () => {
  it("calls deps.edit with (organId, request) and returns kind 'edit'", async () => {
    const deps = makeDeps({
      organIds: vi.fn().mockResolvedValue(["water-tracker"]),
      edit: vi.fn().mockResolvedValue(okBuild),
    });
    const turn = await handle("add a delete button to the water tracker", [], deps);
    expect(turn.kind).toBe("edit");
    expect((deps.edit as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const [editedId] = (deps.edit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(editedId).toBe("water-tracker");
    if (turn.kind === "edit") {
      expect(turn.organId).toBe("water-tracker");
      expect(turn.result).toEqual(okBuild);
    }
  });
});

// ---------------------------------------------------------------------------
// handle — edit without resolvable organ (no model call)
// ---------------------------------------------------------------------------

describe("handle — edit without resolvable organ", () => {
  it("returns kind 'reply' mentioning available ids, and does NOT call deps.chat", async () => {
    // askModel forces edit_organ with null organId so rules can't resolve it
    const askModel = vi.fn().mockResolvedValue('{"intent":"edit_organ","organId":null}');
    const chatSpy = vi.fn().mockResolvedValue("should not be called");
    const deps = makeDeps({
      organIds: vi.fn().mockResolvedValue(["water-tracker", "budget-tool"]),
      askModel,
      chat: chatSpy,
    });

    // Utterance that triggers model fallback (no organ mention, ambiguous edit verb)
    const turn = await handle("please update it", [], deps);

    expect(turn.kind).toBe("reply");
    // deps.chat must NOT have been called
    expect(chatSpy).not.toHaveBeenCalled();
    if (turn.kind === "reply") {
      expect(turn.text).toMatch(/water-tracker/);
      expect(turn.text).toMatch(/budget-tool/);
    }
  });

  it("returns a reply even when organIds is empty", async () => {
    const askModel = vi.fn().mockResolvedValue('{"intent":"edit_organ","organId":null}');
    const chatSpy = vi.fn();
    const deps = makeDeps({
      organIds: vi.fn().mockResolvedValue([]),
      askModel,
      chat: chatSpy,
    });
    const turn = await handle("please update it", [], deps);
    expect(turn.kind).toBe("reply");
    expect(chatSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handle — act_on_organ
// ---------------------------------------------------------------------------

describe("handle — act", () => {
  it("returns kind 'act' with the matched organId", async () => {
    const deps = makeDeps({
      organIds: vi.fn().mockResolvedValue(["water-tracker"]),
    });
    const turn = await handle("water tracker", [], deps);
    expect(turn.kind).toBe("act");
    if (turn.kind === "act") {
      expect(turn.organId).toBe("water-tracker");
    }
  });

  it("returns kind 'reply' when organId is missing, and does NOT call deps.chat", async () => {
    // askModel forces act_on_organ with null organId
    const askModel = vi.fn().mockResolvedValue('{"intent":"act_on_organ","organId":null}');
    const chatSpy = vi.fn().mockResolvedValue("should not be called");
    const deps = makeDeps({
      organIds: vi.fn().mockResolvedValue(["water-tracker"]),
      askModel,
      chat: chatSpy,
    });

    const turn = await handle("activate the thing", [], deps);

    expect(turn.kind).toBe("reply");
    // deps.chat must NOT have been called
    expect(chatSpy).not.toHaveBeenCalled();
    if (turn.kind === "reply") {
      expect(turn.text).toMatch(/organ/i);
    }
  });
});
