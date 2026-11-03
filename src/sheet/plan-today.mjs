// Plan today (docs/sheet.md): today's tasks beside a timeline with Lisul's Google events in gray.
// Dropping a task makes a block as tall as its estimate, written to the "Time blocks" calendar;
// resizing a block writes its length back to the estimate. A load meter keeps the day honest.
// Blocks Claude proposed show dashed until approved (docs/sheet-nudges.md).
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import {
  addDays, dayLabel, localNow, zonedIso, minutesOn, load, finishAt, planningDay, snap,
  formatMinutes, formatClock, formatSpan, byPosition, proposedOn, googleStep, DEFAULT_EST,
  blockMinutes, weekdayName, plural,
} from "./logic.mjs";
import { el, icon, state, render, taskRow, moveTask, dropTargets, keyHooks, actHooks, renderHooks, eventHooks, failed, dayCapacity, sourceIcon, sourceWords } from "./planner.mjs";
import { sourceOf, loadShare, stripSegments } from "./glance.mjs";
import { planNotes } from "./morning.mjs";

const START = 7 * 60;
const END = 23 * 60;
const PX = 1.2; // pixels per minute
const y = (min) => (min - START) * PX;
const minuteAt = (clientY, box) => Math.max(START, Math.min(END - 15, snap(START + (clientY - box.top) / PX)));
const clock = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

let dialog;
let day;          // the day being planned
let events = [];  // his Google events that day
let notes = [];   // the day's proposal: "Didn't fit: …", "Campus pick: …"
let picked = null; // a task tapped in the list, waiting for a tap on the timeline (touch, keyboard)

const tasksOn = (d) => [...state.tasks.values()].filter((t) => t.day === d).sort(byPosition);
const blocksOn = (d) => state.blocks.filter((b) => minutesOn(b.starts_at, d, SHEET.timeZone) >= 0 && minutesOn(b.starts_at, d, SHEET.timeZone) < 1440);
const shutdownAt = (d) => clock((state.days[d]?.shutdown_at ?? SHEET.shutdownAt).slice(0, 5));

// A day's load as a 4px bar on a track (docs/sheet-glance.md, change 4).
function loadBar(d) {
  const { pct, level } = loadShare(load(tasksOn(d), dayCapacity(d).capacity).total, dayCapacity(d).capacity);
  const fill = el("span", { className: `sheet-meter-fill is-${level}` });
  fill.style.width = `${pct}%`;
  return el("span", { className: "sheet-meter" }, fill);
}

function meter(d) {
  const m = load(tasksOn(d), dayCapacity(d).capacity);
  const local = localNow(new Date(), SHEET.timeZone);
  const from = d === local.day ? Math.max(local.minutes, 9 * 60) : 9 * 60;
  return { ...m, finish: finishAt(from, m.total) };
}

// The day's load bar at full width, with a marker where the work ends: "Done ≈". Decoration
// only; the line above says it in words (docs/sheet-glance.md, change 4).
function planBar(m) {
  const { pct, level } = loadShare(m.total, m.capacity);
  const fill = el("span", { className: `sheet-meter-fill is-${level}` });
  fill.style.width = `${pct}%`;
  const mark = el("span", { className: "sheet-meter-mark" }, el("span", { textContent: `Done ≈ ${formatClock(m.finish)}` }));
  mark.style.setProperty("--at", `${pct}%`);
  return el("div", { className: "sheet-planbar", ariaHidden: "true" }, el("span", { className: "sheet-meter" }, fill), mark);
}

// A small accent button with the check icon (docs/sheet-glance.md, change 5).
const approveButton = (ariaLabel, cls = "", text = "Approve") =>
  el("button", { type: "button", className: `sheet-btn-approve ${cls}`.trim(), ariaLabel }, icon("check"), text);

// --- The dialog --------------------------------------------------------------------------

