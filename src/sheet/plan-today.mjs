// Plan today (docs/sheet.md): today's tasks beside a timeline with Lisul's Google events in gray.
// Dropping a task makes a block as tall as its estimate, written to the "Time blocks" calendar;
// resizing a block writes its length back to the estimate. A load meter keeps the day honest.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import {
  addDays, dayLabel, localNow, zonedIso, minutesOn, load, finishAt, planningDay, snap,
  formatMinutes, formatClock, byPosition, DEFAULT_EST,
} from "./logic.mjs";
import { el, state, render, taskRow, moveTask, dropTargets, keyHooks, actHooks, renderHooks, failed } from "./planner.mjs";

const START = 7 * 60;
const END = 23 * 60;
const PX = 1.2; // pixels per minute
const y = (min) => (min - START) * PX;
const minuteAt = (clientY, box) => Math.max(START, Math.min(END - 15, snap(START + (clientY - box.top) / PX)));
const clock = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

let dialog;
let day;          // the day being planned
let events = [];  // his Google events that day
let picked = null; // a task tapped in the list, waiting for a tap on the timeline (touch, keyboard)

const tasksOn = (d) => [...state.tasks.values()].filter((t) => t.day === d).sort(byPosition);
const blocksOn = (d) => state.blocks.filter((b) => minutesOn(b.starts_at, d, SHEET.timeZone) >= 0 && minutesOn(b.starts_at, d, SHEET.timeZone) < 1440);
const shutdownAt = (d) => clock((state.days[d]?.shutdown_at ?? SHEET.shutdownAt).slice(0, 5));

function meter(d) {
  const m = load(tasksOn(d), SHEET.capacityMin);
  const local = localNow(new Date(), SHEET.timeZone);
  const from = d === local.day ? Math.max(local.minutes, 9 * 60) : 9 * 60;
  return { ...m, finish: finishAt(from, m.total) };
}

// --- The dialog --------------------------------------------------------------------------

function draw() {
  const { weekday, date } = dayLabel(day);
  const m = meter(day);
  const shut = shutdownAt(day);
  const late = m.finish > shut;

  const timeline = el("div", { className: "sheet-timeline" });
  timeline.style.height = `${(END - START) * PX}px`;
  for (let h = START; h < END; h += 60) {
    const line = el("div", { className: "sheet-hour", textContent: formatClock(h).replace(":00", "") });
    line.style.top = `${y(h)}px`;
    timeline.append(line);
  }
  for (const e of events) {
    const top = Math.max(START, minutesOn(e.starts_at, day, SHEET.timeZone));
    const end = Math.min(END, minutesOn(e.ends_at, day, SHEET.timeZone));
    if (end <= top) continue;
    const box = el("div", { className: "sheet-event", textContent: e.title, title: e.title });
    Object.assign(box.style, { top: `${y(top)}px`, height: `${(end - top) * PX}px` });
    timeline.append(box);
  }
  for (const b of blocksOn(day)) {
    const t = state.tasks.get(b.task_id);
    if (!t) continue;
    const top = minutesOn(b.starts_at, day, SHEET.timeZone);
    const end = minutesOn(b.ends_at, day, SHEET.timeZone);
    const box = el("div", { className: `sheet-block${t.done ? " is-done" : ""}` },
      el("span", { className: "sheet-block-title", textContent: `${t.title}${b.gcal_id ? "" : " (not in Google)"}`, title: t.title }),
      el("button", { type: "button", className: "sheet-block-x", textContent: "×", ariaLabel: `Remove block for ${t.title}` }),
      el("span", { className: "sheet-resize", ariaHidden: "true" }));
    box.dataset.block = b.id;
    Object.assign(box.style, { top: `${y(top)}px`, height: `${Math.max(15, end - top) * PX}px` });
    timeline.append(box);
  }
  const shutLine = el("div", { className: "sheet-shutline", title: "Drag to move today's shutdown" },
    el("span", { textContent: `Shutdown ${formatClock(shut)}` }));
  shutLine.style.top = `${y(shut)}px`;
  timeline.append(shutLine);
  const nowMin = minutesOn(new Date().toISOString(), day, SHEET.timeZone);
  if (nowMin > START && nowMin < END) {
    const nowLine = el("div", { className: "sheet-nowline" });
    nowLine.style.top = `${y(nowMin)}px`;
    timeline.append(nowLine);
  }
  const preview = el("div", { className: "sheet-preview", hidden: true });
  timeline.append(preview);

  const list = el("ul", { className: "sheet-rows" }, ...tasksOn(day).filter((t) => !t.done).map((t) => {
    const row = taskRow(t);
    if (t.id === picked) row.classList.add("is-picked");
    return row;
  }));
  list.dataset.day = day;

  const google = api.googleReady()
    ? null
    : el("p", { className: "sheet-notice" }, "Google Calendar is not connected, so blocks stay here. ",
        Object.assign(el("button", { type: "button", className: "sheet-link", textContent: "Connect" }), { onclick: api.signIn }));

  const scroll = dialog.querySelector(".sheet-timeline-wrap")?.scrollTop;
  dialog.replaceChildren(...[
    el("h2", { id: "sheet-plan-title", textContent: `Plan ${weekday.charAt(0)}${weekday.slice(1).toLowerCase()} ${date}` }),
    el("p", { className: `sheet-load is-${m.level}${late ? " is-late" : ""}` },
      el("strong", { textContent: `${formatMinutes(m.total)} / ${formatMinutes(m.capacity)}` }),
      ` · Done ≈ ${formatClock(m.finish)} · shutdown ${formatClock(shut)}`),
    el("p", { className: "small", textContent: picked
      ? `Now tap a time for "${state.tasks.get(picked)?.title ?? ""}".`
      : "Drag a task onto the timeline, or tap it and then tap a time. D moves the focused task to tomorrow, Z to Someday." }),
    google,
    el("div", { className: "sheet-plan-body" },
      el("div", { className: "sheet-plan-tasks" }, list.children.length ? list : el("p", { className: "small", textContent: "Nothing left on this day." })),
      el("div", { className: "sheet-timeline-wrap", tabIndex: 0, ariaLabel: "Timeline" }, timeline)),
    el("form", { method: "dialog", className: "sheet-dialog-end" },
      el("button", { type: "submit", className: "sheet-btn primary", value: "done", textContent: "Done" })),
  ].filter(Boolean));
  if (scroll != null) dialog.querySelector(".sheet-timeline-wrap").scrollTop = scroll;
}

