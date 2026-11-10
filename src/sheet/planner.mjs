// The planner on /plan (docs/sheet.md): the week, Someday lists, typing tasks in, the task menu,
// drag and drop, and undo. Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import {
  addDays, weekStart, weekDays, localNow, dayLabel, parseEntry, titleDue, withTitleDue, formatMinutes, rowCount,
  positionBetween, byPosition, carriedNote, laterThisWeek, moveChange, DROPPED, blockOnComplete, zonedIso, formatClock, formatSpan,
  eventsOnDay, freeMinutes, clashWith, dueLabel, VIS, plural, capMinutes, minutesOn,
  somedayLog,
} from "./logic.mjs";
import { sourceOf, dueLevel, dayWindow, openView, followToday } from "./glance.mjs";
import { hostToast } from "./toast-host.mjs";
import { scrollToToday } from "./public.mjs";
import { wakeProfile, windowStart, planStart } from "./sleep.mjs";
import { bedtimeFor, bedtimeMarker, ouraWindow, tonight, shutdownFor } from "./bedtime.mjs";
import { chipsLabel, dayChips, lateNap } from "./oura-day.mjs";
import { pickTips } from "./tips.mjs";
import { lightDismiss, menuKeys } from "./dismiss.mjs";
import { dayRows, taskSpan } from "./event-todos.mjs";
import { horizonChip, horizonLine } from "./horizon-view.mjs";
import * as cheer from "./celebrate.mjs";
import { dayProgress, progressText, weekDone, weekTitle } from "./progress.mjs";
import { SNAPSHOT_KEY } from "./snapshot-key.mjs";

export const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null && k !== false));
  return node;
};

// --- Icons (docs/sheet-glance.md, "The icon set") ----------------------------------------

// One symbol from the Lucide sprite in plan/index.astro, hidden from screen readers: the
// row's aria-label carries the words. A label shows as hover text.
const SVG = "http://www.w3.org/2000/svg";
export function icon(name, label) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "sheet-icon");
  if (label) {
    const title = document.createElementNS(SVG, "title");
    title.textContent = label;
    svg.append(title);
  }
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// A source's icon (docs/sheet-glance.md, change 3), paired with its edge colour in sheet.css.
const SOURCES = { course: ["graduation-cap", "From Brightspace"], campus: ["ticket", "Campus event"], github: ["github", "From GitHub"], jira: ["kanban", "From Jira"], slack: ["slack", "From Slack"] };
export const sourceIcon = (src) => icon(...SOURCES[src]);
// The words for the aria-label, since the icon is hidden.
export const sourceWords = (src) => (src ? `, ${SOURCES[src][1].toLowerCase()}` : "");

// --- State -------------------------------------------------------------------------------

export const state = {
  today: null,      // the owner's today, refreshed on every render
  week: null,       // Monday of the week on screen
  focus: null,      // the one day shown on narrow screens
  tasks: new Map(),
  blocks: [],
  days: {},
  lists: new Set(["Inbox"]),
  parked: 0,
  calendars: [],    // extra Google calendar IDs, from settings
  settings: null,   // the settings row
  sleep: [],        // Oura: the sleep_nights rows, for when each day starts
  sleepTimes: [],   // Wind-down: Oura's bedtime windows (sleep_times)
  sleepDays: [],    // Oura: the week's sleep_days rows (and the 13 days before), for the chips and tips
  events: [],       // the week's Google events, never saved
  todoEvents: [],   // the same with "Time blocks" too, for event to-dos (never saved)
  todos: [],        // event_todos rows: done, hidden and Claude's titles
  horizon: [],      // horizon_alloc rows from today on, each with its task's title
  states: new Map(), // horizon_state rows by task id
  actuals: [],      // today's focus minutes (actuals rows: day, minutes), for the progress line
  eventsStale: false,
};

let root;
const $ = (sel) => root.querySelector(sel);
const now = () => localNow(new Date(), SHEET.timeZone);
// Phones show one day at a time (sheet.css, max-width 48rem).
export const NARROW = "(max-width: 48rem)";
// A touch screen (research U6): words that name keys ("Press P", ⌘Z) give way to buttons.
const COARSE = "(pointer: coarse)";

const tasksOn = (day) => [...state.tasks.values()].filter((t) => t.day === day).sort(byPosition);
const tasksIn = (list) => [...state.tasks.values()].filter((t) => t.day === null && t.list === list).sort(byPosition);
export const eventsOn = (day) => eventsOnDay(state.events, day, SHEET.timeZone);
const clock = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

// The workload cap from Settings (v5 D2, settings.workload_cap_min), or the site's budget
// before settings load.
export const workloadCap = () => state.settings?.workload_cap_min ?? SHEET.capacityMin;

// Oura: when a day starts, 30 minutes after his wake (sleep.mjs, windowStart), on today never
// before now; without sleep rows, 9:30 am.
export const dayStart = (day) => (state.sleep.length
  ? windowStart(day, new Date(), SHEET.timeZone, wakeProfile(state.sleep, new Date(), SHEET.timeZone), clock(SHEET.dayStartAt))
  : clock(SHEET.dayStartAt));

// The day's shutdown line in minutes: his, else when wind-down starts (bedtime.mjs, shutdownFor).
// Here rather than in plan-today.mjs, which re-exports it, so capacity can end at it.
export const shutdownAt = (d) => clock(shutdownFor(d, { line: state.days[d]?.shutdown_at, settings: state.settings, sleep: state.sleep, sleepTimes: state.sleepTimes, tz: SHEET.timeZone }));

// Time for tasks on a day: the workload cap, or less when his events leave less free time
// between the day's start (9:30 am, or after his wake) and its shutdown line (on today, from
// now). It ended at a fixed 10 pm (SHEET.dayEndAt) before; his evenings run to 11 pm.
export function dayCapacity(day) {
  const from = Math.max(dayStart(day), day === state.today ? now().minutes : 0);
  const free = freeMinutes(eventsOn(day), from, shutdownAt(day));
  return { free, capacity: Math.min(workloadCap(), free) };
}

// The window the day strip and Plan today's timeline draw (glance.mjs, dayWindow): from when
// the day opens (sleep.mjs planStart, the wake-based start not held to now, so this morning
// stays in view) to an hour past shutdown, grown to hold the day's blocks and timed events.
// `events` defaults to the week's; Plan today passes the ones it read for the day.
export function windowOn(day, events = eventsOn(day)) {
  const tz = SHEET.timeZone;
  const open = state.sleep.length ? planStart(day, new Date(), tz, wakeProfile(state.sleep, new Date(), tz), clock(SHEET.dayStartAt)) : clock(SHEET.dayStartAt);
  const span = (x) => ({ start: minutesOn(x.starts_at, day, tz), end: minutesOn(x.ends_at, day, tz) });
  const spans = [...events.filter((e) => !e.allDay && e.busy !== false).map(span), ...state.blocks.map(span).filter((s) => s.start >= 0 && s.start < 1440)]
    .filter((s) => s.end > 0 && s.start < 1440 && !(s.start <= 0 && s.end >= 1440));
  return dayWindow(open, shutdownAt(day), spans);
}
const lastPosition = (siblings) => (siblings.length ? siblings[siblings.length - 1].position : null);

function setStatus(text) {
  const s = $("[data-status]");
  s.hidden = !text;
  s.textContent = text ?? "";
}

// A write that failed (research U9, Retry only): the status line names it when the caller says
// what it was ("Couldn't save "Laundry" as done."), and offers Retry when it can be run again.
// A retry that works clears the line and redraws; one that fails says so again. Called with
// only the error (a promise's catch), it says what it always did.
export function failed(err, what = null, retry = null) {
  console.error(err);
  // A task deleted elsewhere: its row has gone (saving), and there is nothing to retry.
  if (err?.gone) return;
  if (!what) return setStatus("Something did not save. Reload to see what's stored.");
  const s = $("[data-status]");
  s.hidden = false;
  s.replaceChildren(`Couldn't ${what}.`);
  if (!retry) return void s.append(" Reload to see what's stored.");
  const again = el("button", { type: "button", className: "sheet-link", textContent: "Retry" });
  again.addEventListener("click", async () => {
    setStatus("Trying again…");
    try { await retry(); setStatus(null); } catch (e) { failed(e, what, retry); }
    render();
  });
  s.append(" ", again);
}
const named = (t) => `"${t?.title ?? "the task"}"`;

// --- Undo --------------------------------------------------------------------------------

let undoFn = null;
let toastTimer;
let toast = null; // kept by reference: it moves into an open dialog (toast-host.mjs)

// An Undo belongs to the action that made it, not to when its save lands. Each action takes a
// ticket when it happens (undoTicket) and offers its Undo with it once saved; a save that lands
// after a newer action's toast has shown offers nothing, so Undo never undoes the older one.
let tickets = 0;
let shownTicket = 0;
export const undoTicket = () => ++tickets;

export function offerUndo(text, fn, ticket = undoTicket()) {
  if (ticket < shownTicket) return;
  shownTicket = ticket;
  undoFn = fn;
  toast.querySelector("[data-toast-text]").textContent = text;
  toast.hidden = false;
  hostToast(root, toast);
  clearTimeout(toastTimer);
  // On touch there is no ⌘Z, so Undo stays up longer: 12 s, not 6.
  toastTimer = setTimeout(() => { toast.hidden = true; undoFn = null; }, matchMedia(COARSE).matches ? 12_000 : 6000);
}

async function undo() {
  const fn = undoFn;
  undoFn = null;
  toast.hidden = true;
  if (fn) { try { await fn(); } catch (e) { failed(e, "undo that", fn); } render(); }
}

// --- Changes -----------------------------------------------------------------------------

// Saving in the background (optimistic.mjs): a task's or an event to-do's change shows at once and
// saves after the row's earlier saves. One that fails puts the row back, says "Not saved" on it
// (`errors`, until its next change) and redraws; the caller's catch names it in the status line.
// optimistic.mjs loads once signed in (start(), before anything is drawn): signed out, /plan
// carries none of it.
let taskBook = null;
let todoBook = null;
let booksReady = null;
const books = () => (booksReady ??= import("./optimistic.mjs").then(({ ledger }) => {
  taskBook = ledger({ get: (id) => state.tasks.get(id), set: (id, row) => state.tasks.set(id, row), drop: (id) => state.tasks.delete(id) });
  todoBook = ledger({
    get: (key) => state.todos.find((t) => t.cal_event_key === key),
    set: (key, row) => { const i = state.todos.findIndex((t) => t.cal_event_key === key); if (i < 0) state.todos.push(row); else state.todos[i] = row; },
  });
}, (e) => { booksReady = null; throw e; }));
const errors = new Map(); // "task:<id>", "event:<key>" or "add:<day or list>" -> the row's note

