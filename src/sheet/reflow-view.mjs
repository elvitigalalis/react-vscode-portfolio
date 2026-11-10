// Reflow rest of today (docs/sheet.md): when today's unfinished blocks have slipped (one ended
// undone, or a later one now clashes with an event), today's stamps row offers "Reflow rest of
// today". One tap lays them after now in their old order (reflow.mjs, no AI), clear of busy
// events and before shutdown, saving each through saveBlock, as a drag in Plan today does (the
// Google event moves with it). The Undo toast is the receipt: what moved where, and what didn't
// fit. Loaded after sign-in (plan/index.astro), off the first load.
import { SHEET } from "../site.mjs";
import { formatClock, localNow, minutesOn, plural, zonedIso } from "./logic.mjs";
import { reflowPlan } from "./reflow.mjs";
import { el, state, render, renderHooks, actHooks, eventsOn, shutdownAt, offerUndo, failed } from "./planner.mjs";
import { saveBlock } from "./plan-today.mjs";
import { getSession } from "./focus-start.mjs";
import "./doing-styles.mjs";

const tz = SHEET.timeZone;

// Today's plan as reflow.mjs takes it, or null once the day is shut down or past its line.
export function planToday() {
  const day = state.today;
  if (!day || state.days[day]?.shutdown) return null;
  const now = localNow(new Date(), tz).minutes;
  const shutdown = shutdownAt(day);
  if (now >= shutdown) return null;
  const blocks = state.blocks.map((b) => ({ id: b.id, task_id: b.task_id, proposed: b.proposed, start: minutesOn(b.starts_at, day, tz), end: minutesOn(b.ends_at, day, tz) }))
    .filter((b) => b.start >= 0 && b.start < 1440);
  // A block's own Google event, when he reads the "Time blocks" calendar too, isn't a clash.
  const own = new Set(state.blocks.map((b) => b.gcal_id).filter(Boolean));
  const busy = eventsOn(day).filter((e) => e.busy && !e.allDay && !own.has(e.id));
  const keep = [getSession()?.block_id].filter(Boolean);
  return reflowPlan({ blocks, tasks: state.tasks, busy, now, shutdown, keep });
}

let busyNow = false;

// The line: "Reflow rest of today · 2 blocks slipped", or null when nothing would move.
export function reflowLine() {
  const plan = planToday();
  if (!plan?.moves.length) return null;
  const go = el("button", { type: "button", className: "sheet-link", textContent: busyNow ? "Reflowing…" : "Reflow rest of today", disabled: busyNow });
  go.dataset.act = "reflow";
  return el("p", { className: "sheet-reflow" }, go, ` · ${plural(plan.moves.length, "block")} to move`);
}

const title = (id) => state.tasks.get(id)?.title ?? "a block";
const iso = (m) => zonedIso(state.today, m, tz);

// Saves the moves in order, each to its `side` ("to" or "from"), adding each to `done` once saved.
async function moveAll(moves, side, done = []) {
  for (const m of moves) {
    const b = state.blocks.find((x) => x.id === m.id);
    if (b) await saveBlock(b, { starts_at: iso(m[side].start), ends_at: iso(m[side].end) });
    done.push(m);
  }
}

const listed = (moves) => moves.map((m) => `${title(m.task_id)} ${formatClock(m.to.start)}`).join(", ");

// Plans from the page as it is now (so a Retry plans again rather than replaying an old plan) and
// saves it. A save that fails partway still offers Undo for the moves that saved, then throws.
async function apply() {
  const plan = planToday();
  if (!plan?.moves.length) return;
  const done = [];
  try { await moveAll(plan.moves, "to", done); } catch (e) {
    if (done.length) offerUndo(`Reflowed ${done.length} of ${plan.moves.length}: ${listed(done)}.`, () => moveAll(done, "from"));
    throw e;
  }
  const unfit = plan.unfit.map((id) => title(state.blocks.find((b) => b.id === id)?.task_id));
  offerUndo(`Reflowed: ${listed(plan.moves)}.${unfit.length ? ` Didn't fit before shutdown: ${unfit.join(", ")}.` : ""}`, () => moveAll(plan.moves, "from"));
}

async function reflow() {
  if (busyNow || !planToday()?.moves.length) return;
  busyNow = true;
  render();
  try { await apply(); } catch (e) { failed(e, "reflow the rest of today", apply); }
  busyNow = false;
  render();
}

export function setupReflow(root) {
  actHooks.reflow = () => reflow().catch(console.error);
  renderHooks.push(() => {
    const line = reflowLine();
    if (line) root.querySelector(`.sheet-day[data-day="${state.today}"] .sheet-stamps-row`)?.append(line);
  });
  // The page may have drawn before this module came in.
  if (state.week) render();
  // A block can slip while the page sits open: look again each minute.
  // Not mid-edit or with a dialog open, as planner.mjs's refreshStale holds back.
  setInterval(() => {
    const a = document.activeElement;
    if (!state.week || document.hidden || document.querySelector("dialog[open]") || a?.matches?.(".sheet-edit, .sheet-add")) return;
    if (Boolean(planToday()?.moves.length) !== Boolean(root.querySelector(".sheet-reflow"))) render();
  }, 60_000);
}
