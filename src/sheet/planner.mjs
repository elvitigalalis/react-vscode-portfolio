// The planner on /plan (docs/sheet.md): the week, Someday lists, typing tasks in, the task menu,
// drag and drop, and undo. Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import {
  addDays, weekStart, weekDays, localNow, dayLabel, parseEntry, formatMinutes, rowCount,
  positionBetween, byPosition, rollMark, rollOpacity, blockOnComplete,
} from "./logic.mjs";
import { scrollToToday } from "./public.mjs";

export const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null && k !== false));
  return node;
};

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
};

let root;
const $ = (sel) => root.querySelector(sel);
const now = () => localNow(new Date(), SHEET.timeZone);

const tasksOn = (day) => [...state.tasks.values()].filter((t) => t.day === day).sort(byPosition);
const tasksIn = (list) => [...state.tasks.values()].filter((t) => t.day === null && t.list === list).sort(byPosition);
const lastPosition = (siblings) => (siblings.length ? siblings[siblings.length - 1].position : null);

function setStatus(text) {
  const s = $("[data-status]");
  s.hidden = !text;
  s.textContent = text ?? "";
}

export function failed(err) {
  console.error(err);
  setStatus("Something did not save. Reload to see what's stored.");
}

// --- Undo --------------------------------------------------------------------------------

let undoFn = null;
let toastTimer;

function offerUndo(text, fn) {
  undoFn = fn;
  $("[data-toast-text]").textContent = text;
  $("[data-toast]").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("[data-toast]").hidden = true; undoFn = null; }, 6000);
}

async function undo() {
  const fn = undoFn;
  undoFn = null;
  $("[data-toast]").hidden = true;
  if (fn) { try { await fn(); } catch (e) { failed(e); } render(); }
}

// --- Changes -----------------------------------------------------------------------------

async function patch(id, change) {
  const saved = await api.updateTask(id, change);
  state.tasks.set(id, saved);
  return saved;
}

// Google calendar blocks of a task. A block with no gcal_id was made while Google was off.
const blocksOf = (id) => state.blocks.filter((b) => b.task_id === id);

async function dropBlocks(id) {
  for (const b of blocksOf(id)) {
    if (b.gcal_id && api.googleReady()) await api.deleteEvent(b.gcal_id);
    await api.deleteBlock(b.id);
  }
  state.blocks = state.blocks.filter((b) => b.task_id !== id);
}

export async function addTask(text, where) {
  const parsed = parseEntry(text);
  if (!parsed.title) return;
  const siblings = where.day ? tasksOn(where.day) : tasksIn(where.list);
  const task = await api.insertTask({
    ...parsed, day: where.day ?? null, list: where.day ? null : where.list,
    position: positionBetween(lastPosition(siblings), null),
  });
  state.tasks.set(task.id, task);
  return task;
}

// Move a task to a day (or a Someday list), at the end unless a position is given. Moving to
// another day removes its blocks: a block is a plan for one day.
export async function moveTask(id, where, position) {
  const t = state.tasks.get(id);
  const before = { day: t.day, list: t.list, position: t.position, at_time: t.at_time };
  const target = where.day ? tasksOn(where.day) : tasksIn(where.list);
  const pos = position ?? positionBetween(lastPosition(target.filter((x) => x.id !== id)), null);
  if (where.day !== t.day) await dropBlocks(id);
  await patch(id, { day: where.day ?? null, list: where.day ? null : where.list, position: pos, ...(where.day ? {} : { at_time: null }) });
  offerUndo("Moved.", () => patch(id, before));
}

export async function completeTask(id, done = true) {
  const t = state.tasks.get(id);
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
  await patch(id, { done });
  if (done) offerUndo(`Done: ${t.title}`, () => patch(id, { done: false }));
}

async function removeTask(id) {
  const t = state.tasks.get(id);
  await dropBlocks(id);
  await api.deleteTask(id);
  state.tasks.delete(id);
  const { id: _, created_at, updated_at, ...copy } = t;
  offerUndo(`Deleted: ${t.title}`, async () => {
    const back = await api.insertTask(copy);
    state.tasks.set(back.id, back);
  });
}

async function editTask(id, text) {
  const t = state.tasks.get(id);
  const parsed = parseEntry(text);
  if (!parsed.title) return removeTask(id);
  // Details typed while editing apply; ones not typed stay as they were.
  const change = { title: parsed.title };
  for (const k of ["est_min", "at_time", "tag"]) if (parsed[k] !== null) change[k] = parsed[k];
  if (/(^|\s)!(public|private|p)(\s|$)/i.test(text)) change.public = parsed.public;
  const before = { title: t.title, est_min: t.est_min, at_time: t.at_time, tag: t.tag, public: t.public };
  await patch(id, change);
  if (change.public !== undefined && change.public !== before.public) await retitleBlocks(id);
  offerUndo("Edited.", () => patch(id, before));
}