// Saves wait for the first load to land: a change made on the stored copy (snapshot.mjs) shows at
// once, but what it saves (a block to shorten or delete, say) is worked out from the fresh rows.
let loaded;
const firstLoad = new Promise((r) => { loaded = r; });

// A save that finds its task deleted (`gone`) takes the row away rather than putting it back.
function saving(book, key, change, save) {
  errors.delete(key);
  return book.write(key.slice(key.indexOf(":") + 1), change, () => firstLoad.then(save)).then(
    (saved) => { render(); return saved; },
    (e) => {
      if (e?.gone) forgetTask(key.slice(key.indexOf(":") + 1));
      else errors.set(key, "Not saved");
      render();
      throw e;
    });
}

// A task PATCH that matched no row (deleted elsewhere) saved nothing: that is a failure too.
async function updated(id, change) {
  const saved = await api.updateTask(id, change);
  if (!saved) throw Object.assign(new Error(`task ${id} is gone`), { gone: true });
  return saved;
}

// A task deleted (here, elsewhere, or an Undo of an add): off the page, and its saves still out
// can't bring it back (optimistic.mjs, forget).
export function forgetTask(id) {
  taskBook.forget(id);
  state.tasks.delete(id);
  errors.delete(`task:${id}`);
}
const write = (id, change, save = () => updated(id, change)) => saving(taskBook, `task:${id}`, change, save);
const patch = (id, change) => write(id, change);

// Google calendar blocks of a task. A block with no gcal_id was made while Google was off.
const blocksOf = (id) => state.blocks.filter((b) => b.task_id === id);

// A task's blocks, out of Google Calendar and the table; message-box.mjs's Undo uses it too.
export async function dropBlocks(id) {
  for (const b of blocksOf(id)) {
    if (b.gcal_id && api.googleReady()) await api.deleteEvent(b.gcal_id);
    await api.deleteBlock(b.id);
  }
  state.blocks = state.blocks.filter((b) => b.task_id !== id);
}

// Tasks typed in whose save is still out: drawn as rows in their day or list (addingRow) until
// the saved task takes their place. Not in state.tasks, so nothing can act on one before it has an id.
const adding = [];
const whereKey = (where) => `add:${where.day ?? where.list}${where.also ? ":also" : ""}`;
const sameWhere = (a, b) => (a.day ?? null) === (b.day ?? null) && (a.day ? true : a.list === b.list);

// `extra` goes into the new row as it is ({ done: true } for Also did…).
export async function addTask(text, where, extra = {}) {
  // A due date counts from the task's day; a Someday task's counts from today.
  const parsed = parseEntry(text, where.day ?? state.today);
  if (!parsed.title) return;
  const siblings = where.day ? tasksOn(where.day) : tasksIn(where.list);
  // After the tasks still being added there, so quick adds keep the order they were typed in.
  const last = Math.max(...[lastPosition(siblings), ...adding.filter((a) => sameWhere(a.where, where)).map((a) => a.position)].filter((p) => p != null));
  const position = positionBetween(Number.isFinite(last) ? last : null, null);
  const row = { where, title: parsed.title, position };
  adding.push(row);
  errors.delete(whereKey(where));
  try {
    await firstLoad;
    // A deadline written only in the title ("Nov 14 11:59pm") becomes the due date.
    const task = await api.insertTask(withTitleDue({ ...parsed, day: where.day ?? null, list: where.day ? null : where.list, position, ...extra }, state.today));
    state.tasks.set(task.id, task);
    taskBook.note(task.id, task);
    return task;
  } catch (e) {
    errors.set(whereKey(where), "Not added");
    throw e;
  } finally {
    adding.splice(adding.indexOf(row), 1);
  }
}

// Move a task to a day (or a Someday list), at the end unless a position is given. It shows there
// at once; the promise settles with the save. Moving to another day removes its blocks: a block is
// a plan for one day.
export function moveTask(id, where, position) {
  const t = state.tasks.get(id);
  const ticket = undoTicket();
  const target = where.day ? tasksOn(where.day) : tasksIn(where.list);
  const pos = position ?? positionBetween(lastPosition(target.filter((x) => x.id !== id)), null);
  // Undo goes back to where the server has it, not to a move still saving (or one that failed).
  const { change } = moveChange(t, where, pos);
  const { before } = moveChange(taskBook.confirmed(id) ?? t, where, pos);
  const moving = where.day !== t.day;
  return write(id, change, async () => { if (moving) await dropBlocks(id); return updated(id, change); })
    .then(() => offerUndo("Moved.", () => patch(id, before), ticket));
}

// Done (or not) shows at once; the promise settles with the save. `lead` goes before "Done: …" in
// the Undo toast ("Day cleared."), written with it in one go so a screen reader hears it once.
export function completeTask(id, done = true, lead = null) {
  const t = state.tasks.get(id);
  const ticket = undoTicket();
  return write(id, { done }, async () => {
    if (done) {
      const at = new Date();
      for (const b of blocksOf(id)) {
        const r = blockOnComplete(b, at);
        if (r.action === "delete") {
          if (b.gcal_id && api.googleReady()) await api.deleteEvent(b.gcal_id);
          await api.deleteBlock(b.id);
          state.blocks = state.blocks.filter((x) => x.id !== b.id);
        } else if (r.action === "shrink") {
          if (b.gcal_id && api.googleReady()) await api.patchEvent(b.gcal_id, { end: { dateTime: r.ends_at } });
          Object.assign(b, await api.updateBlock(b.id, { ends_at: r.ends_at }));
        }
      }
    }
    return updated(id, { done });
  }).then(() => { if (done) offerUndo(`${lead ? `${lead} ` : ""}Done: ${t.title}`, () => patch(id, { done: false }), ticket); });
}

// ✓ on a row (and a swipe or the Now/Next line): flip it at once, and say so if it didn't save.
export async function toggleDone(id, lead = null) {
  const done = !state.tasks.get(id).done;
  try { await completeTask(id, done, lead); } catch (err) { failed(err, `save ${named(state.tasks.get(id))} as ${done ? "done" : "not done"}`, () => completeTask(id, done)); }
}

// --- Checking off (celebrate.mjs) -------------------------------------------------------------

// render() replaces every row, which would cut a row's animation short. While a ✓ plays and
// saves, redraws wait (a background reload included) and run once when the last one ends.
let holds = 0;
let owed = false;
let drawn = [];
const nextDraw = () => new Promise((r) => drawn.push(r));
async function hold(work) {
  holds++;
  try { return await work; } finally {
    owed = true;
    if (!--holds) { owed = false; render(); }
  }
}

// The row a task shows in on the page (not in a dialog or a closed Log or project), if any.
const rowOf = (id) => [...root.querySelectorAll(`.sheet-task[data-id="${CSS.escape(id)}"]`)].find((r) => !r.closest("dialog, details:not([open])") && r.getClientRects().length) ?? null;

// The old row plays its ✓ (cheer.playRow) while `save` runs. A save that shows its change at once
// (toggleDone, saving in the background) holds the redraw only for the animation: the redraw then
// draws the done row whether or not the save has landed, and a save that fails later puts the row
// back and redraws again. A save that changes nothing until it lands (focus mode's outbox,
// `gated`) holds it for both, or cheer.SAVE_MS at most: a save that hangs mustn't freeze every
// redraw. Returns { saving }, the save itself.
async function playOff(li, save, { leave = false, moment = null, quiet = false, why = {}, gated = false, from = li.querySelector(".sheet-check") } = {}) {
  cheer.cheer(from, { moment, quiet, why });
  const list = li.closest(".sheet-rows");
  const before = leave ? cheer.places(list) : null;
  const drew = nextDraw();
  const saving = Promise.resolve().then(save);
  // A hidden tab doesn't run animations, so a short timer stands in for one there; a tab hidden
  // midway is covered by the cap.
  const anim = document.hidden ? cheer.wait(150) : cheer.capped(cheer.playRow(li, { leave }), cheer.ANIM_MS);
  const got = await hold(gated ? cheer.capped(Promise.all([saving, anim]), cheer.SAVE_MS) : anim);
  if (got === cheer.LATE) saving.then(() => render(), () => render());
  await drew;
  if (before) cheer.slide(before, root.querySelectorAll(`.sheet-rows[data-list="${CSS.escape(list.dataset.list ?? "")}"] [data-id]`));
  return { saving };
}

// ✓ on a task, from its row, a key, a swipe, the Now/Next line or focus mode. Reopening a done
// task redraws at once. `save` defaults to toggleDone, which shows the change before it saves;
// focus mode passes its outbox, which doesn't, so its ✓ still waits for it (gated).
// A Someday row leaves for the Log once done, so it fades out and the Log's count pops.
// A second tap while the ✓ plays does nothing (cheer.once, keyed by task or event); one after it
// queues behind the first save (optimistic.mjs), so the server gets them in order. Resolves once the
// row is redrawn, with the save still running; an outbox ✓ stays busy until its save ends.
// `focusMin`: the minutes of the focus session that finished it (focus Done), for the burst.
const inFlight = new Set();
export async function checkOff(id, { li = rowOf(id), save = null, quiet = false, from, focusMin = null } = {}) {
  const t = state.tasks.get(id);
  if (!t) return;
  await cheer.once(inFlight, `task:${id}`, async () => {
    const moment = t.done ? null : cheer.momentOf(t, state.tasks.values(), state.today);
    const gated = Boolean(save);
    save ??= () => toggleDone(id, cheer.MOMENT_WORDS[moment] ?? null);
    if (t.done || !li) {
      const saving = save();
      if (gated) await saving;
      render();
      // With no animation to wait out, a double tap's second half still mustn't flip it back.
      if (!gated) await cheer.wait(cheer.TAP_MS);
      return;
    }
    const leave = Boolean(li.closest(".sheet-list"));
    const why = { first: cheer.firstOfDay(state.tasks.values(), state.today, SHEET.timeZone), rolls: t.rolls ?? 0, early: cheer.inside(t, focusMin) };
    const { saving } = await playOff(li, save, { leave, moment, quiet, why, gated, ...(from ? { from } : {}) });
    if (state.tasks.get(id)?.done) {
      if (moment === "day") cheer.pop(root.querySelector(".sheet-day.is-today .sheet-alldone"));
      if (leave) cheer.pop($("[data-log-count]"));
    }
    if (gated) await saving;
  });
}

// After a ✓, focus goes back to the row (`sel` in it), or to the row now in its place when it
// left its list.
function focusAfter(id, sel, list, index) {
  const back = rowOf(id)?.querySelector(sel);
  if (back) back.focus();
  else if (list) refocus(list, index);
}

