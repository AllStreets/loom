/**
 * config.test.ts — tests for deck origin / URL environment resolution.
 *
 * Tests the buildDeckConfig factory directly for both dev and prod branches,
 * avoiding module-level import.meta.env evaluation gotchas.
 */
import { describe, it, expect } from "vitest";
import { buildDeckConfig } from "./config";

describe("buildDeckConfig factory — dev branch (isDev = true)", () => {
  it("DECK_URL is the vite relative path in dev", () => {
    const config = buildDeckConfig(true);
    expect(config.url).toBe("/decks/auspex/index.html");
  });

  it("DECK_ORIGIN is window.location.origin in dev", () => {
    const config = buildDeckConfig(true);
    // jsdom sets window.location.origin; the factory must return it.
    expect(config.origin).toBe(window.location.origin);
  });
});

describe("buildDeckConfig factory — prod branch (isDev = false)", () => {
  it("DECK_URL is the custom protocol URL in prod", () => {
    const config = buildDeckConfig(false);
    expect(config.url).toBe("deck://localhost/index.html");
  });

  it("DECK_ORIGIN is deck://localhost in prod", () => {
    const config = buildDeckConfig(false);
    expect(config.origin).toBe("deck://localhost");
  });

  it("prod origin is deck://localhost (macOS/Linux Tauri v2 custom scheme)", () => {
    // Tauri v2 app.rs:2126: macOS/iOS/Linux custom scheme origin = "<scheme>://localhost"
    // Windows/Android would be "http://<scheme>.localhost" — we target macOS.
    const config = buildDeckConfig(false);
    expect(config.origin).toMatch(/^deck:\/\/localhost$/);
  });
});

describe("DECK_ORIGIN matches postMessage targetOrigin expectation", () => {
  it("in dev: DECK_ORIGIN equals window.location.origin (shared-origin iframe)", () => {
    const config = buildDeckConfig(true);
    // The existing GlobeDeck tests use window.location.origin as targetOrigin.
    // After this task that flows through DECK_ORIGIN — verify parity.
    expect(config.origin).toBe(window.location.origin);
  });

  it("in prod: DECK_ORIGIN is 'deck://localhost' — isolated origin for postMessage", () => {
    // Cross-origin postMessage with specific targetOrigin is safe:
    // the browser will only deliver to a frame at exactly that origin.
    const config = buildDeckConfig(false);
    expect(config.origin).not.toBe(window.location.origin);
  });
});
