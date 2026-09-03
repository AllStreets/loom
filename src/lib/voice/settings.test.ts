import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getSetting,
  setSetting,
  resetAllSettings,
  migrateSettings,
  SETTINGS_KEYS,
  VOICE_IDS,
  VOICE_LABELS,
  isValidModelTag,
} from "./settings";

// jsdom provides localStorage
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("settings whitelist", () => {
  it("SETTINGS_KEYS contains exactly the surviving keys", () => {
    expect(SETTINGS_KEYS).toContain("voice.default");
    expect(SETTINGS_KEYS).toContain("voice.speakReplies");
    expect(SETTINGS_KEYS).toContain("orb.tier");
    expect(SETTINGS_KEYS).toContain("loom.reviewBeforeSave");
    expect(SETTINGS_KEYS).toContain("model.builder");
    expect(SETTINGS_KEYS).toContain("model.companion");
    expect(SETTINGS_KEYS).toContain("model.rewriter");
    expect(SETTINGS_KEYS).toContain("cockpit.tapestry");
    expect(SETTINGS_KEYS).toContain("cockpit.chatMin");
    expect(SETTINGS_KEYS).toContain("cockpit.initiative");
    for (const retired of ["model.cloudBuilder", "cockpit.deck", "cockpit.interact", "cockpit.watchOpen", "terminal.symbols"]) {
      expect(SETTINGS_KEYS).not.toContain(retired);
    }
    expect(SETTINGS_KEYS).toHaveLength(10);
  });

  it("throws on unknown key in getSetting", () => {
    expect(() => getSetting("unknown.key")).toThrow(/Unknown settings key/);
  });

  it("throws on unknown key in setSetting", () => {
    expect(() => setSetting("unknown.key", "value")).toThrow(/Unknown settings key/);
  });
});

describe("settings defaults", () => {
  it("voice.default defaults to en_US-lessac-medium", () => {
    expect(getSetting("voice.default")).toBe("en_US-lessac-medium");
  });

  it("voice.speakReplies defaults to whenSpoken", () => {
    expect(getSetting("voice.speakReplies")).toBe("whenSpoken");
  });

  it("orb.tier defaults to auto", () => {
    expect(getSetting("orb.tier")).toBe("auto");
  });

  it("loom.reviewBeforeSave defaults to 0", () => {
    expect(getSetting("loom.reviewBeforeSave")).toBe("0");
  });

  it("cockpit.tapestry defaults to on — the Tapestry is the brand", () => {
    expect(getSetting("cockpit.tapestry")).toBe("on");
  });

  it("cockpit.chatMin defaults to off — the typing box is present until folded", () => {
    expect(getSetting("cockpit.chatMin")).toBe("off");
  });
});

describe("cockpit.chatMin setting", () => {
  it("accepts 'on' and 'off'", () => {
    setSetting("cockpit.chatMin", "on");
    expect(getSetting("cockpit.chatMin")).toBe("on");
    setSetting("cockpit.chatMin", "off");
    expect(getSetting("cockpit.chatMin")).toBe("off");
  });

  it("rejects unknown values", () => {
    expect(() => setSetting("cockpit.chatMin", "half")).toThrow(/Invalid value/);
  });
});

describe("cockpit.tapestry setting", () => {
  it("accepts 'on' and 'off'", () => {
    setSetting("cockpit.tapestry", "off");
    expect(getSetting("cockpit.tapestry")).toBe("off");
    setSetting("cockpit.tapestry", "on");
    expect(getSetting("cockpit.tapestry")).toBe("on");
  });

  it("rejects unknown values", () => {
    expect(() => setSetting("cockpit.tapestry", "maybe")).toThrow(/Invalid value/);
  });

  it("cockpit.constellation is no longer a settings key", () => {
    expect(SETTINGS_KEYS).not.toContain("cockpit.constellation");
    expect(() => getSetting("cockpit.constellation")).toThrow(/Unknown settings key/);
    expect(() => setSetting("cockpit.constellation", "on")).toThrow(/Unknown settings key/);
  });
});

