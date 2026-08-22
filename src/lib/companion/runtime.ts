import { compile } from "../compiler/compile";
import type { BuildResult } from "../loom/build";
import type { Msg } from "../core";
import { COMPANION_SYSTEM, windowMessages } from "./persona";
import type { DeckCommandResult } from "../decks/commands";
import type { ScoredEvent } from "../watch/types";
import { buildCatalog, helpText } from "../shuttle/catalog";

export type CompanionDeps = {
  chat: (role: string, messages: Msg[], opts?: object) => Promise<string>;
  build: (request: string) => Promise<BuildResult>;
  edit: (organId: string, request: string) => Promise<BuildResult>;
  organIds: () => Promise<string[]>;
  askModel: (system: string, prompt: string) => Promise<string>;
  /** Current cockpit deck state — used for deck_command auto-switch logic */
  currentDeck?: () => "void" | "globe" | "terminal";
  /** Returns the top-k salient events for the briefing fast path */
  getSalient?: (k: number) => ScoredEvent[];
  /** Send bridge commands to the globe deck (fly_to steering from briefings) */
  sendDeckCommands?: (cmds: import("../decks/commands").BridgeCmd[]) => void;
};

export type CompanionTurn =
  | { kind: "reply"; text: string }
  | { kind: "build"; result: BuildResult }
  | { kind: "edit"; organId: string; result: BuildResult }
  | { kind: "act"; organId: string }
  | { kind: "deck_command"; deckCommandResult: DeckCommandResult; confirmation: string }
  | { kind: "briefing"; text: string }
  | { kind: "help"; text: string };

export async function handle(
  utterance: string,
  history: Msg[],
  deps: CompanionDeps
): Promise<CompanionTurn> {
  const ids = await deps.organIds();
  const currentDeck = deps.currentDeck ? deps.currentDeck() : "void";
  const c = await compile(utterance, ids, deps.askModel, history, currentDeck);

  switch (c.intent) {
    case "briefing": {
      // Fast path — zero model calls. Assembles spoken briefing from salient events.
      const items = deps.getSalient ? deps.getSalient(3) : [];
      if (items.length === 0) {
        return { kind: "briefing", text: "The watch is quiet. Nothing crosses your thresholds." };
      }
      const sentences = items.map((item) =>
        item.reasons.length > 0
          ? `${item.title} — ${item.reasons[0]}.`
          : `${item.title}.`
      );
      // Steer the globe when active and top item has coords
      if (
        deps.sendDeckCommands &&
        deps.currentDeck &&
        deps.currentDeck() === "globe"
      ) {
        const located = items.find((item) => typeof item.lat === "number" && typeof item.lng === "number");
        if (located) {
          deps.sendDeckCommands([{ type: "fly_to", lat: located.lat!, lng: located.lng! }]);
        }
      }
      return { kind: "briefing", text: "Top of the watch: " + sentences.join(" ") };
    }

    case "help": {
      // Fast path — zero model calls. Speaks the command grammar generated
      // FROM the shuttle catalog (same no-model pattern as briefings), so
      // voice discoverability and the Cmd+K palette can never drift apart.
      const catalog = buildCatalog({ organs: ids.map((id) => ({ id, title: id })) });
      return { kind: "help", text: helpText(catalog) };
    }

    case "deck_command": {
      // Fast path — no model call. The deck command result is already fully
      // resolved by the rule classifier (classifyDeckCommand).
      const dcr = c.deckCommandResult;
      if (!dcr) {
        // Should not happen: rules always populate deckCommandResult for deck_command.
        // Fall through to converse as a safety net.
        const windowed = windowMessages(history.filter((m) => m.role !== "system"));
        const messages: Msg[] = [
          { role: "system", content: COMPANION_SYSTEM },
          ...windowed,
          { role: "user", content: c.request },
        ];
        const text = await deps.chat("companion", messages);
        return { kind: "reply", text };
      }
      return {
        kind: "deck_command",
        deckCommandResult: dcr,
        confirmation: dcr.confirmation,
      };
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
