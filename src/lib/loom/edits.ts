export function extractCode(s: string): string {
  let t = (s || "").trim();
  const open = t.match(/^```[a-zA-Z0-9]*[ \t]*\r?\n/);
  if (open) {
    t = t.slice(open[0].length);
    t = t.replace(/\r?\n?```[a-zA-Z0-9]*[ \t]*$/, "");
  } else {
    const inner = t.match(/```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)```/);
    if (inner) t = inner[1];
  }
  t = t.replace(/^```[a-zA-Z0-9]*[ \t]*\r?\n/, "").replace(/\r?\n?```[a-zA-Z0-9]*[ \t]*$/, "");
  return t.replace(/\s+$/, "");
}

export function scrubFences(t: string): string {
  return String(t ?? "")
    .replace(/^\s*```[a-zA-Z0-9]*[ \t]*\r?\n/, "")
    .replace(/\r?\n?```[a-zA-Z0-9]*[ \t]*\s*$/, "");
}

/**
 * Apply one SEARCH/REPLACE block. The TypeScript twin of `apply_exact_unique`
 * in `src-tauri/src/kernel.rs`, and — since round 4 — held to the same rules.
 *
 * Returns the edited text, or null when the SEARCH is simply absent (the
 * caller's retry/rewrite path). THROWS on a refusal: an empty or an ambiguous
 * SEARCH is a malformed edit, and the message is what `editOrgan` feeds back to
 * the model on its retry.
 *
 * THE THREE DIVERGENCES ROUND 4 CLOSED (Rust was right on all three):
 *
 *  1. LITERAL REPLACEMENT. `text.replace(search, replace)` interprets `$$`,
 *     `$&`, "$`" and `$'` in the REPLACEMENT argument. The search side was a
 *     literal string and safe; the replacement was not, so an organ edit whose
 *     replacement contained, say, `.replace(/x/, "$&")` was written to disk
 *     mangled — no error, nothing pointing at the cause. Rust finds and slices.
 *     So do we now: indexOf + slice, never a substitution pattern.
 *
 *  2. EMPTY SEARCH IS REFUSED. It used to blind-append the replacement to the
 *     end of the file. Nothing in the prompt contract offers an empty SEARCH as
 *     an "append" convention — an empty SEARCH means the model failed to copy
 *     the anchor, and appending its replacement to the bottom of an organ is
 *     almost certainly wrong AND silent. Rust refuses; a refusal is a retry
 *     with a reason, which is strictly better than a wrong file.
 *
 *  3. AMBIGUOUS SEARCH IS REFUSED. It used to take the first of several
 *     matches. The judgment call: this DOES retire one working pattern — two
 *     identical blocks in one response, applied in order, each consuming the
 *     next occurrence. That pattern is worth less than what it costs. The
 *     prompt tells the model to copy verbatim and keep it minimal, so a short
 *     anchor matching three places is the COMMON case, and first-match silently
 *     edits a line the model never meant. `editOrgan` already retries on a
 *     throw with the error text appended, and falls back to a full rewrite on a
 *     second failure — so a refusal degrades into "say more context", while a
 *     wrong first match degrades into a corrupted organ. And it makes the
 *     kernel path agree end to end: the same edit text that TypeScript accepts
 *     is the edit text Rust will accept, which is the seam that broke this
 *     phase twice.
 *
 * The whitespace-tolerant fallback (indentation drift in SEARCH) stays — it is
 * a real leniency the Rust side does not need, because kernel edits are checked
 * against the file Rust itself read. It is held to the same uniqueness rule.
 */
export function applyBlock(text: string, search: string, replace: string): string | null {
  if (search === "") {
    throw new Error("an empty SEARCH is not allowed — copy the lines to change from the file");
  }

  // Exact path — literal find-and-slice, exactly as apply_exact_unique does.
  const first = text.indexOf(search);
  if (first !== -1) {
    const after = first + search.length;
    if (text.indexOf(search, after) !== -1) {
      throw new Error("the SEARCH text is ambiguous (it matches more than once) — include more surrounding lines");
    }
    return text.slice(0, first) + replace + text.slice(after);
  }

  // Whitespace-tolerant path — compare trimmed lines, still uniquely.
  const T = text.split("\n");
  const S = search.split("\n").map((l) => l.trim());
  while (S.length && S[S.length - 1] === "") S.pop();
  while (S.length && S[0] === "") S.shift();
  if (!S.length) return null;
  let at = -1;
  for (let i = 0; i + S.length <= T.length; i++) {
    let ok = true;
    for (let j = 0; j < S.length; j++) if (T[i + j].trim() !== S[j]) { ok = false; break; }
    if (!ok) continue;
    if (at !== -1) {
      throw new Error("the SEARCH text is ambiguous (it matches more than once) — include more surrounding lines");
    }
    at = i;
  }
  if (at === -1) return null;
  return [...T.slice(0, at), ...replace.split("\n"), ...T.slice(at + S.length)].join("\n");
}

export function applyEditBlocks(base: string, raw: string): string | null {
  const re = /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n?={5,}\s*\r?\n([\s\S]*?)\r?\n?>{5,}\s*REPLACE/g;
  const blocks = [...raw.matchAll(re)];
  if (!blocks.length) return null;
  let text = base;
  for (const b of blocks) {
    const applied = applyBlock(text, b[1].replace(/\r/g, ""), b[2].replace(/\r/g, ""));
    if (applied == null) throw new Error("an edit block's SEARCH text was not found in the file");
    text = applied;
  }
  return text;
}

export function spliceEntries(base: string, varName: string, raw: string): string {
  let snip = extractCode(raw).trim();
  snip = snip.replace(/^[^[{]*/, "");
  snip = snip.replace(/^(?:const|let|var)\s+\w+\s*=\s*/, "").replace(/;?\s*$/, "");
  snip = snip.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!snip) throw new Error("the model returned no new entries");
  if (!snip.endsWith(",")) snip += ",";
  new Function("return [\n" + snip + "\n]"); // throws on invalid entries
  const m = base.match(new RegExp("(?:const|let|var)\\s+" + varName + "\\s*=\\s*\\["));
  if (!m || m.index === undefined) throw new Error("could not find the " + varName + " array");
  const at = m.index + m[0].length;
  return base.slice(0, at) + "\n" + snip + "\n" + base.slice(at);
}