describe("migrateSettings — retired-key boot migration", () => {
  it("deletes a stored cockpit.constellation value", () => {
    localStorage.setItem("cockpit.constellation", "on");
    migrateSettings();
    expect(localStorage.getItem("cockpit.constellation")).toBeNull();
  });

  it("deletes stored deck.agora.* values (Phase 18 — AGORA left the ship)", () => {
    localStorage.setItem("deck.agora.url", "http://localhost:3000");
    localStorage.setItem("deck.agora.path", "/Users/x/AGORA");
    localStorage.setItem("deck.agora.product", "ETH-USD");
    migrateSettings();
    expect(localStorage.getItem("deck.agora.url")).toBeNull();
    expect(localStorage.getItem("deck.agora.path")).toBeNull();
    expect(localStorage.getItem("deck.agora.product")).toBeNull();
  });

  it("deck.agora.* are no longer settings keys", () => {
    for (const k of ["deck.agora.url", "deck.agora.path", "deck.agora.product"]) {
      expect(SETTINGS_KEYS).not.toContain(k);
      expect(() => getSetting(k)).toThrow(/Unknown settings key/);
      expect(() => setSetting(k, "x")).toThrow(/Unknown settings key/);
    }
  });

  it("deletes every Cockpit key and store (Phase 23a — Rebirth)", () => {
    localStorage.setItem("cockpit.deck", "globe");
    localStorage.setItem("cockpit.interact", "off");
    localStorage.setItem("cockpit.watchOpen", "on");
    localStorage.setItem("terminal.symbols", "AAPL");
    localStorage.setItem("model.cloudBuilder", "anthropic");
    localStorage.setItem("loom.watch.v1", "{}");
    localStorage.setItem("auspex.tour.seen.v1", "1");
    migrateSettings();
    for (const k of ["cockpit.deck", "cockpit.interact", "cockpit.watchOpen", "terminal.symbols", "model.cloudBuilder", "loom.watch.v1", "auspex.tour.seen.v1"]) {
      expect(localStorage.getItem(k)).toBeNull();
    }
  });

  it("the Cockpit keys are no longer settings keys", () => {
    for (const k of ["cockpit.deck", "cockpit.interact", "cockpit.watchOpen", "terminal.symbols", "model.cloudBuilder"]) {
      expect(() => getSetting(k)).toThrow(/Unknown settings key/);
      expect(() => setSetting(k, "on")).toThrow(/Unknown settings key/);
    }
  });

  it("is idempotent — running twice (or with nothing stored) is a no-op", () => {
    expect(() => migrateSettings()).not.toThrow();
    localStorage.setItem("cockpit.constellation", "off");
    localStorage.setItem("deck.agora.product", "BTC-USD");
    localStorage.setItem("cockpit.deck", "agora");
    migrateSettings();
    migrateSettings();
    expect(localStorage.getItem("cockpit.constellation")).toBeNull();
    expect(localStorage.getItem("deck.agora.product")).toBeNull();
    expect(localStorage.getItem("cockpit.deck")).toBeNull();
  });

  it("does not touch live settings keys", () => {
    setSetting("cockpit.tapestry", "off");
    setSetting("cockpit.chatMin", "on");
    migrateSettings();
    expect(getSetting("cockpit.tapestry")).toBe("off");
    expect(getSetting("cockpit.chatMin")).toBe("on");
  });
});

describe("settings validation", () => {
  it("accepts valid voice.default values", () => {
    expect(() => setSetting("voice.default", "en_US-lessac-medium")).not.toThrow();
    expect(() => setSetting("voice.default", "en_GB-alba-medium")).not.toThrow();
    expect(() => setSetting("voice.default", "en_US-libritts-high")).not.toThrow();
  });

  it("rejects invalid voice.default value", () => {
    expect(() => setSetting("voice.default", "unknown-voice")).toThrow(/Invalid value/);
  });

  it("accepts valid voice.speakReplies values", () => {
    expect(() => setSetting("voice.speakReplies", "always")).not.toThrow();
    expect(() => setSetting("voice.speakReplies", "whenSpoken")).not.toThrow();
    expect(() => setSetting("voice.speakReplies", "never")).not.toThrow();
  });

  it("rejects invalid voice.speakReplies value", () => {
    expect(() => setSetting("voice.speakReplies", "sometimes")).toThrow(/Invalid value/);
  });

  it("accepts valid orb.tier values", () => {
    expect(() => setSetting("orb.tier", "auto")).not.toThrow();
    expect(() => setSetting("orb.tier", "flat")).not.toThrow();
  });

  it("rejects invalid orb.tier value", () => {
    expect(() => setSetting("orb.tier", "3d")).toThrow(/Invalid value/);
  });

  it("accepts valid loom.reviewBeforeSave values", () => {
    expect(() => setSetting("loom.reviewBeforeSave", "0")).not.toThrow();
    expect(() => setSetting("loom.reviewBeforeSave", "1")).not.toThrow();
  });

  it("rejects invalid loom.reviewBeforeSave value", () => {
    expect(() => setSetting("loom.reviewBeforeSave", "true")).toThrow(/Invalid value/);
  });
});

describe("orb.tier legacy-key side effect", () => {
  it("setting orb.tier=flat writes loom.orb=flat", () => {
    setSetting("orb.tier", "flat");
    expect(localStorage.getItem("loom.orb")).toBe("flat");
  });

  it("setting orb.tier=auto removes loom.orb", () => {
    localStorage.setItem("loom.orb", "flat"); // pre-existing
    setSetting("orb.tier", "auto");
    expect(localStorage.getItem("loom.orb")).toBeNull();
  });

  it("loom.orb is not touched when setting other keys", () => {
    setSetting("voice.speakReplies", "always");
    expect(localStorage.getItem("loom.orb")).toBeNull();
  });
});

describe("getSetting persists set value", () => {
  it("returns what was set", () => {
    setSetting("voice.default", "en_GB-alba-medium");
    expect(getSetting("voice.default")).toBe("en_GB-alba-medium");
  });
});