// A block's Google title follows the task's visibility: its title if public, "Busy" if not.
export async function retitleBlocks(id) {
  const t = state.tasks.get(id);
  if (!api.googleReady()) return;
  for (const b of blocksOf(id)) if (b.gcal_id) await api.patchEvent(b.gcal_id, api.eventTitle(t.title, t.public));
}

async function toggleVisibility(id) {
  const t = state.tasks.get(id);
  await patch(id, { public: !t.public });
  await retitleBlocks(id);
  offerUndo(t.public ? "Now private." : "Now public.", async () => { await patch(id, { public: t.public }); await retitleBlocks(id); });
}

// --- Rendering ---------------------------------------------------------------------------

export function taskRow(t) {
  const li = el("li", { className: `sheet-row sheet-task${t.done ? " is-done" : ""}` });
  li.dataset.id = t.id;
  li.style.setProperty("--ink", String(rollOpacity(t.rolls)));
  const title = el("button", { type: "button", className: "sheet-title", textContent: t.title, title: t.title });
  title.setAttribute("aria-label", `${t.title}${t.public ? "" : ", private"}${t.done ? ", done" : ""}. Edit`);
  li.append(...[
    rollMark(t.rolls) ? el("span", { className: "sheet-roll", textContent: rollMark(t.rolls), title: `Rolled over ${t.rolls} time${t.rolls > 1 ? "s" : ""}` }) : null,
    title,
    t.at_time ? el("span", { className: "sheet-meta", textContent: t.at_time.slice(0, 5) }) : null,
    t.est_min ? el("span", { className: "sheet-meta", textContent: formatMinutes(t.est_min) }) : null,
    t.public ? null : el("span", { className: "sheet-priv", textContent: "private", title: "Only you see this; /now shows a bar" }),
    el("button", { type: "button", className: "sheet-check", textContent: t.done ? "↺" : "✓", ariaLabel: t.done ? `Reopen ${t.title}` : `Complete ${t.title}` }),
    el("button", { type: "button", className: "sheet-more", textContent: "⋯", ariaLabel: `More for ${t.title}` }),
  ].filter(Boolean));
  return li;
}

function addRow(where, label) {
  const input = el("input", { className: "sheet-add", type: "text", autocomplete: "off", spellcheck: true, ariaLabel: label, placeholder: "+ Add a task" });
  if (where.day) input.dataset.day = where.day; else input.dataset.list = where.list;
  return el("li", { className: "sheet-row is-empty is-add" }, input);
}

function dayColumn(day, rows) {
  const list = tasksOn(day);
  const { weekday, date } = dayLabel(day);
  const info = state.days[day] ?? {};
  const allDone = day === state.today && list.length > 0 && list.every((t) => t.done);
  const ul = el("ul", { className: "sheet-rows" }, ...list.map(taskRow), addRow({ day }, `Add a task to ${weekday} ${date}`));
  ul.dataset.day = day;
  for (let i = list.length + 1; i < rows; i++) ul.append(el("li", { className: "sheet-row is-empty" }));
  const marks = [info.planned && "Planned ✓", info.shutdown && "Shut down ✓"].filter(Boolean).join(" · ");
  const section = el("section", { className: `sheet-day${day === state.today ? " is-today" : ""}${day === state.focus ? " is-focus" : ""}` },
    el("h2", { className: "sheet-head" },
      el("span", { className: "sheet-wd", textContent: weekday }), " ",
      el("span", { className: "sheet-dt", textContent: date }),
      allDone ? el("span", { className: "sheet-alldone", textContent: " ✓", title: "Everything done today" }) : null,
      day === state.today ? el("span", { className: "visually-hidden", textContent: " (today)" }) : null),
    el("p", { className: "sheet-stamps", textContent: marks }),
    ul);
  section.dataset.day = day;
  return section;
}

function listColumn(name) {
  const list = tasksIn(name);
  const ul = el("ul", { className: "sheet-rows" }, ...list.map(taskRow), addRow({ list: name }, `Add a task to ${name}`));
  ul.dataset.list = name;
  return el("section", { className: "sheet-list" }, el("h3", { className: "sheet-head" }, el("span", { className: "sheet-wd", textContent: name })), ul);
}

