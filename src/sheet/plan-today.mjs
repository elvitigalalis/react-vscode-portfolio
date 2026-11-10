// Plan today (docs/sheet.md): today's tasks beside a timeline with Lisul's Google events in gray.
// Dropping a task makes a block as tall as its estimate, written to the "Time blocks" calendar;
// resizing a block writes its length back to the estimate. A load meter keeps the day honest.
// Blocks Claude proposed show dashed until approved (docs/sheet-nudges.md).
// This module is the part the week needs on load; the dialog itself is plan-dialog.mjs, loaded
// the first time Plan today opens.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { localNow, minutesOn, load, snap, formatMinutes, formatClock, formatSpan, byPosition, proposedOn, googleStep, weekdayName, addDays, zonedIso } from "./logic.mjs";
import { el, icon, state, render, keyHooks, actHooks, renderHooks, eventHooks, failed, dayCapacity, dayStart, workloadCap, shutdownAt, windowOn, spanOf, taskAction } from "./planner.mjs";
import { loadShare, stripSegments, plannedLeft, overCommit } from "./glance.mjs";

// The timeline's window in minutes past midnight. It follows the day being planned (setWindow,
// planner.mjs windowOn): from his wake to an hour past shutdown, no longer fixed at 7 am–11 pm.
// `let` exports are live bindings, so plan-dialog.mjs always reads the current window.
let START = 7 * 60;
let END = 23 * 60;
export const setWindow = ({ from, to }) => { START = from; END = to; };
const PX = 1.2; // pixels per minute
const y = (min) => (min - START) * PX;
const minuteAt = (clientY, box) => Math.max(START, Math.min(END - 15, snap(START + (clientY - box.top) / PX)));
const clock = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export { START, END, PX, y, minuteAt, clock };

let dialog;
let planDialog = null; // plan-dialog.mjs, once Plan today has opened

export const tasksOn = (d) => [...state.tasks.values()].filter((t) => t.day === d).sort(byPosition);
export const blocksOn = (d) => state.blocks.filter((b) => minutesOn(b.starts_at, d, SHEET.timeZone) >= 0 && minutesOn(b.starts_at, d, SHEET.timeZone) < 1440);
// The day's shutdown line in minutes (planner.mjs), kept exported here for its old importers.
export { shutdownAt };

// A day's load as a 4px bar on a track (docs/sheet-glance.md, change 4).
function loadBar(d) {
  const { pct, level } = loadShare(load(tasksOn(d), dayCapacity(d).capacity).total, dayCapacity(d).capacity);
  const fill = el("span", { className: `sheet-meter-fill is-${level}` });
  fill.style.width = `${pct}%`;
  return el("span", { className: "sheet-meter" }, fill);
}

// Over-commit (docs/sheet.md, "Over-commit note"): when day `d` holds more than the free time
// left before its shutdown, one calm line says so, "Planned 9h · about 6h free", with a link that
// opens (`open`) a list of its undone untimed tasks; a tap moves one to the next day. It warns and
// never blocks. Past the day's shutdown, or once the day is shut down, there is nothing to say. `toggle` flips `open`; `where` names the note ("week", "dialog") so focus can
// find it again after a redraw. Null when the day isn't over.
// The toggle keeps focus, as a disclosure button does; after a move, the next task in the list.
// A move that makes the plan fit takes the note away: the Undo toast says "Plan fits now." and
// takes focus, else (the move failed) the day's heading does.
const refocus = (where, pick = false) => {
  const box = document.querySelector(`[data-over="${where}"]`);
  if (box) return ((pick && box.querySelector(".sheet-over-pick button")) || box.querySelector(".sheet-link"))?.focus();
  if (!pick) return;
  const toast = document.querySelector("[data-toast]");
  if (toast && !toast.hidden) {
    const text = toast.querySelector("[data-toast-text]");
    text.textContent = `${text.textContent} Plan fits now.`;
    return toast.querySelector('[data-act="undo"]')?.focus();
  }
  const head = document.querySelector(where === "dialog" ? "#sheet-plan-title" : ".sheet-day.is-today .sheet-head");
  head?.setAttribute("tabindex", "-1");
  head?.focus();
};
let styled = false;
let styling = null;
const calmStyles = () => (styling ??= import("./calm-styles.mjs").catch(console.error).then(() => { styled = true; }));
export function overNote(d, open, toggle, where) {
  const shut = Date.parse(zonedIso(d, shutdownAt(d), SHEET.timeZone));
  if (state.days[d]?.shutdown || Date.now() >= shut) return null;
  const { free, capacity } = dayCapacity(d);
  const o = overCommit(plannedLeft(tasksOn(d), blocksOn(d), Date.now(), shut), capacity);
  if (!o) return null;
  // Its styles load the first time it shows (calm-styles.mjs); it draws once they are in, so it
  // never shows unstyled.
  if (!calmReady()) return null;
  const next = d === state.today ? "tomorrow" : weekdayName(addDays(d, 1));
  const link = el("button", { type: "button", className: "sheet-link", textContent: `Move some to ${next}` });
  link.setAttribute("aria-expanded", String(open));
  link.onclick = () => { toggle(); refocus(where); };
  // The room is the free time, or the workload cap when that is less ("room for about 8h").
  const room = !o.room ? "no free time left before shutdown" : capacity < free ? `room for about ${formatMinutes(o.room)}` : `about ${formatMinutes(o.room)} free`;
  const line = el("p", { className: "sheet-over" }, `Planned ${formatMinutes(o.planned)} · ${room} · `, link);
  const out = open ? el("div", { className: "sheet-over-wrap" }, line) : line;
  out.dataset.over = where;
  if (open) out.append(movePicker(d, where));
  return out;
}