describe("VOICE_IDS and VOICE_LABELS", () => {
  it("VOICE_IDS has exactly 3 entries", () => {
    expect(VOICE_IDS).toHaveLength(3);
  });

  it("every VOICE_ID has a label", () => {
    for (const id of VOICE_IDS) {
      expect(VOICE_LABELS[id]).toBeTruthy();
    }
  });

  it("has expected voice ids", () => {
    expect(VOICE_IDS).toContain("en_US-lessac-medium");
    expect(VOICE_IDS).toContain("en_GB-alba-medium");
    expect(VOICE_IDS).toContain("en_US-libritts-high");
  });
});

describe("isValidModelTag", () => {
  it("accepts simple name without tag", () => {
    expect(isValidModelTag("llama3.2")).toBe(true);
  });

  it("accepts name with tag", () => {
    expect(isValidModelTag("qwen3-coder:30b-a3b-q4_K_M")).toBe(true);
  });

  it("accepts HuggingFace-style path with tag", () => {
    expect(isValidModelTag("hf.co/user/model:Q4")).toBe(true);
  });

  it("rejects string with space and special char", () => {
    expect(isValidModelTag("bad tag!")).toBe(false);
  });

  it("rejects leading hyphen", () => {
    expect(isValidModelTag("-leading")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidModelTag("")).toBe(false);
  });

  it("rejects string longer than 128 chars", () => {
    expect(isValidModelTag("a".repeat(129))).toBe(false);
  });

  it("accepts string exactly 128 chars", () => {
    // 128 alphanumeric chars is valid
    expect(isValidModelTag("a".repeat(128))).toBe(true);
  });

  it("rejects two colons (a:b:c)", () => {
    expect(isValidModelTag("a:b:c")).toBe(false);
  });
});

describe("model.* settings", () => {
  it("model.builder defaults to empty string", () => {
    expect(getSetting("model.builder")).toBe("");
  });

  it("model.companion defaults to empty string", () => {
    expect(getSetting("model.companion")).toBe("");
  });

  it("model.rewriter defaults to empty string", () => {
    expect(getSetting("model.rewriter")).toBe("");
  });

  it("setSetting accepts a valid model tag", () => {
    expect(() => setSetting("model.builder", "llama3.2")).not.toThrow();
    expect(getSetting("model.builder")).toBe("llama3.2");
  });

  it("setSetting accepts empty string (reset to unset)", () => {
    setSetting("model.builder", "llama3.2");
    expect(() => setSetting("model.builder", "")).not.toThrow();
    expect(getSetting("model.builder")).toBe("");
  });

  it("setSetting rejects garbage tag", () => {
    expect(() => setSetting("model.builder", "bad tag!")).toThrow(/Invalid model tag/);
  });

  it("setSetting rejects 200-char string", () => {
    expect(() => setSetting("model.companion", "a".repeat(200))).toThrow(/Invalid model tag/);
  });

  it("setSetting accepts complex valid tag for rewriter", () => {
    expect(() => setSetting("model.rewriter", "hf.co/user/model:Q4_K_M")).not.toThrow();
    expect(getSetting("model.rewriter")).toBe("hf.co/user/model:Q4_K_M");
  });
});

describe("cockpit.initiative setting", () => {
  it("cockpit.initiative default is 'on'", () => {
    expect(getSetting("cockpit.initiative")).toBe("on");
  });

  it("cockpit.initiative accepts 'on' and 'off'", () => {
    setSetting("cockpit.initiative", "off");
    expect(getSetting("cockpit.initiative")).toBe("off");
    setSetting("cockpit.initiative", "on");
    expect(getSetting("cockpit.initiative")).toBe("on");
  });

  it("cockpit.initiative rejects unknown values", () => {
    expect(() => setSetting("cockpit.initiative", "maybe")).toThrow();
  });
});

describe("resetAllSettings", () => {
  it("clears all SETTINGS_KEYS", () => {
    setSetting("cockpit.chatMin", "on");
    setSetting("cockpit.initiative", "off");
    resetAllSettings();
    for (const k of SETTINGS_KEYS) {
      expect(localStorage.getItem(k)).toBeNull();
    }
  });

  it("removes all loom.* keys", () => {
    localStorage.setItem("loom.minimized", JSON.stringify(["notes"]));
    localStorage.setItem("loom.win.notes", JSON.stringify({ x: 40 }));
    localStorage.setItem("loom.organs.deleted", JSON.stringify(["notes"]));
    resetAllSettings();
    expect(localStorage.getItem("loom.minimized")).toBeNull();
    expect(localStorage.getItem("loom.win.notes")).toBeNull();
    expect(localStorage.getItem("loom.organs.deleted")).toBeNull();
  });

  it("removes loom.organs.deleted tombstones", () => {
    localStorage.setItem("loom.organs.deleted", JSON.stringify(["notes", "timeline"]));
    resetAllSettings();
    expect(localStorage.getItem("loom.organs.deleted")).toBeNull();
  });
});