// Delete, like every change, shows at once: the row goes now and the delete runs behind it. One
// that fails puts the row back with "Not deleted" and reloads the week, since its blocks may be
// half gone.
async function removeTask(id) {
  const t = state.tasks.get(id);
  const ticket = undoTicket();
  forgetTask(id);
  try {
    await firstLoad; // its blocks as loaded, not as stored
    await dropBlocks(id);
    await api.deleteTask(id);
  } catch (e) {
    taskBook.restore(id);
    state.tasks.set(id, t);
    errors.set(`task:${id}`, "Not deleted");
    load({ scroll: false }).catch(console.error);
    throw e;
  }
  const { id: _, created_at, updated_at, ...copy } = t;
  offerUndo(`Deleted: ${t.title}`, async () => {
    const back = await api.insertTask(copy);
    state.tasks.set(back.id, back);
  }, ticket);
}

async function editTask(id, text) {
  const t = state.tasks.get(id);
  const ticket = undoTicket();
  const was = taskBook.confirmed(id) ?? t;
  const parsed = parseEntry(text, t.day ?? state.today);
  if (!parsed.title) return removeTask(id);
  // Details typed while editing apply; ones not typed stay as they were.
  const change = { title: parsed.title };
  for (const k of ["est_min", "at_time", "tag", "due"]) if (parsed[k] !== null) change[k] = parsed[k];
  if (!change.due && !t.due) { const due = titleDue(parsed.title, state.today); if (due) change.due = due; }
  if (VIS.test(text)) change.public = parsed.public;
  const before = { title: was.title, est_min: was.est_min, at_time: was.at_time, tag: was.tag, public: was.public, due: was.due };
  await patch(id, change);
  if (change.public !== undefined && change.public !== before.public) await retitleBlocks(id);
  offerUndo("Edited.", () => patch(id, before), ticket);
}

// A block's Google title follows the task's visibility: its title if public, "Busy" if not.
export async function retitleBlocks(id) {
  const t = state.tasks.get(id);
  if (!api.googleReady()) return;
  for (const b of blocksOf(id)) if (b.gcal_id) await api.patchEvent(b.gcal_id, api.eventTitle(t.title, t.public));
}

async function toggleVisibility(id) {
  const t = state.tasks.get(id);
  const ticket = undoTicket();
  const was = (taskBook.confirmed(id) ?? t).public;
  await patch(id, { public: !t.public });
  await retitleBlocks(id);
  offerUndo(t.public ? "Now private." : "Now public.", async () => { await patch(id, { public: was }); await retitleBlocks(id); }, ticket);
}

async function clearDue(id) {
  const ticket = undoTicket();
  const due = (taskBook.confirmed(id) ?? state.tasks.get(id)).due;
  await patch(id, { due: null });
  offerUndo("Due date cleared.", () => patch(id, { due }), ticket);
}

// --- Rendering ---------------------------------------------------------------------------

const dueText = (due) => dueLabel(due, state.today);

// The details typed so far, shown beside the input as one chip ("45m · 3:00 pm · due Fri").
function typedChip(input) {
  const li = input.closest("li");
  const day = input.dataset.day ?? state.tasks.get(li.dataset.id)?.day ?? state.today;
  const p = parseEntry(input.value, day);
  const text = [p.est_min && formatMinutes(p.est_min), p.at_time && formatClock(clock(p.at_time)), p.tag && `#${p.tag}`,
    !p.public && "private", p.due && dueText(p.due)].filter(Boolean).join(" · ");
  let chip = li.querySelector(".sheet-typed");
  if (!chip) li.append(chip = el("span", { className: "sheet-meta sheet-typed" }));
  chip.textContent = text;
  chip.hidden = !text;
}

// The due date's look by level: overdue in red with the word, at risk in amber; both carry ⚠.
const DUE = {
  overdue: { className: " sheet-overdue", title: "Overdue: its due date has passed", tail: " overdue" },
  risk: { className: " sheet-risk", title: "At risk: no block before it is due", tail: "" },
};

// A task's details beside its title: source, time (when its title doesn't show it), clash,
// estimate, due date, private and carried over (on a day, while undone).
function detailsOf(t, clash, level, span, hz) {
  const src = sourceOf(t);
  const carried = t.day && !t.done ? carriedNote(t.rolls) : null;
  const due = DUE[level];
  const chip = hz && !t.done ? horizonChip(hz) : null;
  const kids = [
    // v5 SRC1: a GitHub or Jira task's icon links to its page (tasks.link is https only).
    src ? el(t.link ? "a" : "span", { className: "sheet-meta sheet-source", ...(t.link ? { href: t.link, target: "_blank", rel: "noopener" } : {}) }, sourceIcon(src)) : null,
    t.at_time && !span ? el("span", { className: "sheet-meta" }, icon("clock"), ` ${formatClock(clock(t.at_time.slice(0, 5)))}`) : null,
    clash ? el("span", { className: "sheet-clash", textContent: "⚠", title: `Clashes with ${clash.title}` }) : null,
    t.est_min ? el("span", { className: "sheet-meta", textContent: formatMinutes(t.est_min) }) : null,
    t.due ? el("span", { className: `sheet-meta${due?.className ?? ""}`, ...(due ? { title: due.title } : {}) },
      due ? "⚠ " : null, icon("flag"), ` ${dueText(t.due).replace(/^due /, "")}${due?.tail ?? ""}`) : null,
    // Horizon planning: the task's state, in the due date's colours.
    chip ? el("span", { className: `sheet-meta sheet-hz is-${chip.level}`, textContent: chip.text }) : null,
    t.public ? null : el("span", { className: "sheet-priv" }, icon("lock", "Only you see this")),
    carried ? el("span", { className: "sheet-meta sheet-carried", textContent: "carried over", title: carried }) : null,
  ].filter(Boolean);
  return kids.length ? el("span", { className: "sheet-details" }, ...kids) : null;
}

// A timed row's time, its own label before the title in a fixed column ("7–7:20 pm"), the same on
// task and event rows. Screen readers get it from the row's words instead: "7 to 7:20 pm, …".
const whenLabel = (start, end) => el("span", { className: "sheet-when", ariaHidden: "true", textContent: formatSpan(start, end) });
const spoken = (start, end) => `${formatSpan(start, end).replace("–", " to ")}, `;
// Every row has one layout: its time (when it has one), then a body holding the title and, on a
// line of its own under it, the details (source or calendar icon, length, due date, private).
const withWhen = (start, end, kids) => [start == null ? null : whenLabel(start, end),
  el("span", { className: "sheet-body" }, ...kids.filter(Boolean))].filter(Boolean);

// A task on a day with a time (taskSpan) reads like an event row: "7–7:20 pm  Register for classes".
export const spanOf = (t) => (t.day ? taskSpan(t, t.day, SHEET.timeZone, state.blocks) : null);

// "Not saved" on a row whose last change didn't save (errors), until its next change.
const errNote = (key) => (errors.has(key) ? el("span", { className: "sheet-row-err", textContent: errors.get(key) }) : null);
const errWords = (key) => (errors.has(key) ? `, ${errors.get(key).toLowerCase()}` : "");

export function taskRow(t, span = spanOf(t)) {
  const li = el("li", { className: `sheet-row sheet-task${t.done ? " is-done" : ""}` });
  li.dataset.id = t.id;
  if (sourceOf(t)) li.dataset.source = sourceOf(t);
  const when = span ? spoken(span.start, span.end) : "";
  const title = el("button", { type: "button", className: "sheet-title", textContent: t.title, title: t.title });
  const clash = t.at_time && t.day && !t.done ? clashWith(clock(t.at_time.slice(0, 5)), eventsOn(t.day)) : null;
  // Horizon planning: with a state, its chip says at risk, so the due date shows only overdue.
  const hz = state.states.get(t.id);
  const level = hz ? (t.due && !t.done && t.due < state.today ? "overdue" : null) : dueLevel(t, state.blocks, state.today, SHEET.timeZone);
  const line = hz && !t.done ? horizonLine(hz, state.horizon.filter((a) => a.task_id === t.id), t.due, state.today) : null;
  title.setAttribute("aria-label", `${when}${t.title}${sourceWords(sourceOf(t))}${t.public ? "" : ", private"}${t.done ? ", done" : ""}${t.due ? `, ${dueText(t.due)}` : ""}${level ? `, ${level === "risk" ? "at risk" : "overdue"}` : ""}${line ? `, ${horizonChip(hz).text}, ${line}` : ""}${clash ? `, clashes with ${clash.title}` : ""}${t.day && !t.done && t.rolls >= 1 ? ", carried over" : ""}${errWords(`task:${t.id}`)}. Edit`);
  li.append(...[
    ...withWhen(span?.start, span?.end, [
      title,
      // The details, kept together so they move under the title as one line when they don't fit.
      detailsOf(t, clash, level, span, hz),
      line ? el("span", { className: `sheet-hz-line${hz.state === "wont_fit" ? " is-overdue" : ""}`, ariaHidden: "true", textContent: line }) : null,
      errNote(`task:${t.id}`)]),
    el("button", { type: "button", className: "sheet-check", ariaLabel: t.done ? `Reopen ${t.title}` : `Complete ${t.title}` }, t.done ? "↺" : icon("check")),
    el("button", { type: "button", className: "sheet-more", ariaLabel: `More for ${t.title}` }, icon("more-horizontal")),
  ].filter(Boolean));
  return li;
}

// Typing a task: a one-row textarea that grows as the title wraps, so a long title stays
// readable. Enter saves; line breaks never go in (a title is one line, wrapped).
const taskBox = (props) => el("textarea", { className: "sheet-add", rows: 1, autocomplete: "off", spellcheck: true, ...props });
const fitBox = (box) => { box.style.height = "auto"; box.style.height = `${box.scrollHeight}px`; };

function addRow(where, label, placeholder = "+ Add a task") {
  const input = taskBox({ ariaLabel: label, placeholder });
  if (where.day) input.dataset.day = where.day; else input.dataset.list = where.list;
  return el("li", { className: "sheet-row is-empty is-add" }, input, errNote(whereKey(where)));
}
// The box for `where`; on today, Also did… (`also`) is the second box.
const addBox = (where) => root.querySelector(where.day ? `.sheet-add[data-day="${where.day}"]${where.also ? "[data-also]" : ":not([data-also])"}` : `.sheet-add[data-list="${CSS.escape(where.list ?? "")}"]`);

// A task typed in whose save is still out (adding): its title, muted, until the saved row takes
// its place. Not a .sheet-task, so no click, key, swipe or drag acts on it.
const addingRow = (a) => el("li", { className: "sheet-row sheet-adding", ariaBusy: "true" }, ...withWhen(null, null, [el("span", { className: "sheet-title", textContent: a.title })]));
const addingIn = (where) => adding.filter((a) => sameWhere(a.where, where)).map((a) => ({ kind: "adding", ...a }));

