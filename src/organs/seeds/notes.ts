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
    var ui = loom.ui;
    var { root, body } = ui.card({ title: "Notes" });

    // hero moment: note count + 7-day spark
    var heroEl = ui.hero(0, "notes captured");
    var sparkEl = ui.spark([], { width: 72, height: 20 });
    var heroRow = ui.row(heroEl, sparkEl);
    heroRow.style.justifyContent = "space-between";
    heroRow.style.alignItems = "flex-end";

    var heading = ui.heading("Quick Capture", "Jot a thought, keep it forever.");
    var input = ui.input({ placeholder: "New note...", action: "new-note", onEnter: addNote });
    var addBtn = ui.button("Add", { variant: "primary", action: "add" });
    var inputRow = ui.row(input, addBtn);
    input.style.flex = "1";

    var noteList = ui.list();

    body.appendChild(heroRow);
    body.appendChild(heading);
    body.appendChild(inputRow);
    body.appendChild(noteList.root);
    el.appendChild(root);

    function last7DayCounts(items) {
      var now = Date.now();
      var DAY = 86400000;
      var counts = [];
      for (var d = 6; d >= 0; d--) {
        var dayStart = now - (d + 1) * DAY;
        var dayEnd = now - d * DAY;
        var count = 0;
        for (var i = 0; i < items.length; i++) {
          if (items[i].t >= dayStart && items[i].t < dayEnd) count++;
        }
        counts.push(count);
      }
      return counts;
    }

    function refresh() {
      var items = loom.storage.get("items", []);
      noteList.clear();
      var sorted = items.slice().sort(function(a, b) { return b.t - a.t; });
      if (sorted.length === 0) {
        noteList.add(ui.empty("No notes yet."));
      } else {
        for (var i = 0; i < sorted.length; i++) {
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
          })(sorted[i]);
        }
      }
      heroEl._valNode.textContent = String(items.length);
      sparkEl.update(last7DayCounts(items));
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
      var input = el.querySelector('[data-action="new-note"]');
      assert(input !== null, "input exists");
      input.value = "hello world";
      var btn = el.querySelector('[data-action="add"]');
      assert(btn !== null, "button exists");
      btn.click();
      var items = loom.storage.get("items", []);
      assert(items.length === 1, "storage has 1 item");
      assert(items[0].text === "hello world", "item text matches");
    },
  },
  {
    name: "renders existing notes",
    fn: async ({ loom, organ, assert }) => {
      loom.storage.set("items", [{ t: 1700000000000, text: "existing note" }]);
      var freshEl = document.createElement("div");
      organ.render(freshEl, loom);
      assert(freshEl.textContent.includes("existing note"), "existing note is rendered");
    },
  },
  {
    name: "removes a note",
    fn: async ({ loom, organ, assert }) => {
      loom.storage.set("items", [{ t: 1700000000000, text: "note to remove" }]);
      var freshEl = document.createElement("div");
      organ.render(freshEl, loom);
      var removeBtn = freshEl.querySelector('[data-action="remove"]');
      assert(removeBtn !== null, "remove button exists");
      removeBtn.click();
      var items = loom.storage.get("items", []);
      assert(items.length === 0, "storage has 0 items");
    },
  },
  {
    name: "hero count updates after add",
    fn: async ({ el, loom, assert }) => {
      var input = el.querySelector('[data-action="new-note"]');
      var btn = el.querySelector('[data-action="add"]');
      input.value = "first";
      btn.click();
      var items = loom.storage.get("items", []);
      assert(items.length === 1, "storage has 1 item after add");
    },
  },
];`;

export const files: OrganFile[] = [
  { name: "manifest.json", content: MANIFEST },
  { name: "organ.js", content: ORGAN_JS },
  { name: "test.js", content: TEST_JS },
];