// The list under a note: day `d`'s undone untimed tasks, each a button that moves it a day on.
// `where` is the note's data-over name, for focus after a move. Also used by the readiness
// note (readiness-note.mjs).
export function movePicker(d, where) {
  const next = d === state.today ? "tomorrow" : weekdayName(addDays(d, 1));
  const picks = tasksOn(d).filter((t) => !t.done && !spanOf(t)).map((t) => {
    const b = el("button", { type: "button", ariaLabel: `Move ${t.title} to ${next}` },
      el("span", { textContent: t.title }), t.est_min ? el("span", { className: "sheet-meta", textContent: formatMinutes(t.est_min) }) : null);
    b.onclick = () => taskAction(t.id, "day-after").then(() => refocus(where, true));
    return el("li", {}, b);
  });
  return picks.length ? el("ul", { className: "sheet-over-pick" }, ...picks) : el("p", { className: "sheet-over", textContent: "Nothing untimed left to move." });
}

// True once the calm styles (sheet-calm.css) are in; until then it loads them, redraws, and
// says false, so a note never shows unstyled.
export function calmReady() {
  if (!styled) calmStyles().then(render);
  return styled;
}
let picking = false; // the week's list is open

// A small accent button with the check icon (docs/sheet-glance.md, change 5).
export const approveButton = (ariaLabel, cls = "", text = "Approve") =>
  el("button", { type: "button", className: `sheet-btn-approve ${cls}`.trim(), ariaLabel }, icon("check"), text);

// Saves a block's new times. A proposed block is approved by it: it gets its Google event now,
// exactly as a dragged-on task does. Approving alone saves no new times.
export async function saveBlock(b, times = {}) {
  const t = state.tasks.get(b.task_id);
  const { starts_at = b.starts_at, ends_at = b.ends_at } = times;
  const change = { ...times };
  // v5 H1: a habit block stays off Google Calendar.
  const step = api.googleReady() && t ? googleStep(b) : null;
  if (step === "create") change.gcal_id = await api.createEvent(t.title, t.public, starts_at, ends_at);
  if (step === "patch") await api.patchEvent(b.gcal_id, api.eventTimes(starts_at, ends_at));
  if (b.proposed) change.proposed = false;
  // Auto-approval: a block he moves or approves here is his, so no revision moves it again.
  if (b.auto) change.auto = false;
  Object.assign(b, await api.updateBlock(b.id, change));
}

// --- Off-page approvals (docs/sheet-morning.md, "/plan") ---------------------------------

// Blocks approved from Telegram have no Google event, and only the browser can make one. Each
// time the page loads Google events (eventHooks), the approved blocks without one that haven't
// ended get theirs, as createEvent makes it for a block approved here. Three guards keep an
// event from being made twice: one run at a time in this tab, a lock shared by this browser's
// tabs (https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request), and gcal_id set
// only while it is still empty, so an event a second device made too is deleted again.
let creating = null;
const shared = (fn) => (navigator.locks ? navigator.locks.request("sheet.gcal-create", fn) : fn());

async function createMissed() {
  const now = new Date();
  let made = 0;
  for (const b of await api.eventlessBlocks(now.toISOString())) {
    if (googleStep(b, now) !== "create" || b.proposed || !b.tasks) continue;
    const id = await api.createEvent(b.tasks.title, b.tasks.public, b.starts_at, b.ends_at);
    const saved = await api.claimEvent(b.id, id);
    if (!saved) { await api.deleteEvent(id); continue; }
    const mine = state.blocks.find((x) => x.id === b.id);
    if (mine) mine.gcal_id = saved.gcal_id;
    made++;
  }
  if (made) render();
}

const createMissedOnce = () => (creating ??= shared(createMissed).finally(() => { creating = null; }));

// The dialog itself (plan-dialog.mjs) loads the first time it opens; its listeners go on then.
let loading = null;
const loadDialog = () => (loading ??= import("./plan-dialog.mjs").then((m) => { m.setupPlanDialog(dialog); return (planDialog = m); }, (e) => { loading = null; throw e; }));

// --- Wiring ------------------------------------------------------------------------------

