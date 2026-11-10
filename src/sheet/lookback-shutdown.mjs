// Shutdown's look back and ahead (docs/sheet-lookback.md, research U14): today's event to-dos and
// one line from what is logged, the last few reflections, and a Tomorrow step. Loaded with
// shutdown-view.mjs, so /plan's first-load script stays small. Shutdown opens before these reads
// land and fills them in; without them it finishes from its first step.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { addDays, dayLabel, eventsOnDay, formatClock, freeMinutes, load, weekdayName, zonedIso } from "./logic.mjs";
import { dayRows } from "./event-todos.mjs";
import { el, state, dayStart, failed, rowsOn, shutdownAt, workloadCap } from "./planner.mjs";
import { keepsMoving, paceTrend, shutdownLine, tomorrowLine } from "./lookback.mjs";
import { history, moverPrompts } from "./lookback-view.mjs";

const tz = SHEET.timeZone;

let data = null;

// What Shutdown shows beyond the week on screen. Each read can fail alone.
export async function prepare(today) {
  const tomorrow = addDays(today, 1);
  const quiet = (p) => p.catch((e) => { console.error(e); return []; });
  const [hist, tasks, events, todos, turned, past] = await Promise.all([
    history(),
    quiet(api.rest(`tasks?day=eq.${tomorrow}&order=position`)),
    api.googleReady() ? quiet(api.calendarEvents(zonedIso(tomorrow, 0, tz), zonedIso(tomorrow, 1440, tz), state.calendars)) : [],
    quiet(api.listEventTodos(tomorrow, tomorrow)),
    quiet(api.rest(`feedback?select=ref&action=eq.turn_down&ref->>day=eq.${today}`)),
    quiet(api.rest(`days?select=day,reflection&day=lt.${today}&reflection=not.is.null&order=day.desc&limit=5`)),
  ]);
  data = { today, tomorrow, hist, tasks, events, todos, turned: new Set(turned.map((f) => f.ref?.task_id)).size, past: past.filter((d) => d.reflection?.trim()) };
}

// Tomorrow's tasks as read when Shutdown opened (tomorrow can be outside the week on screen).
export const tomorrowTasks = () => data?.tasks ?? [];

async function toggleEvent(row, redraw) {
  try {
    await api.saveEventTodo({ cal_event_key: row.key, day: data.today, done: !row.done });
    const own = state.todos.find((x) => x.cal_event_key === row.key);
    if (own) own.done = !row.done;
    else state.todos.push({ cal_event_key: row.key, title_ai: null, done: !row.done, hidden: false });
    redraw();
  } catch (e) { failed(e, `save "${row.title}"`); }
}

// Above the reflection box: today's events, each with its check, and the day's one line. The
// wins list above says what got done, so the line leaves that out. `moving` counts the tasks he
// has sent to tomorrow so far.
export function todayPart(moving, redraw) {
  const rows = rowsOn(data.today).filter((r) => r.kind === "event");
  const line = shutdownLine({ done: 0, moving, turned_down: data.turned, trend: paceTrend(data.hist?.actuals ?? []) });
  return [
    rows.length ? el("section", { className: "sheet-shut-events" },
      el("h3", { textContent: "Today's events" }),
      el("ul", {}, ...rows.map((r) => {
        const b = el("button", { type: "button", className: `sheet-shut-event${r.done ? " is-done" : ""}`, textContent: r.title, onclick: () => toggleEvent(r, redraw) });
        b.setAttribute("aria-pressed", String(r.done));
        return el("li", {}, b);
      }))) : null,
    line ? el("p", { className: "small sheet-shut-line", textContent: line }) : null,
  ];
}

// Below the box, collapsed: the last few reflections, which were saved and never shown again.
export function pastPart() {
  if (!data.past.length) return null;
  return el("details", { className: "sheet-shut-past" },
    el("summary", { textContent: "Earlier reflections" }),
    el("ul", { className: "sheet-back-notes" }, ...data.past.map((d) => el("li", {},
      el("strong", { textContent: `${weekdayName(d.day)} ${dayLabel(d.day).date} ` }), d.reflection.trim()))));
}

// The Tomorrow step: its events, its tasks with those he is sending from today (`moving`), the
// load against the room, and a prompt for any that keep moving. Room is the cap or the free time
// around tomorrow's events, as planner.mjs's dayCapacity, read here since tomorrow can be outside
// the week on screen.
export function tomorrowPart(moving, redraw) {
  const { tomorrow, tasks, events, todos, hist } = data;
  const rows = dayRows({ day: tomorrow, timeZone: tz, tasks: [], events, blocks: state.blocks, todos });
  // A task moved out of the dialog since it opened reads from state.
  const staying = tasks.map((t) => state.tasks.get(t.id) ?? t).filter((t) => t.day === tomorrow && !t.done);
  const added = [...state.tasks.values()].filter((t) => t.day === tomorrow && !t.done && !staying.some((x) => x.id === t.id));
  const onTomorrow = [...staying, ...added];
  const room = Math.min(workloadCap(), freeMinutes(eventsOnDay(events, tomorrow, tz), dayStart(tomorrow), shutdownAt(tomorrow)));
  const { total } = load([...onTomorrow, ...moving], room);
  const feedback = hist?.feedback ?? [];
  const movers = [...onTomorrow, ...moving.map((t) => ({ ...t, rolls: (t.rolls ?? 0) + 1 }))]
    .filter((t) => keepsMoving(t, feedback, data.today, tz)).map((t) => state.tasks.get(t.id) ?? t);
  const prompts = moverPrompts(movers, tomorrow, redraw);
  const taskItems = [...onTomorrow.map((t) => el("li", { textContent: t.title })), ...moving.map((t) => el("li", {}, t.title, el("span", { className: "sheet-meta", textContent: " from today" })))];
  return [
    el("p", { className: "sheet-back-line", textContent: tomorrowLine(total, room) }),
    rows.length ? el("h3", { textContent: "Events" }) : null,
    rows.length ? el("ul", { className: "sheet-shut-list" }, ...rows.map((r) => el("li", {}, r.start == null || r.allDay ? null : el("span", { className: "sheet-meta", textContent: `${formatClock(r.start)} ` }), r.title))) : null,
    el("h3", { textContent: "Tasks" }),
    taskItems.length ? el("ul", { className: "sheet-shut-list" }, ...taskItems) : el("p", { className: "small", textContent: "Nothing on it yet." }),
    prompts,
  ];
}
