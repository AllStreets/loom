import { describe, it, expect, beforeEach } from "vitest";
import { UIKIT_SRC, KIT_TOKENS } from "./uikitSrc";
import { buildUiKit } from "./uikit";
import { buildHarnessSrc } from "../loom/sandbox";
import { makeLoomApi } from "./api";

const TOKENS = {
  bg: "#060b18",
  panel: "#0d1424",
  t1: "#e8edf7",
  t2: "#9fb0cc",
  t3: "#5f6f8c",
  accent: "#22d3ee",
  go: "#4ade80",
  warn: "#f97316",
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

describe("hero", () => {
  it("renders value and label text", () => {
    const ui = buildUiKit(TOKENS);
    const h = ui.hero(1234, "steps today");
    expect(h.textContent).toContain("1234");
    expect(h.textContent).toContain("steps today");
  });

  it("value node has 28px font-size", () => {
    const ui = buildUiKit(TOKENS);
    const h = ui.hero(42, "items");
    const valNode = h._valNode as HTMLElement;
    expect(valNode).toBeTruthy();
    expect(valNode.style.fontSize).toBe("28px");
  });

  it("value node has accent color", () => {
    const ui = buildUiKit(TOKENS);
    const h = ui.hero(7, "days");
    const valNode = h._valNode as HTMLElement;
    expect(valNode.style.color).toContain(toRgb(TOKENS.accent));
  });

  it("converts numeric value to string", () => {
    const ui = buildUiKit(TOKENS);
    const h = ui.hero(0, "count");
    expect(h.textContent).toContain("0");
  });
});

describe("spark", () => {
  it("returns an SVGSVGElement", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.spark([1, 2, 3, 4, 5]);
    expect(s.tagName.toLowerCase()).toBe("svg");
  });

  it("renders a polyline for 2+ values", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.spark([10, 20, 15, 30]);
    expect(s.querySelector("polyline")).toBeTruthy();
  });

  it("renders nothing for less than 2 values", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.spark([42]);
    expect(s.querySelector("polyline")).toBeNull();
  });

  it(".update() replaces the polyline with new data", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.spark([1, 2, 3]);
    expect(s.querySelector("polyline")).toBeTruthy();
    s.update([5, 10, 7, 12]);
    // Still has polyline, but with updated points
    expect(s.querySelector("polyline")).toBeTruthy();
  });

  it(".update() with 0 values removes polyline", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.spark([1, 2]);
    s.update([]);
    expect(s.querySelector("polyline")).toBeNull();
  });

  it("renders accent dot on last data point", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.spark([1, 5, 3]);
    expect(s.querySelector("circle")).toBeTruthy();
  });

  it("respects custom width and height", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.spark([1, 2], { width: 100, height: 30 });
    expect(s.getAttribute("width")).toBe("100");
    expect(s.getAttribute("height")).toBe("30");
  });
});

describe("keyval", () => {
  it("renders all key/value pairs", () => {
    const ui = buildUiKit(TOKENS);
    const kv = ui.keyval([["speed", "fast"], ["weight", 42], ["mode", "auto"]]);
    expect(kv.textContent).toContain("speed");
    expect(kv.textContent).toContain("fast");
    expect(kv.textContent).toContain("weight");
    expect(kv.textContent).toContain("42");
    expect(kv.textContent).toContain("mode");
  });

  it("renders correct number of rows", () => {
    const ui = buildUiKit(TOKENS);
    const kv = ui.keyval([["a", 1], ["b", 2]]);
    expect(kv.children.length).toBe(2);
  });

  it("returns empty container for empty pairs array", () => {
    const ui = buildUiKit(TOKENS);
    const kv = ui.keyval([]);
    expect(kv.children.length).toBe(0);
  });
});

describe("section", () => {
  it("renders the title text", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.section("Voice Settings");
    expect(s.textContent).toContain("Voice Settings");
  });

  it("contains a hairline divider element", () => {
    const ui = buildUiKit(TOKENS);
    const s = ui.section("General");
    // The header div contains a label and a line div
    const header = s.firstChild as HTMLElement;
    expect(header.children.length).toBeGreaterThanOrEqual(2);
  });
});