export function setupPlanToday(root) {
  dialog = root.querySelector("[data-plan]");
  eventHooks.push(createMissedOnce);
  renderHooks.push(() => { if (dialog.open) planDialog?.draw(); });
  // Today's over-commit note, under its glance strip.
  renderHooks.push(() => {
    const note = overNote(state.today, picking, () => { picking = !picking; render(); }, "week");
    if (!note) picking = false;
    else root.querySelector(`.sheet-day[data-day="${state.today}"] .sheet-stamps-row`)?.append(note);
  });
  actHooks.plan = () => loadDialog().then((m) => m.open()).catch(failed);
  keyHooks.push((e) => { if (e.key === "p" || e.key === "P") { actHooks.plan(); return true; } return false; });
  // In the week, each proposed block shows dashed under its task, with its time and Approve.
  // When the row's own time label already is the block's time (research U17), the time isn't
  // said twice: the sparkles and Approve go on the row's details line instead.
  renderHooks.push(() => {
    for (const col of root.querySelectorAll(".sheet-day")) {
      const d = col.dataset.day;
      for (const b of proposedOn(state.blocks, d, SHEET.timeZone)) {
        const row = col.querySelector(`.sheet-task[data-id="${b.task_id}"]`);
        if (!row) continue;
        const [from, to] = [minutesOn(b.starts_at, d, SHEET.timeZone), minutesOn(b.ends_at, d, SHEET.timeZone)];
        const span = formatSpan(from, to);
        const ok = approveButton(`Approve ${span} block for ${state.tasks.get(b.task_id).title}`);
        Object.assign(ok.dataset, { act: "approve", block: b.id });
        const own = spanOf(state.tasks.get(b.task_id));
        const body = row.querySelector(".sheet-body");
        if (own?.start === from && own?.end === to && body) {
          const details = body.querySelector(":scope > .sheet-details") ?? body.appendChild(el("span", { className: "sheet-details" }));
          details.append(el("span", { className: "sheet-meta", title: "Proposed by Claude" }, icon("sparkles"), el("span", { className: "visually-hidden", textContent: " proposed" })), ok);
          continue;
        }
        row.append(el("span", { className: "sheet-proposal", title: "Proposed by Claude" },
          icon("sparkles"), el("span", { textContent: span }), el("span", { className: "visually-hidden", textContent: " proposed" }), ok));
      }
    }
  });
  actHooks.approve = async (e) => {
    const b = state.blocks.find((x) => x.id === e.target.closest("[data-block]").dataset.block);
    const save = () => saveBlock(b);
    try { await save(); } catch (err) { failed(err, `approve the block for "${state.tasks.get(b.task_id)?.title ?? "the task"}"`, save); }
    render();
  };
  // Each day's header shows its planned load, coloured near and over capacity.
  renderHooks.push(() => {
    for (const head of root.querySelectorAll(".sheet-day")) {
      const { free, capacity } = dayCapacity(head.dataset.day);
      const m = load(tasksOn(head.dataset.day), capacity);
      if (!m.total) continue;
      // When events leave less than the usual budget, the chip shows what's left: "2h45 / 3h10".
      const short = capacity < workloadCap();
      head.querySelector(".sheet-head").append(el("span", {
        className: `sheet-load-chip is-${m.level}`,
        textContent: short ? `${formatMinutes(m.total)} / ${formatMinutes(capacity)}` : formatMinutes(m.total),
        title: `${formatMinutes(m.total)} planned. ${formatMinutes(free)} free around your calendar between ${formatClock(dayStart(head.dataset.day))} and shutdown at ${formatClock(shutdownAt(head.dataset.day))}; tasks get up to ${formatMinutes(workloadCap())}.`,
      }));
    }
  });
  // Load and free time, drawn (docs/sheet-glance.md, change 4): under each day's header, a 4px
  // load bar and a 6px strip of the day from his wake to an hour past shutdown (windowOn), with a
  // now tick on today. Both are decoration: the chip's text carries the load.
  renderHooks.push(() => {
    const local = localNow(new Date(), SHEET.timeZone);
    for (const col of root.querySelectorAll(".sheet-day")) {
      const d = col.dataset.day;
      const { from, to } = windowOn(d);
      const strip = el("span", { className: "sheet-strip" }, ...stripSegments(state.events, state.blocks, d, SHEET.timeZone, from, to).map((s) => {
        const seg = el("span", { className: `sheet-seg is-${s.kind}` });
        Object.assign(seg.style, { left: `${s.from}%`, width: `${s.to - s.from}%` });
        return seg;
      }));
      if (d === local.day && local.minutes > from && local.minutes < to) {
        const tick = el("span", { className: "sheet-strip-now" });
        tick.style.left = `${(100 * (local.minutes - from)) / (to - from)}%`;
        strip.append(tick);
      }
      col.querySelector(".sheet-stamps").prepend(el("span", { className: "sheet-glance", ariaHidden: "true" }, loadBar(d), strip));
    }
  });
}