// Also did… (docs/sheet.md): today's second box, for a win that wasn't planned. Enter logs it as
// a task already done today, so it counts in the progress line.
function alsoRow(day) {
  const input = taskBox({ ariaLabel: "Log something else you did today", placeholder: "Also did…" });
  input.dataset.day = day;
  input.dataset.also = "";
  return el("li", { className: "sheet-row is-empty is-add is-also" }, input, errNote(whereKey({ day, also: true })));
}

// --- Event to-dos (docs/sheet-v5.md, "Event to-dos") ---------------------------------------

// A day's list: its calendar events as to-dos merged with its tasks, in time order
// (event-todos.mjs). The calendar itself shows on Plan today's timeline.
export const rowsOn = (day) => dayRows({ day, timeZone: SHEET.timeZone, tasks: tasksOn(day), events: state.todoEvents, blocks: state.blocks, todos: state.todos });

// An event row looks like a timed task row: its time first, the title, and the calendar icon on
// the details line under it, where a task shows its source.
function eventTodoRow(r) {
  const li = el("li", { className: `sheet-row sheet-evtodo${r.done ? " is-done" : ""}` });
  li.dataset.key = r.key;
  const check = el("button", { type: "button", className: "sheet-check", ariaLabel: r.done ? `Reopen ${r.title}` : `Complete ${r.title}` }, r.done ? "↺" : icon("check"));
  check.dataset.act = "evtodo-done";
  const more = el("button", { type: "button", className: "sheet-more", ariaLabel: `More for ${r.title}` }, icon("more-horizontal"));
  more.dataset.act = "evtodo-more";
  li.append(...[
    r.allDay ? null : el("span", { className: "visually-hidden", textContent: spoken(r.start, r.end) }),
    ...withWhen(r.allDay ? null : r.start, r.end, [
      el("span", { className: "sheet-title", textContent: r.title, title: r.raw }),
      el("span", { className: "sheet-details" }, el("span", { className: "sheet-meta sheet-source" }, icon("calendar", "From your calendar"))),
      errNote(`event:${r.key}`)]),
    check, more].filter(Boolean));
  return li;
}

const eventRowOf = (target) => {
  const key = target.closest("[data-key]")?.dataset.key ?? evMenuFor;
  const day = target.closest("[data-day]")?.dataset.day ?? evMenuDay;
  return { key, day, row: rowsOn(day).find((r) => r.kind === "event" && r.key === key) };
};

// Shows at once and saves in the background, like a task (saving).
function saveEventTodo(key, day, change) {
  if (!state.todos.some((x) => x.cal_event_key === key)) state.todos.push({ cal_event_key: key, title_ai: null, done: false, hidden: false });
  return saving(todoBook, `event:${key}`, change, () => api.saveEventTodo({ cal_event_key: key, day, ...change }));
}

export async function toggleEventTodo(target, { quiet = false } = {}) {
  const { key, day, row } = eventRowOf(target);
  if (!row) return;
  const li = target.closest?.(".sheet-evtodo") ?? root.querySelector(`.sheet-day[data-day="${day}"] .sheet-evtodo[data-key="${CSS.escape(key)}"]`);
  const save = async () => {
    const ticket = undoTicket();
    try {
      await saveEventTodo(key, day, { done: !row.done });
      if (!row.done) offerUndo(`Done: ${row.title}`, () => saveEventTodo(key, day, { done: false }), ticket);
    } catch (e) { failed(e, `save "${row.title}" as ${row.done ? "not done" : "done"}`, () => saveEventTodo(key, day, { done: !row.done })); }
  };
  // As with a task: done shows at once, and the save runs on behind the redraw.
  const ran = await cheer.once(inFlight, `event:${day}:${key}`, async () => {
    if (row.done || !li) { save(); render(); await cheer.wait(cheer.TAP_MS); return; }
    await playOff(li, save, { quiet, ...(target.matches?.(".sheet-nownext-done") ? { from: target } : {}) });
  });
  if (ran) root.querySelector(`[data-key="${CSS.escape(key)}"] .sheet-check`)?.focus();
}

let evMenuFor = null;
let evMenuDay = null;

