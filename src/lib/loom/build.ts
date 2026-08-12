import { organSystemPrompt, ctxFor } from "./prompts";
import { extractCode } from "./edits";
import { manifestGuard } from "./validate";
import type { gate } from "./validate";
import type { organWrite, Msg, OrganFile, ChatOpts } from "../core";

export type BuildEvent = { ts: number; phase: string; detail: string };
export type BuildResult = { ok: boolean; organId?: string; sha?: string; error?: string; stage?: string; log: BuildEvent[] };
export type BuildDeps = {
  chat: (role: string, messages: Msg[], opts?: ChatOpts) => Promise<string>;
  write: typeof organWrite;
  gate: typeof gate;
  onEvent?: (e: BuildEvent) => void;
  /** Optional human review gate: called with the validated files BEFORE anything
   *  is written. Resolve true to apply, false to discard (nothing is written). */
  review?: (files: OrganFile[]) => Promise<boolean>;
};

let busy = false;

export function isBusy(): boolean {
  return busy;
}

export async function buildOrgan(request: string, deps: BuildDeps): Promise<BuildResult> {
  if (busy) {
    return { ok: false, error: "a build is already running", log: [] };
  }
  busy = true;
  const log: BuildEvent[] = [];

  function emit(phase: string, detail: string): void {
    const e: BuildEvent = { ts: Date.now(), phase, detail };
    log.push(e);
    deps.onEvent?.(e);
  }

  try {
    // Phase 1: manifest
    emit("manifest", "generating manifest...");
    const manifestSystem = organSystemPrompt("manifest");
    const manifestMessages: Msg[] = [
      { role: "system", content: manifestSystem },
      { role: "user", content: request },
    ];
    const manifestRaw = await deps.chat("builder", manifestMessages, {
      numCtx: ctxFor(manifestSystem.length + request.length),
      temperature: 0.2,
    });
    const manifestCode = extractCode(manifestRaw);
    const manifestResult = manifestGuard(manifestCode);
    if (!manifestResult.ok) {
      emit("manifest", "failed: " + manifestResult.error);
      return { ok: false, error: manifestResult.error, log };
    }
    const { manifest } = manifestResult;
    const organId = manifest.id;
    emit("manifest", "ok — id: " + organId);

    // Phase 2: organ.js
    emit("code", "generating organ.js...");
    const codeSystem = organSystemPrompt("code");
    const codeUser = `Request: ${request}\n\nManifest:\n${manifestCode}`;
    const codeMessages: Msg[] = [
      { role: "system", content: codeSystem },
      { role: "user", content: codeUser },
    ];
    const codeRaw = await deps.chat("builder", codeMessages, {
      numCtx: ctxFor(codeSystem.length + codeUser.length),
      temperature: 0.2,
    });
    const codeContent = extractCode(codeRaw);
    emit("code", "ok");

    // Phase 3: test.js
    emit("tests", "generating test.js...");
    const testsSystem = organSystemPrompt("tests");
    const testsUser = `Manifest:\n${manifestCode}\n\nCode:\n${codeContent}`;
    const testsMessages: Msg[] = [
      { role: "system", content: testsSystem },
      { role: "user", content: testsUser },
    ];
    const testsRaw = await deps.chat("builder", testsMessages, {
      numCtx: ctxFor(testsSystem.length + testsUser.length),
      temperature: 0.2,
    });
    const testsContent = extractCode(testsRaw);
    emit("tests", "ok");

    // Phase 4: gate — with TWO bounded repair rounds. A real coding agent does not
    // stop at the first red test: it reads the error and fixes its code.
    // Strategy: tests are treated as the SPEC. A tests-stage failure usually means
    // the CODE is wrong (e.g. "should not add empty movie" = missing input guard),
    // so round 1 repairs organ.js. Only if that doesn't help does round 2 consider
    // the tests themselves unreasonable and repair test.js. Load/render failures
    // are always the code's fault.
    let code = codeContent;
    let tests = testsContent;
    emit("gate", "validating...");
    let gateResult = await deps.gate({ manifest: manifestCode, code, tests }, organId);
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
          : `The manifest is:\n${manifestCode}\n\nThe failing tests describe the intended behavior — fix organ.js so it satisfies them:\n${tests}\n\n`) +
        `Output the complete corrected ${target}.`;
      const repairRaw = await deps.chat("builder", [
        { role: "system", content: repairSystem },
        { role: "user", content: repairUser },
      ], { numCtx: ctxFor(repairSystem.length + repairUser.length), temperature: 0.2 });
      const repaired = extractCode(repairRaw);
      if (target === "test.js") tests = repaired; else code = repaired;
      emit("repair", `${target} rewritten — revalidating...`);
      gateResult = await deps.gate({ manifest: manifestCode, code, tests }, organId);
    }
    if (!gateResult.ok) {
      const stage = gateResult.verdict?.stage ?? "gate";
      const errors = gateResult.verdict?.errors?.join("; ") ?? gateResult.error ?? "gate failed";
      emit("gate", `failed after ${round} repair round${round === 1 ? "" : "s"} at ${stage}: ${errors}`);
      return { ok: false, error: errors, stage, log };
    }
    emit("gate", "passed");

    // Phase 4.5: optional human review before anything touches disk
    const reviewFiles: OrganFile[] = [
      { name: "manifest.json", content: manifestCode },
      { name: "organ.js", content: code },
      { name: "test.js", content: tests },
    ];
    if (deps.review) {
      emit("review", "waiting for your review...");
      const approved = await deps.review(reviewFiles);
      if (!approved) {
        emit("review", "discarded — nothing was written");
        return { ok: false, error: "discarded in review", stage: "review", log };
      }
      emit("review", "approved");
    }

    // Phase 5: write
    emit("write", "committing...");
    const commitMsg = `loom: build ${organId} — ${request.slice(0, 60)}`;
    const sha = await deps.write(organId, reviewFiles, commitMsg);
    emit("write", "committed " + sha);

    return { ok: true, organId, sha, log };
  } catch (err) {
    const error = String(err);
    emit("error", error);
    return { ok: false, error, log };
  } finally {
    busy = false;
  }
}