export function render() {
  const keep = document.activeElement?.classList.contains("sheet-add") ? { day: document.activeElement.dataset.day, list: document.activeElement.dataset.list } : null;
  state.today = now().day;
  const days = weekDays(state.week);
  if (!days.includes(state.focus)) state.focus = days.includes(state.today) ? state.today : days[0];
  const rows = rowCount(Object.fromEntries(days.map((d) => [d, tasksOn(d)])));
  $("[data-week]").replaceChildren(...days.map((d) => dayColumn(d, rows)));
  const first = dayLabel(days[0]);
  $("[data-week-title]").textContent = `Week of ${first.date}`;

  for (const t of state.tasks.values()) if (t.day === null) state.lists.add(t.list);
  const newList = el("input", { className: "sheet-add sheet-newlist", type: "text", autocomplete: "off", placeholder: "New list…", ariaLabel: "New Someday list" });
  $("[data-someday]").replaceChildren(...[...state.lists].map(listColumn), el("section", { className: "sheet-list" }, newList));
  $("[data-someday-title]").hidden = false;

  const notice = $("[data-notice]");
  notice.hidden = !state.parked;
  notice.textContent = `${state.parked} task${state.parked === 1 ? "" : "s"} moved to Someday.`;
  for (const hook of renderHooks) hook();

  if (keep) root.querySelector(keep.day ? `.sheet-add[data-day="${keep.day}"]` : `.sheet-add[data-list="${CSS.escape(keep.list)}"]`)?.focus();
}

export const renderHooks = [];

// --- Loading -----------------------------------------------------------------------------

export async function load() {
  const days = weekDays(state.week);
  const [tasks, blocks, dayRows, parked] = await Promise.all([
    api.listTasks(days[0], days[6]),
    api.listBlocks(new Date(`${addDays(days[0], -1)}T00:00:00Z`).toISOString(), new Date(`${addDays(days[6], 2)}T00:00:00Z`).toISOString()),
    api.listDays(days[0], days[6]),
    api.parkedOn(state.today),
  ]);
  state.tasks = new Map(tasks.map((t) => [t.id, t]));
  state.blocks = blocks;
  state.days = Object.fromEntries(dayRows.map((d) => [d.day, d]));
  state.parked = parked.length;
  render();
  scrollToToday($("[data-week]"));
}

async function showWeek(monday) {
  state.week = monday;
  try { await load(); } catch (e) { failed(e); }
}

// --- Editing in place --------------------------------------------------------------------

