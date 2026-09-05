import { compile } from "../compiler/compile";
import type { BuildResult } from "../loom/build";
import {
  kernelIdentity,
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
 * The body's seams (Phase 23 — Rebirth). Every one is a READ; nothing here
 * moves the body. The runtime composes the sentence the owner reads, and the
 * Companion carries the owner's answer to the protected orchestration.
 *
 * `commitsAhead` used to live here, hardwired to null: no command could ever
 * count, so the consent line could never say "from 4 commits" and the spec's
 * own example was unreachable. The parameter is gone rather than kept as a
 * promise the code cannot keep — a `genome_ahead` Rust command would bring
 * the count (and the line) back honestly.
 */
export type RebirthDeps = {
  readiness: () => Promise<Readiness>;
  threadStatus: () => Promise<ThreadStatus>;
  identity: () => Promise<Identity>;
  generations: () => Promise<Generation[]>;
};

const REBIRTH_DEFAULTS: RebirthDeps = {
  readiness: () => reweaveReadiness(),
  threadStatus,
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
  | { kind: "consent"; consent: "thread_consent"; line: string }
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
/** The branch a returned-to generation lands on is `generation/<sha7>`. */
const sha7 = (sha: string) => sha.slice(0, 7);

export const LINE_THREADING = "threading the loom — this needs the network once";
export const LINE_NO_PREVIOUS = "there is no previous generation to return to";
/**
 * The third consent turn. Threading is the one step in an offline-and-yours
 * computer that reaches the network, so the owner reads that fact BEFORE the
 * fetch, not after it started. Word for word the line Settings already shows
 * beside THREAD THE LOOM — one wording, enforced by a drift test.
 */
export const LINE_THREAD_CONSENT =
  "threading needs the network once — after that LOOM weaves offline";
export const missingToolLine = (tool: string, install: string) =>
  `the loom can't be threaded yet — ${tool} is missing: ${install}`;

/**
 * What a weave will actually do, said before it is agreed to. Three endings,
 * because there are three truths:
 *   - packaged on macOS — the swap happens: LOOM closes and returns;
 *   - dev — `tauri dev` owns the binary, so the body stays (Settings' sentence);
 *   - packaged elsewhere — `platform.rs` has no swap yet: the build and the
 *     ledger still work, the body does not change.
 *
 * The sha named is the genome's HEAD — what the core will actually weave
 * (`run_job` takes `kernel::head_sha(&ctx.source)` as its target). Round-3
 * review, Finding 2: this named `genomeSha`, the sha the running binary was
 * compiled from, so the one state where the old gate let a weave through said
 * "weave generation <the body you are already in>" while the core wove
 * something else — a sentence naming a third thing from the act.
 *
 * A `null` head (no source cloned, or git silent) is not named at all: LOOM
 * does not put a sha in the owner's sentence that it could not read.
 */
export const reweaveConsentLine = (
  genomeHead: string | null,
  mode: Identity["mode"],
  canSwap: boolean,
) => {
  const head = genomeHead ? `weave generation ${short(genomeHead)}` : "weave the genome's head";
  if (mode === "dev") return `${head} — in dev the body stays; restart tauri dev to become it`;
  if (!canSwap) {
    return `${head} — the swap is macOS-only in this generation; the build and the ledger still work, the body stays`;
  }
  return `${head} — LOOM will close and return`;
};

/** The same three truths for a return to a kept generation. */
export const returnConsentLine = (sha: string, mode: Identity["mode"], canSwap: boolean) => {
  const head = `return to generation ${short(sha)}`;
  if (mode === "dev") {
    return `${head} — in dev the body stays; the genome moves to generation/${sha7(sha)}`;
  }
  if (!canSwap) {
    return `${head} — the swap is macOS-only in this generation; the genome moves, the body stays`;
  }
  return `${head} — LOOM will close and return`;
};
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
      return {
        kind: "consent",
        consent: "reweave_consent",
        line: reweaveConsentLine(ready.genomeHead, ready.mode, ready.canSwap),
      };
    }

    case "thread": {
      // Threading is the ceremony that reaches the network — once. It gets a
      // card like the other two acts on the body, and the card carries the
      // network line, so the owner reads it before anything is fetched.
      const status = await body.threadStatus();
      const missingName = status.missing[0];
      if (missingName !== undefined) {
        const tool = status.tools.find((t) => t.name === missingName);
        return { kind: "reply", text: missingToolLine(missingName, tool?.install ?? "see Settings") };
      }
      return { kind: "consent", consent: "thread_consent", line: LINE_THREAD_CONSENT };
    }

    case "identity": {
      const id = await body.identity();
      return { kind: "reply", text: identityLine(id) };
    }

    case "generation_return": {
      const previous = (await body.generations()).find((g) => g.isPrevious);
      if (!previous) return { kind: "reply", text: LINE_NO_PREVIOUS };
      const id = await body.identity();
      return {
        kind: "consent",
        consent: "generation_return_consent",
        sha: previous.sha,
        line: returnConsentLine(previous.sha, id.mode, id.canSwap),
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