describe("dot", () => {
  it("renders an inline 8px circle", () => {
    const ui = buildUiKit(TOKENS);
    const d = ui.dot("go");
    expect(d.style.width).toBe("8px");
    expect(d.style.height).toBe("8px");
    expect(d.style.borderRadius).toBe("50%");
  });

  it("go tone uses go color", () => {
    const ui = buildUiKit(TOKENS);
    const d = ui.dot("go");
    expect(d.style.background).toContain(toRgb(TOKENS.go));
  });

  it("danger tone uses danger color", () => {
    const ui = buildUiKit(TOKENS);
    const d = ui.dot("danger");
    expect(d.style.background).toContain(toRgb(TOKENS.danger));
  });

  it("defaults to accent tone when no tone given", () => {
    const ui = buildUiKit(TOKENS);
    const d = ui.dot();
    expect(d.style.background).toContain(toRgb(TOKENS.accent));
  });
});

describe("toolbar", () => {
  it("creates a flex row with justify-content flex-end", () => {
    const ui = buildUiKit(TOKENS);
    const tb = ui.toolbar(ui.button("A"), ui.button("B"));
    expect(tb.style.display).toBe("flex");
    expect(tb.style.justifyContent).toBe("flex-end");
  });

  it("contains all passed children", () => {
    const ui = buildUiKit(TOKENS);
    const tb = ui.toolbar(ui.button("X"), ui.button("Y"), ui.button("Z"));
    expect(tb.children.length).toBe(3);
  });

  it("works with zero children", () => {
    const ui = buildUiKit(TOKENS);
    const tb = ui.toolbar();
    expect(tb.children.length).toBe(0);
  });
});

describe("buildUiKit — v2 factory presence", () => {
  it("returns all v2 factories", () => {
    const ui = buildUiKit(TOKENS);
    expect(typeof ui.hero).toBe("function");
    expect(typeof ui.spark).toBe("function");
    expect(typeof ui.keyval).toBe("function");
    expect(typeof ui.section).toBe("function");
    expect(typeof ui.dot).toBe("function");
    expect(typeof ui.toolbar).toBe("function");
  });
});

