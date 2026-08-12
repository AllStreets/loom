import { organSystemPrompt, ctxFor } from "./prompts";
import { extractCode } from "./edits";
import type { gate } from "./validate";
import type { Msg, ChatOpts } from "../core";

export type GateRepairDeps = {
  chat: (role: string, messages: Msg[], opts?: ChatOpts) => Promise<string>;
  gate: typeof gate;
  emit: (phase: string, detail: string) => void;
};

export type GateRepairResult =
  | { ok: true; code: string; tests: string }
  | { ok: false; stage: string; errors: string };

export async function runGateWithRepair(
  files: { manifest: string; code: string; tests: string },
  organId: string,
  deps: GateRepairDeps,
): Promise<GateRepairResult> {
  const { chat, gate, emit } = deps;
  const { manifest } = files;
  let code = files.code;
  let tests = files.tests;

  emit("gate", "validating...");
  let gateResult = await gate({ manifest, code, tests }, organId);
  let round = 0;

  while (!gateResult.ok && round < 2) {
    round++;
    const stage = gateResult.verdict?.stage ?? "gate";
    const errors = gateResult.verdict?.errors?.join("; ") ?? gateResult.error ?? "gate failed";
    emit("gate", `failed at ${stage}: ${errors}`);

    const target = stage === "tests" && round === 2 ? "test.js" : "organ.js";
    const broken = target === "test.js" ? tests : code;
    emit("repair", `round ${round}: asking the builder to fix ${target}...`);
    const repairSystem = organSystemPrompt("repair");
    const repairUser =
      `FILE: ${target}\n\nCURRENT (FAILED) CONTENT:\n${broken}\n\n` +
      `VALIDATION ERRORS (stage: ${stage}):\n${errors}\n\n` +
      (target === "test.js"
        ? `The organ.js under test is:\n${code}\n\nThe tests may be too strict or query elements that do not exist — make them robust and faithful to the organ's real behavior.\n\n`
        : `The manifest is:\n${manifest}\n\nThe failing tests describe the intended behavior — fix organ.js so it satisfies them:\n${tests}\n\n`) +
      `Output the complete corrected ${target}.`;
    const repairRaw = await chat("builder", [
      { role: "system", content: repairSystem },
      { role: "user", content: repairUser },
    ], { numCtx: ctxFor(repairSystem.length + repairUser.length), temperature: 0.2 });
    const repaired = extractCode(repairRaw);
    if (target === "test.js") tests = repaired; else code = repaired;
    emit("repair", `${target} rewritten — revalidating...`);
    gateResult = await gate({ manifest, code, tests }, organId);
  }

  if (!gateResult.ok) {
    const stage = gateResult.verdict?.stage ?? "gate";
    const errors = gateResult.verdict?.errors?.join("; ") ?? gateResult.error ?? "gate failed";
    emit("gate", `failed after ${round} repair round${round === 1 ? "" : "s"} at ${stage}: ${errors}`);
    return { ok: false, stage, errors };
  }

  emit("gate", "passed");
  return { ok: true, code, tests };
}
