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
import { addDays, byPosition, localNow, positionBetween, weekDays } from "./logic.mjs";
import { el, state, render, load, loadHooks, saveTask, savePending, afterFirstLoad, failed, progressHooks } from "./planner.mjs";
import { dayProgress } from "./progress.mjs";
import { habitDay } from "./habit-rate.mjs";
import { bedtimeFor, bedtimeMarker, tonight } from "./bedtime.mjs";
import { burst } from "./celebrate.mjs";
import * as lb from "./lookback-shutdown.mjs";
import { holdEscape } from "./dismiss.mjs";
import { choicesFor, closedLine, decisionChange, firstUp, rollsOnServer, targetOf, undecided, winLines, winsOf } from "./shutdown-close.mjs";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

const tz = SHEET.timeZone;
const FRESH_MS = 2 * 60_000; // a warm look-ahead this recent is used as it is
const EXTRAS_WAIT_MS = 8_000; // the look ahead counts as failed after this long
const WINS_FRESH_MS = 5_000; // wins read this recently (the opening tap's own press) aren't read again

let dialog;
let today;
let step = "today";   // today → tomorrow → closed
let reflection = "";
let decisions = new Map(); // task id → done | tomorrow | week | someday
let asked = false;    // Next or Finish was pressed with tasks still to place
let busy = false;
let session = 0;      // one per open, so a stale Finish can't draw over a new open
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
  // A read that hangs counts as failed after EXTRAS_WAIT_MS, so nothing waits on it for good; if it
  // lands later after all, its parts still fill in.
  r.extrasLate = new Promise((done) => setTimeout(() => { if (r.extrasOk == null) r.extrasOk = false; done(); }, EXTRAS_WAIT_MS));
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
let body;        // the dialog's content, replaced per step
let live;        // one live region for the whole dialog, never replaced: what changes is said there

// Said once through the live region (cleared first, so the same words are said again).
function announce(text) {
  live.textContent = "";
  setTimeout(() => { live.textContent = text; }, 50);
}
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
  body.replaceChildren(el("h2", { id: "sheet-shut-title", tabIndex: -1, textContent: "Shut down" }), parts.wins, parts.open, parts.late, box, parts.past, parts.end);
  fill(parts.wins, winsNodes());
  fill(parts.open, openNodes());
  fill(parts.late, lateNodes());
  syncOpen();
  fill(parts.past, pastNodes());
  fill(parts.end, endNodes());
}

// Tomorrow's look ahead; while it reads, a line; if it couldn't be read, what is known here (the
// tasks he is sending) and that Finish still works.
function tomorrowNodes() {
  const status = reads?.extrasOk;
  if (status === true) return lb.tomorrowPart(sentTomorrow(), () => fill(parts.tomorrow, tomorrowNodes()));
  if (status == null) return [el("p", { className: "small", textContent: "Reading tomorrow…" })];
  const going = sentTomorrow();
  return [
    el("p", { className: "small", textContent: "Tomorrow's calendar couldn't be read just now. Finish still closes the day." }),
    going.length ? el("h3", { textContent: "Moving to tomorrow" }) : null,
    going.length ? el("ul", { className: "sheet-shut-list" }, ...going.map((t) => el("li", { textContent: t.title }))) : null,
  ];
}

function buildTomorrow() {
  parts = { tomorrow: el("div", {}) };
  const back = el("button", { type: "button", className: "sheet-btn", textContent: "Back", onclick: () => { step = "today"; buildToday(); dialog.querySelector('[data-key="next"]')?.focus(); } });
  const done = el("button", { type: "button", className: "sheet-btn primary", textContent: "Finish", onclick: finish });
  done.dataset.key = "finish";
  body.replaceChildren(el("h2", { id: "sheet-shut-title", tabIndex: -1, textContent: "Tomorrow" }), parts.tomorrow, el("div", { className: "sheet-dialog-end" }, back, done));
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
  if (reads !== r || !dialog.open || busy) return; // while Finish saves, nothing redraws
  if (step === "today") { fill(parts.late, lateNodes()); fill(parts.past, pastNodes()); fill(parts.end, endNodes()); }
  if (step === "tomorrow") {
    fill(parts.tomorrow, tomorrowNodes());
    if (reads.extrasOk === false) announce("Tomorrow's calendar couldn't be read just now. Finish still closes the day.");
  }
};

