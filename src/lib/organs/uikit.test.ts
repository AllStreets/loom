import { describe, it, expect, beforeEach } from "vitest";
import { UIKIT_SRC } from "./uikitSrc";
import { buildUiKit } from "./uikit";

const TOKENS = {
  bg: "#060b18",
  panel: "#0d1424",
  t1: "#e8edf7",
  t2: "#9fb0cc",
  t3: "#5f6f8c",
  accent: "#22d3ee",
  go: "#4ade80",
  warn: "#fbbf24",
  danger: "#f87171",
};

// jsdom normalizes hex colors to rgb() when reading back el.style.*
// This helper converts #rrggbb to rgb(r, g, b) for comparison.
function toRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

beforeEach(() => {
  // Remove injected style between tests so injection guard can be tested explicitly
  document.getElementById("lui-style")?.remove();
  document.head.innerHTML = "";
});

describe("UIKIT_SRC source guards", () => {
  it("contains no import statements", () => {
    expect(UIKIT_SRC).not.toMatch(/\bimport\b/);
  });

  it("contains no export statements", () => {
    expect(UIKIT_SRC).not.toMatch(/\bexport\b/);
  });

  it("contains no TypeScript type annotations (: string)", () => {
    expect(UIKIT_SRC).not.toMatch(/: string/);
  });

  it("contains no TypeScript interface declarations", () => {
    expect(UIKIT_SRC).not.toMatch(/\binterface\b/);
  });

  it("is ES2019-parseable via new Function without throwing", () => {
    expect(() => new Function(UIKIT_SRC)).not.toThrow();
  });
});

describe("buildUiKit — factory presence", () => {
  it("returns all required factories", () => {
    const ui = buildUiKit(TOKENS);
    expect(typeof ui.heading).toBe("function");
    expect(typeof ui.card).toBe("function");
    expect(typeof ui.button).toBe("function");
    expect(typeof ui.input).toBe("function");
    expect(typeof ui.row).toBe("function");
    expect(typeof ui.stack).toBe("function");
    expect(typeof ui.stat).toBe("function");
    expect(typeof ui.setStat).toBe("function");
    expect(typeof ui.progress).toBe("function");
    expect(typeof ui.list).toBe("function");
    expect(typeof ui.listRow).toBe("function");
    expect(typeof ui.badge).toBe("function");
    expect(typeof ui.empty).toBe("function");
  });

  it("exposes tokens on ui.tokens", () => {
    const ui = buildUiKit(TOKENS);
    expect(ui.tokens).toBe(TOKENS);
  });
});

describe("button", () => {
  it("primary variant has accent background", () => {
    const ui = buildUiKit(TOKENS);
    const btn = ui.button("Go", { variant: "primary" });
    // jsdom normalizes hex to rgb()
    expect(btn.style.background).toContain(toRgb(TOKENS.accent));
  });

  it("ghost variant has transparent background", () => {
    const ui = buildUiKit(TOKENS);
    const btn = ui.button("Ghost", { variant: "ghost" });
    expect(btn.style.background).toBe("transparent");
  });

  it("danger variant uses danger color", () => {
    const ui = buildUiKit(TOKENS);
    const btn = ui.button("Delete", { variant: "danger" });
    expect(btn.style.color).toBe(toRgb(TOKENS.danger));
  });

  it("sets dataset.action when action option provided", () => {
    const ui = buildUiKit(TOKENS);
    const btn = ui.button("Submit", { action: "submit-form" });
    expect(btn.dataset.action).toBe("submit-form");
  });

  it("does not set dataset.action when no action provided", () => {
    const ui = buildUiKit(TOKENS);
    const btn = ui.button("OK");
    expect(btn.dataset.action).toBeUndefined();
  });

  it("calls onClick when clicked", () => {
    const ui = buildUiKit(TOKENS);
    let called = false;
    const btn = ui.button("Click", { onClick: () => { called = true; } });
    document.body.appendChild(btn);
    btn.click();
    expect(called).toBe(true);
  });

  it("has lui-btn and variant class", () => {
    const ui = buildUiKit(TOKENS);
    const btn = ui.button("X", { variant: "ghost" });
    expect(btn.classList.contains("lui-btn")).toBe(true);
    expect(btn.classList.contains("lui-btn-ghost")).toBe(true);
  });
});

describe("input", () => {
  it("fires onEnter only on Enter key", () => {
    const ui = buildUiKit(TOKENS);
    const calls: string[] = [];
    const inp = ui.input({ onEnter: () => calls.push("enter") });
    document.body.appendChild(inp);

    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(calls).toEqual(["enter"]);
  });

  it("sets placeholder", () => {
    const ui = buildUiKit(TOKENS);
    const inp = ui.input({ placeholder: "Type here" });
    expect(inp.placeholder).toBe("Type here");
  });

  it("sets dataset.action", () => {
    const ui = buildUiKit(TOKENS);
    const inp = ui.input({ action: "search" });
    expect(inp.dataset.action).toBe("search");
  });
});

describe("progress", () => {
  it("clamps initial pct to 0..100", () => {
    const ui = buildUiKit(TOKENS);
    const p1 = ui.progress(-10);
    const p2 = ui.progress(150);
    const fill1 = p1.firstChild as HTMLElement;
    const fill2 = p2.firstChild as HTMLElement;
    expect(fill1.style.width).toBe("0%");
    expect(fill2.style.width).toBe("100%");
  });

  it(".set() updates fill width clamped to 0..100", () => {
    const ui = buildUiKit(TOKENS);
    const p = ui.progress(50);
    const fill = p.firstChild as HTMLElement;
    expect(fill.style.width).toBe("50%");
    p.set(75);
    expect(fill.style.width).toBe("75%");
    p.set(-5);
    expect(fill.style.width).toBe("0%");
    p.set(200);
    expect(fill.style.width).toBe("100%");
  });
});

