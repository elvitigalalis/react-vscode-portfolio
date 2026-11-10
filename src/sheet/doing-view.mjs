// The phone's Doing view (docs/sheet.md, "On the phone"): one card for what to do now (the task a
// focus is running on, the row on now, else the next), with Start (or Resume) into focus mode and
// ✓, a small ring of the time left, the two after it, Reflow rest of today when the day has
// slipped, and the week one tap away. During his day it is what a phone opens to, instead of the
// week's crowded today (Now/Next, load bar, strip, Oura, progress, wind-down); his pick of Doing or
// the week holds for the day. Phones only (under 48 rem): plan/index.astro loads it there, after
// the first load. Logic is in doing.mjs. Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import { formatClock, formatSpan, localNow } from "./logic.mjs";
import { doingPick, doingMode, minutesLeft } from "./doing.mjs";
import { focusClock } from "./focus.mjs";
import { rowTitle } from "./now-next.mjs";
import { el, icon, state, render, renderHooks, loadHooks, actHooks, rowsOn, checkOff, toggleEventTodo, windowOn, shutdownAt, NARROW } from "./planner.mjs";
import { getSession, openFocus, progressFor, audioContext } from "./focus-start.mjs";
import { reflowLine } from "./reflow-view.mjs";
import "./doing-styles.mjs";

const KEY = "sheet.doing";
const tz = SHEET.timeZone;
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const keep = (mode) => { try { localStorage.setItem(KEY, JSON.stringify({ day: state.today, mode })); } catch {} };

let root, box;
// The view in use; null until the first draw after each load of the week (the first, and each
// reload on coming back or changing week), so the default is chosen then and never flips under
// him mid-use. His day runs from
// when it opens (planner.mjs windowOn: after his wake, not held to now) to the shutdown line.
let mode = null;
let loaded = false;

const SVG = "http://www.w3.org/2000/svg";
function ring(share) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "sheet-doing-ring");
  for (const cls of ["sheet-doing-track", "sheet-doing-arc"]) {
    const c = document.createElementNS(SVG, "circle");
    for (const [k, v] of Object.entries({ cx: 20, cy: 20, r: 17, pathLength: 1, class: cls })) c.setAttribute(k, String(v));
    svg.append(c);
  }
  svg.lastChild.style.strokeDashoffset = share.toFixed(4);
  return svg;
}

// The approved block Start goes on for a task: today's first that hasn't ended.
function startBlock(taskId) {
  const t = Date.now();
  return state.blocks.filter((b) => b.task_id === taskId && !b.proposed && Date.parse(b.ends_at) > t
    && localNow(new Date(b.starts_at), tz).day === state.today).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0] ?? null;
}

const span = (r) => (r.start == null ? null : formatSpan(r.start, r.end));

// How long is left, as a ring share and in words: the focus session's, or the row on now's.
function timeLeft(pick, minutes, s) {
  const r = pick.card;
  if (pick.kind === "focus") {
    const c = focusClock(s, new Date());
    return { share: c.share, words: c.over ? "over" : `${minutesLeft(s.ends_at - Date.now())} left` };
  }
  if (pick.kind === "now") return { share: (minutes - r.start) / (r.end - r.start), words: `${minutesLeft((r.end - minutes) * 60_000)} left` };
  return null;
}
// Which card is drawn ("now:task:t2"), so the timer can update it in place while it stays the same.
const cardKey = (pick) => (pick.card ? `${pick.kind}:${pick.card.kind}:${pick.card.task?.id ?? pick.card.key}` : "none");
let drawnKey = null;

function card(pick, minutes, s) {
  const r = pick.card;
  const title = rowTitle(r);
  const task = r.kind === "task" ? r.task : null;
  const left = timeLeft(pick, minutes, s);
  const kicker = { focus: "Focusing", now: `Now · until ${formatClock(r.end)}`, next: `Next · ${span(r)}`, untimed: "Up next" }[pick.kind];
  const b = task ? state.blocks.find((x) => x.id === (s?.task_id === task.id ? s.block_id : startBlock(task.id)?.id)) : null;
  const note = task ? progressFor(task.id)?.note : null;
  const sub = b?.first_step ? `First: ${b.first_step}` : note ? `Where you left off: ${note}` : task?.est_min && !span(r) ? `About ${task.est_min} min` : null;

  const actions = el("div", { className: "sheet-doing-actions" });
  if (task && b) {
    const go = el("button", { type: "button", className: "sheet-btn primary sheet-doing-start", textContent: s?.task_id === task.id ? "Resume" : "Start" });
    go.dataset.act = "doing-start";
    go.dataset.block = b.id;
    actions.append(go);
  }
  const done = el("button", { type: "button", className: "sheet-check sheet-doing-done", ariaLabel: `Complete ${title}` }, icon("check"), el("span", { textContent: "Done" }));
  done.dataset.act = "doing-done";
  if (task) done.dataset.task = task.id;
  else Object.assign(done.dataset, { key: r.key, day: state.today });
  actions.append(done);

  const node = el("div", { className: "sheet-doing-card" },
    el("p", { className: "sheet-doing-kicker", textContent: kicker }),
    el("div", { className: "sheet-doing-head" },
      left ? el("span", { className: "sheet-doing-dial" }, ring(left.share)) : null,
      el("h2", { id: "sheet-doing-title", className: "sheet-doing-title", textContent: title })),
    left ? el("p", { className: "sheet-doing-left", textContent: left.words }) : null,
    sub ? el("p", { className: "sheet-doing-sub", textContent: sub }) : null,
    actions,
    reflowLine());
  if (task) node.dataset.task = task.id;
  return node;
}

