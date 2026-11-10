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

const todays = () => [...state.tasks.values()].filter((t) => t.day === today).sort(byPosition);
const openTasks = () => todays().filter((t) => !t.done);
const sentTomorrow = () => openTasks().filter((t) => decisions.get(t.id) === "tomorrow");
const extrasReady = () => reads?.extrasOk === true;

function winsSection() {
  const w = reads?.winsData;
  const focused = dayProgress(state.tasks.values(), today, progressHooks.focused?.() ?? state.actuals).focused;
  const lines = winLines(winsOf({ tasks: state.tasks.values(), today, tz, focused, workouts: w?.workouts ?? [], habits: w?.habits ?? [] }));
  const items = lines.map((l) => {
    const li = el("li", { className: drawnWins && !shown.has(l.key) ? "is-new" : "" }, l.text, l.detail ? el("span", { className: "sheet-meta", textContent: l.detail }) : null);
    shown.add(l.key);
    return li;
  });
  if (!w) items.push(el("li", { className: "is-reading", textContent: "Checking Hevy and habits" }));
  drawnWins = true;
  return el("section", { className: "sheet-shut-wins-part" },
    el("h3", { textContent: "Today's wins" }),
    items.length ? el("ul", { className: "sheet-shut-wins", role: "list" }, ...items) : el("p", { className: "sheet-shut-quiet", textContent: "Nothing logged today. Closing the day still counts." }));
}

function taskRow(t, choices) {
  const pick = decisions.get(t.id);
  return el("li", { className: `sheet-shut-task${asked && !pick ? " is-asked" : ""}` },
    el("p", { textContent: t.title }),
    el("div", { className: "sheet-shut-choices", role: "group", ariaLabel: `Where ${t.title} goes` }, ...choices.map((c) => {
      const b = el("button", { type: "button", className: "sheet-shut-choice", textContent: c.label });
      b.setAttribute("aria-pressed", String(pick === c.kind));
      b.dataset.key = `${t.id}|${c.kind}`;
      b.dataset.id = t.id;
      b.dataset.kind = c.kind;
      return b;
    })));
}

function openSection() {
  const open = openTasks();
  if (!open.length) return el("p", { className: "sheet-shut-quiet", textContent: "Nothing left open today." });
  const left = undecided(open, decisions).length;
  const choices = choicesFor(today);
  // Two or more still to place: one more tap sends the rest to tomorrow.
  const rest = left >= 2 ? el("button", { type: "button", className: "sheet-link sheet-shut-rest", textContent: "Rest to tomorrow", onclick: restToTomorrow }) : null;
  if (rest) rest.dataset.key = "rest";
  return el("section", {},
    el("h3", { textContent: `Still open (${open.length})` }),
    el("p", { className: "small" }, "One tap each: where does it go?", rest),
    el("ul", { className: "sheet-shut-open" }, ...open.map((t) => taskRow(t, choices))),
    asked && left ? el("p", { className: "sheet-shut-ask", role: "status", textContent: `${left === 1 ? "1 task still needs" : `${left} tasks still need`} a place.` }) : null);
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
    el("form", { method: "dialog", className: "sheet-dialog-end" }, el("button", { type: "submit", className: "sheet-btn primary", textContent: "Close", autofocus: true })));
}

// Every redraw replaces the dialog; focus and the reflection's caret come back to the same place.
function draw() {
  const a = document.activeElement;
  const key = dialog.contains(a) ? a?.dataset?.key : null;
  const caret = key === "reflect" ? [a.selectionStart, a.selectionEnd] : null;
  if (step === "closed") dialog.replaceChildren(closedScreen());
  else if (step === "tomorrow") {
    const status = reads?.extrasOk;
    dialog.replaceChildren(...[
      el("h2", { id: "sheet-shut-title", textContent: "Tomorrow" }),
      ...(status === true ? lb.tomorrowPart(sentTomorrow(), draw) : [el("p", { className: "small", role: "status", textContent: "Reading tomorrow…" })]),
      el("div", { className: "sheet-dialog-end" },
        el("button", { type: "button", className: "sheet-btn", textContent: "Back", onclick: () => { step = "today"; draw(); } }),
        el("button", { type: "button", className: "sheet-btn primary", textContent: "Finish", onclick: finish })),
    ].filter(Boolean));
  } else {
    const box = el("textarea", { className: "sheet-reflect", rows: 2, value: reflection, ariaLabel: "What went well, what got in the way? (optional)", placeholder: "What went well, what got in the way? (optional)" });
    box.dataset.key = "reflect";
    box.addEventListener("input", () => { reflection = box.value; });
    // Tomorrow comes next unless the look ahead couldn't be read.
    const next = reads?.extrasOk === false
      ? el("button", { type: "button", className: "sheet-btn primary", textContent: "Finish", onclick: finish })
      : el("button", { type: "button", className: "sheet-btn primary", textContent: "Next: tomorrow", onclick: toTomorrow });
    next.dataset.key = "next";
    dialog.replaceChildren(...[
      el("h2", { id: "sheet-shut-title", textContent: "Shut down" }),
      winsSection(),
      ...(extrasReady() ? lb.todayPart(sentTomorrow().length, draw) : []),
      openSection(),
      box,
      extrasReady() ? lb.pastPart() : null,
      el("div", { className: "sheet-dialog-end" },
        el("button", { type: "button", className: "sheet-btn", textContent: "Cancel", onclick: () => dialog.close() }),
        next),
    ].filter(Boolean));
  }
  const back = key ? dialog.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
  if (back) {
    back.focus();
    if (caret) back.setSelectionRange(...caret);
  }
}

const redraw = (r) => () => { if (reads === r && dialog.open && step !== "closed") draw(); };

// --- Acting -----------------------------------------------------------------------------------------

// Nothing moves on to tomorrow or to the end while a task has no place: the note says how many,
// and focus goes to the first one's choices.
function placed() {
  if (!undecided(openTasks(), decisions).length) return true;
  asked = true;
  step = "today";
  draw();
  const first = dialog.querySelector(".sheet-shut-task.is-asked .sheet-shut-choice");
  first?.focus();
  first?.scrollIntoView({ block: "center" });
  return false;
}

function toTomorrow() {
  if (!placed()) return;
  step = "tomorrow";
  draw();
  dialog.scrollTop = 0;
}

function restToTomorrow() {
  for (const t of undecided(openTasks(), decisions)) decisions.set(t.id, "tomorrow");
  draw();
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
    draw();
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
  const r = prefetch(today);
  if (Date.now() - r.winsAt > WINS_FRESH_MS) readWins(r);
  r.wins.then(redraw(r));
  r.extras.then(redraw(r));
  draw();
  dialog.showModal();
  dialog.querySelector(".sheet-shut-choice, [data-key='next']")?.focus();
}

export function setupView(root) {
  dialog = root.querySelector("[data-shut]");
  dialog.addEventListener("click", (e) => {
    const b = e.target.closest(".sheet-shut-choice");
    if (!b) return;
    decisions.set(b.dataset.id, b.dataset.kind);
    draw();
  });
  dialog.addEventListener("close", () => render());
}
