import type { OrganFile } from "../../lib/core";

const MANIFEST = JSON.stringify({
  id: "timeline",
  name: "Timeline",
  description: "How LOOM remembers — every change is a commit.",
  version: 1,
  permissions: [],
});

const ORGAN_JS = `export default {
  id: "timeline",
  render(el, loom) {
    var ui = loom.ui;
    var { root, body } = ui.card({ title: "Timeline" });

    var heading = ui.heading("LOOM remembers everything.", "Every change is a commit — nothing is ever lost.");
    body.appendChild(heading);

    // How it works section
    var howSection = ui.section("How it works");
    body.appendChild(howSection);

    var principles = ui.keyval([
      ["commits", "every organ edit"],
      ["rollback", "one click to any state"],
      ["safety", "bad edits cannot strand you"],
      ["history", "full git log, always intact"],
    ]);
    body.appendChild(principles);

    // Status section
    var statusSection = ui.section("System");
    body.appendChild(statusSection);

    var statusRow = ui.row(
      ui.dot("go"),
      (function() {
        var s = document.createElement("span");
        s.textContent = "Timeline active";
        s.style.fontSize = "13px";
        s.style.color = ui.tokens.t2;
        return s;
      })()
    );
    body.appendChild(statusRow);

    el.appendChild(root);
  }
};`;

const TEST_JS = `export const tests = [
  {
    name: "renders the organ heading",
    fn: async ({ el, assert }) => {
      assert(el.textContent.includes("LOOM remembers everything"), "heading text is present");
    },
  },
  {
    name: "renders keyval principle rows",
    fn: async ({ el, assert }) => {
      assert(el.textContent.includes("commits"), "commits key is present");
      assert(el.textContent.includes("rollback"), "rollback key is present");
    },
  },
  {
    name: "renders section labels",
    fn: async ({ el, assert }) => {
      var text = el.textContent.toUpperCase();
      assert(text.includes("HOW IT WORKS"), "How it works section present");
    },
  },
];`;

export const files: OrganFile[] = [
  { name: "manifest.json", content: MANIFEST },
  { name: "organ.js", content: ORGAN_JS },
  { name: "test.js", content: TEST_JS },
];