function startEdit(li) {
  const t = state.tasks.get(li.dataset.id);
  const input = el("input", { className: "sheet-add sheet-edit", type: "text", value: t.title, ariaLabel: `Edit ${t.title}` });
  li.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    try { if (save && input.value.trim() !== t.title) await editTask(t.id, input.value); } catch (e) { failed(e); }
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

function openMenu(id, anchor) {
  const menu = $("[data-menu]");
  menuFor = id;
  const t = state.tasks.get(id);
  menu.querySelector('[data-move="visibility"]').textContent = t.public ? "Make private" : "Make public";
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 260)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - 180, document.documentElement.clientWidth - 200))}px`;
  menu.showPopover();
  menu.querySelector("button").focus();
}

async function menuAction(kind) {
  const id = menuFor;
  $("[data-menu]").hidePopover();
  if (!id) return;
  const today = now().day;
  try {
    if (kind === "today") await moveTask(id, { day: today });
    if (kind === "tomorrow") await moveTask(id, { day: addDays(today, 1) });
    if (kind === "next-week") await moveTask(id, { day: addDays(weekStart(today), 7) });
    if (kind === "someday") await moveTask(id, { list: "Inbox" });
    if (kind === "visibility") await toggleVisibility(id);
    if (kind === "delete") await removeTask(id);
  } catch (e) { failed(e); }
  render();
  root.querySelector(`[data-id="${id}"] .sheet-title`)?.focus();
}

// --- Drag and drop -----------------------------------------------------------------------

// Pointer-based so it works on touch. Other modules (plan today) register drop targets.
export const dropTargets = [];
let drag = null;

function dropSpot(x, y) {
  const under = document.elementFromPoint(x, y);
  const ul = under?.closest(".sheet-rows");
  if (!ul || !root.contains(ul)) return null;
  const rows = [...ul.querySelectorAll(".sheet-task")].filter((r) => r.dataset.id !== drag.id);
  const after = rows.find((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  const idx = after ? rows.indexOf(after) : rows.length;
  const pos = (r) => state.tasks.get(r.dataset.id).position;
  return {
    where: ul.dataset.day ? { day: ul.dataset.day } : { list: ul.dataset.list },
    position: positionBetween(idx > 0 ? pos(rows[idx - 1]) : null, after ? pos(after) : null),
    ul, before: after ?? null,
  };
}

function onPointerDown(e) {
  const li = e.target.closest(".sheet-task");
  if (!li || e.button !== 0 || e.target.closest("button:not(.sheet-title), input")) return;
  drag = { id: li.dataset.id, li, x: e.clientX, y: e.clientY, on: false };
}

function onPointerMove(e) {
  if (!drag) return;
  if (!drag.on) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
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
  dropSpot(e.clientX, e.clientY)?.ul.classList.add("is-drop");
}

async function onPointerUp(e) {
  const d = drag;
  drag = null;
  if (!d?.on) return;
  d.float.remove();
  document.body.classList.remove("sheet-dragging");
  d.li.classList.remove("is-ghost");
  root.querySelectorAll(".is-drop").forEach((n) => n.classList.remove("is-drop"));
  try {
    for (const t of dropTargets) if (await t.drop?.(e, d)) { render(); return; }
    const spot = dropSpot(e.clientX, e.clientY);
    if (spot) await moveTask(d.id, spot.where, spot.position);
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

function wire() {
  root.addEventListener("click", async (e) => {
    if (Date.now() - wasDrag.at < 300) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act) {
      if (act === "prev-week") return showWeek(addDays(state.week, -7));
      if (act === "next-week") return showWeek(addDays(state.week, 7));
      if (act === "this-week") return showWeek(weekStart(now().day));
      if (act === "prev-day" || act === "next-day") {
        const next = addDays(state.focus, act === "prev-day" ? -1 : 1);
        state.focus = next;
        if (weekStart(next) !== state.week) return showWeek(weekStart(next));
        return render();
      }
      if (act === "help") return $("[data-help]").showModal();
      if (act === "undo") return undo();
      if (act === "sign-out") { api.signOut(); location.reload(); return; }
      return actHooks[act]?.();
    }
    const move = e.target.closest("[data-move]")?.dataset.move;
    if (move) return menuAction(move);
    const li = e.target.closest(".sheet-task");
    if (!li) {
      // Any empty row of a day types into that day.
      const ul = e.target.closest(".sheet-rows");
      if (ul && e.target.closest(".is-empty")) ul.querySelector(".sheet-add")?.focus();
      return;
    }
    const id = li.dataset.id;
    if (e.target.closest(".sheet-check")) {
      try { await completeTask(id, !state.tasks.get(id).done); } catch (err) { failed(err); }
      render();
      root.querySelector(`[data-id="${id}"] .sheet-check`)?.focus();
    } else if (e.target.closest(".sheet-more")) openMenu(id, e.target);
    else if (e.target.closest(".sheet-title")) startEdit(li);
  });

  root.addEventListener("contextmenu", (e) => {
    const li = e.target.closest(".sheet-task");
    if (li) { e.preventDefault(); openMenu(li.dataset.id, li); }
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
    try { await addTask(text, input.dataset.day ? { day: input.dataset.day } : { list: input.dataset.list }); } catch (err) { failed(err); input.value = text; }
    render();
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.target.closest?.("input, textarea")) { e.preventDefault(); undo(); return; }
    if (typing(e) || document.querySelector("dialog[open]")) return;
    if (e.key === "ArrowLeft") showWeek(addDays(state.week, -7));
    else if (e.key === "ArrowRight") showWeek(addDays(state.week, 7));
    else if (e.key === "t" || e.key === "T") showWeek(weekStart(now().day));
    else if (e.key === "?") $("[data-help]").showModal();
    else if (e.key === ".") {
      const li = document.activeElement?.closest?.(".sheet-task");
      if (li) { e.preventDefault(); openMenu(li.dataset.id, li); }
    } else for (const hook of keyHooks) if (hook(e)) { e.preventDefault(); return; }
  });

  root.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove, { passive: false });
  document.addEventListener("pointerup", (e) => { if (drag?.on) wasDrag.at = Date.now(); onPointerUp(e); });
  document.addEventListener("pointercancel", () => { if (drag?.on) { drag.float.remove(); drag.li.classList.remove("is-ghost"); document.body.classList.remove("sheet-dragging"); } drag = null; });
}

// --- Start -------------------------------------------------------------------------------

// `plugins` (plan today, shutdown) each get the root once the planner is wired.
export async function start(node, plugins = []) {
  root = node;
  if (!api.configured) return setStatus("The planner is not set up yet.");
  api.takeRedirect();
  if (!(await api.signedIn())) {
    const button = el("button", { type: "button", className: "sheet-btn primary", textContent: "Sign in with Google" });
    button.addEventListener("click", api.signIn);
    const status = $("[data-status]");
    status.hidden = false;
    status.replaceChildren("This is Lisul's planner. The public view is at ", el("a", { href: "/now/", textContent: "/now" }), ". ", button);
    return;
  }
  wire();
  for (const plugin of plugins) plugin(root);
  try {
    if (!(await api.settings())) {
      setStatus("This account cannot open the planner.");
      $("[data-tools]").hidden = false;
      return;
    }
    state.today = now().day;
    state.week = weekStart(state.today);
    $("[data-tools]").hidden = false;
    $("[data-daynav]").hidden = false;
    setStatus(null);
    await load();
  } catch (e) { failed(e); }
}
