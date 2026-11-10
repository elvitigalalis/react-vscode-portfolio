// The Campus list in /plan (docs/sheet-sources.md, "/plan"): under each day's calendar, a
// "Campus · N" row counted after the routine filter. It opens that day's SB Engaged events in a
// dialog, with tag filters and Add to my day. The week's campus_events are read once per week on
// screen and kept in memory; the list is drawn only when opened. Never on /now.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { addDays, weekDays, zonedIso, minutesOn, formatSpan, dayLabel, positionBetween, byPosition, plural } from "./logic.mjs";
import { campusDay, campusTags, eventToTask, freeFood, isAdded, activeTags, tagsOf } from "./campus.mjs";
import { el, icon, state, render, renderHooks, keyHooks, actHooks, offerUndo, failed, forgetTask } from "./planner.mjs";
import { campusSummary } from "./glance.mjs";

const tz = SHEET.timeZone;
const KEY = "sheet.campus";
// Every event links out: to its own page, or (no page known) to SB Engaged's public events list,
// which needs no sign-in. Its search box is filled by script, so there is no search link to make.
const EVENTS = "https://sbengaged.stonybrook.edu/events";

let root, dialog;
let events = [];   // the week's campus_events rows
let week = null;   // the Monday they were read for
let day = null;    // the day the dialog shows
let note = null;   // "Added: …", while its undo lasts

// The filters, remembered in this browser: tags to keep (none keeps all) and the routine switch.
let filters = { tags: [], showRoutine: false };
try { filters = { ...filters, ...JSON.parse(localStorage.getItem(KEY)) }; } catch {}
const remember = () => { try { localStorage.setItem(KEY, JSON.stringify(filters)); } catch {} };

async function loadWeek() {
  const w = (week = state.week);
  events = [];
  const days = weekDays(w);
  let rows = [];
  try { rows = await api.listCampus(zonedIso(days[0], 0, tz), zonedIso(addDays(days[6], 1), 0, tz)); } catch (e) { console.error(e); }
  if (week !== w) return;
  events = rows;
  if (rows.length) render();
}

const routineShown = (d) => campusDay(events, d, tz, { showRoutine: filters.showRoutine });

// The row sits in the calendar's slot of each day. When the week has no calendar events that
// slot is empty, so every day gets one to keep the columns' grid rows level.
function drawRows() {
  if (state.week !== week) loadWeek();
  const counts = Object.fromEntries(weekDays(state.week).map((d) => [d, campusSummary(routineShown(d))]));
  if (!Object.values(counts).some((c) => c.n)) return;
  for (const section of root.querySelectorAll(".sheet-day")) {
    let ul = section.querySelector(".sheet-events");
    if (!ul) {
      ul = el("ul", { className: "sheet-events" });
      ul.setAttribute("aria-label", "Calendar");
      section.querySelector(".sheet-rows").before(ul);
    }
    const { n, food } = counts[section.dataset.day];
    if (!n) continue;
    // A chip (docs/sheet-glance.md, change 3): the ticket and the count, and the utensils and
    // how many have free food. The label keeps the words "Campus · N".
    const b = el("button", { type: "button", className: "sheet-chip sheet-campus-row", ariaLabel: `Campus · ${plural(n, "event")}${food ? `, ${food} with free food` : ""}` },
      icon("ticket"), ` ${n}`, food ? el("span", { className: "sheet-campus-n" }, icon("utensils"), ` ${food}`) : null);
    b.dataset.act = "campus";
    b.dataset.campus = section.dataset.day;
    b.setAttribute("aria-haspopup", "dialog");
    ul.append(el("li", {}, b));
  }
  if (dialog.open) draw();
}

function item(e) {
  const t = eventToTask(e, tz);
  const added = isAdded(state.tasks.values(), t);
  const tags = tagsOf(e);
  const label = added ? "Added ✓" : "Add to my day";
  const add = el("button", { type: "button", className: "sheet-btn", textContent: label, disabled: added, ariaLabel: `${label}: ${t.title}` });
  add.dataset.add = e.uid;
  const when = e.all_day ? "All day" : formatSpan(minutesOn(e.starts_at, day, tz), minutesOn(e.ends_at, day, tz));
  return el("li", { className: "sheet-campus-item" },
    el("p", { className: "sheet-meta" }, when, e.rsvp_count > 0 ? ` · ${e.rsvp_count} going` : null,
      freeFood(e) ? " " : null, freeFood(e) ? el("span", { className: "sheet-campus-food", textContent: "Free food" }) : null),
    el("a", { className: "sheet-campus-title", href: e.url ?? EVENTS, target: "_blank", rel: "noopener", textContent: e.title }),
    e.group_name ? el("p", { className: "sheet-meta", textContent: e.group_name }) : null,
    tags.length ? el("p", { className: "sheet-campus-tags" }, ...tags.map((g) => el("span", { className: "sheet-campus-tag", textContent: g }))) : null,
    add);
}