// --- Acting -----------------------------------------------------------------------------------------

// Nothing moves on to tomorrow or to the end while a task has no place: the note says how many,
// and focus goes to the first one's choices.
function placed() {
  if (!undecided(openTasks(), decisions).length) return true;
  asked = true;
  if (step !== "today") { step = "today"; buildToday(); }
  syncOpen();
  const left = undecided(openTasks(), decisions).length;
  announce(`${left === 1 ? "1 task still needs" : `${left} tasks still need`} a place.`);
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
  const rolled = open.filter((t) => rollsOnServer(t, decisions.get(t.id), savePending(t.id)));
  // Every write runs to its end, so one failure doesn't leave the others mid-flight; then any
  // failure stops Finish before the day is shut down, and a second Finish retries what's left.
  // Each goes through the row's save queue (planner.mjs, saveTask): it shows at once and saves
  // after the row's earlier saves, with no Undo toast; one that fails puts its row back. A PATCH
  // that matched no row (the task gone elsewhere) is a failure too, and its row goes.
  const results = await Promise.allSettled(open.filter((t) => !rolled.includes(t)).map((t) => {
    const kind = decisions.get(t.id);
    const change = kind === "done" ? { done: true } : decisionChange(t, kind, today, end(targetOf(kind, today)));
    return saveTask(t.id, change).catch((e) => { throw e?.gone ? Object.assign(new Error(`"${t.title}" is gone`), { cause: e }) : e; });
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

// While Finish saves: every control is off (the box read-only), the dialog is aria-busy and Escape
// doesn't close it. Focus comes back to Finish if it fails.
function setBusy(on, label = null) {
  busy = on;
  if (on) dialog.setAttribute("aria-busy", "true"); else dialog.removeAttribute("aria-busy");
  for (const b of dialog.querySelectorAll("button")) b.disabled = on;
  if (box) box.readOnly = on;
  const go = dialog.querySelector('[data-key="finish"], [data-key="next"]');
  if (go && label) go.textContent = label;
}

// Finish: the decisions, then the day (rpc shut_down: the stamp, the reflection, today's
// unapproved proposals), then "Day closed" with a small burst from the button. The week is
// updated in place, so nothing waits on a reload; the server's copy follows behind. `session`
// ties it to this open: a Finish that lands after the dialog was closed and opened again changes
// the week but never draws over the new one.
async function finish(e) {
  if (busy || !placed()) return;
  const mine = session;
  const button = e?.currentTarget;
  const at = button?.getBoundingClientRect();
  const label = button?.textContent;
  setBusy(true, "Saving…");
  announce("Saving…");
  try {
    const rolled = await saveDecisions();
    const note = reflection.trim() || null;
    await api.shutDown(today, note);
    // The roll's moves, as the server made them (its positions come with the reload behind).
    for (const { t, change } of rolled) state.tasks.set(t.id, { ...t, ...change });
    state.days[today] = { ...(state.days[today] ?? { day: today, planned: false }), shutdown: true, reflection: note };
    hooks.closed?.(today);
    state.blocks = state.blocks.filter((b) => !(b.proposed && localNow(new Date(b.starts_at), tz).day === today));
    load({ scroll: false }).catch(console.error);
    if (mine !== session) return;
    setBusy(false);
    step = "closed";
    parts = {};
    body.replaceChildren(closedScreen());
    dialog.querySelector(".sheet-shut-closed .sheet-btn")?.focus();
    announce([...body.querySelectorAll(".sheet-shut-closed p")].map((p) => p.textContent).join(" "));
    if (at) burst(at, dialog);
  } catch (err) {
    if (mine !== session) return;
    setBusy(false, label);
    button?.focus();
    announce(`Not saved yet: ${err.message}. Finish tries again.`);
    failed(err);
  }
}

// The day's tasks when it isn't the week on screen (after midnight on a Monday, or another week
// open): read into the planner's state, which the dialog reads, before it builds.
async function readDay(day) {
  const [tasks, days] = await Promise.all([api.rest(`tasks?day=eq.${day}&order=position`), api.rest(`days?day=eq.${day}`)]);
  for (const t of tasks) state.tasks.set(t.id, t);
  if (days[0]) state.days[day] = days[0];
}

const offWeek = (day) => state.week && !weekDays(state.week).includes(day);

function showReading() {
  parts = {};
  body.replaceChildren(el("h2", { id: "sheet-shut-title", tabIndex: -1, textContent: "Shut down" }), el("p", { className: "small", textContent: "Reading the day…" }));
}

// A first load that failed (or the day's own read): say so, with Retry. Resolves true on Retry,
// false when the dialog closes instead.
function askRetry() {
  return new Promise((done) => {
    const retry = el("button", { type: "button", className: "sheet-btn primary", textContent: "Retry", onclick: () => { dialog.removeEventListener("close", gone); done(true); } });
    const cancel = el("button", { type: "button", className: "sheet-btn", textContent: "Cancel", onclick: () => dialog.close() });
    const gone = () => done(false);
    dialog.addEventListener("close", gone, { once: true });
    parts = {};
    body.replaceChildren(el("h2", { id: "sheet-shut-title", tabIndex: -1, textContent: "Shut down" }),
      el("p", { textContent: "Couldn't load the latest. Shutdown needs today's tasks as they are now." }),
      el("div", { className: "sheet-dialog-end" }, cancel, retry));
    retry.focus();
    announce("Couldn't load the latest. Retry?");
  });
}

// Waits for the planner's first real load (planner.mjs, afterFirstLoad, which rejects when that
// load fails) and reads a day off the week on screen. On a failure it offers Retry, which loads
// again. True once the rows are fresh; false when he closes it or a newer open took over.
async function freshRows(day, mine) {
  let again = false;
  for (;;) {
    // A retry's load starts first: starting clears the last failure, so the wait is for it.
    if (again && !loadedOnce) load({ scroll: false }).catch(console.error);
    const wait = afterFirstLoad();
    try {
      await wait;
      if (offWeek(day)) await readDay(day);
      return true;
    } catch (e) {
      console.error(e);
      if (mine !== session || !dialog.open) return false;
      if (!(await askRetry()) || mine !== session) return false;
      again = true;
      showReading();
      dialog.querySelector("#sheet-shut-title")?.focus();
    }
  }
}

export async function open(day) {
  const mine = ++session;
  busy = false;
  dialog.removeAttribute("aria-busy");
  today = day;
  step = "today";
  decisions = new Map();
  asked = false;
  shown = new Set();
  drawnWins = false;
  const r = prefetch(today);
  if (Date.now() - r.winsAt > WINS_FRESH_MS) readWins(r);
  // It opens on fresh rows: before the first load lands (the stored copy on screen, snapshot.mjs)
  // it waits for it; and a day off the week on screen is read first.
  if (!loadedOnce || offWeek(day)) {
    showReading();
    dialog.showModal();
    dialog.querySelector("#sheet-shut-title")?.focus();
    if (!(await freshRows(day, mine)) || mine !== session || !dialog.open) return;
  }
  reflection = state.days[today]?.reflection ?? "";
  box = el("textarea", { className: "sheet-reflect", rows: 2, value: reflection, ariaLabel: "What went well, what got in the way? (optional)", placeholder: "What went well, what got in the way? (optional)" });
  box.dataset.key = "reflect";
  box.addEventListener("input", () => { reflection = box.value; });
  r.wins.then(landed(r));
  r.extras.then(landed(r));
  r.extrasLate.then(landed(r));
  buildToday();
  if (!dialog.open) dialog.showModal();
  // The heading, not a choice: a screen reader starts at the top, and no answer is preselected.
  dialog.querySelector("#sheet-shut-title")?.focus();
}

let hooks = {};
let loadedOnce = false; // the planner's first real load has landed

// `closed(day)` tells shutdown.mjs a day was shut down (for the button off the week on screen).
export function setupView(root, given = {}) {
  hooks = given;
  // Landed already (this module loads late), or later: a fresh load after a failed one counts too.
  afterFirstLoad().then(() => { loadedOnce = true; }, () => {});
  loadHooks.push(({ copy }) => { if (!copy) loadedOnce = true; });
  dialog = root.querySelector("[data-shut]");
  body = el("div", {});
  live = el("p", { className: "visually-hidden", role: "status" });
  dialog.replaceChildren(body, live);
  dialog.addEventListener("click", (e) => {
    const b = e.target.closest(".sheet-shut-choice");
    if (b) choose(b.dataset.id, b.dataset.kind);
  });
  holdEscape(dialog, () => busy);
  dialog.addEventListener("close", () => { session++; render(); });
}