function openEventMenu(target) {
  const { key, day, row } = eventRowOf(target);
  if (!row) return;
  evMenuFor = key;
  evMenuDay = day;
  const menu = $("[data-evmenu]");
  menu.querySelector('[data-act="evtodo-open"]').hidden = !row.link;
  const r = target.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 100)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - 180, document.documentElement.clientWidth - 200))}px`;
  menu.showPopover();
  menu.querySelector("button:not([hidden])")?.focus();
}

async function eventMenuAction(act) {
  $("[data-evmenu]").hidePopover();
  const { key, day, row } = eventRowOf($("[data-evmenu]"));
  if (!row) return;
  if (act === "evtodo-open") return void window.open(row.link, "_blank", "noopener");
  const ticket = undoTicket();
  try {
    await saveEventTodo(key, day, { hidden: true });
    offerUndo(`Hidden: ${row.title}`, () => saveEventTodo(key, day, { hidden: false }), ticket);
  } catch (e) { failed(e, `hide "${row.title}"`, () => saveEventTodo(key, day, { hidden: true })); }
  render();
}

// An empty today: "Press P" on a keyboard, a Plan button on touch (research U6).
function blankRow() {
  if (!matchMedia(COARSE).matches) return el("li", { className: "sheet-row sheet-blank", textContent: "Nothing planned. Press P to plan today" });
  const plan = el("button", { type: "button", className: "sheet-link", textContent: "Plan today" });
  plan.dataset.act = "plan";
  return el("li", { className: "sheet-row sheet-blank" }, "Nothing planned yet. ", plan);
}

function dayColumn(day, rows, items) {
  const list = tasksOn(day);
  const { weekday, date } = dayLabel(day);
  const info = state.days[day] ?? {};
  const allDone = day === state.today && list.length > 0 && list.every((t) => t.done);
  // An empty today says what to do next (docs/sheet-glance.md, change 7), always shown.
  const blank = day === state.today && !items.length;
  const ul = el("ul", { className: `sheet-rows${blank ? " is-blank" : ""}` }, ...items.map((r) => (r.kind === "task" ? taskRow(r.task, r.start == null ? null : r) : r.kind === "adding" ? addingRow(r) : eventTodoRow(r))),
    blank ? blankRow() : null,
    addRow({ day }, `Add a task to ${weekday} ${date}`),
    day === state.today ? alsoRow(day) : null);
  ul.dataset.day = day;
  for (let i = items.length + (blank ? 2 : 1) + (day === state.today ? 1 : 0); i < rows; i++) ul.append(el("li", { className: "sheet-row is-empty" }));
  const marks = [info.planned && "Planned ✓", info.shutdown && "Shut down ✓"].filter(Boolean).join(" · ");
  const section = el("section", { className: `sheet-day${day === state.today ? " is-today" : ""}${day === state.focus ? " is-focus" : ""}` },
    el("h2", { className: "sheet-head" },
      el("span", { className: "sheet-wd", textContent: weekday }), " ",
      el("span", { className: "sheet-dt", textContent: date }),
      allDone ? el("span", { className: "sheet-alldone", textContent: " ✓", title: "Everything done today" }) : null,
      day === state.today ? el("span", { className: "visually-hidden", textContent: " (today)" }) : null),
    // The stamps row of the week's grid (sheet.css, subgrid): the Oura chips and wind-down sit in
    // it, so every column's tasks still start level.
    el("div", { className: "sheet-stamps-row" },
      el("p", { className: "sheet-stamps", textContent: marks }),
      day <= state.today ? ouraChips(day, `${weekday} ${date}`) : null,
      day === state.today ? progressMark(day) : null,
      day === state.focus ? weekDoneMark() : null,
      day === state.today ? windDownMark() : null,
      day > state.today ? horizonDay(day) : null),
    ul);
  section.dataset.day = day;
  return section;
}

// Progress (progress.mjs): today's "3 of 7 done · 1h40 focused" after a small ring that closes
// as today's tasks get done (a ring, so it doesn't read as the load meter's bar). Real progress
// only: an empty day shows nothing.
// `progressHooks.focused`, when set (focus-start.mjs), gives the { day, minutes } entries the
// focused half counts, in place of state.actuals.
export const progressHooks = { focused: null };
function progressMark(day) {
  const p = dayProgress(state.tasks.values(), day, progressHooks.focused?.() ?? state.actuals);
  const text = progressText(p);
  if (!text) return null;
  let ring = null;
  if (p.total) {
    ring = document.createElementNS(SVG, "svg");
    ring.setAttribute("viewBox", "0 0 16 16");
    ring.setAttribute("aria-hidden", "true");
    ring.setAttribute("class", "sheet-progress-ring");
    ring.dataset.left = String(1 - p.done / p.total);
    // At 0 done only the track: a round-capped empty stroke would still draw a dot.
    for (const cls of ["sheet-progress-track", p.done ? "sheet-progress-fill" : null].filter(Boolean)) {
      const c = document.createElementNS(SVG, "circle");
      for (const [k, v] of Object.entries({ cx: 8, cy: 8, r: 6, pathLength: 1, class: cls })) c.setAttribute(k, String(v));
      ring.append(c);
    }
    if (p.done) ring.lastChild.style.strokeDashoffset = ring.dataset.left;
  }
  // Each half stays whole ("1 of 4 done ·" / "1h40 focused"); the real space between them is
  // where a narrow column wraps.
  const halves = text.split(" · ").flatMap((h, i, all) => [i ? " " : null, el("span", { textContent: i < all.length - 1 ? `${h} ·` : h })]);
  return el("p", { className: "sheet-progress" }, ring, el("span", {}, ...halves));
}

// Phones hide the week title (the h1, still read out), so the shown day says the week's count
// there: "14 done this week", nothing at 0. CSS shows it only on phones (plan-phone.css).
function weekDoneMark() {
  const n = weekDone(state.tasks.values(), weekDays(state.week), SHEET.timeZone);
  if (!n) return null;
  const p = el("p", { className: "sheet-weekdone", textContent: `${n} done this week` });
  p.setAttribute("aria-hidden", "true");
  return p;
}

// The ring closes from where it was before the redraw (render() replaces it), so a ✓ shows as
// the ring filling a step.
let leftWas = null;
function growProgress() {
  const ring = root.querySelector(".sheet-day.is-today .sheet-progress-ring");
  const fill = ring?.querySelector(".sheet-progress-fill");
  const left = ring ? Number(ring.dataset.left) : null;
  if (fill && leftWas != null && left !== leftWas && cheer.calm()) {
    fill.animate([{ strokeDashoffset: leftWas }, { strokeDashoffset: left }], { duration: 400, easing: cheer.EASE_OUT });
  }
  leftWas = left;
}

// Oura (oura-day.mjs): a past day's or today's "☾ 82 · ⚡ 86 · 7h 40m", a button that opens the
// day's numbers; nothing on future days or without a row.
// Today's also says a late nap ("late nap 5:10–6:20 pm") and "1 tip" when there is one.
function ouraChips(day, when) {
  const chips = dayChips(state.sleepDays.find((r) => r.day === day));
  if (!chips.length) return null;
  const today = day === state.today;
  const nap = today ? lateNap(state.sleep, day, SHEET.timeZone) : null;
  const tips = today ? pickTips(state.sleepDays, day).length : 0;
  const extra = [nap, tips ? plural(tips, "tip") : null].filter(Boolean);
  const kids = chips.flatMap((c, i) => [
    i ? el("span", { className: "sheet-oura-sep", textContent: "·" }) : null,
    c.icon ? icon(c.icon) : null,
    el("span", { className: c.band ? `is-${c.band}` : "", textContent: c.text }),
  ]);
  if (extra.length) kids.push(el("span", { className: "sheet-oura-note", textContent: extra.join(" · ") }));
  const label = `${chipsLabel(chips, when).replace(/\. Open details$/, "")}${extra.length ? `; ${extra.join("; ")}` : ""}. Open details`;
  const button = el("button", { type: "button", className: "sheet-oura", ariaLabel: label }, ...kids);
  button.dataset.act = "oura-day";
  button.dataset.day = day;
  return button;
}

// Horizon planning: a later day's planned minutes, faded ("OS project 1h30 · Essay 1h"). Only
// minutes, never times: the morning plan times them on the day.
function horizonDay(day) {
  const rows = state.horizon.filter((a) => a.day === day && a.task?.title && !state.tasks.get(a.task_id)?.done);
  if (!rows.length) return null;
  const text = rows.map((a) => `${a.task.title} ${formatMinutes(a.minutes)}`).join(" · ");
  return el("p", { className: "sheet-hz-day", textContent: text, title: `Planned minutes: ${text}` });
}

// Wind-down (bedtime.mjs): today's thin "Wind down 11:30 pm · Bed 12:30 am" line, for tonight
// (after midnight, the night still going), or nothing without a bedtime.
function windDownMark() {
  const tz = SHEET.timeZone;
  const b = bedtimeFor(tonight(new Date(), tz), { settings: state.settings, sleep: state.sleep, sleepTimes: state.sleepTimes, tz });
  if (!b) return null;
  // Oura's window and hint go in its hover text, and in Settings, to keep the line short.
  const full = bedtimeMarker(b, ouraWindow(tonight(new Date(), tz), state.sleepTimes));
  return el("p", { className: "sheet-winddown", textContent: bedtimeMarker(b), title: full });
}

function listColumn(name) {
  // A project's steps show under it (project-list.mjs), not in Someday.
  // Done ones wait in the Log below the lists (somedayLog).
  const list = tasksIn(name).filter((t) => !t.project_id && !t.done);
  // An empty list always shows its "+ Add a task" hint.
  const typed = addingIn({ list: name });
  const ul = el("ul", { className: `sheet-rows${list.length + typed.length ? "" : " is-blank"}` }, ...list.map((t) => taskRow(t, null)), ...typed.map(addingRow), addRow({ list: name }, `Add a task to ${name}`));
  ul.dataset.list = name;
  return el("section", { className: "sheet-list" }, el("h3", { className: "sheet-head" }, el("span", { className: "sheet-wd", textContent: name })), ul);
}

export function render() {
  if (holds) { owed = true; return; }
  const a = document.activeElement;
  // An edit in place redraws when it ends (startEdit), so a save landing mid-edit can't wipe it.
  if (a?.matches(".sheet-edit:not([data-done])") && root.contains(a)) return;
  // The box being typed in keeps its words and caret: saves now land while he types the next task.
  const keep = a?.classList.contains("sheet-add") ? { day: a.dataset.day, list: a.dataset.list, also: "also" in a.dataset, value: a.value, from: a.selectionStart, to: a.selectionEnd } : null;
  state.today = now().day;
  const days = weekDays(state.week);
  if (!days.includes(state.focus)) state.focus = days.includes(state.today) ? state.today : days[0];
  const items = Object.fromEntries(days.map((d) => [d, [...rowsOn(d), ...addingIn({ day: d })]]));
  // Today holds one more box (Also did…) under its add row.
  const rows = Math.max(rowCount(items), items[state.today] ? Math.max(items[state.today].length, 1) + 2 : 0);
  $("[data-week]").replaceChildren(...days.map((d) => dayColumn(d, rows, items[d])));
  $("[data-week]").style.setProperty("--rows", String(rows));
  growProgress();
  const first = dayLabel(days[0]);
  $("[data-week-title]").textContent = weekTitle(first.date, weekDone(state.tasks.values(), days, SHEET.timeZone));

  for (const t of state.tasks.values()) if (t.day === null) state.lists.add(t.list);
  const newList = el("input", { className: "sheet-add sheet-newlist", type: "text", autocomplete: "off", placeholder: "New list…", ariaLabel: "New Someday list" });
  $("[data-someday]").replaceChildren(...[...state.lists].map(listColumn), el("section", { className: "sheet-list" }, newList));
  $("[data-someday-title]").hidden = false;
  const log = somedayLog(state.tasks.values());
  $("[data-log]").hidden = !log.length;
  $("[data-log-count]").textContent = String(log.length);
  $("[data-log-list]").replaceChildren(...log.map((t) => taskRow(t, null)));

  // Reconnect only helps when there is no Google token at all; a read that failed with one
  // (Google down, say) just shows the kept copy.
  const stale = $("[data-events-stale]");
  stale.hidden = !state.eventsStale || api.googleReady();

  const notice = $("[data-notice]");
  notice.hidden = !state.parked;
  notice.textContent = `${plural(state.parked, "task")} moved to Someday.`;
  for (const hook of renderHooks) hook();
  hostToast(root, toast);

  const box = keep ? addBox(keep) : null;
  if (box) {
    box.focus();
    if (keep.value && !box.value) {
      box.value = keep.value;
      box.setSelectionRange(keep.from, keep.to);
      typedChip(box);
      fitBox(box);
    }
  }
  for (const r of drawn.splice(0)) r();
}

export const renderHooks = [];

// --- Loading -----------------------------------------------------------------------------

// The week draws as soon as the tables are read; Google's events are read beside them and redraw
// the week when they arrive, if they changed (until then it shows the copy kept in this browser).
// `scroll: false` keeps the week where it is (a reload on coming back, refreshStale). `quiet`
// skips the redraw when nothing read has changed since the last load. `sync` is Google work to
// finish before the events are read (syncGoogle on opening). A load started later wins: an older
// one that returns after it changes nothing. Rows with saves out keep their changes (optimistic.mjs).
let loadGen = 0;
let lastRead = null;  // the last load's rows, as JSON
let eventsFor = null; // the Monday of the week state.events are for
export async function load({ scroll = true, quiet = false, sync = null } = {}) {
  const gen = ++loadGen;
  const since = [taskBook.now(), todoBook.now()];
  const days = weekDays(state.week);
  const events = Promise.resolve(sync).catch(console.error).then(() => readEvents(days));
  const read = await Promise.all([
    api.listTasks(days[0], days[6]),
    api.listBlocks(new Date(`${addDays(days[0], -1)}T00:00:00Z`).toISOString(), new Date(`${addDays(days[6], 2)}T00:00:00Z`).toISOString()),
    api.listDays(days[0], days[6]),
    api.parkedOn(state.today),
    api.settings(),
    api.listEventTodos(addDays(days[0], -1), addDays(days[6], 1)).catch((e) => { console.error(e); return []; }),
    api.listSleep(),
    api.listSleepTimes(),
    api.listSleepDays(addDays(days[0], -13), days[6]),
    api.listHorizon(now().day),
    api.listHorizonStates(),
    api.listActualsOn(now().day),
  ]);
  if (gen !== loadGen) return;
  const [tasks, blocks, dayList, parked, settings, todos, sleep, sleepTimes, sleepDays, horizon, states, actuals] = read;
  const json = JSON.stringify([days[0], now().day, read]);
  const same = quiet && json === lastRead;
  lastRead = json;
  // Nothing new: no redraw, but a new state.tasks all the same, so the modules that read their own
  // data once per load (projects, habits) read it again from reloadHooks.
  if (same) state.tasks = new Map(state.tasks);
  loadedAt = Date.now();
  loadedDay = now().day;
  if (!same) {
    state.actuals = actuals;
    state.horizon = horizon;
    state.states = new Map(states.map((h) => [h.task_id, h]));
    state.sleepTimes = sleepTimes;
    state.sleepDays = sleepDays;
    state.todos = todos;
    // What the page shows isn't just this read when saves or deletes were laid over it: the next
    // quiet reload compares against nothing, so it redraws.
    if (todoBook.keep(since[1])) lastRead = null;
    state.settings = settings;
    state.sleep = sleep;
    state.calendars = settings?.calendars ?? [];
    state.tasks = new Map(tasks.map((t) => [t.id, t]));
    if (taskBook.keep(since[0])) lastRead = null;
    state.blocks = blocks;
    state.days = Object.fromEntries(dayList.map((d) => [d.day, d]));
    state.parked = parked.length;
    loaded();
    if (eventsFor !== days[0]) { setEvents(cachedEvents(days)); eventsFor = days[0]; }
    render();
    if (scroll) scrollToToday($("[data-week]"));
    saveCopy();
  }
  // The stored copy is gone from the page: so is what the status line said about it.
  if (copy) {
    copy = false;
    if ([UPDATING, COPY_FAILED].includes($("[data-status]").textContent)) setStatus(null);
  }
  const got = await events;
  if (gen !== loadGen) return;
  const changed = got.stale !== state.eventsStale || JSON.stringify(got.all) !== JSON.stringify(state.todoEvents);
  useEvents(days, got);
  if (changed) render();
}

// --- Opening from the copy kept in this browser (snapshot.mjs) ---------------------------------

const UPDATING = "Updating…";
const COPY_FAILED = "Couldn't load the latest. This is the week as you last saw it.";
let copy = false; // the week on screen is the stored copy, until the first load draws

// The week's data as before anything is read: what a copy that can't be drawn leaves behind.
const blankWeek = () => ({ tasks: new Map(), blocks: [], days: {}, parked: 0, todos: [], horizon: [], states: new Map(),
  settings: null, calendars: [], sleep: [], sleepTimes: [], sleepDays: [], actuals: [], events: [], todoEvents: [] });

// Draws this week's stored copy for `user`, if there is one, marked "Updating…". True when it did. A copy
// that can't be drawn (a shape this code doesn't expect) is thrown away and the page loads as if
// there were none: the copy is only ever a placeholder.
// snapshot.mjs loads only once signed in (signed out, /plan carries none of it); start() asks for
// it first thing, so it is there by the time it is needed.
let snapshotModule = null;
const snapshot = () => (snapshotModule ??= import("./snapshot.mjs"));

async function showCopy(user, text = readCopy()) {
  let got = null;
  try { got = (await snapshot()).unpack(text, state.week, user); } catch {}
  if (!got) return false;
  try {
    Object.assign(state, got);
    setEvents(cachedEvents(weekDays(state.week)));
    eventsFor = state.week;
    copy = true;
    render();
    scrollToToday($("[data-week]"));
    setStatus(UPDATING);
    return true;
  } catch (e) {
    console.warn("Stored week not drawn", e);
    try { localStorage.removeItem(SNAPSHOT_KEY); } catch {}
    Object.assign(state, blankWeek());
    eventsFor = null;
    copy = false;
    setStatus(null);
    return false;
  }
}

const readCopy = () => { try { return localStorage.getItem(SNAPSHOT_KEY); } catch { return null; } };

// A copy whose token doesn't say who stored it, taken out of storage: it is drawn only once
// settings shows this account can open the planner, and the load stores it again.
function takeCopy() {
  const text = readCopy();
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch {}
  return text;
}

// Stores the week as just loaded; only this week's, the one /plan opens on.
function saveCopy() {
  if (state.week !== weekStart(now().day)) return;
  const user = api.userId();
  snapshot().then(({ pack }) => { try { localStorage.setItem(SNAPSHOT_KEY, pack(state, user)); } catch {} }, console.error);
}

// --- Coming back (research U8/P1) ----------------------------------------------------------

// Telegram taps (Done, Move, Tomorrow), replans and Claude's answers change tasks, blocks and
// Needs you while /plan sits in a background tab, and iOS Safari keeps the tab alive, so coming
// back shows an old plan. When the page is shown again (visibilitychange to visible; pageshow
// from the back/forward cache, https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event)
// or the network returns (online), the week reloads if the last load is over a minute old.
// Not mid-edit, mid-drag, while typing a task or with a dialog open: render() would drop what
// he is doing, and the next return catches up. Modules with their own data (Needs you) push a
// reload into reloadHooks.
const STALE_MS = 60_000;
let loadedAt = 0;
let loadedDay = null; // the owner's today at the last load (followToday)
export const reloadHooks = [];

async function refreshStale() {
  if (document.visibilityState !== "visible" || !state.week || Date.now() - loadedAt < STALE_MS) return;
  const a = document.activeElement;
  if (drag || document.querySelector("dialog[open]") || a?.matches?.(".sheet-edit") || (a?.matches?.(".sheet-add") && a.value)) return;
  loadedAt = Date.now();
  // Back the next day: today's view moves to the new today (glance.mjs, followToday).
  const moved = followToday({ week: state.week, focus: state.focus }, loadedDay, now().day);
  if (moved) Object.assign(state, moved);
  try { await load({ scroll: Boolean(moved), quiet: !moved }); } catch (e) { console.error(e); }
  for (const hook of reloadHooks) Promise.resolve().then(hook).catch(console.error);
}

// Oura: the week's day numbers and sleep again, redrawn only when something changed.
async function refreshOura() {
  if (document.visibilityState !== "visible" || !state.week) return;
  const days = weekDays(state.week);
  const [sleepDays, sleep] = await Promise.all([api.listSleepDays(addDays(days[0], -13), days[6]), api.listSleep()]);
  if (JSON.stringify([sleepDays, sleep]) === JSON.stringify([state.sleepDays, state.sleep])) return;
  state.sleepDays = sleepDays;
  state.sleep = sleep;
  render();
}

export const eventHooks = [];

// Without Google (no sign-in token and none from the server grant), the week shows the last copy
// of its events kept in this browser, and says so.
const EVENTS_KEY = "sheet.events.";

// Event to-dos also read "Time blocks", for the events a message made there; the week's other
// views leave it out unless he added it to his calendars.
function setEvents(all) {
  const tb = state.settings?.gcal_calendar_id;
  state.todoEvents = all;
  state.events = tb && !state.calendars.includes(tb) ? all.filter((e) => e.calendar !== tb) : all;
}

const cachedEvents = (days) => { try { return JSON.parse(localStorage.getItem(EVENTS_KEY + days[0])) ?? []; } catch { return []; } };

// The week's events from Google, and a copy kept; without Google, the kept copy, marked stale.
async function readEvents(days) {
  const tb = state.settings?.gcal_calendar_id;
  try {
    if (await api.ensureGoogle()) {
      const all = await api.calendarEvents(zonedIso(days[0], 0, SHEET.timeZone), zonedIso(addDays(days[6], 1), 0, SHEET.timeZone),
        tb && !state.calendars.includes(tb) ? [...state.calendars, tb] : state.calendars);
      try { localStorage.setItem(EVENTS_KEY + days[0], JSON.stringify(all)); } catch {}
      return { all, stale: false, fresh: true };
    }
  } catch (e) { console.error(e); }
  return { all: cachedEvents(days), stale: true, fresh: false };
}

function useEvents(days, got) {
  setEvents(got.all);
  state.eventsStale = got.stale;
  eventsFor = days[0];
  // Work that needs Google and runs after each load, in the background (busy times, events
  // for blocks approved off the page). A hook that fails never stops the page.
  // Pending deletes and moves first (syncGoogle), so a replan's old events go before its new
  // ones are added, on a refresh as well as on opening.
  if (got.fresh) syncGoogle().then(() => { for (const hook of eventHooks) Promise.resolve().then(hook).catch(console.error); });
}

async function loadEvents(days) { useEvents(days, await readEvents(days)); }

// A Done tap in Telegram shortens or deletes a block while the browser may be closed, and only
// the browser can edit Google: bring those events in line on opening. Without Google, they wait.
async function syncGoogle() {
  if (!(await api.ensureGoogle())) return;
  try {
    for (const p of await api.listGcalPending()) {
      await (p.ends_at ? api.patchEvent(p.gcal_id, api.eventTimes(null, p.ends_at)) : api.deleteEvent(p.gcal_id));
      await api.clearGcalPending(p.gcal_id);
    }
  } catch (e) { console.error(e); }
}

async function saveCalendars() {
  const ids = [...new Set($("#sheet-cal-ids").value.split(/\s+/).filter(Boolean))];
  try {
    await api.saveSettings({ calendars: ids });
    state.calendars = ids;
    $("[data-cal-ids-note]").textContent = "Saved.";
    await loadEvents(weekDays(state.week));
    render();
  } catch (e) { failed(e); }
}

// Settings (docs/sheet-sources.md, "/plan"): one dialog of sections (mail accounts, interest
// profile, feeds). Each module that owns a section pushes a function here that fills it; opening
// Settings shows the dialog, then runs them all at once, so no section waits on or depends on
// another, and the order they were added in doesn't matter.
export const settingsHooks = [];

// The sections only Settings needs are a module of their own (settings.mjs), loaded the first
// time Settings opens; start() gets the loader, and each section's setup runs once.
let settingsModule = () => Promise.resolve([]);
let settingsReady = null;
const loadSettings = () => (settingsReady ??= settingsModule().then((setups) => { for (const setup of setups) setup(root); }, (e) => { settingsReady = null; throw e; }));

// `section` is the group it opens at (research U12); settings-sections.mjs fills settingsNav.
export const settingsNav = { open: null, go: null };
async function openSettings(section = null) {
  try { await loadSettings(); } catch (e) { return failed(e); }
  if ($("[data-settings]").open) return settingsNav.go?.(section);
  $("[data-interests-note]").textContent = "";
  settingsNav.open?.(section);
  $("[data-settings]").showModal();
  await Promise.all(settingsHooks.map(async (fill) => { try { await fill(); } catch (e) { failed(e); } }));
  settingsNav.go?.(section);
}

// Settings, interest profile: what Claude picks campus events against (docs/sheet-claude.md).
// Blank saves null, so the column stays "not written yet" rather than an empty profile. Settings
// stays open, so the note beside Save says it worked.
settingsHooks.push(() => { $("#sheet-interests").value = state.settings?.interests ?? ""; });

async function saveInterests() {
  const interests = $("#sheet-interests").value.trim() || null;
  try {
    await api.saveSettings({ interests });
    state.settings = { ...state.settings, interests };
    $("[data-interests-note]").textContent = "Saved.";
  } catch (e) { failed(e); }
}

// Settings, completion sound (celebrate.mjs): a soft tick on each ✓, kept in this browser. Off
// until he turns it on.
const soundButton = () => $('[data-act="sound"]');
settingsHooks.push(() => soundButton()?.setAttribute("aria-pressed", String(cheer.soundOn())));
function toggleSound() {
  const on = !cheer.soundOn();
  cheer.setSound(on);
  soundButton().setAttribute("aria-pressed", String(on));
  if (on) cheer.tick();
}

// Settings, workload cap (v5 D2): the most hours of blocks Claude plans in a day, and the load
// bar's capacity. Hours from 1 to 16 in half hours; anything else says so and saves nothing.
settingsHooks.push(() => {
  $("#sheet-cap").value = String(workloadCap() / 60);
  $("[data-cap-note]").textContent = "";
});

async function saveCap() {
  const workload_cap_min = capMinutes($("#sheet-cap").value);
  if (workload_cap_min == null) return void ($("[data-cap-note]").textContent = "1 to 16 hours, in half hours.");
  try {
    await api.saveSettings({ workload_cap_min });
    state.settings = { ...state.settings, workload_cap_min };
    $("[data-cap-note]").textContent = "Saved.";
    render();
  } catch (e) { failed(e); }
}

// Telegram on or off. The "Time blocks" events from today on follow it: no alerts while Telegram
// nudges him, Google's default alert as the backup while it's off.
async function toggleTelegram() {
  const settings = { ...state.settings, nudges_on: !state.settings.nudges_on };
  try {
    await api.saveSettings({ nudges_on: settings.nudges_on });
    state.settings = settings;
    render();
    if (!api.googleReady()) return setStatus("Saved. Connect Google Calendar and switch again to change the blocks' alerts.");
    for (const b of await api.eventBlocksFrom(zonedIso(now().day, 0, SHEET.timeZone))) await api.patchEvent(b.gcal_id, api.eventReminders(settings));
  } catch (e) { failed(e); }
}

// Signing out leaves no copy of the week or its events in this browser.
function forgetEvents() {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(EVENTS_KEY) || k === SNAPSHOT_KEY) localStorage.removeItem(k); } catch {}
}

async function showWeek(monday) {
  state.week = monday;
  try { await load(); } catch (e) { failed(e); }
}

// --- Editing in place --------------------------------------------------------------------

function startEdit(li) {
  const t = state.tasks.get(li.dataset.id);
  const input = taskBox({ className: "sheet-add sheet-edit", value: t.title, ariaLabel: `Edit ${t.title}` });
  li.replaceChildren(input);
  fitBox(input);
  input.focus();
  input.select();
  let done = false;
  // The edit shows at once (patch saves in the background), then redraws again once saved.
  const finish = async (save) => {
    if (done) return;
    done = true;
    input.dataset.done = "";
    const text = input.value;
    const going = save && text.trim() !== t.title ? editTask(t.id, text) : null;
    render();
    try { await going; } catch (e) { failed(e, `save your edit to ${named(t)}`, () => editTask(t.id, text)); }
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

// --- The task menu -----------------------------------------------------------------------

let menuFor = null;

async function openMenu(id, anchor) {
  const menu = $("[data-menu]");
  menuFor = id;
  const t = state.tasks.get(id);
  menu.querySelector('[data-move="visibility"]').textContent = t.public ? "Make private" : "Make public";
  menu.querySelector('[data-move="clear-due"]').hidden = !t.due;
  // Where it could go: a task carried over twice or more leads with Tomorrow, Later this week,
  // Someday and Drop; the plain "To tomorrow" and "To Someday" step aside meanwhile.
  const triage = Boolean(t.day && !t.done && t.rolls >= 2);
  menu.querySelector("[data-triage]").hidden = !triage;
  // Its styles (calm-styles.mjs) are in before it shows, so it never flashes unstyled.
  if (triage) await import("./calm-styles.mjs").catch(console.error);
  menu.querySelector('[data-triage] [data-move="this-week"]').hidden = !laterThisWeek(now().day);
  for (const kind of ["tomorrow", "someday"]) menu.querySelector(`:scope > [data-move="${kind}"]`).hidden = triage;
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.right - 180, document.documentElement.clientWidth - 200))}px`;
  menu.showPopover();
  menu.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("button:not([hidden], [hidden] *)").focus();
}

