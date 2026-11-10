// Shutdown on screen (docs/sheet.md, "Shutdown"): today's wins, filled in from what is logged; one
// tap for where each unfinished task goes; an optional reflection; tomorrow; then "Day closed",
// which hands over to the wind-down line. Loaded on demand (shutdown.mjs warms it on hover, focus
// and idle once the Shut down button shows), so /plan's first load carries none of it.
//
// It opens at once from what the week already holds and fills in as its reads land: Hevy and the
// habits for the wins, and the look back and ahead (lookback-shutdown.mjs). Finish saves the
// decisions and the day, updates the week in place and shows "Day closed" without waiting on a
// reload; the server's copy is read behind it.
import css from "../styles/sheet-shutdown.css?inline";
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { addDays, byPosition, localNow, positionBetween } from "./logic.mjs";
import { el, state, render, load, completeTask, dropBlocks, failed, progressHooks } from "./planner.mjs";
import { dayProgress } from "./progress.mjs";
import { habitDay } from "./habit-rate.mjs";
import { bedtimeFor, bedtimeMarker, tonight } from "./bedtime.mjs";
import { burst } from "./celebrate.mjs";
import * as lb from "./lookback-shutdown.mjs";
import { choicesFor, closedLine, decisionChange, firstUp, rollsOnServer, targetOf, undecided, winLines, winsOf } from "./shutdown-close.mjs";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

const tz = SHEET.timeZone;
const FRESH_MS = 2 * 60_000; // a warm look-ahead this recent is used as it is
const WINS_FRESH_MS = 5_000; // wins read this recently (the opening tap's own press) aren't read again

let dialog;
let today;
let step = "today";   // today → tomorrow → closed
let reflection = "";
let decisions = new Map(); // task id → done | tomorrow | week | someday
let asked = false;    // Next or Finish was pressed with tasks still to place
let busy = false;
let reads = null;     // { day, at, wins, extras }, with { winsData, extrasOk } once each lands
let shown = new Set(); // wins line keys already drawn, so only ones that land later fade in
let drawnWins = false;

// --- Reads ----------------------------------------------------------------------------------------

const quiet = (p) => p.catch((e) => { console.error(e); return []; });

// The wins' own reads: today's Hevy workouts and the habits ticked today. Each lands on its own; a
// read that fails leaves its part out.
function readWins(r) {
  r.winsAt = Date.now();
  const mine = r.winsGen = (r.winsGen ?? 0) + 1;
  r.winsData = null;
  r.wins = Promise.all([
    quiet(api.rest(`hevy_workouts?select=id,title,starts_at,ends_at&day=eq.${r.day}&order=starts_at`)),
    quiet(api.rest(`habit_done?select=habit_id&day=eq.${habitDay(new Date(), tz)}`)),
    quiet(api.rest("habits?select=id,name&order=position,created_at")),
  ]).then(([workouts, ticks, habits]) => {
    const ticked = new Set(ticks.map((t) => t.habit_id));
    const data = { workouts, habits: habits.filter((h) => ticked.has(h.id)).map((h) => h.name) };
    if (r.winsGen === mine) r.winsData = data; // an older read landing late is dropped
  });
  return r.wins;
}

// Warm-up (shutdown.mjs): the wins and the look back and ahead. A warm look-ahead under two
// minutes old is used as it is; the wins are read again on every open (WINS_FRESH_MS covers the
// read the same tap's press started), since a workout or a habit can land at any minute.
export function prefetch(day) {
  if (reads?.day === day && Date.now() - reads.at < FRESH_MS) return reads;
  const r = { day, at: Date.now(), winsData: null, extrasOk: null };
  readWins(r);
  // A prepare a newer one overtook leaves its own reads object stale; only `reads` is drawn.
  r.extras = lb.prepare(day).then((latest) => { if (latest) r.extrasOk = true; }, (e) => { console.error(e); r.extrasOk = false; });
  reads = r;
  return r;
}

// --- What it shows ---------------------------------------------------------------------------------
// The step is built once when it shows; after that each part is filled in place (fill), so a read
// that lands or a tap never replaces the reflection box or the button that has focus. Everything
// that can arrive late sits below the open tasks.

const todays = () => [...state.tasks.values()].filter((t) => t.day === today).sort(byPosition);
const openTasks = () => todays().filter((t) => !t.done);
const sentTomorrow = () => openTasks().filter((t) => decisions.get(t.id) === "tomorrow");
const extrasReady = () => reads?.extrasOk === true;

let parts = {}; // the step's hosts: wins, open, late, past, end, tomorrow
let box = null;  // the reflection box, one per open

