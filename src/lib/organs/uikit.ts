import { UIKIT_SRC } from "./uikitSrc";

export type LoomUiKit = {
  tokens: Record<string, string>;
  heading(text: string, sub?: string): HTMLElement;
  card(opts?: { title?: string }): { root: HTMLElement; body: HTMLElement };
  button(
    label: string,
    opts?: {
      variant?: "primary" | "ghost" | "danger";
      action?: string;
      onClick?: (e: MouseEvent) => void;
    },
  ): HTMLButtonElement;
  input(opts?: {
    placeholder?: string;
    action?: string;
    onEnter?: (e: KeyboardEvent) => void;
  }): HTMLInputElement;
  row(...children: HTMLElement[]): HTMLElement;
  stack(...children: HTMLElement[]): HTMLElement;
  stat(label: string, value: string | number): HTMLElement;
  setStat(statEl: HTMLElement, value: string | number): void;
  progress(pct: number): HTMLElement & { set(pct: number): void };
  list(): { root: HTMLElement; add(el: HTMLElement): void; clear(): void };
  listRow(
    text: string,
    opts?: {
      onRemove?: (e: MouseEvent) => void;
      removeAction?: string;
    },
  ): HTMLElement;
  badge(text: string, tone?: "accent" | "go" | "warn" | "danger" | "muted"): HTMLElement;
  empty(text: string): HTMLElement;
};

export function buildUiKit(tokens: Record<string, string>): LoomUiKit {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("tokens", UIKIT_SRC + "\nreturn makeUi(tokens);")(tokens) as LoomUiKit;
}
