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
  hero(value: string | number, label: string): HTMLElement & { _valNode: HTMLElement };
  spark(
    values: number[],
    opts?: { width?: number; height?: number; color?: string },
  ): SVGSVGElement & { update(values: number[]): void };
  keyval(pairs: [string, string | number][]): HTMLElement;
  section(title: string): HTMLElement;
  dot(tone?: "accent" | "go" | "warn" | "danger" | "muted"): HTMLElement;
  toolbar(...children: HTMLElement[]): HTMLElement;
  tabs(labels: string[], opts?: { onTabChange?: (index: number) => void }): { root: HTMLElement; panels: HTMLElement[]; onChange: (index: number) => void };
  barChart(data: Array<{label: string; value: number}>, opts?: { width?: number; height?: number; color?: string }): SVGSVGElement;
  lineChart(series: number[], opts?: { width?: number; height?: number }): SVGSVGElement;
  gauge(value: number, max: number, opts?: { size?: number; label?: string }): SVGSVGElement;
  heatmap(values: number[], opts?: { cellSize?: number; gap?: number }): HTMLElement;
  dataGrid(columns: string[], rows: Array<Array<string | number>>): HTMLElement;
  toggle(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement;
  select(options: Array<{value: string; label: string} | string>, opts?: { action?: string; onChange?: (value: string) => void }): HTMLSelectElement;
  spinner(size?: number): HTMLElement;
  icon(name: string): SVGSVGElement;
};

export function buildUiKit(tokens: Record<string, string>): LoomUiKit {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("tokens", UIKIT_SRC + "\nreturn makeUi(tokens);")(tokens) as LoomUiKit;
}
