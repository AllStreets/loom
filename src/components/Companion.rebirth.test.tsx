/**
 * Companion.rebirth.test.tsx — the companion's rebirth surface (Phase 23).
 *
 * - A `consent` turn renders as a card with REWEAVE / RETURN and NOT NOW;
 *   only the affirmative action reaches the protected orchestration
 *   (`startReweave` / `returnToGeneration`), never the runtime.
 * - The first boot after a weave greets once: "I'm back — generation {sha7}."
 *   No model call; the line is spoken per `voice.speakReplies`; the
 *   generation is remembered so the next boot stays quiet.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import type { CompanionTurn } from "../lib/companion/runtime";

const SHA = "3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a";
const PREV = "9b8c7d9b8c7d9b8c7d9b8c7d9b8c7d9b8c7d9b8c";

const identityMock = vi.fn<() => Promise<unknown>>();

const invokeMock = vi.fn(async (cmd: string) => {
  if (cmd === "kernel_identity") return identityMock();
  if (cmd === "tts_speak") return [1, 2, 3];
  return [];
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [string])),
}));

const mockHandle = vi.fn<
  (utterance: string, history: unknown[], deps: unknown) => Promise<CompanionTurn>
>();
vi.mock("../lib/companion/runtime", () => ({
  handle: (...args: Parameters<typeof mockHandle>) => mockHandle(...args),
}));

const reweave = vi.hoisted(() => ({ startReweave: vi.fn() }));
vi.mock("../lib/loom/reweave", () => ({ startReweave: reweave.startReweave }));

const generations = vi.hoisted(() => ({ returnToGeneration: vi.fn() }));
vi.mock("../lib/loom/generations", () => ({ returnToGeneration: generations.returnToGeneration }));

const player = vi.hoisted(() => ({ playWav: vi.fn() }));
vi.mock("../lib/voice/player", () => ({
  playWav: (...a: unknown[]) => player.playWav(...a),
  stopPlayback: vi.fn(),
}));

beforeEach(() => {
  mockHandle.mockReset();
  identityMock.mockReset();
  identityMock.mockResolvedValue({ mode: "packaged", genomeSha: SHA, generation: null, threaded: true, loomhome: "/l" });
  reweave.startReweave.mockReset();
  reweave.startReweave.mockResolvedValue({ ok: true });
  generations.returnToGeneration.mockReset();
  generations.returnToGeneration.mockResolvedValue(undefined);
  player.playWav.mockReset();
  player.playWav.mockResolvedValue(undefined);
  localStorage.clear();
  localStorage.setItem("loom.firstGreeting", "1");
});
afterEach(() => {
  vi.clearAllMocks();
});

import Companion from "./Companion";

async function submit(text: string) {
  const textarea = screen.getByPlaceholderText(/Talk to LOOM/i);
  await userEvent.type(textarea, text);
  await userEvent.keyboard("{Enter}");
}

describe("Companion — consent turns", () => {
  it("renders the reweave consent line with REWEAVE and NOT NOW; REWEAVE calls startReweave", async () => {
    mockHandle.mockResolvedValue({
      kind: "consent",
      consent: "reweave_consent",
      line: "weave generation 3f2a1c from 4 commits — LOOM will close and return",
    });
    render(<Companion />);
    await submit("reweave yourself");

    const card = await screen.findByTestId("consent-reweave_consent");
    expect(card).toHaveTextContent("weave generation 3f2a1c from 4 commits — LOOM will close and return");
    expect(screen.getByRole("button", { name: "NOT NOW" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "REWEAVE" }));
    await waitFor(() => expect(reweave.startReweave).toHaveBeenCalledTimes(1));
    expect(generations.returnToGeneration).not.toHaveBeenCalled();
    // the buttons are gone once the choice is made — no double start
    expect(screen.queryByRole("button", { name: "REWEAVE" })).not.toBeInTheDocument();
  });

  it("a refused start speaks the reason instead of pretending", async () => {
    reweave.startReweave.mockResolvedValue({ ok: false, reason: "a weave is already under way" });
    mockHandle.mockResolvedValue({
      kind: "consent",
      consent: "reweave_consent",
      line: "weave generation 3f2a1c — LOOM will close and return",
    });
    render(<Companion />);
    await submit("reweave yourself");
    await userEvent.click(await screen.findByRole("button", { name: "REWEAVE" }));
    expect(await screen.findByText("a weave is already under way")).toBeInTheDocument();
  });

  it("renders the return consent with RETURN; RETURN calls returnToGeneration(sha)", async () => {
    mockHandle.mockResolvedValue({
      kind: "consent",
      consent: "generation_return_consent",
      sha: PREV,
      line: "return to generation 9b8c7d — LOOM will close and return",
    });
    render(<Companion />);
    await submit("return to the previous generation");

    const card = await screen.findByTestId("consent-generation_return_consent");
    expect(card).toHaveTextContent("return to generation 9b8c7d — LOOM will close and return");
    await userEvent.click(screen.getByRole("button", { name: "RETURN" }));
    await waitFor(() => expect(generations.returnToGeneration).toHaveBeenCalledWith(PREV));
    expect(reweave.startReweave).not.toHaveBeenCalled();
  });

  it("NOT NOW settles the card and touches nothing", async () => {
    mockHandle.mockResolvedValue({
      kind: "consent",
      consent: "reweave_consent",
      line: "weave generation 3f2a1c — LOOM will close and return",
    });
    render(<Companion />);
    await submit("reweave yourself");
    await userEvent.click(await screen.findByRole("button", { name: "NOT NOW" }));
    expect(screen.queryByRole("button", { name: "REWEAVE" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "NOT NOW" })).not.toBeInTheDocument();
    expect(reweave.startReweave).not.toHaveBeenCalled();
    expect(generations.returnToGeneration).not.toHaveBeenCalled();
    expect(screen.getByTestId("consent-reweave_consent")).toHaveTextContent(/not now/i);
  });
});

describe("Companion — the greeting after a weave", () => {
  it("greets once with the new generation and remembers it", async () => {
    identityMock.mockResolvedValue({ mode: "packaged", genomeSha: SHA, generation: SHA, threaded: true, loomhome: "/l" });
    localStorage.setItem("loom.lastGeneration", PREV);

    const { unmount } = render(<Companion />);
    expect(await screen.findByText("I'm back — generation 3f2a1c.")).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("loom.lastGeneration")).toBe(SHA));
    // no model call was made for the greeting
    expect(mockHandle).not.toHaveBeenCalled();
    unmount();

    // the next boot of the same generation stays quiet
    render(<Companion />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText("I'm back — generation 3f2a1c.")).not.toBeInTheDocument();
  });

  it("stays quiet when no generation has been woven (dev mode, generation null)", async () => {
    render(<Companion />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText(/I'm back/)).not.toBeInTheDocument();
    expect(localStorage.getItem("loom.lastGeneration")).toBeNull();
  });

  it("speaks the greeting when voice.speakReplies is always", async () => {
    identityMock.mockResolvedValue({ mode: "packaged", genomeSha: SHA, generation: SHA, threaded: true, loomhome: "/l" });
    localStorage.setItem("voice.speakReplies", "always");
    render(<Companion />);
    await screen.findByText("I'm back — generation 3f2a1c.");
    await waitFor(() => {
      const spoke = invokeMock.mock.calls.find((c) => c[0] === "tts_speak");
      expect(spoke).toBeDefined();
    });
  });

  it("outside the shell the greeting is skipped without a failure card", async () => {
    identityMock.mockRejectedValue(new Error("This surface needs the desktop shell."));
    render(<Companion />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText(/I'm back/)).not.toBeInTheDocument();
    expect(screen.queryByText(/desktop shell/)).not.toBeInTheDocument();
  });
});