async function fetchEvents() {
  events = [];
  if (!api.googleReady()) return;
  try { events = (await api.calendarEvents(zonedIso(day, 0, SHEET.timeZone), zonedIso(day, 1440, SHEET.timeZone), state.calendars)).filter((e) => !e.allDay); } catch (e) { console.error(e); }
}

async function open() {
  day = planningDay(localNow(new Date(), SHEET.timeZone));
  await fetchEvents();
  draw();
  dialog.showModal();
  dialog.querySelector(".sheet-timeline-wrap").scrollTop = Math.max(0, y(Math.min(meter(day).finish, shutdownAt(day))) - 300);
}

// --- Blocks ------------------------------------------------------------------------------

async function addBlock(taskId, startMin) {
  const t = state.tasks.get(taskId);
  const len = t.est_min ?? DEFAULT_EST;
  const starts_at = zonedIso(day, startMin, SHEET.timeZone);
  const ends_at = zonedIso(day, startMin + len, SHEET.timeZone);
  const gcal_id = api.googleReady() ? await api.createEvent(t.title, t.public, starts_at, ends_at) : null;
  state.blocks.push(await api.insertBlock({ task_id: taskId, starts_at, ends_at, gcal_id }));
  if (t.est_min == null) state.tasks.set(taskId, await api.updateTask(taskId, { est_min: len }));
}

async function removeBlock(id) {
  const b = state.blocks.find((x) => x.id === id);
  if (b.gcal_id && api.googleReady()) await api.deleteEvent(b.gcal_id);
  await api.deleteBlock(id);
  state.blocks = state.blocks.filter((x) => x.id !== id);
}

// The estimate is the time blocked for the task, so resizing changes both.
async function resizeBlock(id, endMin) {
  const b = state.blocks.find((x) => x.id === id);
  const ends_at = zonedIso(day, endMin, SHEET.timeZone);
  if (b.gcal_id && api.googleReady()) await api.patchEvent(b.gcal_id, { end: { dateTime: ends_at } });
  Object.assign(b, await api.updateBlock(id, { ends_at }));
  const total = state.blocks.filter((x) => x.task_id === b.task_id)
    .reduce((s, x) => s + Math.round((new Date(x.ends_at) - new Date(x.starts_at)) / 60_000), 0);
  state.tasks.set(b.task_id, await api.updateTask(b.task_id, { est_min: total }));
}

// --- Pointer work inside the timeline ----------------------------------------------------