// A host's content replaced; focus inside it comes back to the same place (by key, else by order).
function fill(host, nodes) {
  if (!host) return;
  const a = document.activeElement;
  const inside = host.contains(a) ? a : null;
  const key = inside?.dataset?.key;
  const index = inside ? [...host.querySelectorAll("button, a, input, summary")].indexOf(inside) : -1;
  host.replaceChildren(...nodes.filter(Boolean));
  if (!inside) return;
  const back = (key && host.querySelector(`[data-key="${CSS.escape(key)}"]`)) || host.querySelectorAll("button, a, input, summary")[index];
  back?.focus();
}

// What the week already holds (tasks, focus, GitHub, Jira) shows at the top and never changes
// while the dialog is open. What a read brings (Hevy, the habits) and the look-back's parts land
// below the open tasks, so nothing above a choice moves while he taps (lateNodes).
const isLate = (l) => l.key.startsWith("lift-") || l.key === "habits";

function winLinesNow() {
  const w = reads?.winsData;
  const focused = dayProgress(state.tasks.values(), today, progressHooks.focused?.() ?? state.actuals).focused;
  return winLines(winsOf({ tasks: state.tasks.values(), today, tz, focused, workouts: w?.workouts ?? [], habits: w?.habits ?? [] }));
}

const winItem = (l) => {
  const li = el("li", { className: drawnWins && !shown.has(l.key) ? "is-new" : "" }, l.text, l.detail ? el("span", { className: "sheet-meta", textContent: l.detail }) : null);
  shown.add(l.key);
  return li;
};

function winsNodes() {
  const items = winLinesNow().filter((l) => !isLate(l)).map(winItem);
  return [
    el("h3", { textContent: "Today's wins" }),
    items.length ? el("ul", { className: "sheet-shut-wins", role: "list" }, ...items) : el("p", { className: "sheet-shut-quiet", textContent: "Nothing ticked off today. Closing the day still counts." }),
  ];
}

function taskRow(t, choices) {
  return el("li", { className: "sheet-shut-task" },
    el("p", { textContent: t.title }),
    el("div", { className: "sheet-shut-choices", role: "group", ariaLabel: `Where ${t.title} goes` }, ...choices.map((c) => {
      const b = el("button", { type: "button", className: "sheet-shut-choice", textContent: c.label });
      b.dataset.key = `${t.id}|${c.kind}`;
      b.dataset.id = t.id;
      b.dataset.kind = c.kind;
      return b;
    })));
}

// The open tasks are drawn once; a tap only changes what is pressed (syncOpen).
function openNodes() {
  const open = openTasks();
  if (!open.length) return [el("p", { className: "sheet-shut-quiet", textContent: "Nothing left open today." })];
  const choices = choicesFor(today);
  // Two or more still to place: one more tap sends the rest to tomorrow.
  const rest = el("button", { type: "button", className: "sheet-link sheet-shut-rest", textContent: "Rest to tomorrow", onclick: restToTomorrow });
  rest.dataset.key = "rest";
  return [
    el("h3", { textContent: `Still open (${open.length})` }),
    el("p", { className: "small" }, "One tap each: where does it go?", rest),
    el("ul", { className: "sheet-shut-open" }, ...open.map((t) => taskRow(t, choices))),
    el("p", { className: "sheet-shut-ask", hidden: true }),
  ];
}

function syncOpen() {
  const host = parts.open;
  if (!host) return;
  const left = undecided(openTasks(), decisions).length;
  for (const li of host.querySelectorAll(".sheet-shut-task")) {
    const id = li.querySelector(".sheet-shut-choice")?.dataset.id;
    const pick = decisions.get(id);
    li.classList.toggle("is-asked", asked && !pick);
    for (const b of li.querySelectorAll(".sheet-shut-choice")) b.setAttribute("aria-pressed", String(pick === b.dataset.kind));
  }
  const rest = host.querySelector(".sheet-shut-rest");
  if (rest) rest.hidden = left < 2;
  const ask = host.querySelector(".sheet-shut-ask");
  if (ask) {
    ask.hidden = !(asked && left);
    ask.textContent = asked && left ? `${left === 1 ? "1 task still needs" : `${left} tasks still need`} a place.` : "";
  }
}

// Late parts, below the open tasks: the wins a read brings, today's events and the day's line;
// and the earlier reflections under the box.
function lateNodes() {
  const items = winLinesNow().filter(isLate).map(winItem);
  if (!reads?.winsData) items.push(el("li", { className: "is-reading", textContent: "Checking Hevy and habits" }));
  drawnWins = true;
  return [
    items.length ? el("h3", { textContent: "Also today" }) : null,
    items.length ? el("ul", { className: "sheet-shut-wins", role: "list" }, ...items) : null,
    ...(extrasReady() ? lb.todayPart(sentTomorrow().length, () => fill(parts.late, lateNodes())) : []),
  ];
}
const pastNodes = () => [extrasReady() ? lb.pastPart() : null];

