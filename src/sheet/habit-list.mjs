// Habits as rates on /plan (docs/sheet-habits.md): under the week, one row per habit with a ✓ for
// today, its last seven days as dots and "5 of last 7" (habit-rate.mjs). After a missed day the
// row asks "Back on it today?" and says nothing else about the miss. The habits and their
// habit_done rows are read when the planner loads and when Settings closes; a ✓ shows at once and
// is saved behind it, and goes back if the save fails. The module loads after first paint, and
// its styles come with it as text (Vite's ?inline, as lookback-view.mjs), so /plan's first load
// carries no rules it doesn't use.
import css from "../styles/plan-habits.css?inline";
import * as api from "./api.mjs";
import { actHooks, el, failed, icon, renderHooks, state } from "./planner.mjs";
import { SHEET } from "../site.mjs";
import { habitDay, habitView, rateText } from "./habit-rate.mjs";
import { addDays } from "./logic.mjs";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

let root;
let habits = [];
let done = new Map(); // habit id → Set of habit days
let seen = null;      // the state.tasks they were read for (one read per load, as project-list.mjs)
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const WORDS = { done: "done", missed: "not done", due: "today, open", off: "off" };

const today = () => habitDay(new Date(), SHEET.timeZone);
const daysOf = (id) => done.get(id) ?? done.set(id, new Set()).get(id);

async function refresh() {
  const from = addDays(today(), -55); // seven scheduled days back for a once-a-week habit
  const [rows, ticks] = await Promise.all([api.listHabits(), api.listHabitDone(from)]);
  habits = rows;
  done = new Map();
  for (const t of ticks) daysOf(t.habit_id).add(t.day);
  draw();
}

function row(h, day, fresh) {
  const since = h.created_at ? habitDay(new Date(h.created_at), SHEET.timeZone) : null;
  const v = habitView(h, daysOf(h.id), day, since);
  const on = daysOf(h.id).has(day);
  const check = el("button", { type: "button", className: "sheet-habit-check", ariaLabel: `${h.name} done today`, title: on ? "Done today" : "Mark done today" }, icon("check"));
  check.setAttribute("aria-pressed", String(on));
  check.dataset.act = "habit-done";
  check.dataset.id = h.id;
  const label = v.dots.map((d) => `${WEEKDAY.format(new Date(`${d.day}T12:00:00Z`))} ${WORDS[d.state]}`).join(", ");
  const dots = el("span", { className: "sheet-habit-dots", role: "img", ariaLabel: `Last 7 days: ${label}`, title: label },
    ...v.dots.map((d) => el("span", { className: `is-${d.state}` })));
  return el("li", { className: `sheet-habit${on ? " is-done" : ""}${on && h.id === fresh ? " is-fresh" : ""}` }, check,
    el("span", { className: "sheet-habit-name", textContent: h.name }),
    dots,
    el("span", { className: "sheet-habit-rate", textContent: rateText(v) }),
    v.back ? el("span", { className: "sheet-habit-back", textContent: "Back on it today?" }) : null);
}

function draw(fresh = null) {
  const day = today();
  root.querySelector("[data-habit-rates]").hidden = !habits.length;
  root.querySelector("[data-habit-list]").replaceChildren(...habits.map((h) => row(h, day, fresh)));
}

async function toggle(e) {
  const id = e.target.closest("[data-id]").dataset.id;
  const day = today();
  const days = daysOf(id);
  const on = !days.has(day);
  const flip = () => (days.has(day) ? days.delete(day) : days.add(day));
  flip();
  draw(id);
  root.querySelector(`.sheet-habit-check[data-id="${id}"]`)?.focus();
  try {
    await (on ? api.markHabitDone(id, day) : api.unmarkHabitDone(id, day));
  } catch (err) {
    flip();
    draw();
    failed(err);
  }
}

export function setupHabits(node) {
  root = node;
  actHooks["habit-done"] = toggle;
  // Habits added or removed in Settings show when it closes.
  root.querySelector("[data-settings]")?.addEventListener("close", () => refresh().catch(console.error));
  const hook = () => {
    if (state.tasks !== seen) { seen = state.tasks; refresh().catch(console.error); }
    else draw();
  };
  renderHooks.push(hook);
  // Loaded after the first render (index.astro loads this module lazily): catch up now.
  if (state.week) hook();
}