// What each task action is, for the status line when it fails.
const ACTION_WORDS = { today: "move %s to today", tomorrow: "move %s to tomorrow", "next-week": "move %s to next week", "day-before": "move %s a day earlier",
  "day-after": "move %s a day later", "this-week": "move %s to later this week", someday: "move %s to Someday", drop: "drop %s", visibility: "change who sees %s", "clear-due": "clear the due date of %s", delete: "delete %s" };

async function menuAction(kind) {
  const id = menuFor;
  $("[data-menu]").hidePopover();
  if (!id) return;
  if (kind === "details") return import("./task-details-dialog.mjs").then((m) => m.openDetails(root, id), failed);
  await taskAction(id, kind);
  root.querySelector(`[data-id="${id}"] .sheet-title`)?.focus();
}

// One of the task menu's actions on a task (the menu, the week's keys, a swipe), then a redraw. A
// move shows at once (moveTask), so it resolves then, with the save running on; the others resolve
// once saved.
const MOVES = new Set(["today", "tomorrow", "next-week", "day-before", "day-after", "this-week", "someday", "drop"]);
export async function taskAction(id, kind) {
  const run = () => runAction(id, kind);
  const going = run().catch((e) => failed(e, ACTION_WORDS[kind]?.replace("%s", named(state.tasks.get(id))) ?? null, run)).then(() => render());
  render();
  if (!MOVES.has(kind)) await going;
}