// Tomorrow comes next unless the look ahead couldn't be read.
function endNodes() {
  const next = reads?.extrasOk === false
    ? el("button", { type: "button", className: "sheet-btn primary", textContent: "Finish", onclick: finish })
    : el("button", { type: "button", className: "sheet-btn primary", textContent: "Next: tomorrow", onclick: toTomorrow });
  next.dataset.key = "next";
  const cancel = el("button", { type: "button", className: "sheet-btn", textContent: "Cancel", onclick: () => dialog.close() });
  cancel.dataset.key = "cancel";
  return [cancel, next];
}

function buildToday() {
  parts = {
    wins: el("section", { className: "sheet-shut-wins-part" }),
    late: el("div", {}),
    open: el("section", {}),
    past: el("div", {}),
    end: el("div", { className: "sheet-dialog-end" }),
  };
  dialog.replaceChildren(el("h2", { id: "sheet-shut-title", textContent: "Shut down" }), parts.wins, parts.open, parts.late, box, parts.past, parts.end);
  fill(parts.wins, winsNodes());
  fill(parts.open, openNodes());
  fill(parts.late, lateNodes());
  syncOpen();
  fill(parts.past, pastNodes());
  fill(parts.end, endNodes());
}

function tomorrowNodes() {
  return reads?.extrasOk === true ? lb.tomorrowPart(sentTomorrow(), () => fill(parts.tomorrow, tomorrowNodes()))
    : [el("p", { className: "small", textContent: "Reading tomorrow…" })];
}

function buildTomorrow() {
  parts = { tomorrow: el("div", {}) };
  const back = el("button", { type: "button", className: "sheet-btn", textContent: "Back", onclick: () => { step = "today"; buildToday(); dialog.querySelector('[data-key="next"]')?.focus(); } });
  const done = el("button", { type: "button", className: "sheet-btn primary", textContent: "Finish", onclick: finish });
  done.dataset.key = "finish";
  dialog.replaceChildren(el("h2", { id: "sheet-shut-title", textContent: "Tomorrow" }), parts.tomorrow, el("div", { className: "sheet-dialog-end" }, back, done));
  fill(parts.tomorrow, tomorrowNodes());
}

function closedScreen() {
  const tomorrow = addDays(today, 1);
  const byId = new Map(lb.tomorrowTasks().map((t) => [t.id, t]));
  for (const t of state.tasks.values()) byId.set(t.id, t);
  const next = firstUp([...byId.values()].filter((t) => t.day === tomorrow));
  const b = bedtimeFor(tonight(new Date(), tz), { settings: state.settings, sleep: state.sleep, sleepTimes: state.sleepTimes, tz });
  const line = closedLine(decisions);
  return el("div", { className: "sheet-shut-closed" },
    el("h2", { id: "sheet-shut-title", textContent: "Day closed" }),
    line ? el("p", { textContent: line }) : null,
    el("p", { className: "sheet-shut-next", textContent: next ? `Tomorrow starts with ${next}.` : "Tomorrow is open." }),
    // The week's wind-down line (planner.mjs, windDownMark), as what comes next tonight.
    b ? el("p", { className: "sheet-winddown", textContent: `Next: ${bedtimeMarker(b)}` }) : el("p", { className: "small", textContent: "Nothing else tonight." }),
    el("form", { method: "dialog", className: "sheet-dialog-end" }, el("button", { type: "submit", className: "sheet-btn primary", textContent: "Close" })));
}

// A read landed: fill what it feeds, in place.
const landed = (r) => () => {
  if (reads !== r || !dialog.open) return;
  if (step === "today") { fill(parts.late, lateNodes()); fill(parts.past, pastNodes()); fill(parts.end, endNodes()); }
  if (step === "tomorrow") fill(parts.tomorrow, tomorrowNodes());
};

// --- Acting -----------------------------------------------------------------------------------------

// Nothing moves on to tomorrow or to the end while a task has no place: the note says how many,
// and focus goes to the first one's choices.
function placed() {
  if (!undecided(openTasks(), decisions).length) return true;
  asked = true;
  if (step !== "today") { step = "today"; buildToday(); }
  syncOpen();
  const first = dialog.querySelector(".sheet-shut-task.is-asked .sheet-shut-choice");
  first?.focus();
  first?.scrollIntoView({ block: "center" });
  return false;
}

function toTomorrow() {
  if (!placed()) return;
  step = "tomorrow";
  buildTomorrow();
  dialog.scrollTop = 0;
  dialog.querySelector('[data-key="finish"]')?.focus();
}

function choose(id, kind) {
  decisions.set(id, kind);
  syncOpen();
  fill(parts.late, lateNodes()); // the line counts what moves to tomorrow
}

function restToTomorrow() {
  for (const t of undecided(openTasks(), decisions)) decisions.set(t.id, "tomorrow");
  syncOpen();
  fill(parts.late, lateNodes());
  dialog.querySelector('[data-key="next"]')?.focus();
}

