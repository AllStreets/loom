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

export function applyBlock(text: string, search: string, replace: string): string | null {
  if (search === "") return text.replace(/\n?$/, "") + "\n" + replace + "\n";
  if (text.includes(search)) return text.replace(search, replace);
  const T = text.split("\n");
  const S = search.split("\n").map((l) => l.trim());
  while (S.length && S[S.length - 1] === "") S.pop();
  while (S.length && S[0] === "") S.shift();
  if (!S.length) return null;
  for (let i = 0; i + S.length <= T.length; i++) {
    let ok = true;
    for (let j = 0; j < S.length; j++) if (T[i + j].trim() !== S[j]) { ok = false; break; }
    if (ok) return [...T.slice(0, i), ...replace.split("\n"), ...T.slice(i + S.length)].join("\n");
  }
  return null;
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
