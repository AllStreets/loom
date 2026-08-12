export function newOrganPlan(_request: string): { kind: "new"; steps: ["manifest", "code", "tests"] } {
  return { kind: "new", steps: ["manifest", "code", "tests"] };
}

export function parseSteps(raw: string, validFiles: string[]): { file: string; step: string }[] {
  let arr: unknown = null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : raw;
  try { arr = JSON.parse(src); } catch {
    const bracket = src.match(/\[[\s\S]*\]/);
    if (bracket) { try { arr = JSON.parse(bracket[0]); } catch { /* fall through */ } }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is { file: string; step: string } =>
      !!x && typeof (x as { file?: unknown }).file === "string" && typeof (x as { step?: unknown }).step === "string")
    .map((x) => ({ file: x.file.trim(), step: x.step.slice(0, 240) }))
    .filter((x) => validFiles.includes(x.file))
    .slice(0, 6);
}
