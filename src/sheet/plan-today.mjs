// Plan today (docs/sheet.md): today's tasks beside a timeline with Lisul's Google events in gray.
// Dropping a task makes a block as tall as its estimate, written to the "Time blocks" calendar;
// resizing a block writes its length back to the estimate. A load meter keeps the day honest.
// Blocks Claude proposed show dashed until approved (docs/sheet-nudges.md).
// This module is the part the week needs on load; the dialog itself is plan-dialog.mjs, loaded
// the first time Plan today opens.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { localNow, minutesOn, load, snap, formatMinutes, formatClock, formatSpan, byPosition, proposedOn, googleStep } from "./logic.mjs";
import { el, icon, state, render, keyHooks, actHooks, renderHooks, eventHooks, failed, dayCapacity, dayStart, workloadCap } from "./planner.mjs";
import { loadShare, stripSegments } from "./glance.mjs";
import { shutdownFor } from "./bedtime.mjs";

const START = 7 * 60;
const END = 23 * 60;
const PX = 1.2; // pixels per minute
const y = (min) => (min - START) * PX;
const minuteAt = (clientY, box) => Math.max(START, Math.min(END - 15, snap(START + (clientY - box.top) / PX)));
const clock = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export { START, END, PX, y, minuteAt, clock };

let dialog;
let planDialog = null; // plan-dialog.mjs, once Plan today has opened

export const tasksOn = (d) => [...state.tasks.values()].filter((t) => t.day === d).sort(byPosition);
export const blocksOn = (d) => state.blocks.filter((b) => minutesOn(b.starts_at, d, SHEET.timeZone) >= 0 && minutesOn(b.starts_at, d, SHEET.timeZone) < 1440);
// The day's shutdown line in minutes: his, else when wind-down starts (bedtime.mjs, shutdownFor).
export const shutdownAt = (d) => clock(shutdownFor(d, { line: state.days[d]?.shutdown_at, settings: state.settings, sleep: state.sleep, sleepTimes: state.sleepTimes, tz: SHEET.timeZone }));

// A day's load as a 4px bar on a track (docs/sheet-glance.md, change 4).
function loadBar(d) {
  const { pct, level } = loadShare(load(tasksOn(d), dayCapacity(d).capacity).total, dayCapacity(d).capacity);
  const fill = el("span", { className: `sheet-meter-fill is-${level}` });
  fill.style.width = `${pct}%`;
  return el("span", { className: "sheet-meter" }, fill);
}

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
  actHooks.plan = () => loadDialog().then((m) => m.open()).catch(failed);
  keyHooks.push((e) => { if (e.key === "p" || e.key === "P") { actHooks.plan(); return true; } return false; });
  // In the week, each proposed block shows dashed under its task, with its time and Approve.
  renderHooks.push(() => {
    for (const col of root.querySelectorAll(".sheet-day")) {
      const d = col.dataset.day;
      for (const b of proposedOn(state.blocks, d, SHEET.timeZone)) {
        const row = col.querySelector(`.sheet-task[data-id="${b.task_id}"]`);
        if (!row) continue;
        const span = formatSpan(minutesOn(b.starts_at, d, SHEET.timeZone), minutesOn(b.ends_at, d, SHEET.timeZone));
        const ok = approveButton(`Approve ${span} block for ${state.tasks.get(b.task_id).title}`);
        Object.assign(ok.dataset, { act: "approve", block: b.id });
        row.append(el("span", { className: "sheet-proposal", title: "Proposed by Claude" },
          icon("sparkles"), el("span", { textContent: span }), el("span", { className: "visually-hidden", textContent: " proposed" }), ok));
      }
    }
  });
  actHooks.approve = async (e) => {
    try { await saveBlock(state.blocks.find((b) => b.id === e.target.closest("[data-block]").dataset.block)); } catch (err) { failed(err); }
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
        title: `${formatMinutes(m.total)} planned. ${formatMinutes(free)} free around your calendar between ${formatClock(dayStart(head.dataset.day))} and ${formatClock(clock(SHEET.dayEndAt))}; tasks get up to ${formatMinutes(workloadCap())}.`,
      }));
    }
  });
  // Load and free time, drawn (docs/sheet-glance.md, change 4): under each day's header, a 4px
  // load bar and a 6px strip of the day from 7 am to 11 pm, with a now tick on today. Both are
  // decoration: the chip's text carries the load.
  renderHooks.push(() => {
    const local = localNow(new Date(), SHEET.timeZone);
    for (const col of root.querySelectorAll(".sheet-day")) {
      const d = col.dataset.day;
      const strip = el("span", { className: "sheet-strip" }, ...stripSegments(state.events, state.blocks, d, SHEET.timeZone).map((s) => {
        const seg = el("span", { className: `sheet-seg is-${s.kind}` });
        Object.assign(seg.style, { left: `${s.from}%`, width: `${s.to - s.from}%` });
        return seg;
      }));
      if (d === local.day && local.minutes > START && local.minutes < END) {
        const tick = el("span", { className: "sheet-strip-now" });
        tick.style.left = `${(100 * (local.minutes - START)) / (END - START)}%`;
        strip.append(tick);
      }
      col.querySelector(".sheet-stamps").prepend(el("span", { className: "sheet-glance", ariaHidden: "true" }, loadBar(d), strip));
    }
  });
}
