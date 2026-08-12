import { organSystemPrompt, ctxFor } from "./prompts";
import { extractCode } from "./edits";
import { manifestGuard } from "./validate";
import type { gate } from "./validate";
import type { organWrite, Msg, OrganFile, ChatOpts } from "../core";

export type BuildEvent = { ts: number; phase: string; detail: string };
export type BuildResult = { ok: boolean; organId?: string; sha?: string; error?: string; log: BuildEvent[] };
export type BuildDeps = {
  chat: (role: string, messages: Msg[], opts?: ChatOpts) => Promise<string>;
  write: typeof organWrite;
  gate: typeof gate;
  onEvent?: (e: BuildEvent) => void;
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

    // Phase 4: gate
    emit("gate", "validating...");
    const gateResult = await deps.gate(
      { manifest: manifestCode, code: codeContent, tests: testsContent },
      organId,
    );
    if (!gateResult.ok) {
      const errors = gateResult.verdict?.errors?.join("; ") ?? gateResult.error ?? "gate failed";
      emit("gate", "failed: " + errors);
      return { ok: false, error: errors, log };
    }
    emit("gate", "passed");

    // Phase 5: write
    emit("write", "committing...");
    const files: OrganFile[] = [
      { name: "manifest.json", content: manifestCode },
      { name: "organ.js", content: codeContent },
      { name: "test.js", content: testsContent },
    ];
    const commitMsg = `loom: build ${organId} — ${request.slice(0, 60)}`;
    const sha = await deps.write(organId, files, commitMsg);
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