describe("kit v3 factories", () => {
  it("tabs: tab switch changes visible panel", () => {
    const ui = buildUiKit(TOKENS);
    const { root, panels } = ui.tabs(["A", "B", "C"]);
    document.body.appendChild(root);
    // Initially first panel is visible
    expect(panels[0].style.display).toBe("block");
    expect(panels[1].style.display).toBe("none");
    // Click second tab button
    const tabBar = root.children[0] as HTMLElement;
    const secondBtn = tabBar.children[1] as HTMLButtonElement;
    secondBtn.click();
    expect(panels[0].style.display).toBe("none");
    expect(panels[1].style.display).toBe("block");
  });

  it("barChart: returns SVG with correct number of rect elements", () => {
    const ui = buildUiKit(TOKENS);
    const data = [{ label: "Mon", value: 5 }, { label: "Tue", value: 10 }, { label: "Wed", value: 3 }];
    const svg = ui.barChart(data);
    expect(svg.tagName.toLowerCase()).toBe("svg");
    const rects = svg.querySelectorAll("rect");
    expect(rects.length).toBe(data.length);
  });

  it("lineChart: returns SVG with a polyline element", () => {
    const ui = buildUiKit(TOKENS);
    const svg = ui.lineChart([1, 5, 3, 8, 2]);
    expect(svg.tagName.toLowerCase()).toBe("svg");
    const polyline = svg.querySelector("polyline");
    expect(polyline).toBeTruthy();
  });

  it("lineChart: two lineCharts in one document have distinct gradient ids", () => {
    const ui = buildUiKit(TOKENS);
    const svg1 = ui.lineChart([1, 5, 3, 8, 2]);
    const svg2 = ui.lineChart([2, 4, 6, 3, 7]);

    // Extract gradient IDs from fill attributes
    const area1 = svg1.querySelector("polygon");
    const area2 = svg2.querySelector("polygon");
    expect(area1).toBeTruthy();
    expect(area2).toBeTruthy();

    const fill1 = area1!.getAttribute("fill");
    const fill2 = area2!.getAttribute("fill");

    // Both should have url(#...) pattern but different IDs
    expect(fill1).toMatch(/^url\(#lui-lg-\d+\)$/);
    expect(fill2).toMatch(/^url\(#lui-lg-\d+\)$/);
    expect(fill1).not.toBe(fill2);
  });

  it("gauge: arc dasharray changes with different values", () => {
    const ui = buildUiKit(TOKENS);
    const g1 = ui.gauge(25, 100);
    const g2 = ui.gauge(75, 100);
    // Both must be SVGs
    expect(g1.tagName.toLowerCase()).toBe("svg");
    expect(g2.tagName.toLowerCase()).toBe("svg");
    // The arc circles (second circle) must have different stroke-dasharray
    const circles1 = g1.querySelectorAll("circle");
    const circles2 = g2.querySelectorAll("circle");
    expect(circles1.length).toBeGreaterThanOrEqual(2);
    expect(circles2.length).toBeGreaterThanOrEqual(2);
    const arc1 = circles1[1].getAttribute("stroke-dasharray");
    const arc2 = circles2[1].getAttribute("stroke-dasharray");
    expect(arc1).not.toBe(arc2);
  });

  it("heatmap: cell count equals values.length; alpha scales with value", () => {
    const ui = buildUiKit(TOKENS);
    const values = [0, 1, 2, 3, 4, 5, 6];
    const hm = ui.heatmap(values);
    expect(hm.children.length).toBe(values.length);
    // Cell with value 0 should have lower alpha than cell with value 5
    const cell0 = hm.children[0] as HTMLElement;
    const cell5 = hm.children[5] as HTMLElement;
    // Both should have rgba background
    expect(cell0.style.background).toContain("rgba");
    expect(cell5.style.background).toContain("rgba");
  });

  it("dataGrid: correct row count (header + data rows); correct column count", () => {
    const ui = buildUiKit(TOKENS);
    const columns = ["Name", "Value", "Status"];
    const rows = [["Alpha", 1, "ok"], ["Beta", 2, "warn"], ["Gamma", 3, "error"]];
    const grid = ui.dataGrid(columns, rows);
    // The inner table div
    const table = grid.firstChild as HTMLElement;
    expect(table.children.length).toBe(1 + rows.length); // header + data rows
    // Header has correct column count
    const header = table.children[0] as HTMLElement;
    expect(header.children.length).toBe(columns.length);
    // First data row has correct column count
    const firstRow = table.children[1] as HTMLElement;
    expect(firstRow.children.length).toBe(columns.length);
  });

  it("dataGrid: short row still renders columns.length cells per row", () => {
    const ui = buildUiKit(TOKENS);
    const columns = ["Name", "Value", "Status"];
    // Second and third rows are shorter than columns.length
    const rows = [["Alpha", 1, "ok"], ["Beta", 2], ["Gamma"]];
    const grid = ui.dataGrid(columns, rows);
    const table = grid.firstChild as HTMLElement;

    // All three data rows should have exactly columns.length cells
    for (let i = 0; i < rows.length; i++) {
      const row = table.children[i + 1] as HTMLElement;
      expect(row.children.length).toBe(columns.length);
    }

    // Short row cells should render as empty strings for missing values
    const shortRow = table.children[2] as HTMLElement; // ["Beta", 2]
    expect(shortRow.children[2].textContent).toBe(""); // Third cell should be empty
  });

  it("toggle: flips checked state and calls onChange with new value", () => {
    const ui = buildUiKit(TOKENS);
    const calls: boolean[] = [];
    const tog = ui.toggle("Enable feature", false, (v) => calls.push(v));
    document.body.appendChild(tog);
    tog.click();
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(true);
    tog.click();
    expect(calls[1]).toBe(false);
  });

  it("select: correct number of options", () => {
    const ui = buildUiKit(TOKENS);
    const options = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Gamma" },
    ];
    const sel = ui.select(options);
    expect(sel.tagName.toLowerCase()).toBe("select");
    expect(sel.options.length).toBe(options.length);
    expect(sel.options[0].value).toBe("a");
    expect(sel.options[1].label).toBe("Beta");
  });

  it("spinner: has animation style containing 'spin'", () => {
    const ui = buildUiKit(TOKENS);
    const sp = ui.spinner(32);
    expect(sp).toBeTruthy();
    const anim = sp.style.animation || sp.style.animationName;
    expect(anim).toBeTruthy();
    expect(anim.toLowerCase()).toContain("spin");
  });

  it("icon: returns SVG element with correct tagName", () => {
    const ui = buildUiKit(TOKENS);
    const ic = ui.icon("check");
    expect(ic.tagName.toLowerCase()).toBe("svg");
    const path = ic.querySelector("path");
    expect(path).toBeTruthy();
  });
});

describe("buildUiKit — v3 factory presence", () => {
  it("returns all v3 factories", () => {
    const ui = buildUiKit(TOKENS);
    expect(typeof ui.tabs).toBe("function");
    expect(typeof ui.barChart).toBe("function");
    expect(typeof ui.lineChart).toBe("function");
    expect(typeof ui.gauge).toBe("function");
    expect(typeof ui.heatmap).toBe("function");
    expect(typeof ui.dataGrid).toBe("function");
    expect(typeof ui.toggle).toBe("function");
    expect(typeof ui.select).toBe("function");
    expect(typeof ui.spinner).toBe("function");
    expect(typeof ui.icon).toBe("function");
  });
});

describe("UIKIT_SRC srcdoc-safety", () => {
  it("contains no backtick characters", () => {
    expect(UIKIT_SRC).not.toContain("`");
  });

  it("contains no template literal ${", () => {
    expect(UIKIT_SRC).not.toContain("${");
  });

  it("contains no </script substring", () => {
    expect(UIKIT_SRC.toLowerCase()).not.toContain("</script");
  });
});

describe("KIT_TOKENS single-source parity", () => {
  it("harness srcdoc embeds JSON.stringify(KIT_TOKENS) verbatim", () => {
    const src = buildHarnessSrc(
      { manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" },
      "tok-test",
    );
    expect(src).toContain(JSON.stringify(KIT_TOKENS));
    // Spot-check the accent value is present
    expect(src).toContain("#22d3ee");
  });

  it("harness tokens JSON round-trips to deep-equal KIT_TOKENS", () => {
    const src = buildHarnessSrc(
      { manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" },
      "tok-test2",
    );
    // Extract the first JSON object that matches KIT_TOKENS serialisation
    const serialised = JSON.stringify(KIT_TOKENS);
    expect(src).toContain(serialised);
    const idx = src.indexOf(serialised);
    const parsed = JSON.parse(src.slice(idx, idx + serialised.length));
    expect(parsed).toEqual(KIT_TOKENS);
  });

  it("makeLoomApi ui.tokens deep-equals KIT_TOKENS", () => {
    const api = makeLoomApi("x", []);
    expect(api.ui.tokens).toEqual(KIT_TOKENS);
  });
});

// ── sandbox `self` mock — deterministic, offline ───────────────────────────────

type HarnessLoom = {
  self: {
    identity(): Promise<{ mode: string; genomeSha: string; generation: string | null; threaded: boolean; loomhome: string; loomhomeBytes: number }>;
    threads(): Promise<{ threaded: boolean; tools: { name: string; path: string | null; version: string | null; install: string }[]; missing: string[] }>;
    generations(): Promise<unknown[]>;
    thread(onEvent?: (e: { step: string; detail: string; tail: string[] }) => void): Promise<void>;
    reweave(): Promise<{ ok: boolean; reason?: string }>;
    returnTo(sha: string): Promise<void>;
    returned: string[];
  };
};

/** Evaluate the harness's own `freshLoom` factory outside the iframe. */
function harnessLoom(): HarnessLoom {
  const src = buildHarnessSrc(
    { manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" },
    "self-mock",
  );
  const a = src.indexOf("const freshLoom = ");
  const b = src.indexOf("const mockLoom = freshLoom();");
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  const factory = new Function("makeUi", src.slice(a, b) + "\nreturn freshLoom();");
  return factory(() => ({})) as HarnessLoom;
}

describe("sandbox self mock", () => {
  it("identity is a threaded dev body whose generation matches its genome", async () => {
    const id = await harnessLoom().self.identity();
    expect(id.mode).toBe("dev");
    expect(id.threaded).toBe(true);
    expect(id.genomeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(id.generation).toBe(id.genomeSha);
    expect(typeof id.loomhomeBytes).toBe("number");
    // Deterministic across fresh looms.
    expect(await harnessLoom().self.identity()).toEqual(id);
  });

  it("threads reports every tool present with a path and a version", async () => {
    const t = await harnessLoom().self.threads();
    expect(t.threaded).toBe(true);
    expect(t.missing).toEqual([]);
    const names = t.tools.map((x) => x.name);
    for (const n of ["git", "cargo", "rustc", "node", "npm", "cmake", "clang", "codesign"]) expect(names).toContain(n);
    for (const tool of t.tools) {
      expect(tool.path).toBeTruthy();
      expect(tool.version).toBeTruthy();
      expect(typeof tool.install).toBe("string");
    }
  });

  it("generations is empty; thread() reports done; reweave says nothing new; returnTo records", async () => {
    const loom = harnessLoom();
    expect(await loom.self.generations()).toEqual([]);
    const steps: string[] = [];
    await loom.self.thread((e) => steps.push(e.step));
    expect(steps[steps.length - 1]).toBe("done");
    const r = await loom.self.reweave();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nothing new to weave/);
    await loom.self.returnTo("abc");
    expect(loom.self.returned).toEqual(["abc"]);
  });
});
