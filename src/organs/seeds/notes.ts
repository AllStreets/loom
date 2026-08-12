import type { OrganFile } from "../../lib/core";

const MANIFEST = JSON.stringify({
  id: "notes",
  name: "Notes",
  description: "Quick capture — jot a thought, keep it forever.",
  version: 1,
  permissions: ["storage"],
});

const ORGAN_JS = `export default {
  id: "notes",
  render(el, loom) {
    const t = loom.ui.tokens;
    el.style.fontFamily = "system-ui, sans-serif";
    el.style.color = t.t1;

    // Input row
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.marginBottom = "12px";

    const input = document.createElement("input");
    input.placeholder = "Jot a thought...";
    input.style.flex = "1";
    input.style.background = t.panel;
    input.style.color = t.t1;
    input.style.border = "1px solid " + t.t3;
    input.style.borderRadius = "4px";
    input.style.padding = "6px 10px";
    input.style.outline = "none";

    const btn = document.createElement("button");
    btn.textContent = "Add";
    btn.style.background = t.accent;
    btn.style.color = t.bg;
    btn.style.border = "none";
    btn.style.borderRadius = "4px";
    btn.style.padding = "6px 14px";
    btn.style.cursor = "pointer";
    btn.style.fontWeight = "bold";

    row.appendChild(input);
    row.appendChild(btn);
    el.appendChild(row);

    // Notes list
    const list = document.createElement("div");
    el.appendChild(list);

    // Count line
    const countLine = document.createElement("div");
    countLine.style.color = t.accent;
    countLine.style.fontSize = "12px";
    countLine.style.marginTop = "8px";
    el.appendChild(countLine);

    function render() {
      const items = loom.storage.get("items", []);
      list.innerHTML = "";
      const sorted = items.slice().sort((a, b) => b.t - a.t);
      for (const item of sorted) {
        const noteEl = document.createElement("div");
        noteEl.style.display = "flex";
        noteEl.style.alignItems = "center";
        noteEl.style.gap = "8px";
        noteEl.style.background = t.panel;
        noteEl.style.borderRadius = "4px";
        noteEl.style.padding = "6px 10px";
        noteEl.style.marginBottom = "6px";

        const text = document.createElement("span");
        text.style.flex = "1";
        text.style.color = t.t1;
        text.textContent = item.text;

        const del = document.createElement("button");
        del.textContent = "x";
        del.style.background = "transparent";
        del.style.color = t.danger;
        del.style.border = "none";
        del.style.cursor = "pointer";
        del.style.fontSize = "14px";
        del.onclick = () => {
          const all = loom.storage.get("items", []);
          loom.storage.set("items", all.filter((n) => n.t !== item.t));
          render();
        };

        noteEl.appendChild(text);
        noteEl.appendChild(del);
        list.appendChild(noteEl);
      }
      const count = items.length;
      countLine.textContent = count === 0 ? "No notes yet." : count + " note" + (count === 1 ? "" : "s");
    }

    function addNote() {
      const text = input.value.trim();
      if (!text) return;
      const items = loom.storage.get("items", []);
      items.push({ t: Date.now(), text });
      loom.storage.set("items", items);
      input.value = "";
      render();
    }

    btn.onclick = addNote;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addNote();
    });

    render();
  }
};`;

const TEST_JS = `export const tests = [
  {
    name: "adds a note to storage",
    fn: async ({ el, loom, assert }) => {
      const input = el.querySelector("input");
      assert(input !== null, "input exists");
      input.value = "hello world";
      const btn = el.querySelector("button");
      assert(btn !== null, "button exists");
      btn.click();
      const items = loom.storage.get("items", []);
      assert(items.length === 1, "storage has 1 item");
      assert(items[0].text === "hello world", "item text matches");
    },
  },
  {
    name: "renders existing notes",
    fn: async ({ loom, organ, assert }) => {
      loom.storage.set("items", [{ t: 1700000000000, text: "existing note" }]);
      const freshEl = document.createElement("div");
      organ.render(freshEl, loom);
      assert(freshEl.textContent.includes("existing note"), "existing note is rendered");
    },
  },
];`;

export const files: OrganFile[] = [
  { name: "manifest.json", content: MANIFEST },
  { name: "organ.js", content: ORGAN_JS },
  { name: "test.js", content: TEST_JS },
];
