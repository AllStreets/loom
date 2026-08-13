import { describe, it, expect, beforeEach } from "vitest";
import {
  getSetting,
  setSetting,
  SETTINGS_KEYS,
  VOICE_IDS,
  VOICE_LABELS,
} from "./settings";

// jsdom provides localStorage
beforeEach(() => {
  localStorage.clear();
});

describe("settings whitelist", () => {
  it("SETTINGS_KEYS contains the four required keys", () => {
    expect(SETTINGS_KEYS).toContain("voice.default");
    expect(SETTINGS_KEYS).toContain("voice.speakReplies");
    expect(SETTINGS_KEYS).toContain("orb.tier");
    expect(SETTINGS_KEYS).toContain("loom.reviewBeforeSave");
    expect(SETTINGS_KEYS).toHaveLength(4);
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
