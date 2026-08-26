/**
 * runtime.ts — the initiative runtime (observe → evaluate → emit)
 *
 * Wires the passive observer (observe.ts) to the pure rules engine (propose.ts)
 * and the proposal surface (Proposal.tsx). It is event-driven, NOT a polling
 * loop: it re-evaluates only when the observer already heard an activity event,
 * debounced so a burst of activity costs one evaluation.
 *
 * Governance is honored end-to-end:
 *   - enabled read live from `cockpit.initiative`.
 *   - the rules engine itself enforces the 24h rate-limit + never-list.
 *   - at most one LIVE proposal: while a card is open we do not re-emit. The
 *     card, when it closes, resets nothing here — but markProposed (written by
 *     the card) starts the 24h quiet window the engine reads next time.
 *
 * `mountInitiative()` returns an unmount fn that tears down the observer AND
 * every listener/timer this runtime added. No leaks.
 */

import { mountObserver, loadUsage } from "./observe";
import { proposeFromObservation, type Proposal, type OrganRef } from "./propose";
import { getInitiativeState } from "./store";
import { getSetting } from "../voice/settings";
import { getSignals } from "../watch/store";
import { computeWeights } from "../watch/learned";
import { organList } from "../core";

/** Debounce window: a burst of activity collapses into one evaluation. */
const EVAL_DEBOUNCE_MS = 1200;

/** The events that mean "the ledger may have just changed" — evaluate after. */
const ACTIVITY_EVENTS = [
  "loom-deck",
  "loom-utterance",
  "loom-settings-changed",
  "loom-floor-open",
  "loom-salience",
] as const;

/** Read the installed organs as OrganRefs, tolerating a broken/absent shell. */
async function installedOrgans(): Promise<OrganRef[]> {
  try {
    const entries = await organList();
    const refs: OrganRef[] = [];
    for (const e of entries) {
      try {
        const m = JSON.parse(e.manifest) as { id?: string; name?: string };
        if (typeof m.id === "string") {
          refs.push({ id: m.id, title: typeof m.name === "string" ? m.name : m.id });
        }
      } catch {
        // skip an unparseable manifest — never let it abort evaluation
      }
    }
    return refs;
  } catch {
    return [];
  }
}

/**
 * Mount the initiative runtime. Starts the observer, then evaluates the rules
 * engine once on mount and (debounced) after each activity event. Emits
 * `loom-proposal {proposal}` when an idea is earned and the setting is on.
 *
 * Returns an unmount fn.
 */
export function mountInitiative(): () => void {
  const unmountObserver = mountObserver();

  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // The id of the proposal currently floated on screen — while set, we do not
  // re-emit (at most one live proposal). Cleared when the card closes.
  let liveProposalId: string | null = null;

  async function evaluate() {
    if (disposed) return;
    // Setting off → the engine returns null anyway, but short-circuit to avoid
    // the organList round-trip entirely when initiative is silenced.
    const enabled = getSetting("cockpit.initiative") === "on";
    if (!enabled) return;
    // A card is already up — do not stack a second idea.
    if (liveProposalId !== null) return;

    const gov = getInitiativeState();
    const organs = await installedOrgans();
    if (disposed || liveProposalId !== null) return;

    const proposal: Proposal | null = proposeFromObservation({
      ledger: loadUsage(),
      signals: getSignals(),
      weights: computeWeights(getSignals()),
      organs,
      neverList: gov.neverList,
      lastProposalTs: gov.lastProposalTs,
      now: Date.now(),
      enabled,
    });

    if (!proposal) return;
    liveProposalId = proposal.id;
    window.dispatchEvent(new CustomEvent("loom-proposal", { detail: { proposal } }));
  }

  function scheduleEvaluate() {
    if (disposed) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void evaluate();
    }, EVAL_DEBOUNCE_MS);
  }

  const onActivity = () => scheduleEvaluate();
  for (const name of ACTIVITY_EVENTS) {
    window.addEventListener(name, onActivity);
  }

  // The card, when the owner acts on it, writes markProposed and re-dispatches
  // nothing — but the next proposal must be allowed once the card is gone. The
  // three actions all fold to "the card closed" from the runtime's view: any of
  // them dispatches a settings/utterance event that would re-trigger evaluate,
  // so we clear the live guard on the same events the card acts through. To keep
  // this explicit and leak-free, listen for a dedicated close signal.
  const onProposalClosed = () => {
    liveProposalId = null;
  };
  window.addEventListener("loom-proposal-closed", onProposalClosed);

  // Once on mount — silence is the common, correct result.
  void evaluate();

  return () => {
    disposed = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    for (const name of ACTIVITY_EVENTS) {
      window.removeEventListener(name, onActivity);
    }
    window.removeEventListener("loom-proposal-closed", onProposalClosed);
    unmountObserver();
  };
}
