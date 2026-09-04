import { compile } from "../compiler/compile";
import type { BuildResult } from "../loom/build";
import {
  kernelIdentity,
  threadLoom,
  threadStatus,
  type Generation,
  type Identity,
  type Msg,
  type ThreadStatus,
} from "../core";
import { reweaveReadiness, type Readiness } from "../loom/reweave";
import { listGenerations } from "../loom/generations";
import { COMPANION_SYSTEM, windowMessages } from "./persona";
import { buildCatalog, helpText } from "../shuttle/catalog";

/**
 * The body's seams (Phase 23 — Rebirth). Every one is a read or a ceremony
 * the Rust core already guards; the runtime only composes the sentence.
 * `commitsAhead` is how many genome commits the running generation lacks —
 * null when nobody can count (the default), and the consent line then simply
 * omits the count rather than inventing one.
 */
export type RebirthDeps = {
  readiness: () => Promise<Readiness>;
  commitsAhead: () => Promise<number | null>;
  threadStatus: () => Promise<ThreadStatus>;
  threadLoom: () => Promise<void>;
  identity: () => Promise<Identity>;
  generations: () => Promise<Generation[]>;
};

const REBIRTH_DEFAULTS: RebirthDeps = {
  readiness: () => reweaveReadiness(),
  commitsAhead: async () => null,
  threadStatus,
  threadLoom,
  identity: kernelIdentity,
  generations: listGenerations,
};

export type CompanionDeps = {
  chat: (role: string, messages: Msg[], opts?: object) => Promise<string>;
  build: (request: string) => Promise<BuildResult>;
  edit: (organId: string, request: string) => Promise<BuildResult>;
  organIds: () => Promise<string[]>;
  askModel: (system: string, prompt: string) => Promise<string>;
  /** Optional overrides for the body's seams; the core wrappers by default. */
  rebirth?: Partial<RebirthDeps>;
};

/**
 * A consent turn asks before the body changes. The Companion renders it with
 * an affirmative action (REWEAVE / RETURN) and NOT NOW; only the affirmative
 * reaches the protected orchestration. The line is what the owner reads and
 * hears.
 */
export type ConsentTurn =
  | { kind: "consent"; consent: "reweave_consent"; line: string }
  | { kind: "consent"; consent: "generation_return_consent"; sha: string; line: string };

export type CompanionTurn =
  | { kind: "reply"; text: string }
  | { kind: "self_edit"; request: string }
  | { kind: "build"; result: BuildResult }
  | { kind: "edit"; organId: string; result: BuildResult }
  | { kind: "act"; organId: string }
  | { kind: "help"; text: string }
  | ConsentTurn;

// ── Copy law (docs/BRAND.md): fact — hinge — remedy, lowercase, no exclamation ──

const short = (sha: string) => sha.slice(0, 6);

export const LINE_THREADING = "threading the loom — this needs the network once";
export const LINE_NO_PREVIOUS = "there is no previous generation to return to";
export const missingToolLine = (tool: string, install: string) =>
  `the loom can't be threaded yet — ${tool} is missing: ${install}`;
export const reweaveConsentLine = (genomeSha: string, commits: number | null) =>
  commits === null
    ? `weave generation ${short(genomeSha)} — LOOM will close and return`
    : `weave generation ${short(genomeSha)} from ${commits} ${commits === 1 ? "commit" : "commits"} — LOOM will close and return`;
export const returnConsentLine = (sha: string) =>
  `return to generation ${short(sha)} — LOOM will close and return`;
export const identityLine = (id: Identity) =>
  `generation ${id.generation === null ? "unwoven" : short(id.generation)} · ${id.mode} · ${id.threaded ? "threaded" : "not threaded"}`;

export async function handle(
  utterance: string,
  history: Msg[],
  deps: CompanionDeps
): Promise<CompanionTurn> {
  const ids = await deps.organIds();
  const c = await compile(utterance, ids, deps.askModel, history);
  const body: RebirthDeps = { ...REBIRTH_DEFAULTS, ...(deps.rebirth ?? {}) };

  switch (c.intent) {
    // ── Rebirth (Phase 23): rules about the body, never a model call ──────────

    case "reweave": {
      // The dry run first: a refusal reads the same line the card would show;
      // readiness becomes a consent line, and nothing starts until the owner
      // presses REWEAVE in the Companion.
      const ready = await body.readiness();
      if (!ready.ok) return { kind: "reply", text: ready.reason };
      const commits = await body.commitsAhead();
      return { kind: "consent", consent: "reweave_consent", line: reweaveConsentLine(ready.genomeSha, commits) };
    }

    case "thread": {
      const status = await body.threadStatus();
      const missingName = status.missing[0];
      if (missingName !== undefined) {
        const tool = status.tools.find((t) => t.name === missingName);
        return { kind: "reply", text: missingToolLine(missingName, tool?.install ?? "see Settings") };
      }
      await body.threadLoom();
      return { kind: "reply", text: LINE_THREADING };
    }

    case "identity": {
      const id = await body.identity();
      return { kind: "reply", text: identityLine(id) };
    }

    case "generation_return": {
      const previous = (await body.generations()).find((g) => g.isPrevious);
      if (!previous) return { kind: "reply", text: LINE_NO_PREVIOUS };
      return {
        kind: "consent",
        consent: "generation_return_consent",
        sha: previous.sha,
        line: returnConsentLine(previous.sha),
      };
    }

    case "help": {
      // Fast path — zero model calls. Speaks the command grammar generated
      // FROM the shuttle catalog, so voice discoverability and the Cmd+K
      // palette can never drift apart.
      const catalog = buildCatalog({ organs: ids.map((id) => ({ id, title: id })) });
      return { kind: "help", text: helpText(catalog) };
    }

    case "converse": {
      const windowed = windowMessages(history.filter((m) => m.role !== "system"));
      const messages: Msg[] = [
        { role: "system", content: COMPANION_SYSTEM },
        ...windowed,
        { role: "user", content: c.request },
      ];
      const text = await deps.chat("companion", messages);
      return { kind: "reply", text };
    }

    case "self_edit": {
      // The deliberate, weightier act: LOOM editing its OWN kernel. The runtime
      // stays pure — it hands the request back to Companion, which owns the
      // dev-only guard and the kernelBuild pipeline (the walls). No model call
      // here; the pipeline reads the real file and drafts the edit itself.
      return { kind: "self_edit", request: c.request };
    }

    case "build_organ": {
      const result = await deps.build(c.request);
      return { kind: "build", result };
    }

    case "edit_organ": {
      if (!c.organId) {
        // Cannot resolve which organ — ask the user, no model call.
        const listPart =
          ids.length > 0
            ? ` Available organs: ${ids.join(", ")}.`
            : "";
        const text = `Which organ would you like to edit?${listPart}`;
        return { kind: "reply", text };
      }
      const result = await deps.edit(c.organId, c.request);
      return { kind: "edit", organId: c.organId, result };
    }

    case "act_on_organ": {
      if (!c.organId) {
        // Cannot resolve which organ — ask the user, no model call.
        const listPart =
          ids.length > 0
            ? ` Available organs: ${ids.join(", ")}.`
            : "";
        const text = `Which organ would you like to act on?${listPart}`;
        return { kind: "reply", text };
      }
      return { kind: "act", organId: c.organId };
    }
  }
}
