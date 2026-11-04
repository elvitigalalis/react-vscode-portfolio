// Event to-dos (docs/sheet-v5.md, "Event to-dos"): every Google Calendar event on a day is also a
// to-do in that day's list, so Lisul plans from one list in time order. The browser has the raw
// titles from Google and never saves them; event_todos keeps only done, hidden and a concise
// title Claude wrote (title_ai), by the event's key.
import { eventsOnDay, minutesOn } from "./logic.mjs";
import { linkish } from "./proposal.mjs";

// An event's key: the calendar it was read from ("primary" for his main one) and its ID.
// Calendar IDs and event IDs hold no ":", so the event ID is everything after the last one.
export const eventKey = (calendar, id) => `${calendar}:${id}`;
const eventIdOf = (key) => key.slice(key.lastIndexOf(":") + 1);

const clock = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// A day's rows in order: all-day events first; then, by time, events (by start), tasks with an
// at_time and tasks with an approved block that day (by its start); then the untimed tasks in
// the order given. Ties keep events before tasks.
// - events: calendarEvents' events ({ id, calendar, title, allDay, starts_at, ends_at, link }).
//   The Sheet's own block events (a block's gcal_id) are left out: their tasks are on the list.
// - tasks: the day's tasks, in their order. blocks: blocks rows. todos: event_todos rows.
// An event row is { kind: "event", key, title, raw, allDay, start, end, done, link }: start and
// end are minutes past midnight on the day; title is title_ai, else the raw title trimmed. A
// hidden event has no row. done and hidden are read from the row under the browser's own key;
// title_ai also from a row Claude wrote under another calendar ID for the same event.
export function dayRows({ day, timeZone, tasks, events, blocks, todos }) {
  const sheetEvents = new Set(blocks.map((b) => b.gcal_id).filter(Boolean));
  const byKey = new Map(todos.map((t) => [t.cal_event_key, t]));
  const byEvent = new Map(todos.map((t) => [eventIdOf(t.cal_event_key), t]));
  const evRows = eventsOnDay(events.filter((e) => e.id && !sheetEvents.has(e.id)), day, timeZone).flatMap((e) => {
    const key = eventKey(e.calendar, e.id);
    const own = byKey.get(key);
    if (own?.hidden) return [];
    const raw = String(e.title ?? "").replace(/\s+/g, " ").trim() || "Busy";
    const title = own?.title_ai ?? byEvent.get(e.id)?.title_ai ?? raw;
    return [{ kind: "event", key, title, raw, allDay: e.allDay, start: Math.max(0, e.start), end: e.end, done: Boolean(own?.done), link: e.link ?? null }];
  });
  const blockStart = (id) => {
    const starts = blocks.filter((b) => b.task_id === id && !b.proposed)
      .map((b) => minutesOn(b.starts_at, day, timeZone)).filter((m) => m >= 0 && m < 1440);
    return starts.length ? Math.min(...starts) : null;
  };
  const timed = [];
  const untimed = [];
  for (const t of tasks) {
    const at = t.at_time ? clock(t.at_time) : blockStart(t.id);
    if (at == null) untimed.push({ kind: "task", task: t });
    else timed.push({ kind: "task", task: t, at });
  }
  const allDay = evRows.filter((r) => r.allDay);
  const withTime = [...evRows.filter((r) => !r.allDay).map((r) => ({ ...r, at: r.start })), ...timed]
    .map((r, i) => ({ r, i })).sort((a, b) => a.r.at - b.r.at || a.i - b.i).map(({ r: { at, ...r } }) => r);
  return [...allDay, ...withTime, ...untimed];
}

// --- Concise titles from Claude (planner-mcp's submit_proposal and answer_messages) ---------

export const MAX_EVENT_TODOS = 80;
export const MAX_TITLE = 60;
// Line breaks and other control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// A calendar ID has no ":" or space ("primary", an address, …@group.calendar.google.com); an
// event ID is letters, digits, "_" and "-" (a recurring instance's is "<id>_20261104T140000Z").
const CALENDAR_ID = /^[^\s:]{1,255}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;

// The event_todos field: [{ calendar_id, event_id, title }], title a one-line to-do of at most 60
// characters with no link. Returns the rows to save, { cal_event_key, title_ai }, and an error
// naming each item refused; the others are kept. A second title for the same event is refused.
export function checkEventTodos(items) {
  const errors = [];
  const rows = [];
  if (items == null) return { errors, rows };
  if (!Array.isArray(items)) return { errors: ["event_todos: must be a list"], rows };
  if (items.length > MAX_EVENT_TODOS) return { errors: [`event_todos: at most ${MAX_EVENT_TODOS}, got ${items.length}`], rows };
  const seen = new Set();
  items.forEach((x, i) => {
    const name = `event_todos[${i}]`;
    const title = typeof x?.title === "string" ? x.title.trim() : "";
    if (!CALENDAR_ID.test(x?.calendar_id ?? "")) return errors.push(`${name}.calendar_id: a Google Calendar ID, as list_events gave it`);
    if (!EVENT_ID.test(x?.event_id ?? "")) return errors.push(`${name}.event_id: a Google Calendar event ID, as list_events gave it`);
    const key = eventKey(x.calendar_id, x.event_id);
    if (seen.has(key)) return errors.push(`${name}.event_id: that event already has a title above`);
    if (!title || title.length > MAX_TITLE) return errors.push(`${name}.title: 1 to ${MAX_TITLE} characters`);
    if (CONTROL.test(title)) return errors.push(`${name}.title: must be one line, with no line breaks or control characters`);
    if (linkish(title)) return errors.push(`${name}.title: no URL or anything that reads as a link`);
    seen.add(key);
    rows.push({ cal_event_key: key, title_ai: title });
  });
  return { errors, rows };
}
