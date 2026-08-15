import { organSystemPrompt, ctxFor } from "./prompts";
import { extractCode } from "./edits";
import { manifestGuard, renderProbe } from "./validate";
import type { gate } from "./validate";
import type { organWrite, Msg, OrganFile, ChatOpts } from "../core";
import { isBusy as _isBusy, withFlight } from "./flight";
import { runGateWithRepair } from "./gateRepair";

export type BuildEvent = { ts: number; phase: string; detail: string };
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
};

// Re-export isBusy from flight for backward compat with LoomConsole/Companion imports
export function isBusy(): boolean {
  return _isBusy();
}

export async function buildOrgan(request: string, deps: BuildDeps): Promise<BuildResult> {
  const result = await withFlight(async () => {
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
    let codeContent = extractCode(codeRaw);
    emit("code", "ok");

    // Phase 3: render probe — verify organ.js actually renders before generating tests
    const probe = deps.renderProbe ?? renderProbe;
    emit("probe", "render-probing organ.js...");
    let probeResult = await probe({ manifest: manifestCode, code: codeContent, tests: "export const tests = [];" }, organId);
    if (!probeResult.ok) {
      // One code repair round on render failure
      emit("probe", "render failed: " + (probeResult.error ?? "unknown") + " — attempting code repair...");
      const repairSystem = organSystemPrompt("repair");
      const repairUser =
        `FILE: organ.js\n\nCURRENT (FAILED) CONTENT:\n${codeContent}\n\n` +
        `RENDER ERRORS:\n${probeResult.error ?? "render failed"}\n\n` +
        `The manifest is:\n${manifestCode}\n\nOutput the complete corrected organ.js.`;
      const repairRaw = await deps.chat("builder", [
        { role: "system", content: repairSystem },
        { role: "user", content: repairUser },
      ], { numCtx: ctxFor(repairSystem.length + repairUser.length), temperature: 0.2 });
      codeContent = extractCode(repairRaw);
      probeResult = await probe({ manifest: manifestCode, code: codeContent, tests: "export const tests = [];" }, organId);
      if (!probeResult.ok) {
        emit("probe", "render repair failed: " + (probeResult.error ?? "unknown"));
        return { ok: false, error: probeResult.error ?? "render probe failed", stage: "render", log };
      }
    }
    const renderedHtml = probeResult.renderedHtml ?? "";
    emit("probe", "render ok — DOM captured (" + renderedHtml.length + " chars)");

    // Phase 4: test.js — generated WITH the real DOM so selectors are grounded
    emit("tests", "generating test.js...");
    const testsSystem = organSystemPrompt("tests");
    const testsUser =
      `Manifest:\n${manifestCode}\n\nCode:\n${codeContent}\n\n` +
      `The organ's ACTUAL rendered HTML (ground truth — your selectors MUST match elements present here):\n${renderedHtml}`;
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

    // Phase 5: gate — delegated to shared runGateWithRepair
    const gateResult = await runGateWithRepair(
      { manifest: manifestCode, code: codeContent, tests: testsContent },
      organId,
      { chat: deps.chat, gate: deps.gate, emit },
    );
    if (!gateResult.ok) {
      return { ok: false, error: gateResult.errors, stage: gateResult.stage, log };
    }
    const { code, tests } = gateResult;

    // Phase 6: optional human review before anything touches disk
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

    // Phase 7: write
    emit("write", "committing...");
    const commitMsg = `loom: build ${organId} — ${request.slice(0, 60)}`;
    const sha = await deps.write(organId, reviewFiles, commitMsg);
    emit("write", "committed " + sha);

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
