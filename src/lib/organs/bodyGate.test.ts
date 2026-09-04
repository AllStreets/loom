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
} from "./bodyGate";

/** A fake chrome that claims every request and answers however the test says. */
function mountChrome(answer: (req: BodyRequest) => void) {
  const seen: BodyRequest[] = [];
  const onRequest = (ev: Event) => {
    const req = (ev as CustomEvent<BodyRequest>).detail;
    seen.push(req);
    claimBodyRequest(req.id);
    answer(req);
  };
  window.addEventListener(BODY_REQUEST_EVENT, onRequest);
  return { seen, unmount: () => window.removeEventListener(BODY_REQUEST_EVENT, onRequest) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("requestBody", () => {
  it("dispatches the request with kind, sha and the organ that asked", async () => {
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