function draw() {
  if (!state.week || !box) return;
  const minutes = localNow(new Date(), tz).minutes;
  const s = getSession();
  const pick = doingPick(rowsOn(state.today), minutes, s?.task_id ?? null);
  drawnKey = cardKey(pick);
  // Not before the week has loaded: a draw before then has no rows.
  if (mode == null && loaded) {
    mode = doingMode({ stored: read(), today: state.today, minutes, dayStart: windowOn(state.today).from, shutdown: shutdownAt(state.today), shutDown: Boolean(state.days[state.today]?.shutdown), hasCard: Boolean(pick.card) });
  }
  const doing = mode === "doing" && matchMedia(NARROW).matches;
  root.classList.toggle("is-doing", doing);
  box.hidden = !doing;
  // Hidden, it holds nothing: no stray title or button for lookups by id or class to find.
  if (!doing) { box.replaceChildren(); drawnKey = null; }
  if (doing) {
    const then = pick.next.map((r) => el("li", {}, el("span", { className: "sheet-doing-when", textContent: span(r) ?? "" }), el("span", { textContent: rowTitle(r) })));
    const week = el("button", { type: "button", className: "sheet-btn sheet-doing-week", textContent: "See the week" });
    week.dataset.act = "doing-week";
    box.replaceChildren(
      pick.card ? card(pick, minutes, s) : el("div", { className: "sheet-doing-card" },
        el("h2", { id: "sheet-doing-title", className: "sheet-doing-title", textContent: "Nothing left on today's list" }), reflowLine()),
      then.length ? el("div", { className: "sheet-doing-then" }, el("h3", { textContent: "Then" }), el("ul", {}, ...then)) : null,
      week);
  }
  // Back to Doing from the week's today, on a phone only: a wider screen has no Doing view.
  if (!doing && pick.card && matchMedia(NARROW).matches) {
    const back = el("button", { type: "button", className: "sheet-link sheet-doing-back", textContent: "Doing view" });
    back.dataset.act = "doing-view";
    root.querySelector(`.sheet-day[data-day="${state.today}"].is-focus .sheet-stamps-row`)?.prepend(back);
  }
}

function tickCard() {
  const minutes = localNow(new Date(), tz).minutes;
  const s = getSession();
  const pick = doingPick(rowsOn(state.today), minutes, s?.task_id ?? null);
  if (cardKey(pick) !== drawnKey) return draw();
  const left = timeLeft(pick, minutes, s);
  if (!left) return;
  const arc = box.querySelector(".sheet-doing-arc");
  const words = box.querySelector(".sheet-doing-left");
  if (arc) arc.style.strokeDashoffset = left.share.toFixed(4);
  if (words && words.textContent !== left.words) words.textContent = left.words;
}

function show(next) {
  mode = next;
  keep(next);
  render();
  if (next === "doing") box.querySelector(".sheet-doing-start, .sheet-doing-done")?.focus();
  else root.querySelector(`.sheet-day[data-day="${state.today}"] .sheet-head`)?.scrollIntoView({ block: "nearest" });
}

export function setupDoing(node) {
  root = node;
  box = el("section", { className: "sheet-doing", hidden: true });
  box.setAttribute("aria-labelledby", "sheet-doing-title");
  root.querySelector("[data-week]").before(box);
  renderHooks.push(draw);
  actHooks["doing-week"] = () => show("week");
  actHooks["doing-view"] = () => show("doing");
  actHooks["doing-start"] = (e) => {
    // Inside the tap, so the focus view's chimes can play on iOS (focus-start.mjs).
    audioContext();
    return openFocus(e.target.closest("[data-block]").dataset.block).catch(console.error);
  };
  actHooks["doing-done"] = (e) => {
    const b = e.target.closest("[data-act]");
    return b.dataset.key ? toggleEventTodo(b) : checkOff(b.dataset.task, { li: b.closest(".sheet-doing-card"), from: b });
  };
  // The top bar's day arrows and day button go to the week, as he'd expect from them.
  root.addEventListener("click", (e) => {
    if (mode === "doing" && e.target.closest('[data-act="prev"], [data-act="next"], [data-act="this-week"]')) { mode = "week"; keep("week"); }
  }, true);
  // Each load chooses again (his pick for today still wins), as the time of day may have moved.
  loadHooks.push(() => { loaded = true; mode = null; });
  // The ring and "25 min left" move on while the card shows, in place, so focus and a screen
  // reader's place stay put; only a change of card draws it again.
  setInterval(() => { if (mode === "doing" && !document.hidden && !document.querySelector("dialog[open]")) tickCard(); }, 15_000);
  // Wider than a phone (turned sideways, a resized window): the week.
  matchMedia(NARROW).addEventListener("change", () => render());
  // Loaded already, when this module came in late.
  if (state.settings) { loaded = true; render(); }
}
