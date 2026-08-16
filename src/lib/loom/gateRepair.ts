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
  | { ok: true; code: string; tests: string; repairRounds: number }
  | { ok: false; stage: string; errors: string; repairRounds: number };

// Error-aware target routing: match error patterns before falling back to fixed sequence.
// Quick-win 2: priorAttempts memory
// Quick-win 3: error-aware routing before fixed sequence tiebreak
// Quick-win 4: temperature 0.0 for repairs
// Round targeting for tests-stage failures:
// round 1 → organ.js  (the code is probably wrong)
// round 2 → test.js   (the tests may be imagining elements that don't exist)
// round 3 → organ.js  (last chance fix to the code)
function targetForRound(stage: string, round: number, errors: string): "organ.js" | "test.js" {
  if (stage !== "tests") return "organ.js";
  // Error-aware routing: pattern match before fixed sequence tiebreak
  if (/import|cannot resolve|not a module/i.test(errors)) return "test.js";
  if (/querySelector.*null|not a function|undefined/i.test(errors)) return "organ.js";
  // Fixed sequence tiebreak
  if (round === 2) return "test.js";
  return "organ.js";
}

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

  // Accumulate compact summaries of each repair round for priorAttempts memory
  const priorAttempts: string[] = [];

  while (!gateResult.ok && round < 3) {
    round++;
    const stage = gateResult.verdict?.stage ?? "gate";
    const errors = gateResult.verdict?.errors?.join("; ") ?? gateResult.error ?? "gate failed";
    const renderedHtml = gateResult.verdict?.renderedHtml;
    emit("gate", `failed at ${stage}: ${errors}`);

    const target = targetForRound(stage, round, errors);
    const broken = target === "test.js" ? tests : code;

    // Build per-test failure lines for structured feedback
    const failedTests = gateResult.verdict?.testResults?.filter((r) => !r.ok) ?? [];
    const perTestLines = failedTests.length > 0
      ? "\nFAILED TESTS:\n" + failedTests.map((r) => `- ${r.name}: ${r.error ?? "unknown error"}`).join("\n")
      : "";

    // Include the real rendered DOM so the model sees what was actually built
    const renderedHtmlSection = renderedHtml
      ? `\nThe organ's ACTUAL rendered HTML (ground truth — your selectors MUST match elements present here):\n${renderedHtml}\n`
      : "";

    // Build priorAttempts section for memory across repair rounds
    const priorAttemptsSection = priorAttempts.length > 0
      ? `\nPRIOR REPAIR ATTEMPTS (do NOT repeat these mistakes):\n${priorAttempts.join("\n")}\n`
      : "";

    emit("repair", `round ${round}: asking the builder to fix ${target}...`);
    const repairSystem = organSystemPrompt("repair");
    const repairUser =
      `FILE: ${target}\n\nCURRENT (FAILED) CONTENT:\n${broken}\n\n` +
      `VALIDATION ERRORS (stage: ${stage}):\n${errors}${perTestLines}\n\n` +
      renderedHtmlSection +
      priorAttemptsSection +
      (target === "test.js"
        ? `The organ.js under test is:\n${code}\n\nThe tests may be too strict or query elements that do not exist — make them robust and faithful to the organ's real behavior. Remember: re-set input.value before each add click; re-query remove buttons after each mutation.\n\n`
        : `The manifest is:\n${manifest}\n\nThe failing tests describe the intended behavior — fix organ.js so it satisfies them. Remember: clear input after successful add; re-render the list after every mutation:\n${tests}\n\n`) +
      `Output the complete corrected ${target}.`;
    const repairRaw = await chat("builder", [
      { role: "system", content: repairSystem },
      { role: "user", content: repairUser },
    ], { numCtx: ctxFor(repairSystem.length + repairUser.length), temperature: 0.0 });
    const repaired = extractCode(repairRaw);

    if (target === "test.js") tests = repaired; else code = repaired;
    emit("repair", `${target} rewritten — revalidating...`);
    gateResult = await gate({ manifest, code, tests }, organId);

    // Record compact before/after for priorAttempts memory
    const beforeLines = errors.split(/[;\n]/).map((l) => l.trim()).filter(Boolean).slice(0, 2);
    const afterErrors = !gateResult.ok
      ? (gateResult.verdict?.errors?.join("; ") ?? gateResult.error ?? "gate failed")
      : null;
    const afterLines = afterErrors
      ? afterErrors.split(/[;\n]/).map((l) => l.trim()).filter(Boolean).slice(0, 2)
      : ["resolved"];
    priorAttempts.push(
      `Round ${round}: fixed ${target}\n` +
      `  before: ${beforeLines.join(" | ")}\n` +
      `  after:  ${afterLines.join(" | ")}`
    );
  }

  if (!gateResult.ok) {
    const stage = gateResult.verdict?.stage ?? "gate";
    const errors = gateResult.verdict?.errors?.join("; ") ?? gateResult.error ?? "gate failed";
    emit("gate", `failed after ${round} repair round${round === 1 ? "" : "s"} at ${stage}: ${errors}`);
    return { ok: false, stage, errors, repairRounds: round };
  }

  emit("gate", "passed");
  return { ok: true, code, tests, repairRounds: round };
}
