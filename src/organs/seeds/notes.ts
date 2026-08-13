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
    const ui = loom.ui;
    const { root, body } = ui.card({ title: "Notes" });

    const heading = ui.heading("Quick Capture", "Jot a thought, keep it forever.");
    const input = ui.input({ placeholder: "New note...", action: "new-note", onEnter: addNote });
    const addBtn = ui.button("Add", { variant: "primary", action: "add" });
    const inputRow = ui.row(input, addBtn);
    input.style.flex = "1";

    const noteList = ui.list();
    const countStat = ui.stat("notes", 0);

    body.appendChild(heading);
    body.appendChild(inputRow);
    body.appendChild(noteList.root);
    body.appendChild(countStat);
    el.appendChild(root);

    function refresh() {
      const items = loom.storage.get("items", []);
      noteList.clear();
      const sorted = items.slice().sort(function(a, b) { return b.t - a.t; });
      if (sorted.length === 0) {
        noteList.add(ui.empty("No notes yet."));
      } else {
        for (var i = 0; i < sorted.length; i++) {
          var item = sorted[i];
          (function(it) {
            var row = ui.listRow(it.text, {
              onRemove: function() {
                var all = loom.storage.get("items", []);
                loom.storage.set("items", all.filter(function(n) { return n.t !== it.t; }));
                refresh();
              },
              removeAction: "remove",
            });
            noteList.add(row);
          })(item);
        }
      }
      ui.setStat(countStat, items.length);
    }

    function addNote() {
      var text = input.value.trim();
      if (!text) return;
      var items = loom.storage.get("items", []);
      items.push({ t: Date.now(), text: text });
      loom.storage.set("items", items);
      input.value = "";
      refresh();
    }

    addBtn.addEventListener("click", addNote);

    refresh();
  }
};`;

const TEST_JS = `export const tests = [
  {
    name: "adds a note to storage",
    fn: async ({ el, loom, assert }) => {
      const input = el.querySelector('[data-action="new-note"]');
      assert(input !== null, "input exists");
      input.value = "hello world";
      const btn = el.querySelector('[data-action="add"]');
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
  {
    name: "removes a note",
    fn: async ({ loom, organ, assert }) => {
      loom.storage.set("items", [{ t: 1700000000000, text: "note to remove" }]);
      const freshEl = document.createElement("div");
      organ.render(freshEl, loom);
      const removeBtn = freshEl.querySelector('[data-action="remove"]');
      assert(removeBtn !== null, "remove button exists");
      removeBtn.click();
      const items = loom.storage.get("items", []);
      assert(items.length === 0, "storage has 0 items");
    },
  },
];`;

export const files: OrganFile[] = [
  { name: "manifest.json", content: MANIFEST },
  { name: "organ.js", content: ORGAN_JS },
  { name: "test.js", content: TEST_JS },
];