async function runAction(id, kind) {
  const today = now().day;
  if (kind === "today") await moveTask(id, { day: today });
  if (kind === "tomorrow") await moveTask(id, { day: addDays(today, 1) });
  if (kind === "next-week") await moveTask(id, { day: addDays(weekStart(today), 7) });
  // One day either way from where it is now; a Someday task counts from today.
  if (kind === "day-before" || kind === "day-after") {
    await moveTask(id, { day: addDays(state.tasks.get(id).day ?? today, kind === "day-after" ? 1 : -1) });
  }
  if (kind === "this-week") await moveTask(id, { day: laterThisWeek(today) ?? addDays(today, 1) });
  if (kind === "someday") await moveTask(id, { list: "Inbox" });
  if (kind === "drop") await moveTask(id, { list: DROPPED });
  if (kind === "visibility") await toggleVisibility(id);
  if (kind === "clear-due") await clearDue(id);
  if (kind === "delete") await removeTask(id);
}

// --- Drag and drop -----------------------------------------------------------------------

// Pointer-based so it works on touch. Other modules (plan today) register drop targets.
export const dropTargets = [];
let drag = null;

function dropSpot(x, y, id) {
  const under = document.elementFromPoint(x, y);
  const ul = under?.closest(".sheet-rows");
  if (!ul || !root.contains(ul)) return null;
  const rows = [...ul.querySelectorAll(".sheet-task")].filter((r) => r.dataset.id !== id);
  const after = rows.find((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  const idx = after ? rows.indexOf(after) : rows.length;
  const pos = (r) => state.tasks.get(r.dataset.id).position;
  return {
    where: ul.dataset.day ? { day: ul.dataset.day } : { list: ul.dataset.list },
    position: positionBetween(idx > 0 ? pos(rows[idx - 1]) : null, after ? pos(after) : null),
    ul, before: after ?? null,
  };
}

// A finger swipe has to keep scrolling the page, so on touch a task is picked up by holding it
// still for a moment; after that, touchmove is cancelled so the browser doesn't scroll instead.
const HOLD_MS = 300;

function onPointerDown(e) {
  const li = e.target.closest(".sheet-task");
  if (!li || e.button !== 0 || e.target.closest("button:not(.sheet-title), input, textarea")) return;
  drag = { id: li.dataset.id, li, x: e.clientX, y: e.clientY, on: false, touch: e.pointerType !== "mouse", held: false };
  if (drag.touch) {
    const d = drag;
    d.timer = setTimeout(() => { d.held = true; d.li.classList.add("is-held"); }, HOLD_MS);
  }
}

function dropDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  drag.li.classList.remove("is-held");
  drag = null;
}

function onPointerMove(e) {
  if (!drag) return;
  if (!drag.on) {
    const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    // Moving before the hold finishes is a scroll, not a drag.
    if (drag.touch && !drag.held) { if (moved > 8) dropDrag(); return; }
    if (!drag.touch && moved < 5) return;
    drag.li.classList.remove("is-held");
    drag.on = true;
    drag.li.classList.add("is-ghost");
    drag.float = el("div", { className: "sheet-float", textContent: state.tasks.get(drag.id).title });
    document.body.append(drag.float);
    document.body.classList.add("sheet-dragging");
  }
  e.preventDefault();
  drag.float.style.transform = `translate(${e.clientX + 8}px, ${e.clientY + 8}px)`;
  root.querySelectorAll(".is-drop").forEach((n) => n.classList.remove("is-drop"));
  for (const t of dropTargets) if (t.over?.(e, drag)) return;
  dropSpot(e.clientX, e.clientY, drag.id)?.ul.classList.add("is-drop");
}

async function onPointerUp(e) {
  const d = drag;
  dropDrag();
  if (!d?.on) return;
  d.float.remove();
  document.body.classList.remove("sheet-dragging");
  d.li.classList.remove("is-ghost");
  root.querySelectorAll(".is-drop").forEach((n) => n.classList.remove("is-drop"));
  try {
    for (const t of dropTargets) if (await t.drop?.(e, d)) { render(); return; }
    const spot = dropSpot(e.clientX, e.clientY, d.id);
    if (spot) {
      const move = () => moveTask(d.id, spot.where, spot.position);
      const going = move();
      render(); // it shows where it was dropped at once
      try { await going; } catch (err) { failed(err, `move ${named(state.tasks.get(d.id))}`, move); }
    }
  } catch (err) { failed(err); }
  render();
}

// Clicks that follow a drag are not clicks.
const wasDrag = { at: 0 };

// --- Wiring ------------------------------------------------------------------------------

export const keyHooks = [];
export const actHooks = {};

function typing(e) {
  return e.target.closest?.("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey;
}

// --- Keys on a focused row (research U19) ----------------------------------------------------

// In the week, with a row focused: Space (on a task's title) or X completes it, D moves it to
// tomorrow, Z to Someday, E edits it, and J/K step to the next or previous row on screen. J or K
// with no row focused starts at the focused day's first row. Plan today keeps its own D and Z
// (plan-dialog.mjs); the document listener ignores keys while a dialog is open.
const rowFocus = (li) => li?.querySelector(li.classList.contains("sheet-task") ? ".sheet-title" : ".sheet-check");
const shownRows = () => [...root.querySelectorAll(".sheet-day .sheet-task, .sheet-day .sheet-evtodo, .sheet-list .sheet-task")].filter((r) => r.getClientRects().length);

// After a row moves away, focus stays at its place in its list: the row now there, else the last.
function refocus(list, index) {
  const ul = list.dataset.day ? root.querySelector(`.sheet-rows[data-day="${list.dataset.day}"]`) : root.querySelector(`.sheet-rows[data-list="${CSS.escape(list.dataset.list ?? "")}"]`);
  const rows = [...(ul?.querySelectorAll(".sheet-task, .sheet-evtodo") ?? [])];
  rowFocus(rows[Math.min(index, rows.length - 1)])?.focus();
}

function rowKey(e) {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.shiftKey && key !== "j" && key !== "k") return false;
  const li = document.activeElement?.closest?.(".sheet-task, .sheet-evtodo");
  if (key === "j" || key === "k") {
    const rows = shownRows();
    if (!rows.length) return false;
    const at = rows.indexOf(li);
    const next = at < 0 ? (root.querySelector(`.sheet-day[data-day="${state.focus}"] :is(.sheet-task, .sheet-evtodo)`) ?? rows[0])
      : rows[Math.max(0, Math.min(rows.length - 1, at + (key === "j" ? 1 : -1)))];
    e.preventDefault();
    rowFocus(next)?.focus();
    return true;
  }
  if (!li || !root.contains(li)) return false;
  if (li.classList.contains("sheet-evtodo")) {
    if (key !== "x") return false;
    e.preventDefault();
    toggleEventTodo(li, { quiet: true });
    return true;
  }
  const id = li.dataset.id;
  const kind = { x: "done", " ": "done", d: "tomorrow", z: "someday", e: "edit" }[key];
  if (!kind || (key === " " && !e.target.matches(".sheet-title"))) return false;
  e.preventDefault();
  if (kind === "edit") { startEdit(li); return true; }
  const list = li.closest(".sheet-rows");
  const index = [...list.querySelectorAll(".sheet-task, .sheet-evtodo")].indexOf(li);
  if (kind === "done") {
    checkOff(id, { li, quiet: true }).finally(() => focusAfter(id, ".sheet-title", list, index));
    return true;
  }
  taskAction(id, kind).then(() => refocus(list, index));
  return true;
}

function wire() {
  // Every dialog on /plan closes on a backdrop click, as its Close button does (dismiss.mjs).
  for (const d of root.querySelectorAll("dialog")) lightDismiss(d);
  root.addEventListener("click", async (e) => {
    if (Date.now() - wasDrag.at < 300) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act) {
      // A pick from the top bar's ⋯ menu closes it first.
      if (e.target.closest("[data-more]")) $("[data-more]").hidePopover();
      // The top bar's arrows step a week, or a day on phones (one day shows at a time).
      if (act === "prev" || act === "next") {
        if (!matchMedia(NARROW).matches) return showWeek(addDays(state.week, act === "prev" ? -7 : 7));
        const next = addDays(state.focus, act === "prev" ? -1 : 1);
        state.focus = next;
        if (weekStart(next) !== state.week) return showWeek(weekStart(next));
        return render();
      }
      if (act === "this-week") { state.focus = now().day; return showWeek(weekStart(state.focus)); }
      if (act === "help") return $("[data-help]").showModal();
      if (act === "undo") return undo();
      if (act === "sign-out") { api.signOut(); forgetEvents(); location.reload(); return; }
      if (act === "evtodo-done") return toggleEventTodo(e.target);
      if (act === "evtodo-more") return openEventMenu(e.target);
      if (act === "evtodo-open" || act === "evtodo-hide") return eventMenuAction(act);
      // The stale-events banner: the server grant (Settings, Calendar) is what keeps /plan's
      // Google token, so Reconnect goes straight to its consent screen.
      if (act === "connect") return openSettings("accounts").then(() => actHooks["cal-connect"]?.());
      if (act === "calendars") return openSettings("accounts").then(() => $("#sheet-cal-ids").focus({ preventScroll: true }));
      if (act === "save-calendars") return saveCalendars();
      if (act === "settings") return openSettings(e.target.closest("[data-act]").dataset.section ?? null);
      if (act === "oura-day") return import("./oura-popover.mjs").then((m) => m.openOuraDay(root, e.target.closest("[data-act]").dataset.day), failed);
      if (act === "close-oura-day") return $("[data-oura-day]").close();
      if (act === "oura-week") { $("[data-settings]").close(); return import("./oura-popover.mjs").then((m) => m.openOuraDay(root, state.today), failed); }
      if (act === "save-interests") return saveInterests();
      if (act === "save-cap") return saveCap();
      if (act === "sound") return toggleSound();
      if (act === "telegram") return toggleTelegram();
      return actHooks[act]?.(e);
    }
    const move = e.target.closest("[data-move]")?.dataset.move;
    if (move) return menuAction(move);
    const li = e.target.closest(".sheet-task");
    if (!li) {
      // Any empty row of a day types into that day.
      const ul = e.target.closest(".sheet-rows");
      if (ul && e.target.closest(".is-empty") && !e.target.closest(".sheet-add")) ul.querySelector(".sheet-add")?.focus();
      return;
    }
    const id = li.dataset.id;
    if (e.target.closest(".sheet-check")) {
      const list = li.closest(".sheet-rows");
      const index = list ? [...list.querySelectorAll(".sheet-task, .sheet-evtodo")].indexOf(li) : 0;
      await checkOff(id, { li });
      focusAfter(id, ".sheet-check", list, index);
    } else if (e.target.closest(".sheet-more")) openMenu(id, e.target.closest(".sheet-more"));
    else if (e.target.closest(".sheet-title")) startEdit(li);
  });

  root.addEventListener("contextmenu", (e) => {
    const li = e.target.closest(".sheet-task");
    if (li) { e.preventDefault(); if (!drag?.touch) openMenu(li.dataset.id, li); }
  });

  root.addEventListener("input", (e) => {
    if (!e.target.matches(".sheet-add:not(.sheet-newlist)")) return;
    typedChip(e.target);
    fitBox(e.target);
  });

  root.addEventListener("keydown", async (e) => {
    const input = e.target.closest(".sheet-add:not(.sheet-edit)");
    if (!input || e.key !== "Enter") return;
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    if (input.classList.contains("sheet-newlist")) {
      state.lists.add(text.trim());
      input.value = "";
      render();
      root.querySelector(`.sheet-add[data-list="${CSS.escape(text.trim())}"]`)?.focus();
      return;
    }
    input.value = "";
    fitBox(input);
    input.closest("li")?.querySelector(".sheet-typed")?.setAttribute("hidden", "");
    const where = input.dataset.day ? { day: input.dataset.day } : { list: input.dataset.list };
    const also = "also" in input.dataset;
    if (also) where.also = true;
    // The typed row shows at once (adding), and the box is free for the next task. On failure the
    // row goes, "Not added" shows by the box and the words go back in it if it's still empty;
    // Retry adds it and empties the box again. Also did… logs it already done, with Undo.
    const log = async () => {
      const ticket = undoTicket();
      const t = await addTask(text, where, also ? { done: true } : {});
      if (also && t) offerUndo(`Logged: ${t.title}`, async () => { await api.deleteTask(t.id); forgetTask(t.id); }, ticket);
    };
    const add = async () => { await log(); const box = addBox(where); if (box?.value === text) { box.value = ""; fitBox(box); } };
    const going = log();
    render();
    let lost = false;
    try { await going; } catch (err) { failed(err, `add "${parseEntry(text, state.today).title}"`, add); lost = true; }
    render();
    const box = lost ? addBox(where) : null;
    if (box && !box.value) { box.value = text; typedChip(box); fitBox(box); }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.target.closest?.("input, textarea")) { e.preventDefault(); undo(); return; }
    if (typing(e) || document.querySelector("dialog[open]")) return;
    if (rowKey(e)) return;
    if (e.key === "ArrowLeft") showWeek(addDays(state.week, -7));
    else if (e.key === "ArrowRight") showWeek(addDays(state.week, 7));
    else if (e.key === "t" || e.key === "T") showWeek(weekStart(now().day));
    else if (e.key === "?") $("[data-help]").showModal();
    else if (e.key === "s" || e.key === "S") openSettings();
    else if (e.key === ".") {
      const li = document.activeElement?.closest?.(".sheet-task");
      if (li) { e.preventDefault(); if (!drag?.touch) openMenu(li.dataset.id, li); }
    } else for (const hook of keyHooks) if (hook(e)) { e.preventDefault(); return; }
  });

  // Space on a focused title completes it (rowKey) instead of opening the edit box, which a
  // button does on keyup.
  document.addEventListener("keyup", (e) => { if (e.key === " " && e.target.matches?.(".sheet-task .sheet-title") && !document.querySelector("dialog[open]")) e.preventDefault(); });
  for (const menu of root.querySelectorAll(".sheet-menu")) menuKeys(menu);
  // Oura: oura-sync runs every 10 minutes, so today's chips refresh as often while /plan shows.
  setInterval(refreshOura, 10 * 60_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshOura(); });
  document.addEventListener("visibilitychange", refreshStale);
  window.addEventListener("pageshow", (e) => { if (e.persisted) refreshStale(); });
  window.addEventListener("online", refreshStale);
  root.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove, { passive: false });
  document.addEventListener("pointerup", (e) => { if (drag?.on) wasDrag.at = Date.now(); onPointerUp(e); });
  document.addEventListener("pointercancel", () => { if (drag?.on) { drag.float.remove(); drag.li.classList.remove("is-ghost"); document.body.classList.remove("sheet-dragging"); } dropDrag(); });
  document.addEventListener("touchmove", (e) => { if (drag?.held) e.preventDefault(); }, { passive: false });
}

