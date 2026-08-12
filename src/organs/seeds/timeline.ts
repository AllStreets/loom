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
    const t = loom.ui.tokens;
    el.style.fontFamily = "system-ui, sans-serif";
    el.style.color = t.t1;
    el.style.padding = "4px";

    const heading = document.createElement("h3");
    heading.textContent = "The Timeline";
    heading.style.color = t.t1;
    heading.style.margin = "0 0 12px 0";
    heading.style.fontSize = "16px";
    heading.style.fontWeight = "bold";
    el.appendChild(heading);

    const principles = [
      "Every change is a git commit.",
      "One-click rollback to any prior state.",
      "A bad edit can never strand you.",
    ];

    for (const principle of principles) {
      const line = document.createElement("p");
      line.textContent = principle;
      line.style.color = t.t2;
      line.style.margin = "0 0 8px 0";
      line.style.fontSize = "14px";
      el.appendChild(line);
    }
  }
};`;

const TEST_JS = `export const tests = [
  {
    name: "renders the heading",
    fn: async ({ el, assert }) => {
      assert(el.textContent.includes("The Timeline"), "heading text is present");
    },
  },
];`;

export const files: OrganFile[] = [
  { name: "manifest.json", content: MANIFEST },
  { name: "organ.js", content: ORGAN_JS },
  { name: "test.js", content: TEST_JS },
];
