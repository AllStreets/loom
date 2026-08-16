import { compile } from "../compiler/compile";
import type { BuildResult } from "../loom/build";
import type { Msg } from "../core";
import { COMPANION_SYSTEM, windowMessages } from "./persona";

export type CompanionDeps = {
  chat: (role: string, messages: Msg[], opts?: object) => Promise<string>;
  build: (request: string) => Promise<BuildResult>;
  edit: (organId: string, request: string) => Promise<BuildResult>;
  organIds: () => Promise<string[]>;
  askModel: (system: string, prompt: string) => Promise<string>;
};

export type CompanionTurn =
  | { kind: "reply"; text: string }
  | { kind: "build"; result: BuildResult }
  | { kind: "edit"; organId: string; result: BuildResult }
  | { kind: "act"; organId: string };

export async function handle(
  utterance: string,
  history: Msg[],
  deps: CompanionDeps
): Promise<CompanionTurn> {
  const ids = await deps.organIds();
  const c = await compile(utterance, ids, deps.askModel, history);

  switch (c.intent) {
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
