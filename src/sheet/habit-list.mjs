// Habits as rates on /plan (docs/sheet-habits.md): under the week, one row per habit with a ✓ for
// today, its last seven days as dots and "5 of last 7 sessions" (habit-rate.mjs). After a missed day the
// row asks "Back on it today?" and says nothing else about the miss. The habits and their
// habit_done rows are read when the planner loads and when Settings closes; a ✓ shows at once and
// is saved behind it, and goes back if the save fails. The module loads after first paint, and
// its styles come with it as text (Vite's ?inline, as lookback-view.mjs), so /plan's first load
// carries no rules it doesn't use.
import css from "../styles/plan-habits.css?inline";
import * as api from "./api.mjs";
import { actHooks, el, failed, icon, renderHooks, reloadHooks, state } from "./planner.mjs";
import { SHEET } from "../site.mjs";
import { habitDay, habitView, rateText } from "./habit-rate.mjs";
import { addDays } from "./logic.mjs";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

let root;
let habits = [];
let done = new Map(); // habit id → Set of habit days
let seen = null;      // the state.tasks they were read for (one read per load, as project-list.mjs)
// Ticks not yet saved, "id|day" → on. A reload during a save would read the old row, so refresh
// lays these back over what it read; only the newest refresh's answer is used.
const pending = new Map();
let reads = 0;
let drawnDay = null; // the habit day the rows show; at 4 am it moves on (redrawn on a tap or return)
// Saves run one after another per "id|day", so a quick double tap lands in the order tapped.
const queues = new Map();
function queued(key, write) {
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(write);
  queues.set(key, run);
  run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
  return run;
}
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const WORDS = { done: "done", missed: "not done", due: "today, open", off: "off" };

const today = () => habitDay(new Date(), SHEET.timeZone);
const daysOf = (id) => done.get(id) ?? done.set(id, new Set()).get(id);
const setDone = (id, day, on) => (on ? daysOf(id).add(day) : daysOf(id).delete(day));

async function refresh() {
  const from = addDays(today(), -55); // seven scheduled days back for a once-a-week habit
  const n = ++reads;
  const [rows, ticks] = await Promise.all([api.listHabits(), api.listHabitDone(from)]);
  if (n !== reads) return; // a newer read is on its way
  habits = rows;
  done = new Map();
  for (const t of ticks) daysOf(t.habit_id).add(t.day);
  for (const [key, on] of pending) { const [id, day] = key.split("|"); setDone(id, day, on); }
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
  // The rate is the ✓'s description, so a screen reader hears "5 of last 7 sessions" with it.
  const rateId = `sheet-habit-rate-${h.id}`;
  check.setAttribute("aria-describedby", rateId);
  const label = v.dots.map((d) => `${WEEKDAY.format(new Date(`${d.day}T12:00:00Z`))} ${WORDS[d.state]}`).join(", ");
  const dots = el("span", { className: "sheet-habit-dots", role: "img", ariaLabel: `Last 7 days: ${label}`, title: label },
    ...v.dots.map((d) => el("span", { className: `is-${d.state}` })));
  return el("li", { className: `sheet-habit${on ? " is-done" : ""}${on && h.id === fresh ? " is-fresh" : ""}` }, check,
    el("span", { className: "sheet-habit-name", textContent: h.name }),
    dots,
    el("span", { className: "sheet-habit-rate", id: rateId, textContent: rateText(v) }),
    v.back ? el("span", { className: "sheet-habit-back", textContent: "Back on it today?" }) : null);
}

function draw(fresh = null) {
  const day = today();
  drawnDay = day;
  // A redraw (a reload, the planner's render) replaces the rows: focus stays on the same ✓.
  const focused = document.activeElement?.closest?.(".sheet-habit-check")?.dataset.id;
  root.querySelector("[data-habit-rates]").hidden = !habits.length;
  root.querySelector("[data-habit-n]").textContent = habits.length ? String(habits.length) : "";
  root.querySelector("[data-habit-list]").replaceChildren(...habits.map((h) => row(h, day, fresh)));
  if (focused) root.querySelector(`.sheet-habit-check[data-id="${CSS.escape(focused)}"]`)?.focus();
}

async function toggle(e) {
  const id = e.target.closest("[data-id]").dataset.id;
  const day = today();
  // Past 4 am since the last draw: the tap is for the new day, so the rows move to it first.
  if (day !== drawnDay) draw();
  const key = `${id}|${day}`;
  const on = !daysOf(id).has(day);
  pending.set(key, on);
  setDone(id, day, on);
  draw(id);
  // Safari doesn't focus a clicked button, so the tapped ✓ is focused by hand.
  root.querySelector(`.sheet-habit-check[data-id="${CSS.escape(id)}"]`)?.focus();
  try {
    await queued(key, () => (on ? api.markHabitDone(id, day) : api.unmarkHabitDone(id, day)));
    if (pending.get(key) === on) pending.delete(key);
  } catch (err) {
    // Back to what it was before this tap, unless a newer tap has already set it.
    if (pending.get(key) === on) { pending.delete(key); setDone(id, day, !on); draw(); }
    failed(err);
  }
}

export function setupHabits(node) {
  root = node;
  actHooks["habit-done"] = toggle;
  // Habits added or removed in Settings show when it closes.
  root.querySelector("[data-settings]")?.addEventListener("close", () => refresh().catch(console.error));
  const read = () => {
    if (state.tasks === seen) return false;
    seen = state.tasks;
    refresh().catch(console.error);
    return true;
  };
  const hook = () => { if (!read()) draw(); };
  renderHooks.push(hook);
  // Coming back to a page with nothing new skips the redraw (planner.mjs, load): read them anyway.
  reloadHooks.push(read);
  // Back on the page after 4 am (the planner's own reload waits a minute): the rows move on.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && drawnDay && today() !== drawnDay) draw();
  });
  // Loaded after the first render (index.astro loads this module lazily): catch up now.
  if (state.week) hook();
}
