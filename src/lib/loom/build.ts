import { organSystemPrompt, ctxFor } from "./prompts";
import { extractCode } from "./edits";
import { manifestGuard, renderProbe } from "./validate";
import type { gate } from "./validate";
import type { organWrite, Msg, OrganFile, ChatOpts } from "../core";
import { isBusy as _isBusy, withFlight } from "./flight";
import { runGateWithRepair } from "./gateRepair";
import { recordExperience, retrieveExemplars, retrieveLessons } from "./experience";

export type BuildEvent = { ts: number; phase: string; detail: string; role?: "builder" | "companion" | "rewriter" };
export type BuildResult = { ok: boolean; organId?: string; sha?: string; error?: string; stage?: string; log: BuildEvent[] };
export type BuildDeps = {
  chat: (role: string, messages: Msg[], opts?: ChatOpts) => Promise<string>;
  write: typeof organWrite;
  gate: typeof gate;
  renderProbe?: typeof renderProbe;
  onEvent?: (e: BuildEvent) => void;
  /** Optional human review gate: called with the validated files BEFORE anything
   *  is written. Resolve true to apply, false to discard (nothing is written). */
  review?: (files: OrganFile[]) => Promise<boolean>;
  /** Set when this build originated from an unprompted LOOM proposal (Phase 20).
   *  Threaded onto the experience BuildRecord as proposalSource: "initiative". */
  proposalSource?: "initiative";
};

// Re-export isBusy from flight for backward compat with LoomConsole/Companion imports
export function isBusy(): boolean {
  return _isBusy();
}

