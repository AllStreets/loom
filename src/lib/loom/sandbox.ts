import { UIKIT_SRC, KIT_TOKENS } from "../organs/uikitSrc";

export type OrganFilesIn = { manifest: string; code: string; tests: string };
export type SandboxVerdict = {
  ok: boolean;
  stage: "load" | "render" | "tests" | "timeout" | "pass" | "probe";
  errors: string[];
  testResults: { name: string; ok: boolean; error?: string }[];
  renderedHtml?: string;
};

export type SandboxOpts = { probeOnly?: boolean };

export function buildHarnessSrc(files: OrganFilesIn, nonce: string, opts?: SandboxOpts): string {
  // The harness runs INSIDE a sandboxed iframe. It loads organ.js and test.js from
  // blob URLs, renders the organ into a detached div with a MOCK loom api, runs the
  // tests, and posts one result message keyed by the nonce. Any uncaught error or
  // unhandled rejection fails the run.
  const probeOnly = opts?.probeOnly ?? false;
  const codeB64 = btoa(unescape(encodeURIComponent(files.code)));
  const testsB64 = btoa(unescape(encodeURIComponent(files.tests)));
  return `<!doctype html><meta charset="utf-8"><body><script type="module">
const NONCE = ${JSON.stringify(nonce)};
const PROBE_ONLY = ${JSON.stringify(probeOnly)};
const report = (r) => parent.postMessage(Object.assign({ nonce: NONCE }, r), "*");
const fail = (stage, msg, renderedHtml) => report({ ok: false, stage, errors: [String(msg)], testResults: [], renderedHtml: renderedHtml || null });
addEventListener("error", (e) => fail("load", e.message));
addEventListener("unhandledrejection", (e) => fail("load", e.reason));
${UIKIT_SRC}
// Each render/test gets a FRESH loom api with its OWN empty storage — tests are
// isolated, exactly as a developer (or model) naturally assumes. State pollution
// between tests was a real failure mode: "three movies remain" failing because a
// previous test's items were still in a shared store.
const freshLoom = () => {
  var tokens = ${JSON.stringify(KIT_TOKENS)};
  var VOICE_IDS = ["en_US-lessac-medium","en_GB-alba-medium","en_US-libritts-high"];
  var VOICE_LABELS = {"en_US-lessac-medium":"Lessac — warm, neutral (US)","en_GB-alba-medium":"Alba — calm (British)","en_US-libritts-high":"LibriTTS — rich (US)"};
  var settingsMap = new Map();
  // ── Power mocks — deterministic, offline, inspectable ────────────────────────
  // notify records into notifyFn.sent; voice.say into voice.said; pulse.every
  // fires the callback ONCE immediately (the test hook) and records the ms.
  var notifyFn = function(title, body) {
    notifyFn.sent.push({ title: String(title), body: body === undefined ? undefined : String(body) });
  };
  notifyFn.sent = [];
  var voiceApi = { said: [] };
  voiceApi.say = async function(text) { voiceApi.said.push(String(text).slice(0, 300)); };
  var pulseApi = { registered: [] };
  pulseApi.every = function(ms, fn) {
    pulseApi.registered.push(ms);
    try { fn(); } catch (e) { /* a pulse must never crash the harness */ }
    return function() {};
  };
  var FX_RATES = { EUR: 0.92, GBP: 0.79, JPY: 155.3, CHF: 0.88 };
  var WATCH_TOP = [
    { title: "BTC slides 5% in the hour", source: "auspex", score: 0.92, reasons: ["watchlist: bitcoin"] },
    { title: "M6.1 quake off Honshu", source: "quakes", score: 0.74, reasons: ["magnitude 6.1"] },
    { title: "Launch window opens at Boca Chica", source: "auspex", score: 0.55, reasons: ["category: launch"] },
  ];
  var WATCHLIST = [{ kind: "topic", value: "bitcoin" }, { kind: "place", value: "tokyo" }];
  var COMMITS = [
    { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", message: "feat(organ): first weave" },
    { sha: "b2c3d4e5f60718293a4b5c6d7e8f901234567890", message: "fix(organ): calm the edge case" },
  ];
  return {
    storage: { _m: new Map(), get(k, f) { return this._m.has(k) ? this._m.get(k) : f; }, set(k, v) { this._m.set(k, v); }, del(k) { this._m.delete(k); } },
    model: { chat: async () => "(model unavailable in sandbox)" },
    ui: makeUi(tokens),
    notify: notifyFn,
    market: {
      chart: async function(symbol) {
        return { symbol: String(symbol), name: String(symbol), price: 512.34, prevClose: 508.1, open: 509.0, high: 514.2, low: 506.8, volume: 1234567, closes: [508.1, 509.4, 511.0, 512.34], timestamps: [1755820800, 1755820860, 1755820920, 1755820980] };
      },
      crypto: async function(product) {
        return { product: String(product), price: 61250.0, bid: 61249.5, ask: 61250.5, open24h: 64473.68, high24h: 64980.0, low24h: 60900.0, volume24h: 8421.5, changePct24h: -5.0, time: "2026-08-22T12:00:00Z" };
      },
      book: async function(product, depth) {
        var d = Math.max(1, Math.min(depth || 10, 4));
        var bids = [{ price: 61249.5, size: 0.8 }, { price: 61249.0, size: 1.2 }, { price: 61248.5, size: 0.4 }, { price: 61248.0, size: 2.1 }];
        var asks = [{ price: 61250.5, size: 0.6 }, { price: 61251.0, size: 2.0 }, { price: 61251.5, size: 0.9 }, { price: 61252.0, size: 1.5 }];
        return { product: String(product), bids: bids.slice(0, d), asks: asks.slice(0, d) };
      },
      trades: async function(product) {
        return [
          { tradeId: 101, time: "2026-08-22T12:00:00Z", price: 61250.0, size: 0.05, side: "buy" },
          { tradeId: 100, time: "2026-08-22T11:59:58Z", price: 61251.0, size: 0.12, side: "sell" },
        ];
      },
      fx: async function(base, symbols) {
        var rates = {};
        (symbols || []).forEach(function(s) { rates[s] = FX_RATES[s] !== undefined ? FX_RATES[s] : 1.0; });
        return { base: String(base), date: "2026-08-22", rates: rates };
      },
    },
    watch: {
      top: function(n) { return WATCH_TOP.slice(0, n === undefined ? 10 : n).map(function(r) { return { title: r.title, source: r.source, score: r.score, reasons: r.reasons.slice() }; }); },
      list: function() { return WATCHLIST.map(function(e) { return { kind: e.kind, value: e.value }; }); },
    },
    timeline: {
      log: async function(n) { return COMMITS.slice(0, n === undefined ? 20 : n); },
    },
    voice: voiceApi,
    pulse: pulseApi,
    settings: {
      get: function(k) { return settingsMap.has(k) ? settingsMap.get(k) : ""; },
      set: function(k, v) { settingsMap.set(k, v); },
      voices: async function() { return VOICE_IDS.map(function(id) { return { id: id, label: VOICE_LABELS[id], present: false }; }); },
      audition: async function() {},
      micTest: async function() { return "ok"; },
      voiceStatus: async function() { return { ready: false, whisper: false, voices: [], missing_bytes_hint: null }; },
      setup: async function() {},
      models: async function() {
        var tagRe = /^[A-Za-z0-9][A-Za-z0-9._\-\/]*(:[A-Za-z0-9._\-]+)?$/;
        var DEFS = [
          { role: "builder",   def: "qwen3-coder:30b-a3b-q4_K_M", present: true  },
          { role: "companion", def: "gpt-oss:20b",                 present: true  },
          { role: "rewriter",  def: "qwen3:1.7b",                  present: false },
        ];
        return DEFS.map(function(d) {
          var ov = settingsMap.has("model." + d.role) ? settingsMap.get("model." + d.role) : "";
          var effectiveModel = (ov && tagRe.test(ov) && ov.length <= 128) ? ov : d.def;
          return { role: d.role, model: effectiveModel, "default": d.def, override: ov, present: d.present };
        });
      },
      setModel: async function(role, tag) {
        var validRoles = ["builder", "companion", "rewriter"];
        if (validRoles.indexOf(role) === -1) { return { ok: false, error: "unknown role" }; }
        var tagRe = /^[A-Za-z0-9][A-Za-z0-9._\-\/]*(:[A-Za-z0-9._\-]+)?$/;
        if (tag !== "" && (!tagRe.test(tag) || tag.length > 128)) { return { ok: false, error: "invalid tag" }; }
        settingsMap.set("model." + role, tag);
        return { ok: true };
      },
      cloudKeyPresent: async function() { return settingsMap.has("__cloudKey") && !!settingsMap.get("__cloudKey"); },
      cloudKeySet: async function(key) { settingsMap.set("__cloudKey", key); },
      cloudKeyClear: async function() { settingsMap.delete("__cloudKey"); },
    },
  };
};
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
    const renderedHtml = el.innerHTML.slice(0, 9000);
    if (PROBE_ONLY) {
      report({ ok: true, stage: "probe", errors: [], testResults: [], renderedHtml });
      throw new Error("probe done");
    }
    let tests = [];
    // Relative imports cannot resolve from a blob URL — rewrite any organ.js
    // specifier in the tests to the actual organ blob URL so they still work.
    let testsSrc = decode("${testsB64}");
    testsSrc = testsSrc
      .split("'./organ.js'").join("'" + organUrl + "'")
      .split('"./organ.js"').join('"' + organUrl + '"')
      .split("'organ.js'").join("'" + organUrl + "'")
      .split('"organ.js"').join('"' + organUrl + '"');
    try { tests = (await import(mkUrl(testsSrc))).tests || []; } catch (e) { fail("tests", "test.js failed to load: " + (e && e.message || e), renderedHtml); throw e; }
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
    report({ ok: allOk, stage: allOk ? "pass" : "tests", errors: allOk ? [] : results.filter((r) => !r.ok).map((r) => r.name + ": " + r.error), testResults: results, renderedHtml });
  }
} catch (e) { /* already reported */ }
</${"script"}>`;
}

export function sandboxRun(files: OrganFilesIn, timeoutMs = 8000, opts?: SandboxOpts): Promise<SandboxVerdict> {
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
      finish({ ok: !!e.data.ok, stage: e.data.stage, errors: e.data.errors ?? [], testResults: e.data.testResults ?? [], renderedHtml: e.data.renderedHtml ?? undefined });
    };
    window.addEventListener("message", onMsg);
    setTimeout(() => finish({ ok: false, stage: "timeout", errors: [`sandbox timed out after ${timeoutMs}ms`], testResults: [] }), timeoutMs);
    iframe.srcdoc = buildHarnessSrc(files, nonce, opts);
    document.body.appendChild(iframe);
  });
}
