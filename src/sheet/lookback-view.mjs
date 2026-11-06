// The look-back on screen (docs/sheet-lookback.md): the history it reads, the "Last week" dialog,
// the estimate hint and the prompt for tasks that keep moving. Loaded only with Plan today's
// dialog or Shutdown, so /plan's first-load script stays small. Text goes in through textContent.
// Reads are select=* on tasks, so the page works before and after done_at exists.
// Its styles come with it, as text added on load (Vite's ?inline:
// https://vite.dev/guide/features#disabling-css-injection-into-the-page), so /plan's first load
// carries no rules it doesn't use (Lighthouse's unused-css-rules gate).
import css from "../styles/sheet-lookback.css?inline";
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { addDays, formatMinutes, localNow, weekStart, weekdayName, zonedIso } from "./logic.mjs";
import { paceByKind } from "./pace.mjs";
import { lightDismiss } from "./dismiss.mjs";
import { el, state, render, addTask, moveTask, failed, workloadCap } from "./planner.mjs";
import { callLine, callLookback, dueLine, dueLookback, keepsMoving, weekLine, weekReview, weekTitle } from "./lookback.mjs";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

const tz = SHEET.timeZone;
const today = () => localNow(new Date(), tz).day;
const QUIET_KEY = "sheet.lookback.quiet";
const QUIET_DAYS = 7;

let cached = null; // { day, promise }, one read a day