export async function buildOrgan(request: string, deps: BuildDeps): Promise<BuildResult> {
  const result = await withFlight(async () => {
    const log: BuildEvent[] = [];

    function emit(phase: string, detail: string): void {
      // Every phase of a build is performed by the builder role.
      const e: BuildEvent = { ts: Date.now(), phase, detail, role: "builder" };
      log.push(e);
      deps.onEvent?.(e);
    }

    try {

    // Phase 1: manifest
    emit("manifest", "generating manifest...");
    const manifestSystem = organSystemPrompt("manifest", { request });
    const manifestMessages: Msg[] = [
      { role: "system", content: manifestSystem },
      { role: "user", content: request },
    ];
    const manifestRaw = await deps.chat("builder", manifestMessages, {
      numCtx: ctxFor(manifestSystem.length + request.length),
      temperature: 0.2,
    });
    let manifestCode = extractCode(manifestRaw);
    let manifestResult = manifestGuard(manifestCode);
    if (!manifestResult.ok) {
      // Quick-win 1: ONE manifest repair round before giving up
      emit("manifest", "failed: " + manifestResult.error + " — attempting manifest repair...");
      const repairSystem = organSystemPrompt("repair", { request });
      const repairUser =
        `FILE: manifest.json\n\nCURRENT (FAILED) CONTENT:\n${manifestCode}\n\n` +
        `VALIDATION ERRORS:\n${manifestResult.error}\n\n` +
        `Output the complete corrected manifest.json.`;
      const repairRaw = await deps.chat("builder", [
        { role: "system", content: repairSystem },
        { role: "user", content: repairUser },
      ], { numCtx: ctxFor(repairSystem.length + repairUser.length), temperature: 0.0 });
      const repairedManifestCode = extractCode(repairRaw);
      manifestResult = manifestGuard(repairedManifestCode);
      if (!manifestResult.ok) {
        emit("manifest", "failed after repair: " + manifestResult.error);
        recordExperience({
          ts: Date.now(), kind: "build", request, organId: "", ok: false,
          stage: "manifest", repairRounds: 1,
          errors: [manifestResult.error],
        });
        return { ok: false, error: manifestResult.error, log };
      }
      // Use the repaired manifest code for all downstream phases
      manifestCode = repairedManifestCode;
    }
    const { manifest } = manifestResult;
    const organId = manifest.id;
    const finalManifestCode = manifestCode;
    emit("manifest", "ok — id: " + organId);

    // Phase 2: organ.js — retrieve exemplars and lessons before code gen
    emit("code", "generating organ.js...");
    const exemplars = retrieveExemplars(request, 2);
    const lessons = retrieveLessons(request, 2);
    const codeSystem = organSystemPrompt("code", { exemplars, lessons, request });
    const codeUser = `Request: ${request}\n\nManifest:\n${finalManifestCode}`;
    const codeMessages: Msg[] = [
      { role: "system", content: codeSystem },
      { role: "user", content: codeUser },
    ];
    const codeRaw = await deps.chat("builder", codeMessages, {
      numCtx: ctxFor(codeSystem.length + codeUser.length),
      temperature: 0.2,
    });
    let codeContent = extractCode(codeRaw);
    emit("code", "ok");

    // Phase 3: render probe — verify organ.js actually renders before generating tests
    const probe = deps.renderProbe ?? renderProbe;
    emit("probe", "render-probing organ.js...");
    let probeResult = await probe({ manifest: finalManifestCode, code: codeContent, tests: "export const tests = [];" }, organId);
    if (!probeResult.ok) {
      // One code repair round on render failure
      emit("probe", "render failed: " + (probeResult.error ?? "unknown") + " — attempting code repair...");
      const repairSystem = organSystemPrompt("repair", { request });
      const repairUser =
        `FILE: organ.js\n\nCURRENT (FAILED) CONTENT:\n${codeContent}\n\n` +
        `RENDER ERRORS:\n${probeResult.error ?? "render failed"}\n\n` +
        `The manifest is:\n${finalManifestCode}\n\nOutput the complete corrected organ.js.`;
      const repairRaw = await deps.chat("builder", [
        { role: "system", content: repairSystem },
        { role: "user", content: repairUser },
      ], { numCtx: ctxFor(repairSystem.length + repairUser.length), temperature: 0.0 });
      codeContent = extractCode(repairRaw);
      probeResult = await probe({ manifest: finalManifestCode, code: codeContent, tests: "export const tests = [];" }, organId);
      if (!probeResult.ok) {
        emit("probe", "render repair failed: " + (probeResult.error ?? "unknown"));
        recordExperience({
          ts: Date.now(), kind: "build", request, organId, ok: false,
          stage: "render", repairRounds: 1,
          errors: [probeResult.error ?? "render probe failed"],
        });
        return { ok: false, error: probeResult.error ?? "render probe failed", stage: "render", log };
      }
    }
    const renderedHtml = probeResult.renderedHtml ?? "";
    emit("probe", "render ok — DOM captured (" + renderedHtml.length + " chars)");

    // Phase 4: test.js — generated WITH the real DOM so selectors are grounded
    // Quick-win 6: include original request in testsUser
    emit("tests", "generating test.js...");
    const testsSystem = organSystemPrompt("tests", { request });
    const testsUser =
      `Original request: ${request}\n\n` +
      `Manifest:\n${finalManifestCode}\n\nCode:\n${codeContent}\n\n` +
      `The organ's ACTUAL rendered HTML (ground truth — your selectors MUST match elements present here):\n${renderedHtml}`;
    const testsMessages: Msg[] = [
      { role: "system", content: testsSystem },
      { role: "user", content: testsUser },
    ];
    const testsRaw = await deps.chat("builder", testsMessages, {
      numCtx: ctxFor(testsSystem.length + testsUser.length),
      temperature: 0.2,
    });
    let testsContent = extractCode(testsRaw);
    emit("tests", "ok");

    // Quick-win 7: selector grounding re-ask after tests gen
    // Extract data-action values from tests and renderedHtml; if tests reference unknown actions, do ONE corrective re-ask
    const extractActions = (src: string): Set<string> => {
      const actions = new Set<string>();
      for (const m of src.matchAll(/\[data-action="([^"]+)"\]/g)) {
        actions.add(m[1]);
      }
      return actions;
    };
    const domActions = extractActions(renderedHtml);
    const testActions = extractActions(testsContent);
    const unknownActions: string[] = [];
    for (const action of testActions) {
      if (!domActions.has(action)) unknownActions.push(action);
    }
    if (unknownActions.length > 0 && domActions.size > 0) {
      emit("tests", `selector re-ask: unknown data-actions [${unknownActions.join(", ")}], valid: [${[...domActions].join(", ")}]`);
      const reaskUser =
        `Your test refers to data-action values that do not exist: [${unknownActions.map((a) => `"${a}"`).join(", ")}]. ` +
        `Valid values: [${[...domActions].map((a) => `"${a}"`).join(", ")}]. ` +
        `Rewrite test.js using only valid selectors.\n\nOriginal request: ${request}\n\nManifest:\n${finalManifestCode}\n\nCode:\n${codeContent}\n\n` +
        `The organ's ACTUAL rendered HTML:\n${renderedHtml}`;
      const reaskRaw = await deps.chat("builder", [
        { role: "system", content: testsSystem },
        { role: "user", content: reaskUser },
      ], { numCtx: ctxFor(testsSystem.length + reaskUser.length), temperature: 0.0 });
      testsContent = extractCode(reaskRaw);
      emit("tests", "selector re-ask done");
    }

    // Phase 5: gate — delegated to shared runGateWithRepair
    const gateResult = await runGateWithRepair(
      { manifest: finalManifestCode, code: codeContent, tests: testsContent },
      organId,
      { chat: deps.chat, gate: deps.gate, emit },
    );
    if (!gateResult.ok) {
      recordExperience({
        ts: Date.now(), kind: "build", request, organId, ok: false,
        stage: gateResult.stage, repairRounds: gateResult.repairRounds,
        manifest: finalManifestCode, code: codeContent, tests: testsContent,
        errors: [gateResult.errors],
      });
      return { ok: false, error: gateResult.errors, stage: gateResult.stage, log };
    }
    const { code, tests, repairRounds } = gateResult;

    // Phase 6: optional human review before anything touches disk
    const reviewFiles: OrganFile[] = [
      { name: "manifest.json", content: finalManifestCode },
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

    // Phase 7: write
    emit("write", "committing...");
    const commitMsg = `loom: build ${organId} — ${request.slice(0, 60)}`;
    const sha = await deps.write(organId, reviewFiles, commitMsg);
    emit("write", "committed " + sha);

    recordExperience({
      ts: Date.now(), kind: "build", request, organId, ok: true,
      repairRounds,
      manifest: finalManifestCode, code, tests,
      ...(deps.proposalSource ? { proposalSource: deps.proposalSource } : {}),
    });

    return { ok: true, organId, sha, log };

    } catch (err) {
      emit("error", String(err));
      return { ok: false, error: String(err), stage: "error", log };
    }
  });

  if (result && typeof result === "object" && "busy" in result) {
    return { ok: false, error: "a build is already running", log: [] };
  }
  return result as BuildResult;
}
