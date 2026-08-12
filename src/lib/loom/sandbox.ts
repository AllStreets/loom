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
// Each render/test gets a FRESH loom api with its OWN empty storage — tests are
// isolated, exactly as a developer (or model) naturally assumes. State pollution
// between tests was a real failure mode: "three movies remain" failing because a
// previous test's items were still in a shared store.
const freshLoom = () => ({
  storage: { _m: new Map(), get(k, f) { return this._m.has(k) ? this._m.get(k) : f; }, set(k, v) { this._m.set(k, v); }, del(k) { this._m.delete(k); } },
  model: { chat: async () => "(model unavailable in sandbox)" },
  ui: { tokens: { bg: "#060b18", panel: "#0d1424", t1: "#e8edf7", t2: "#9fb0cc", t3: "#5f6f8c", accent: "#22d3ee", go: "#4ade80", warn: "#fbbf24", danger: "#f87171" } },
  notify: () => {},
});
const mockLoom = freshLoom();
const decode = (b64) => decodeURIComponent(escape(atob(b64)));
const mkUrl = (src) => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
try {
  const organUrl = mkUrl(decode("${codeB64}"));
  const organ = (await import(organUrl)).default;
  if (!organ || typeof organ.render !== "function") { fail("load", "organ.js has no default export with a render() function"); }
  else {
    const el = document.createElement("div");
    try { await organ.render(el, mockLoom); } catch (e) { fail("render", e && e.message || e); throw e; }
    let tests = [];
    // Relative imports cannot resolve from a blob URL — rewrite any organ.js
    // specifier in the tests to the actual organ blob URL so they still work.
    let testsSrc = decode("${testsB64}");
    testsSrc = testsSrc
      .split("'./organ.js'").join("'" + organUrl + "'")
      .split('"./organ.js"').join('"' + organUrl + '"')
      .split("'organ.js'").join("'" + organUrl + "'")
      .split('"organ.js"').join('"' + organUrl + '"');
    try { tests = (await import(mkUrl(testsSrc))).tests || []; } catch (e) { fail("tests", "test.js failed to load: " + (e && e.message || e)); throw e; }
    const results = [];
    for (const t of tests) {
      const tEl = document.createElement("div");
      const tLoom = freshLoom();          // isolated per-test storage — no cross-test pollution
      try { await organ.render(tEl, tLoom); } catch { /* render already verified */ }
      const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };
      try { await t.fn({ el: tEl, loom: tLoom, assert, organ }); results.push({ name: t.name, ok: true }); }
      catch (e) { results.push({ name: t.name, ok: false, error: String(e && e.message || e) }); }
    }
    const allOk = results.every((r) => r.ok);
    report({ ok: allOk, stage: allOk ? "pass" : "tests", errors: allOk ? [] : results.filter((r) => !r.ok).map((r) => r.name + ": " + r.error), testResults: results });
  }
} catch (e) { /* already reported */ }
</${"script"}>`;
}

export function sandboxRun(files: OrganFilesIn, timeoutMs = 8000): Promise<SandboxVerdict> {
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