async function read(day) {
  const monday = weekStart(day);
  const from = addDays(monday, -14);
  const since = addDays(day, -28);
  const quiet = (p, fallback = []) => p.catch((e) => { console.error(e); return fallback; });
  const [blocks, days, feedback, due, moving, calls, actuals] = await Promise.all([
    quiet(api.listBlocks(zonedIso(from, 0, tz), zonedIso(monday, 0, tz))),
    quiet(api.listDays(addDays(monday, -7), addDays(monday, -1))),
    quiet(api.rest(`feedback?select=at,action,ref&item=eq.finished&at=gte.${zonedIso(from, 0, tz)}&order=at`)),
    quiet(api.rest(`tasks?due=gte.${since}&due=lt.${day}`)),
    quiet(api.rest(`tasks?done=is.false&or=(rolls.gte.2,parked_on.gte.${addDays(day, -14)})`)),
    // Absent until the look-back's SQL is applied.
    quiet(api.rest(`horizon_calls?select=task_id,due,state&due=lt.${day}&state=eq.on_track`)),
    quiet(api.listActuals()),
  ]);
  const ids = [...new Set([...blocks.map((b) => b.task_id), ...calls.map((c) => c.task_id)].filter(Boolean))];
  const known = new Map([...due, ...moving].map((t) => [t.id, t]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) for (const t of await quiet(api.rest(`tasks?id=in.(${missing.join(",")})`))) known.set(t.id, t);
  const tasks = [...known.values()];
  const week = weekReview({ blocks, tasks, feedback, days, cap: workloadCap(), today: day, timeZone: tz });
  const dueBack = dueLookback({ tasks: due, today: day, timeZone: tz });
  const held = callLookback({ calls, tasks, today: day, timeZone: tz });
  return {
    day, feedback, actuals, week, due: dueBack, held,
    paces: paceByKind(actuals),
    moving: moving.filter((t) => keepsMoving(t, feedback, day, tz)),
  };
}

// The history, read once a day; null when it can't be read, so the dialogs still open.
export function history() {
  const day = today();
  if (cached?.day !== day) cached = { day, promise: read(day).catch((e) => { console.error(e); cached = null; return null; }) };
  return cached.promise;
}

// --- The "Last week" dialog ----------------------------------------------------------------

// A day's bars: planned as an outline, done as a fill in one colour whatever the day was, and the
// cap as a faint tick. The label says it in words.
function dayBars(d, scale) {
  const pct = (m) => `${Math.min(100, (m / scale) * 100)}%`;
  const planned = el("span", { className: "sheet-back-planned" });
  planned.style.width = pct(d.planned_min);
  const done = el("span", { className: "sheet-back-done" });
  done.style.width = pct(d.done_min);
  const cap = el("span", { className: "sheet-back-cap" });
  cap.style.left = pct(d.cap_min);
  const words = d.planned_min ? `${formatMinutes(d.done_min)} of ${formatMinutes(d.planned_min)}` : "nothing planned";
  return el("li", { className: "sheet-back-day", ariaLabel: `${weekdayName(d.day)}: ${words}` },
    el("span", { className: "sheet-back-label", textContent: weekdayName(d.day), ariaHidden: "true" }),
    el("span", { className: "sheet-back-track", ariaHidden: "true" }, planned, done, cap),
    el("span", { className: "sheet-meta", textContent: d.planned_min ? words : "", ariaHidden: "true" }));
}

function weekSection(w) {
  const scale = Math.max(...w.days.map((d) => Math.max(d.planned_min, d.cap_min)), 1);
  const notes = [
    w.moved && `Moved to another day: ${w.moved} ${w.moved === 1 ? "task" : "tasks"}`,
    w.nostart && `Didn't start: ${w.nostart} ${w.nostart === 1 ? "block" : "blocks"}`,
  ].filter(Boolean);
  return [
    el("p", { className: "small", textContent: weekTitle(w) }),
    el("p", { className: "sheet-back-line", textContent: weekLine(w) }),
    el("ul", { className: "sheet-back-days" }, ...w.days.map((d) => dayBars(d, scale))),
    notes.length ? el("p", { className: "small", textContent: notes.join(" · ") }) : null,
    w.done_min < w.planned_min ? el("p", { className: "small", textContent: "To plan less this week, lower the daily cap in Settings." }) : null,
    w.reflections.length ? el("h3", { textContent: "What you wrote" }) : null,
    w.reflections.length ? el("ul", { className: "sheet-back-notes" }, ...w.reflections.map((r) => el("li", {}, el("strong", { textContent: `${r.weekday} ` }), r.text))) : null,
  ];
}

let dialog = null;
function draw(h, onchange) {
  const movers = h.moving.filter(notQuiet);
  const again = () => { draw(h, onchange); onchange?.(); };
  dialog.replaceChildren(...[
    el("h2", { id: "sheet-back-title", textContent: "Last week" }),
    ...(h.week ? weekSection(h.week) : []),
    h.due || h.held ? el("h3", { textContent: "Due dates" }) : null,
    h.due ? el("p", { className: "small", textContent: dueLine(h.due) }) : null,
    h.held ? el("p", { className: "small", textContent: callLine(h.held) }) : null,
    movers.length ? el("h3", { textContent: "Kept moving" }) : null,
    movers.length ? moverPrompts(movers, h.day, again) : null,
    el("form", { method: "dialog", className: "sheet-dialog-end" }, el("button", { type: "submit", className: "sheet-btn primary", textContent: "Close" })),
  ].filter(Boolean));
}

function openDialog(h, onchange) {
  if (!dialog) {
    dialog = el("dialog", { className: "sheet-dialog sheet-back" });
    dialog.setAttribute("aria-labelledby", "sheet-back-title");
    document.querySelector(".sheet-planner").append(dialog);
    lightDismiss(dialog);
  }
  draw(h, onchange);
  dialog.showModal();
}

// Plan today's way in, or null when no section passes its gate. On Monday it carries the week's
// line, since a week start is when it helps; other days it is a quiet link. Kept moving alone
// doesn't open it: those tasks already get their prompt where they sit.
export function lookbackEntry(h, onchange) {
  if (!h || !(h.week || h.due || h.held)) return null;
  const monday = weekStart(h.day) === h.day;
  return el("p", { className: "small sheet-back-entry" },
    monday && h.week ? `Last week: ${weekLine(h.week)}. ` : null,
    el("button", { type: "button", className: "sheet-link", textContent: monday && h.week ? "See the week" : "Last week", onclick: () => openDialog(h, onchange) }));
}

// --- Tasks that keep moving ----------------------------------------------------------------

function quietMap() {
  try { return JSON.parse(localStorage.getItem(QUIET_KEY)) ?? {}; } catch { return {}; }
}
function notQuiet(t) {
  const until = quietMap()[t.id];
  return !until || until <= today();
}
function setQuiet(id) {
  const map = Object.fromEntries(Object.entries(quietMap()).filter(([, until]) => until > today()));
  map[id] = addDays(today(), QUIET_DAYS);
  try { localStorage.setItem(QUIET_KEY, JSON.stringify(map)); } catch {}
}

// Make sure a task from outside the week on screen can be moved (moveTask reads state.tasks).
const known = (t) => { if (!state.tasks.has(t.id)) state.tasks.set(t.id, t); };

// One prompt: an if-then time, a smaller first part, or Someday (research I5; Gollwitzer &
// Sheeran 2006). It gives no count and no verdict. `day` is the day a time or first part lands on.
function moverPrompt(t, day, onchange) {
  known(t);
  const act = (what, fn) => async (e) => {
    e?.preventDefault();
    try { await fn(); render(); onchange(); } catch (err) { failed(err, what, () => act(what, fn)()); }
  };
  const extra = el("form", { className: "sheet-mover-form", hidden: true });
  const ask = (build, what, submit) => () => {
    const input = build();
    extra.replaceChildren(el("label", { className: "small" }, what, input), el("button", { type: "submit", className: "sheet-btn", textContent: "Save" }));
    extra.hidden = false;
    extra.onsubmit = act(`save "${t.title}"`, () => submit(input.value));
    input.focus();
  };
  const giveTime = ask(() => el("input", { type: "time", required: true, className: "sheet-mover-input" }), "Time ", async (time) => {
    if (t.day !== day) await moveTask(t.id, { day });
    const saved = await api.updateTask(t.id, { day, list: null, at_time: time });
    state.tasks.set(t.id, saved);
  });
  const split = ask(() => el("input", { type: "text", required: true, maxLength: 200, className: "sheet-mover-input", value: `${t.title}: first part` }), "First part ", (text) => addTask(text, { day }));
  const buttons = [
    el("button", { type: "button", className: "sheet-btn", textContent: "Give it a time", onclick: giveTime }),
    el("button", { type: "button", className: "sheet-btn", textContent: "Split it", onclick: split }),
    t.day ? el("button", { type: "button", className: "sheet-btn", textContent: "Move to Someday", onclick: act(`move "${t.title}"`, () => moveTask(t.id, { list: "Inbox" })) }) : null,
    el("button", { type: "button", className: "sheet-link", textContent: "Not now", onclick: () => { setQuiet(t.id); onchange(); } }),
  ];
  return el("li", { className: "sheet-mover" },
    el("p", {}, el("strong", { textContent: t.title }), " keeps moving. What would make it easier to start?"),
    el("div", { className: "sheet-mover-acts" }, ...buttons),
    extra);
}

// The prompts for these tasks, or null when none is left after "Not now".
export function moverPrompts(tasks, day, onchange) {
  const shown = tasks.filter(notQuiet);
  return shown.length ? el("ul", { className: "sheet-movers" }, ...shown.map((t) => moverPrompt(t, t.day && t.day >= day ? t.day : day, onchange))) : null;
}

