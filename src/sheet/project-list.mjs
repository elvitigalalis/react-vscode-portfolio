// Projects on /plan (docs/sheet-projects.md): under the week, one row per open project, "CSE 416
// final project · Tight · 3 of 7 steps · 6h left · due Dec 10", which opens to its steps. Each
// step is an ordinary task row (taskRow), so checking, editing, the menu and dragging work as
// anywhere else; steps stay out of the Someday lists. The rows are drawn on each render from
// state; the projects and their steps are read again when the planner loads.
import * as api from "./api.mjs";
import { el, icon, state, render, renderHooks, reloadHooks, taskRow } from "./planner.mjs";
import { projectSummary } from "./project-view.mjs";

let root;
let projects = []; // open projects rows, soonest due first
let seen = null;   // the state.tasks they were read for
const opened = new Set(); // projects shown open, kept across redraws

async function refresh(tasks) {
  const rows = await api.listProjects();
  const steps = await api.listSteps(rows.map((p) => p.id));
  if (state.tasks !== tasks) return; // a newer load is on its way
  const changed = JSON.stringify(rows) !== JSON.stringify(projects);
  projects = rows;
  // Steps on a day outside the week still need to be known for their rows to work.
  const added = steps.filter((t) => !state.tasks.has(t.id));
  for (const t of added) state.tasks.set(t.id, t);
  // Only this list redraws, unless a step new to the page has a block: then the whole page, so
  // the other hooks see it too (focus Start on a step's block today). The hook below then only
  // draws: state.tasks is `seen`.
  if (added.some((t) => state.blocks.some((b) => b.task_id === t.id))) render();
  else if (changed || added.length) draw();
}

// The disclosure's mark: a chevron that turns down when open (plan-sections.css).
function chevron() {
  const svg = icon("chevron-right");
  svg.classList.add("sheet-chev");
  return svg;
}

function row(p, s) {
  const details = el("details", { className: "sheet-project", open: opened.has(p.id) },
    el("summary", {},
      chevron(),
      el("span", { className: "sheet-project-title", textContent: p.title }),
      s.chip ? el("span", { className: `sheet-meta sheet-hz is-${s.chip.level}`, textContent: s.chip.text }) : null,
      el("span", { className: "sheet-hz-line", textContent: s.line })),
    el("ol", { className: "sheet-rows sheet-project-steps", ariaLabel: `Steps of ${p.title}` }, ...s.steps.map((t) => taskRow(t, null))));
  details.addEventListener("toggle", () => (details.open ? opened.add(p.id) : opened.delete(p.id)));
  return el("li", {}, details);
}

function draw() {
  const steps = [...state.tasks.values()].filter((t) => t.project_id);
  const items = projects.map((p) => [p, projectSummary(p, steps.filter((t) => t.project_id === p.id), state.states)])
    .filter(([, s]) => s.steps.length && !s.done);
  root.querySelector("[data-projects]").hidden = !items.length;
  root.querySelector("[data-project-n]").textContent = items.length ? String(items.length) : "";
  root.querySelector("[data-project-list]").replaceChildren(...items.map(([p, s]) => row(p, s)));
}

export function setupProjects(node) {
  root = node;
  const read = () => { if (state.tasks !== seen) { seen = state.tasks; refresh(seen).catch(console.error); } };
  renderHooks.push(() => { read(); draw(); });
  // Coming back to a page with nothing new skips the redraw (planner.mjs, load): read them anyway.
  reloadHooks.push(read);
}