// --- Start -------------------------------------------------------------------------------

// `plugins` (plan today, shutdown) each get the root once the planner is wired; `settings`
// loads Settings' own plugins on demand (openSettings).
export async function start(node, plugins = [], settings = settingsModule) {
  root = node;
  toast = root.querySelector("[data-toast]");
  settingsModule = settings;
  if (!api.configured) return setStatus("The planner is not set up yet.");
  api.takeRedirect();
  const signedIn = api.signedIn();
  // Signed in, the stored week (snapshot.mjs) is drawn first: its module starts loading now.
  signedIn.then((yes) => { if (yes) { snapshot().catch(() => {}); books().catch(() => {}); } });
  if (!(await signedIn)) {
    // Signed out (the button, or a session that ran out): no copy of the week stays behind.
    forgetEvents();
    const button = el("button", { type: "button", className: "sheet-btn primary", textContent: "Sign in with Google" });
    button.addEventListener("click", api.signIn);
    const status = $("[data-status]");
    status.hidden = false;
    status.replaceChildren("This is Lisul's planner. The public view is at ", el("a", { href: "/now/", textContent: "/now" }), ". ", button);
    return;
  }
  try { await books(); } catch (e) { return failed(e); }
  wire();
  for (const plugin of plugins) plugin(root);
  // Back from connecting mail or the calendar: those sections say how it went (mail-settings.mjs).
  if (/[?&](mail|calendar)=/.test(location.search)) loadSettings().catch(failed);
  state.today = now().day;
  state.week = weekStart(state.today);
  // The week as last seen, at once, while the first load runs (snapshot.mjs): only for the user
  // who stored it. When the token doesn't say who is signed in, not until settings has shown this
  // account can open the planner.
  const user = api.userId();
  const held = user ? null : takeCopy();
  let early = user ? await showCopy(user) : false;
  if (early) $("[data-tools]").hidden = false;
  try {
    const settings = await api.settings();
    if (!settings) {
      clearPage();
      setStatus("This account cannot open the planner.");
      $("[data-tools]").hidden = false;
      return;
    }
    if (!user) early = await showCopy(null, held);
    // The events' read starts with the tables', so it needs the calendars now.
    state.settings = settings;
    state.calendars = settings.calendars ?? [];
    $("[data-tools]").hidden = false;
    if (!early) setStatus(null);
    await load({ scroll: !early, sync: syncGoogle() });
    openFromLink();
  } catch (e) {
    if (!copy) return failed(e);
    console.error(e);
    setStatus(COPY_FAILED);
  }
}

// An account that can't open the planner sees none of it: no stored week, nothing drawn.
function clearPage() {
  forgetEvents();
  Object.assign(state, blankWeek());
  copy = false;
  for (const sel of ["[data-week]", "[data-someday]", "[data-log-list]", "[data-project-list]", "[data-habit-list]"]) root.querySelector(sel)?.replaceChildren();
  for (const sel of ["[data-log]", "[data-someday-title]", "[data-projects]", "[data-habit-rates]", "[data-notice]"]) { const n = root.querySelector(sel); if (n) n.hidden = true; }
  $("[data-week-title]").textContent = "Plan";
}

// A Telegram button's link opens its view (?open=plan|shutdown|needs, glance.mjs openView), once:
// the parameter comes off the address first, so a reload or Back doesn't open it again.
// https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState
function openFromLink() {
  const { view, search } = openView(location.search);
  if (search === location.search) return;
  history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
  if (view) actHooks[view]?.();
}
