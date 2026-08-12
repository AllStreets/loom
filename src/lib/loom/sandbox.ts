export type OrganFilesIn = { manifest: string; code: string; tests: string };
export type SandboxVerdict = {
  ok: boolean;
  stage: "load" | "render" | "tests" | "timeout" | "pass";
  errors: string[];
  testResults: { name: string; ok: boolean; error?: string }[];
};

export function buildHarnessSrc(files: OrganFilesIn, nonce: string): string {
  // The harness runs INSIDE a sandboxed iframe. It loads organ.js and test.js from
  // blob URLs, renders the organ into a detached div with a MOCK loom api, runs the
  // tests, and posts one result message keyed by the nonce. Any uncaught error or
  // unhandled rejection fails the run.
  const codeB64 = btoa(unescape(encodeURIComponent(files.code)));
  const testsB64 = btoa(unescape(encodeURIComponent(files.tests)));
  return `<!doctype html><meta charset="utf-8"><body><script type="module">
const NONCE = ${JSON.stringify(nonce)};
const report = (r) => parent.postMessage(Object.assign({ nonce: NONCE }, r), "*");
const fail = (stage, msg) => report({ ok: false, stage, errors: [String(msg)], testResults: [] });
addEventListener("error", (e) => fail("load", e.message));
addEventListener("unhandledrejection", (e) => fail("load", e.reason));
const mockLoom = {
  storage: { _m: new Map(), get(k, f) { return this._m.has(k) ? this._m.get(k) : f; }, set(k, v) { this._m.set(k, v); }, del(k) { this._m.delete(k); } },
  model: { chat: async () => "(model unavailable in sandbox)" },
  ui: { tokens: { bg: "#060b18", panel: "#0d1424", t1: "#e8edf7", t2: "#9fb0cc", t3: "#5f6f8c", accent: "#f59e0b", go: "#4ade80", warn: "#fbbf24", danger: "#f87171" } },
  notify: () => {},
};
const modUrl = (b64) => URL.createObjectURL(new Blob([decodeURIComponent(escape(atob(b64)))], { type: "text/javascript" }));
try {
  const organ = (await import(modUrl("${codeB64}"))).default;
  if (!organ || typeof organ.render !== "function") { fail("load", "organ.js has no default export with a render() function"); }
  else {
    const el = document.createElement("div");
    try { await organ.render(el, mockLoom); } catch (e) { fail("render", e && e.message || e); throw e; }
    let tests = [];
    try { tests = (await import(modUrl("${testsB64}"))).tests || []; } catch (e) { fail("tests", "test.js failed to load: " + (e && e.message || e)); throw e; }
    const results = [];
    for (const t of tests) {
      const tEl = document.createElement("div");
      try { await organ.render(tEl, mockLoom); } catch { /* render already verified */ }
      const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };
      try { await t.fn({ el: tEl, loom: mockLoom, assert }); results.push({ name: t.name, ok: true }); }
      catch (e) { results.push({ name: t.name, ok: false, error: String(e && e.message || e) }); }
    }
    const allOk = results.every((r) => r.ok);
    report({ ok: allOk, stage: allOk ? "pass" : "tests", errors: allOk ? [] : results.filter((r) => !r.ok).map((r) => r.name + ": " + r.error), testResults: results });
  }
} catch (e) { /* already reported */ }
</${"script"}>`;
}

export function sandboxRun(files: OrganFilesIn, timeoutMs = 5000): Promise<SandboxVerdict> {
  return new Promise((resolve) => {
    const nonce = Math.random().toString(36).slice(2);
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.display = "none";
    let done = false;
    const finish = (v: SandboxVerdict) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      iframe.remove();
      resolve(v);
    };
    const onMsg = (e: MessageEvent) => {
      if (!e.data || e.data.nonce !== nonce) return;
      finish({ ok: !!e.data.ok, stage: e.data.stage, errors: e.data.errors ?? [], testResults: e.data.testResults ?? [] });
    };
    window.addEventListener("message", onMsg);
    setTimeout(() => finish({ ok: false, stage: "timeout", errors: [`sandbox timed out after ${timeoutMs}ms`], testResults: [] }), timeoutMs);
    iframe.srcdoc = buildHarnessSrc(files, nonce);
    document.body.appendChild(iframe);
  });
}