function timelineBox() { return dialog.querySelector(".sheet-timeline").getBoundingClientRect(); }
const inside = (e, r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;

// Tasks dragged from the list (planner.mjs runs the drag) land here.
const timelineDrop = {
  over(e, drag) {
    if (!dialog?.open) return false;
    const r = timelineBox();
    const p = dialog.querySelector(".sheet-preview");
    if (!inside(e, r)) { p.hidden = true; return false; }
    const at = minuteAt(e.clientY, r);
    const len = state.tasks.get(drag.id).est_min ?? DEFAULT_EST;
    Object.assign(p.style, { top: `${y(at)}px`, height: `${len * PX}px` });
    p.hidden = false;
    p.textContent = formatClock(at);
    return true;
  },
  async drop(e, drag) {
    if (!dialog?.open || !inside(e, timelineBox())) return false;
    await addBlock(drag.id, minuteAt(e.clientY, timelineBox()));
    draw();
    return true;
  },
};

// Resizing a block's bottom edge and moving the shutdown line.
function onPointerDown(e) {
  const handle = e.target.closest(".sheet-resize, .sheet-shutline");
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  const box = handle.closest(".sheet-block, .sheet-shutline");
  const block = box.dataset.block;
  const top = parseFloat(box.style.top);
  const move = (ev) => {
    const at = minuteAt(ev.clientY, timelineBox());
    if (block) box.style.height = `${Math.max(15 * PX, y(at) - top)}px`;
    else { box.style.top = `${y(at)}px`; box.firstChild.textContent = `Shutdown ${formatClock(at)}`; }
  };
  const up = async (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    const at = minuteAt(ev.clientY, timelineBox());
    try {
      if (block) {
        const start = START + top / PX;
        await resizeBlock(block, Math.max(start + 15, at));
      } else {
        const hhmm = `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
        await api.upsertDay(day, { shutdown_at: hhmm });
        state.days[day] = { ...(state.days[day] ?? { day }), shutdown_at: hhmm };
      }
    } catch (err) { failed(err); }
    draw();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

// --- Wiring ------------------------------------------------------------------------------

export function setupPlanToday(root) {
  dialog = root.querySelector("[data-plan]");
  dropTargets.push(timelineDrop);
  renderHooks.push(() => { if (dialog.open) draw(); });
  actHooks.plan = () => open().catch(failed);
  keyHooks.push((e) => { if (e.key === "p" || e.key === "P") { actHooks.plan(); return true; } return false; });

  dialog.addEventListener("pointerdown", onPointerDown, true);
  dialog.addEventListener("click", async (e) => {
    const x = e.target.closest(".sheet-block-x");
    if (x) {
      try { await removeBlock(x.closest(".sheet-block").dataset.block); } catch (err) { failed(err); }
      return draw();
    }
    // Tap a task, then tap a time: the way to time-block where dragging isn't possible.
    const title = e.target.closest(".sheet-plan-tasks .sheet-title");
    if (title) {
      e.stopPropagation();
      const id = title.closest(".sheet-task").dataset.id;
      picked = picked === id ? null : id;
      draw();
      return dialog.querySelector(`[data-id="${id}"] .sheet-title`)?.focus();
    }
    if (picked && e.target.closest(".sheet-timeline") && !e.target.closest(".sheet-block, .sheet-shutline")) {
      const id = picked;
      picked = null;
      try { await addBlock(id, minuteAt(e.clientY, timelineBox())); } catch (err) { failed(err); }
      draw();
    }
  }, true);
  dialog.addEventListener("keydown", async (e) => {
    const li = e.target.closest?.(".sheet-task");
    if (!li || e.target.closest("input") || e.metaKey || e.ctrlKey) return;
    const key = e.key.toLowerCase();
    if (key !== "d" && key !== "z") return;
    e.preventDefault();
    try { await moveTask(li.dataset.id, key === "d" ? { day: addDays(day, 1) } : { list: "Inbox" }); } catch (err) { failed(err); }
    draw();
    dialog.querySelector(".sheet-task .sheet-title")?.focus();
  });
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue === "done") {
      try {
        await api.upsertDay(day, { planned: true });
        state.days[day] = { ...(state.days[day] ?? { day }), planned: true };
      } catch (err) { failed(err); }
    }
    dialog.returnValue = "";
    picked = null;
    render();
  });
  // Each day's header shows its planned load, coloured near and over capacity.
  renderHooks.push(() => {
    for (const head of root.querySelectorAll(".sheet-day")) {
      const m = load(tasksOn(head.dataset.day), SHEET.capacityMin);
      if (!m.total) continue;
      head.querySelector(".sheet-head").append(el("span", { className: `sheet-load-chip is-${m.level}`, textContent: formatMinutes(m.total), title: `${formatMinutes(m.total)} planned of ${formatMinutes(m.capacity)}` }));
    }
  });
}
