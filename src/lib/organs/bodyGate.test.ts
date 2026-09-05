/**
 * bodyGate.test.ts — the organ asks; only chrome answers.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BODY_REQUEST_EVENT,
  BodyRequestDeclined,
  LINE_DECLINED,
  LINE_NO_CHROME,
  answerBodyRequest,
  claimBodyRequest,
  pendingBodyRequests,
  requestBody,
  type BodyRequest,
  type BodyRequestEvent,
} from "./bodyGate";

/**
 * A fake chrome that claims every request and answers however the test says.
 * It learns WHAT was asked the way the real card does — from the claim, not
 * from the event, which carries an id and nothing else.
 */
function mountChrome(answer: (req: BodyRequest) => void) {
  const seen: BodyRequest[] = [];
  const onRequest = (ev: Event) => {
    const { id } = (ev as CustomEvent<BodyRequestEvent>).detail;
    const claimed = claimBodyRequest(id);
    if (!claimed) return;
    seen.push(claimed);
    answer(claimed);
  };
  window.addEventListener(BODY_REQUEST_EVENT, onRequest);
  return { seen, unmount: () => window.removeEventListener(BODY_REQUEST_EVENT, onRequest) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("requestBody", () => {
  it("the claim carries kind, sha and the organ that asked", async () => {
    const chrome = mountChrome((req) => answerBodyRequest(req.id, { ok: true }));
    await requestBody("return", "settings", "c".repeat(40));
    expect(chrome.seen).toHaveLength(1);
    expect(chrome.seen[0]).toMatchObject({
      kind: "return",
      organId: "settings",
      sha: "c".repeat(40),
    });
    expect(typeof chrome.seen[0].id).toBe("string");
    chrome.unmount();
  });

  /**
   * Round-2 finding 1. The detail used to be the whole request, and chrome read
   * it again when the owner clicked — so an organ could hold the object and
   * change `kind` between the sentence and the act.
   */
  it("the event carries an opaque id and nothing else", async () => {
    const details: unknown[] = [];
    const spy = (ev: Event) => details.push((ev as CustomEvent).detail);
    window.addEventListener(BODY_REQUEST_EVENT, spy);
    const chrome = mountChrome((req) => answerBodyRequest(req.id, { ok: true }));
    await requestBody("return", "settings", "c".repeat(40));
    expect(details).toHaveLength(1);
    expect(Object.keys(details[0] as object)).toEqual(["id"]);
    chrome.unmount();
    window.removeEventListener(BODY_REQUEST_EVENT, spy);
  });

  it("the claimed record is frozen, and mutating it changes nothing behind it", async () => {
    let first: BodyRequest | null = null;
    const chrome = mountChrome((req) => {
      first = req;
      answerBodyRequest(req.id, { ok: true });
    });
    await requestBody("thread", "notes");
    expect(Object.isFrozen(first)).toBe(true);
    chrome.unmount();
  });

  it("an id nobody issued cannot be claimed, and a claimed id cannot be claimed twice", async () => {
    expect(claimBodyRequest("body-999-forged")).toBeNull();
    let claimedTwice: BodyRequest | null | undefined;
    const chrome = mountChrome((req) => {
      claimedTwice = claimBodyRequest(req.id);
      answerBodyRequest(req.id, { ok: true });
    });
    await requestBody("reweave", "notes");
    expect(claimedTwice).toBeNull();
    chrome.unmount();
  });

  it("resolves when chrome approves and the act ran", async () => {
    const chrome = mountChrome((req) => answerBodyRequest(req.id, { ok: true }));
    await expect(requestBody("reweave", "settings")).resolves.toBeUndefined();
    chrome.unmount();
  });

  it("rejects with the calm refusal when the owner declines", async () => {
    const chrome = mountChrome((req) =>
      answerBodyRequest(req.id, { ok: false, reason: LINE_DECLINED, declined: true }),
    );
    const p = requestBody("reweave", "settings");
    await expect(p).rejects.toBeInstanceOf(BodyRequestDeclined);
    await expect(requestBody("reweave", "settings")).rejects.toThrow(LINE_DECLINED);
    chrome.unmount();
  });

  it("rejects with the core's own reason when the act itself refuses", async () => {
    const chrome = mountChrome((req) =>
      answerBodyRequest(req.id, { ok: false, reason: "a weave is already under way" }),
    );
    const p = requestBody("reweave", "settings");
    await expect(p).rejects.toThrow("a weave is already under way");
    await expect(p.catch((e) => e)).resolves.not.toBeInstanceOf(BodyRequestDeclined);
    chrome.unmount();
  });

  it("rejects at once when no chrome is listening — an organ never waits forever", async () => {
    await expect(requestBody("thread", "settings")).rejects.toThrow(LINE_NO_CHROME);
    expect(pendingBodyRequests()).toBe(0);
  });

  it("rejects when chrome hears but does not claim (a card already open)", async () => {
    const onRequest = vi.fn();
    window.addEventListener(BODY_REQUEST_EVENT, onRequest);
    await expect(requestBody("reweave", "settings")).rejects.toThrow(LINE_NO_CHROME);
    expect(onRequest).toHaveBeenCalledTimes(1);
    window.removeEventListener(BODY_REQUEST_EVENT, onRequest);
  });

  it("an answer for an unknown id is ignored, and a second answer changes nothing", async () => {
    let seenId = "";
    const chrome = mountChrome((req) => {
      seenId = req.id;
      answerBodyRequest(req.id, { ok: true });
    });
    await requestBody("thread", "settings");
    expect(() => answerBodyRequest(seenId, { ok: false, reason: "too late" })).not.toThrow();
    expect(() => answerBodyRequest("never-existed", { ok: true })).not.toThrow();
    expect(pendingBodyRequests()).toBe(0);
    chrome.unmount();
  });

  it("each request carries its own id — two in flight settle independently", async () => {
    const ids: string[] = [];
    const onRequest = (ev: Event) => {
      const req = (ev as CustomEvent<BodyRequest>).detail;
      ids.push(req.id);
      claimBodyRequest(req.id);
    };
    window.addEventListener(BODY_REQUEST_EVENT, onRequest);
    const a = requestBody("reweave", "settings");
    const b = requestBody("thread", "settings");
    expect(new Set(ids).size).toBe(2);
    answerBodyRequest(ids[1], { ok: true });
    await expect(b).resolves.toBeUndefined();
    answerBodyRequest(ids[0], { ok: false, reason: LINE_DECLINED, declined: true });
    await expect(a).rejects.toThrow(LINE_DECLINED);
    window.removeEventListener(BODY_REQUEST_EVENT, onRequest);
  });
});