describe("listRow", () => {
  it("renders text content", () => {
    const ui = buildUiKit(TOKENS);
    const row = ui.listRow("Hello world");
    expect(row.textContent).toContain("Hello world");
  });

  it("adds x button with data-action=remove when onRemove given", () => {
    const ui = buildUiKit(TOKENS);
    let removed = false;
    const row = ui.listRow("Item", { onRemove: () => { removed = true; } });
    const xBtn = row.querySelector("[data-action='remove']") as HTMLButtonElement;
    expect(xBtn).toBeTruthy();
    xBtn.click();
    expect(removed).toBe(true);
  });

  it("uses custom removeAction for data-action when given", () => {
    const ui = buildUiKit(TOKENS);
    const row = ui.listRow("Item", {
      onRemove: () => {},
      removeAction: "delete-item",
    });
    const btn = row.querySelector("[data-action='delete-item']");
    expect(btn).toBeTruthy();
  });

  it("no remove button when onRemove not given", () => {
    const ui = buildUiKit(TOKENS);
    const row = ui.listRow("Plain");
    expect(row.querySelector("button")).toBeNull();
  });
});

describe("style injection", () => {
  it("injects exactly one <style id='lui-style'> per document across multiple builds", () => {
    buildUiKit(TOKENS);
    buildUiKit(TOKENS);
    buildUiKit(TOKENS);
    const styles = document.querySelectorAll("#lui-style");
    expect(styles.length).toBe(1);
  });

  it("style tag contains lui-btn class", () => {
    buildUiKit(TOKENS);
    const style = document.getElementById("lui-style");
    expect(style).toBeTruthy();
    expect(style!.textContent).toContain(".lui-btn");
  });
});

describe("card", () => {
  it("returns root and body elements", () => {
    const ui = buildUiKit(TOKENS);
    const { root, body } = ui.card();
    expect(root).toBeInstanceOf(HTMLElement);
    expect(body).toBeInstanceOf(HTMLElement);
    expect(root.contains(body)).toBe(true);
  });

  it("renders mono uppercase eyebrow when opts.title given", () => {
    const ui = buildUiKit(TOKENS);
    const { root } = ui.card({ title: "My Panel" });
    const eyebrow = root.firstChild as HTMLElement;
    expect(eyebrow.textContent).toBe("My Panel");
    expect(eyebrow.style.textTransform).toBe("uppercase");
    expect(eyebrow.style.fontFamily).toBe("monospace");
  });

  it("no eyebrow when no title", () => {
    const ui = buildUiKit(TOKENS);
    const { root, body } = ui.card();
    expect(root.firstChild).toBe(body);
  });
});

describe("stat and setStat", () => {
  it("renders value and label", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.stat("Items", 42);
    expect(s.textContent).toContain("42");
    expect(s.textContent).toContain("Items");
  });

  it("setStat updates the value node", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.stat("Count", 0);
    ui.setStat(s, 99);
    expect(s.firstChild!.textContent).toBe("99");
  });
});

describe("list", () => {
  it("add appends elements; clear empties root", () => {
    const ui = buildUiKit(TOKENS);
    const lst = ui.list();
    lst.add(ui.empty("nothing"));
    lst.add(ui.empty("also nothing"));
    expect(lst.root.children.length).toBe(2);
    lst.clear();
    expect(lst.root.children.length).toBe(0);
  });
});

describe("badge", () => {
  it("renders text", () => {
    const ui = buildUiKit(TOKENS);
    const b = ui.badge("active");
    expect(b.textContent).toBe("active");
  });

  it("defaults to accent tone", () => {
    const ui = buildUiKit(TOKENS);
    const b = ui.badge("ok") as HTMLElement;
    expect(b.style.color).toBe(toRgb(TOKENS.accent));
  });

  it("go tone uses go color", () => {
    const ui = buildUiKit(TOKENS);
    const b = ui.badge("ok", "go") as HTMLElement;
    expect(b.style.color).toBe(toRgb(TOKENS.go));
  });

  it("danger tone uses danger color", () => {
    const ui = buildUiKit(TOKENS);
    const b = ui.badge("err", "danger") as HTMLElement;
    expect(b.style.color).toBe(toRgb(TOKENS.danger));
  });
});

describe("row and stack", () => {
  it("row creates flex row", () => {
    const ui = buildUiKit(TOKENS);
    const r = ui.row(ui.badge("a"), ui.badge("b"));
    expect(r.style.flexDirection).toBe("row");
    expect(r.children.length).toBe(2);
  });

  it("stack creates flex column", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.stack(ui.empty("x"), ui.empty("y"));
    expect(s.style.flexDirection).toBe("column");
    expect(s.children.length).toBe(2);
  });
});

describe("heading", () => {
  it("renders heading text", () => {
    const ui = buildUiKit(TOKENS);
    const h = ui.heading("My Title");
    expect(h.textContent).toContain("My Title");
  });

  it("renders sub text when given", () => {
    const ui = buildUiKit(TOKENS);
    const h = ui.heading("Title", "Subtitle here");
    expect(h.textContent).toContain("Subtitle here");
  });

  it("no sub element when not given", () => {
    const ui = buildUiKit(TOKENS);
    const h = ui.heading("Just Title");
    expect(h.children.length).toBe(1);
  });
});

describe("empty", () => {
  it("renders text and centers it", () => {
    const ui = buildUiKit(TOKENS);
    const e = ui.empty("Nothing here yet");
    expect(e.textContent).toBe("Nothing here yet");
    expect(e.style.textAlign).toBe("center");
  });
});
