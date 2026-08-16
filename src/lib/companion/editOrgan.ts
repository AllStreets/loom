import { organSystemPrompt, ctxFor } from "../loom/prompts";
import { extractCode, applyEditBlocks } from "../loom/edits";
import { withFlight } from "../loom/flight";
import { runGateWithRepair } from "../loom/gateRepair";
import { recordExperience } from "../loom/experience";
import type { gate } from "../loom/validate";
import type { organWrite, organRead, OrganFile, Msg, ChatOpts } from "../core";
import type { BuildEvent, BuildResult } from "../loom/build";

export type EditDeps = {
  chat: (role: string, messages: Msg[], opts?: ChatOpts) => Promise<string>;
  read: typeof organRead;
  write: typeof organWrite;
  gate: typeof gate;
  onEvent?: (e: BuildEvent) => void;
  review?: (files: OrganFile[]) => Promise<boolean>;
};

export async function editOrgan(
  organId: string,
  request: string,
  deps: EditDeps,
): Promise<BuildResult> {
  const result = await withFlight(async () => {
    const log: BuildEvent[] = [];

    function emit(phase: string, detail: string): void {
      const e: BuildEvent = { ts: Date.now(), phase, detail };
      log.push(e);
      deps.onEvent?.(e);
    }

    try {

    // Phase 1: read existing organ files
    emit("read", `reading ${organId}...`);
    const [manifest, code, tests] = await Promise.all([
      deps.read(organId, "manifest.json"),
      deps.read(organId, "organ.js"),
      deps.read(organId, "test.js"),
    ]);
    emit("read", "ok");

    // Phase 2: apply SEARCH/REPLACE edit blocks to organ.js
    emit("edit", "applying edit blocks...");
    const editSystem = organSystemPrompt("edit");
    const editUser =
      `Current organ.js:\n${code}\n\nEdit request: ${request}\nOutput only SEARCH/REPLACE edit blocks.`;
    const editMessages: Msg[] = [
      { role: "system", content: editSystem },
      { role: "user", content: editUser },
    ];

    let newCode: string;

    async function fullRewrite(): Promise<string> {
      emit("edit", "falling back to full rewrite...");
      const codeSystem = organSystemPrompt("code");
      const codeUser = `Request: ${request}\n\nCurrent organ.js:\n${code}\n\nManifest:\n${manifest}`;
      const codeMessages: Msg[] = [
        { role: "system", content: codeSystem },
        { role: "user", content: codeUser },
      ];
      const codeRaw = await deps.chat("builder", codeMessages, {
        numCtx: ctxFor(codeSystem.length + codeUser.length),
        temperature: 0.2,
      });
      return extractCode(codeRaw);
    }

    const editRaw = await deps.chat("builder", editMessages, {
      numCtx: ctxFor(editSystem.length + editUser.length),
      temperature: 0.2,
    });

    let applied: string | null;
    try {
      applied = applyEditBlocks(code, editRaw);
    } catch (err) {
      // SEARCH mismatch: one retry with error appended
      emit("edit", "SEARCH mismatch — retrying edit...");
      const retryUser = editUser + `\n\nPrevious attempt failed with: ${String(err)}\nTry again with exact SEARCH text from the current file.`;
      const retryRaw = await deps.chat("builder", [
        { role: "system", content: editSystem },
        { role: "user", content: retryUser },
      ], { numCtx: ctxFor(editSystem.length + retryUser.length), temperature: 0.2 });

      try {
        applied = applyEditBlocks(code, retryRaw);
      } catch {
        // Second failure: full rewrite fallback
        applied = null;
      }
    }

    if (applied === null) {
      // No blocks found or couldn't apply: full rewrite fallback
      newCode = await fullRewrite();
    } else {
      newCode = applied;
    }

    emit("edit", "ok");

    // Phase 3: gate + repair (same rails as buildOrgan)
    const gateResult = await runGateWithRepair(
      { manifest, code: newCode, tests },
      organId,
      { chat: deps.chat, gate: deps.gate, emit },
    );

    if (!gateResult.ok) {
      recordExperience({
        ts: Date.now(), kind: "edit", request, organId, ok: false,
        stage: gateResult.stage, repairRounds: gateResult.repairRounds,
        code: newCode, tests,
        errors: [gateResult.errors],
      });
      return { ok: false, error: gateResult.errors, stage: gateResult.stage, log };
    }

    const finalCode = gateResult.code;
    const finalTests = gateResult.tests;
    const { repairRounds } = gateResult;

    // Manifest is NEVER modified by this path (permissions cannot silently grow)
    const outputFiles: OrganFile[] = [
      { name: "manifest.json", content: manifest },
      { name: "organ.js", content: finalCode },
      { name: "test.js", content: finalTests },
    ];

    // Phase 4: optional human review
    if (deps.review) {
      emit("review", "waiting for your review...");
      const approved = await deps.review(outputFiles);
      if (!approved) {
        emit("review", "discarded — nothing was written");
        return { ok: false, error: "discarded in review", stage: "review", log };
      }
      emit("review", "approved");
    }

    // Phase 5: write
    emit("write", "committing...");
    const commitMsg = `loom: edit ${organId} — ${request.slice(0, 60)}`;
    const sha = await deps.write(organId, outputFiles, commitMsg);
    emit("write", "committed " + sha);

    recordExperience({
      ts: Date.now(), kind: "edit", request, organId, ok: true,
      repairRounds,
      code: finalCode, tests: finalTests,
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
