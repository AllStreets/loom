import { organSystemPrompt, ctxFor } from "./prompts";
import { extractCode } from "./edits";
import { manifestGuard } from "./validate";
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

    // Phase 4: gate — delegated to shared runGateWithRepair
    const gateResult = await runGateWithRepair(
      { manifest: manifestCode, code: codeContent, tests: testsContent },
      organId,
      { chat: deps.chat, gate: deps.gate, emit },
    );
    if (!gateResult.ok) {
      return { ok: false, error: gateResult.errors, stage: gateResult.stage, log };
    }
    const { code, tests } = gateResult;

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
  });

  if (result && typeof result === "object" && "busy" in result) {
    return { ok: false, error: "a build is already running", log: [] };
  }
  return result as BuildResult;
}