// The page's toast sits behind the modal dialog, so the dialog offers the same undo.
function undoButton() {
  const b = el("button", { type: "button", className: "sheet-link", textContent: "Undo" });
  b.dataset.act = "undo";
  return b;
}

function draw() {
  // Keep focus on the same control across a redraw.
  const a = document.activeElement;
  const keep = a && dialog.contains(a) ? (a.dataset.add ? `[data-add="${a.dataset.add}"]` : a.dataset.tag ? `[data-tag="${CSS.escape(a.dataset.tag)}"]` : a.id ? `#${a.id}` : null) : null;
  const all = routineShown(day);
  const tags = campusTags(all);
  const on = activeTags(filters.tags, tags);
  const shown = campusDay(all, day, tz, { tags: on, showRoutine: true });
  const { weekday, date } = dayLabel(day);
  const routine = el("input", { type: "checkbox", id: "sheet-campus-routine", checked: filters.showRoutine });
  dialog.replaceChildren(...[
    el("h2", { id: "sheet-campus-title", textContent: `Campus · ${weekday} ${date}` }),
    el("div", { className: "sheet-campus-filters", role: "group", ariaLabel: "Filter by tag" }, ...tags.map(({ tag, count }) => {
      const chip = el("button", { type: "button", className: "sheet-chip", textContent: `${tag} ${count}` });
      chip.dataset.tag = tag;
      chip.setAttribute("aria-pressed", String(on.includes(tag)));
      return chip;
    })),
    el("p", { className: "sheet-campus-switch" }, routine, el("label", { htmlFor: "sheet-campus-routine", textContent: " Show practices and meetings" })),
    note ? el("p", { className: "sheet-notice", role: "status" }, note, " ", undoButton()) : null,
    shown.length ? el("ul", { className: "sheet-campus-list" }, ...shown.map(item)) : el("p", { className: "sheet-notice", textContent: "No events match these filters." }),
    el("form", { method: "dialog", className: "sheet-dialog-end" }, el("button", { type: "submit", className: "sheet-btn", textContent: "Close" })),
  ].filter(Boolean));
  if (keep) dialog.querySelector(keep)?.focus();
}

function open(d) {
  day = d;
  note = null;
  draw();
  dialog.showModal();
}

// Through the planner's own insert, at the end of the event's day, with undo (toast and ⌘Z).
let noteTimer;
async function add(uid) {
  const t = eventToTask(events.find((e) => e.uid === uid), tz);
  const last = [...state.tasks.values()].filter((x) => x.day === t.day).sort(byPosition).at(-1);
  try {
    const task = await api.insertTask({ ...t, position: positionBetween(last?.position ?? null, null) });
    state.tasks.set(task.id, task);
    note = `Added: ${task.title}.`;
    offerUndo(`Added: ${task.title}`, async () => { note = null; await api.deleteTask(task.id); forgetTask(task.id); });
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { note = null; if (dialog.open) draw(); }, 6000);
  } catch (e) { failed(e); }
  render();
  // The button just pressed is now disabled; Undo is the next thing he may want.
  dialog.querySelector('[data-act="undo"]')?.focus();
}

export function setupCampus(node) {
  root = node;
  dialog = root.querySelector("dialog[data-campus]");
  actHooks.campus = (e) => open(e.target.closest("[data-campus]").dataset.campus);
  // C opens the focused day's list (on wide screens the day holding focus, else today's).
  keyHooks.push((e) => {
    if (e.key !== "c" && e.key !== "C") return false;
    if (!events.length) return false;
    open(document.activeElement?.closest?.(".sheet-day")?.dataset.day ?? state.focus);
    return true;
  });
  dialog.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-tag]");
    if (chip) {
      const tag = chip.dataset.tag;
      filters.tags = filters.tags.includes(tag) ? filters.tags.filter((g) => g !== tag) : [...filters.tags, tag];
      remember();
      return draw();
    }
    const b = e.target.closest("[data-add]");
    if (b) add(b.dataset.add);
  });
  dialog.addEventListener("change", (e) => {
    if (e.target.id !== "sheet-campus-routine") return;
    filters.showRoutine = e.target.checked;
    remember();
    render();
  });
  dialog.addEventListener("close", () => root.querySelector(`[data-campus="${day}"]`)?.focus());
  renderHooks.push(drawRows);
}