function draw() {
  const { date } = dayLabel(day);
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
  // The now line goes in before the blocks, so it draws beneath their text; its time ("10:20",
  // the hour labels carry am and pm) sits in the hour gutter, where no block reaches.
  const nowMin = minutesOn(new Date().toISOString(), day, SHEET.timeZone);
  if (nowMin > START && nowMin < END) {
    const nowLine = el("div", { className: "sheet-nowline", ariaHidden: "true" }, el("span", { textContent: formatClock(nowMin).replace(/ [ap]m$/, "") }));
    nowLine.style.top = `${y(nowMin)}px`;
    timeline.append(nowLine);
  }
  for (const b of blocksOn(day)) {
    const t = state.tasks.get(b.task_id);
    if (!t) continue;
    const top = minutesOn(b.starts_at, day, SHEET.timeZone);
    const end = minutesOn(b.ends_at, day, SHEET.timeZone);
    const box = el("div", { className: `sheet-block${t.done ? " is-done" : ""}${b.proposed ? " is-proposed" : ""}${end - top < 30 ? " is-short" : ""}` },
      el("span", { className: "sheet-block-title", title: t.title },
        b.proposed ? icon("sparkles", "Proposed by Claude") : null, `${t.title}${b.proposed || b.gcal_id ? "" : " (not in Google)"}`),
      b.proposed ? approveButton(`Approve block for ${t.title}`, "sheet-approve") : null,
      el("button", { type: "button", className: "sheet-block-x", textContent: "×", ariaLabel: `${b.proposed ? "Turn down" : "Remove"} block for ${t.title}` }),
      el("span", { className: "sheet-resize", ariaHidden: "true" }));
    box.dataset.block = b.id;
    // A block takes its task's source: the edge colour (sheet.css) and the icon.
    const src = sourceOf(t);
    if (src) { box.dataset.source = src; box.prepend(sourceIcon(src)); }
    // Focusable, so a block can be moved and approved from the keyboard (see the dialog's keys).
    box.tabIndex = 0;
    box.ariaLabel = `${t.title}${sourceWords(src)}, ${formatSpan(top, end)}${b.proposed ? ", proposed" : ""}`;
    Object.assign(box.style, { top: `${y(top)}px`, height: `${Math.max(15, end - top) * PX}px` });
    timeline.append(box);
  }
  const shutLine = el("div", { className: "sheet-shutline", title: "Drag to move today's shutdown" },
    el("span", { textContent: `Shutdown ${formatClock(shut)}` }));
  shutLine.style.top = `${y(shut)}px`;
  timeline.append(shutLine);
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

  const proposals = proposedOn(state.blocks, day, SHEET.timeZone).length;
  const scroll = dialog.querySelector(".sheet-timeline-wrap")?.scrollTop;
  dialog.replaceChildren(...[
    el("h2", { id: "sheet-plan-title", textContent: `Plan ${weekdayName(day)} ${date}` }),
    el("p", { className: `sheet-load is-${m.level}${late ? " is-late" : ""}` },
      el("strong", { textContent: `${formatMinutes(m.total)} / ${formatMinutes(m.capacity)}` }),
      ` · Done ≈ ${formatClock(m.finish)} · shutdown ${formatClock(shut)}`),
    planBar(m),
    el("p", { className: "small", textContent: picked
      ? `Now tap a time for "${state.tasks.get(picked)?.title ?? ""}".`
      : "Drag tasks onto the timeline · ? for keys" }),
    google,
    proposals ? el("p", { className: "sheet-banner" }, icon("sparkles"), el("span", { textContent: `Claude proposed ${plural(proposals, "block")}` }),
      approveButton("Approve all proposed blocks", "sheet-approve-all", "Approve all")) : null,
    notes.length ? el("ul", { className: "sheet-plan-notes" }, ...notes.map((n) => el("li", { textContent: n }))) : null,
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

// The morning plan's note and campus picks for the day. Without them the dialog still opens.
async function fetchNotes() {
  notes = [];
  try {
    const p = await api.proposalOn(day);
    const campus = p?.picks?.length ? await api.campusByUid(p.picks.map((x) => x.uid)) : [];
    notes = planNotes(p, campus, SHEET.timeZone);
  } catch (e) { console.error(e); }
}

async function open() {
  day = planningDay(localNow(new Date(), SHEET.timeZone));
  await Promise.all([fetchEvents(), fetchNotes()]);
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

// Saves a block's new times. A proposed block is approved by it: it gets its Google event now,
// exactly as a dragged-on task does. Approving alone saves no new times.
async function saveBlock(b, times = {}) {
  const t = state.tasks.get(b.task_id);
  const { starts_at = b.starts_at, ends_at = b.ends_at } = times;
  const change = { ...times };
  const step = api.googleReady() ? googleStep(b) : null;
  if (step === "create") change.gcal_id = await api.createEvent(t.title, t.public, starts_at, ends_at);
  if (step === "patch") await api.patchEvent(b.gcal_id, api.eventTimes(starts_at, ends_at));
  if (b.proposed) change.proposed = false;
  Object.assign(b, await api.updateBlock(b.id, change));
}

const approveAll = async () => { for (const b of proposedOn(state.blocks, day, SHEET.timeZone)) await saveBlock(b); };

// Dragging a block moves it and keeps its length.
async function moveBlock(id, startMin) {
  const b = state.blocks.find((x) => x.id === id);
  const len = blockMinutes(b);
  await saveBlock(b, { starts_at: zonedIso(day, startMin, SHEET.timeZone), ends_at: zonedIso(day, startMin + len, SHEET.timeZone) });
}

// The estimate is the time blocked for the task, so resizing changes both. Proposals don't count.
async function resizeBlock(id, endMin) {
  const b = state.blocks.find((x) => x.id === id);
  await saveBlock(b, { ends_at: zonedIso(day, endMin, SHEET.timeZone) });
  const total = state.blocks.filter((x) => x.task_id === b.task_id && !x.proposed)
    .reduce((s, x) => s + blockMinutes(x), 0);
  state.tasks.set(b.task_id, await api.updateTask(b.task_id, { est_min: total }));
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

// Resizing a block's bottom edge, moving a block, and moving the shutdown line. On touch a
// block's body scrolls the timeline instead of moving; its bottom edge still resizes.
function onPointerDown(e) {
  const handle = e.target.closest(".sheet-resize, .sheet-shutline")
    ?? (e.pointerType !== "touch" && !e.target.closest("button") ? e.target.closest(".sheet-block") : null);
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  const box = handle.closest(".sheet-block, .sheet-shutline");
  const block = box.dataset.block;
  const moving = handle === box && block;
  const top = parseFloat(box.style.top);
  const rawAt = (ev) => START + (ev.clientY - timelineBox().top) / PX;
  const grab = rawAt(e) - (START + top / PX);
  const startAt = (ev) => Math.max(START, Math.min(END - 15, snap(rawAt(ev) - grab)));
  const move = (ev) => {
    const at = minuteAt(ev.clientY, timelineBox());
    if (moving) box.style.top = `${y(startAt(ev))}px`;
    else if (block) box.style.height = `${Math.max(15 * PX, y(at) - top)}px`;
    else { box.style.top = `${y(at)}px`; box.firstChild.textContent = `Shutdown ${formatClock(at)}`; }
  };
  const up = async (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    const at = minuteAt(ev.clientY, timelineBox());
    try {
      if (moving) {
        // A click on a block is not a move.
        if (startAt(ev) !== startAt(e)) await moveBlock(block, startAt(ev));
      } else if (block) {
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
  eventHooks.push(createMissedOnce);
  renderHooks.push(() => { if (dialog.open) draw(); });
  actHooks.plan = () => open().catch(failed);
  keyHooks.push((e) => { if (e.key === "p" || e.key === "P") { actHooks.plan(); return true; } return false; });

  dialog.addEventListener("pointerdown", onPointerDown, true);
  dialog.addEventListener("click", async (e) => {
    const ok = e.target.closest(".sheet-approve, .sheet-approve-all");
    if (ok) {
      try {
        if (ok.classList.contains("sheet-approve")) await saveBlock(state.blocks.find((b) => b.id === ok.closest(".sheet-block").dataset.block));
        else await approveAll();
      } catch (err) { failed(err); }
      return draw();
    }
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
  // Keys on a focused block: ↑ ↓ move it 15 minutes, A approves it; Shift+A approves them all.
  dialog.addEventListener("keydown", async (e) => {
    if (e.metaKey || e.ctrlKey || e.target.closest?.("input")) return;
    const box = e.target.closest?.(".sheet-block");
    const id = box?.dataset.block;
    const b = id && state.blocks.find((x) => x.id === id);
    let act;
    if (e.key === "A" && e.shiftKey) act = approveAll;
    else if (b && e.key.toLowerCase() === "a" && b.proposed) act = () => saveBlock(b);
    else if (b && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const start = minutesOn(b.starts_at, day, SHEET.timeZone) + (e.key === "ArrowUp" ? -15 : 15);
      act = () => moveBlock(id, Math.max(START, Math.min(END - 15, start)));
    }
    if (!act) return;
    e.preventDefault();
    try { await act(); } catch (err) { failed(err); }
    draw();
    dialog.querySelector(`[data-block="${id}"]`)?.focus();
  });
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
      const short = capacity < SHEET.capacityMin;
      head.querySelector(".sheet-head").append(el("span", {
        className: `sheet-load-chip is-${m.level}`,
        textContent: short ? `${formatMinutes(m.total)} / ${formatMinutes(capacity)}` : formatMinutes(m.total),
        title: `${formatMinutes(m.total)} planned. ${formatMinutes(free)} free around your calendar between ${formatClock(clock(SHEET.dayStartAt))} and ${formatClock(clock(SHEET.dayEndAt))}; tasks get up to ${formatMinutes(SHEET.capacityMin)}.`,
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
