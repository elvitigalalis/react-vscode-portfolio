// The sections under the week (docs/sheet.md, "Look"): their styles (plan-sections.css: the
// section header and its count, the chevron disclosure, Someday, the Log and Projects), added as
// text the first time this loads, and Someday's counts. plan/index.astro loads it once signed in
// and the first draw waits for it (drawWaits), so the stored copy never draws them unstyled,
// while signed out /plan carries none of it, rules or script.
import css from "../styles/plan-sections.css?inline";
import { el, renderHooks, state } from "./planner.mjs";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

const open = (t) => t.day === null && !t.done && !t.project_id;

// After each draw: each Someday list's open count by its name, the total by Someday's, and a list
// a feed made (GitHub, Jira) goes while it holds nothing open; his own lists, Inbox and a new
// empty one, always show.
function counts() {
  const tasks = [...state.tasks.values()].filter((t) => t.day === null);
  const n = document.querySelector("[data-someday-n]");
  if (n) n.textContent = String(tasks.filter(open).length || "");
  for (const ul of document.querySelectorAll("[data-someday] ul[data-list]")) {
    const name = ul.dataset.list;
    const all = tasks.filter((t) => t.list === name);
    const left = all.filter(open).length;
    const fed = name !== "Inbox" && all.length && all.every((t) => t.source);
    if (fed && !left && !ul.querySelector(".sheet-adding") && !ul.contains(document.activeElement)) { ul.closest(".sheet-list").remove(); continue; }
    if (left) ul.previousElementSibling?.append(el("span", { className: "sheet-sec-n", textContent: String(left) }));
  }
}
renderHooks.push(counts);
if (state.week) counts();