// Each decision saved, side by side, except a plain Tomorrow, which shut_down's roll makes in the
// same request as the day (rollsOnServer). Moves land at the end of where they go. Returns the
// tasks left for the roll.
async function saveDecisions() {
  const tomorrow = addDays(today, 1);
  const last = new Map();
  const end = (where) => {
    const key = where.day ?? `list:${where.list}`;
    if (!last.has(key)) {
      const sibs = where.day
        ? [...state.tasks.values(), ...(where.day === tomorrow ? lb.tomorrowTasks() : [])].filter((t) => t.day === where.day)
        : [...state.tasks.values()].filter((t) => t.day == null && t.list === where.list);
      last.set(key, sibs.length ? Math.max(...sibs.map((t) => t.position)) : null);
    }
    const p = positionBetween(last.get(key), null);
    last.set(key, p);
    return p;
  };
  const open = openTasks();
  const rolled = open.filter((t) => rollsOnServer(t, decisions.get(t.id)));
  // Every write runs to its end, so one failure doesn't leave the others mid-flight; then any
  // failure stops Finish before the day is shut down, and a second Finish retries what's left.
  const results = await Promise.allSettled(open.filter((t) => !rolled.includes(t)).map(async (t) => {
    const kind = decisions.get(t.id);
    // A PATCH that matched no row (the task gone, or row-level security) saved nothing: a failure.
    const gone = () => new Error(`"${t.title}" wasn't found to save`);
    if (kind === "done") {
      await completeTask(t.id, true);
      if (!state.tasks.get(t.id)) { state.tasks.set(t.id, t); throw gone(); }
      return;
    }
    const where = targetOf(kind, today);
    const change = decisionChange(t, kind, today, end(where));
    if (where.day !== t.day) await dropBlocks(t.id);
    const saved = await api.updateTask(t.id, change);
    if (!saved) throw gone();
    state.tasks.set(t.id, saved);
  }));
  const refused = results.filter((x) => x.status === "rejected");
  if (refused.length) {
    for (const f of refused) console.error(f.reason);
    const err = new Error(`${refused.length} of ${results.length} changes didn't save: ${refused[0].reason?.message ?? refused[0].reason}`);
    err.cause = refused[0].reason;
    throw err;
  }
  return rolled.map((t) => ({ t, change: decisionChange(t, "tomorrow", today, end({ day: tomorrow })) }));
}

// Finish: the decisions, then the day (rpc shut_down: the stamp, the reflection, today's
// unapproved proposals), then "Day closed" with a small burst from the button. The week is
// updated in place, so nothing waits on a reload; the server's copy follows behind.
async function finish(e) {
  if (busy || !placed()) return;
  const at = e?.currentTarget?.getBoundingClientRect();
  busy = true;
  try {
    const rolled = await saveDecisions();
    const note = reflection.trim() || null;
    await api.shutDown(today, note);
    // The roll's moves, as the server made them (its positions come with the reload behind).
    for (const { t, change } of rolled) state.tasks.set(t.id, { ...t, ...change });
    state.days[today] = { ...(state.days[today] ?? { day: today, planned: false }), shutdown: true, reflection: note };
    state.blocks = state.blocks.filter((b) => !(b.proposed && localNow(new Date(b.starts_at), tz).day === today));
    step = "closed";
    parts = {};
    dialog.replaceChildren(closedScreen());
    dialog.querySelector(".sheet-shut-closed .sheet-btn")?.focus();
    if (at) burst(at, dialog);
    load({ scroll: false }).catch(console.error);
  } catch (err) { failed(err); } finally { busy = false; }
}

export function open(day) {
  today = day;
  step = "today";
  reflection = state.days[today]?.reflection ?? "";
  decisions = new Map();
  asked = false;
  shown = new Set();
  drawnWins = false;
  box = el("textarea", { className: "sheet-reflect", rows: 2, value: reflection, ariaLabel: "What went well, what got in the way? (optional)", placeholder: "What went well, what got in the way? (optional)" });
  box.dataset.key = "reflect";
  box.addEventListener("input", () => { reflection = box.value; });
  const r = prefetch(today);
  if (Date.now() - r.winsAt > WINS_FRESH_MS) readWins(r);
  r.wins.then(landed(r));
  r.extras.then(landed(r));
  buildToday();
  dialog.showModal();
  dialog.querySelector(".sheet-shut-choice, [data-key='next']")?.focus();
}

export function setupView(root) {
  dialog = root.querySelector("[data-shut]");
  dialog.addEventListener("click", (e) => {
    const b = e.target.closest(".sheet-shut-choice");
    if (b) choose(b.dataset.id, b.dataset.kind);
  });
  dialog.addEventListener("close", () => render());
}
