// Event to-dos (src/sheet/event-todos.mjs, docs/sheet-v5.md, "Event to-dos"): a day's calendar
// events merged into its to-do list in time order, and what submit_proposal and answer_messages
// accept as concise titles. Expected values are worked out by hand.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRows, checkEventTodos } from "../src/sheet/event-todos.mjs";

const TZ = "America/New_York";
const DAY = "2026-11-04";
const task = (id, position, extra = {}) => ({ id, title: id, day: DAY, position, at_time: null, done: false, ...extra });
const ev = (id, title, starts_at, ends_at, extra = {}) => ({ id, title, starts_at, ends_at, allDay: false, calendar: "primary", link: null, ...extra });
const shape = (rows) => rows.map((r) => (r.kind === "task" ? r.task.id : `ev:${r.title}`));

// ---------------------------------------------------------------- dayRows

test("dayRows: all-day events first, then events and timed tasks by time, then untimed tasks in their order", () => {
  const rows = dayRows({
    day: DAY, timeZone: TZ, blocks: [], todos: [],
    tasks: [task("untimed b", 1), task("at 13:00", 2, { at_time: "13:00:00" }), task("untimed a", 3)],
    events: [
      ev("e2", "CSE 416 lecture", "2026-11-04T19:00:00Z", "2026-11-04T20:20:00Z"), // 2:00-3:20 pm
      ev("e1", "Dentist", "2026-11-04T14:00:00Z", "2026-11-04T15:15:00Z"), // 9:00-10:15 am
      ev("e3", "Election Day", DAY, "2026-11-05", { allDay: true }),
    ],
  });
  assert.deepEqual(shape(rows), ["ev:Election Day", "ev:Dentist", "at 13:00", "ev:CSE 416 lecture", "untimed b", "untimed a"]);
  const dentist = rows[1];
  assert.equal(dentist.key, "primary:e1");
  assert.equal(dentist.start, 9 * 60);
  assert.equal(dentist.end, 10 * 60 + 15);
  assert.equal(dentist.done, false);
});

test("dayRows: The Sheet's own block events are left out, and a task sorts by its approved block, else its pending block", () => {
  const rows = dayRows({
    day: DAY, timeZone: TZ, todos: [],
    tasks: [task("read ch. 4", 1), task("proposed only", 2)],
    blocks: [
      { id: "b1", task_id: "read ch. 4", starts_at: "2026-11-04T16:00:00Z", ends_at: "2026-11-04T17:00:00Z", proposed: false, gcal_id: "blk1" }, // 11:00 am
      { id: "b2", task_id: "proposed only", starts_at: "2026-11-04T13:00:00Z", ends_at: "2026-11-04T14:00:00Z", proposed: true, gcal_id: null },
    ],
    events: [
      ev("blk1", "Read ch. 4", "2026-11-04T16:00:00Z", "2026-11-04T17:00:00Z", { calendar: "tb@group.calendar.google.com" }),
      ev("e1", "Gym", "2026-11-04T17:00:00Z", "2026-11-04T18:00:00Z"), // noon
      ev("e0", "Standup", "2026-11-04T15:30:00Z", "2026-11-04T15:45:00Z"), // 10:30 am
    ],
  });
  // A task with only a pending (proposed) block sorts by that block too: 8:00 am comes first.
  assert.deepEqual(shape(rows), ["proposed only", "ev:Standup", "read ch. 4", "ev:Gym"]);
});

test("dayRows: done and hidden come from event_todos; title_ai replaces the raw title, which is trimmed", () => {
  const rows = dayRows({
    day: DAY, timeZone: TZ, tasks: [], blocks: [],
    events: [
      ev("e1", "  CSE 416:   Software Engineering (LEC 01)  ", "2026-11-04T19:00:00Z", "2026-11-04T20:20:00Z"),
      ev("e2", "Weekly sync", "2026-11-04T20:30:00Z", "2026-11-04T21:00:00Z"),
      ev("e3", "Office hours", "2026-11-04T22:00:00Z", "2026-11-04T23:00:00Z"),
      ev("e4", "Club meeting", "2026-11-04T23:00:00Z", "2026-11-05T00:00:00Z"),
    ],
    todos: [
      { cal_event_key: "primary:e1", title_ai: "Go to CSE 416 lecture", done: true, hidden: false },
      { cal_event_key: "primary:e2", title_ai: null, done: false, hidden: true },
      // Claude read the main calendar under his address; its title still applies, by event ID.
      { cal_event_key: "lisul@example.com:e3", title_ai: "Go to office hours", done: true, hidden: true },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.title, r.done]), [
    ["Go to CSE 416 lecture", true],
    // done and hidden belong to the browser's own key only.
    ["Go to office hours", false],
    ["Club meeting", false],
  ]);
  assert.equal(rows[0].raw, "CSE 416: Software Engineering (LEC 01)");
});

test("dayRows: times are local across a daylight-saving change, and an event from the night before starts at midnight", () => {
  // Sunday 2026-11-01: clocks go back at 2:00 am EDT (UTC-4) to 1:00 am EST (UTC-5).
  const day = "2026-11-01";
  const rows = dayRows({
    day, timeZone: TZ, blocks: [], todos: [],
    tasks: [{ ...task("call home", 1), day, at_time: "09:30:00" }],
    events: [
      ev("e1", "Brunch", "2026-11-01T15:00:00Z", "2026-11-01T16:00:00Z"), // 10:00 am EST
      ev("e2", "Late party", "2026-11-01T03:00:00Z", "2026-11-01T06:30:00Z"), // 11:00 pm EDT Oct 31 to 1:30 am EST
      ev("e3", "Early flight", "2026-11-01T11:00:00Z", "2026-11-01T12:00:00Z"), // 6:00 am EST
    ],
  });
  assert.deepEqual(rows.map((r) => (r.kind === "task" ? r.task.id : [r.title, r.start, r.end])), [
    ["Late party", 0, 90], // ends 1:30 am EST, by the wall clock
    ["Early flight", 6 * 60, 7 * 60],
    "call home",
    ["Brunch", 10 * 60, 11 * 60],
  ]);
});

test("dayRows: a multi-day all-day event is on each of its days, and an event with no ID has no row", () => {
  const args = (day) => ({
    day, timeZone: TZ, tasks: [], blocks: [], todos: [],
    events: [
      ev("trip", "Conference", "2026-11-03", "2026-11-05", { allDay: true }),
      { title: "Cached without an ID", starts_at: "2026-11-04T14:00:00Z", ends_at: "2026-11-04T15:00:00Z", allDay: false, calendar: "primary" },
    ],
  });
  assert.deepEqual(shape(dayRows(args("2026-11-03"))), ["ev:Conference"]);
  assert.deepEqual(shape(dayRows(args(DAY))), ["ev:Conference"]);
  assert.deepEqual(shape(dayRows(args("2026-11-05"))), []);
});

// ---------------------------------------------------------------- checkEventTodos

test("checkEventTodos: each { calendar_id, event_id, title } becomes a key and a trimmed title", () => {
  assert.deepEqual(checkEventTodos([
    { calendar_id: "primary", event_id: "4f2k9q8c1a_20261104T140000Z", title: "  Go to CSE 416 lecture " },
    { calendar_id: "abc123@group.calendar.google.com", event_id: "x7y", title: "Dentist" },
  ]), {
    errors: [],
    rows: [
      { cal_event_key: "primary:4f2k9q8c1a_20261104T140000Z", title_ai: "Go to CSE 416 lecture" },
      { cal_event_key: "abc123@group.calendar.google.com:x7y", title_ai: "Dentist" },
    ],
  });
  assert.deepEqual(checkEventTodos(undefined), { errors: [], rows: [] });
  assert.deepEqual(checkEventTodos(null), { errors: [], rows: [] });
});

test("checkEventTodos: refuses a long, multi-line or link-like title and a bad ID, naming each, and keeps the rest", () => {
  const ok = { calendar_id: "primary", event_id: "good1", title: "Build XYZ" };
  const out = checkEventTodos([
    ok,
    { calendar_id: "primary", event_id: "e2", title: "x".repeat(61) },
    { calendar_id: "primary", event_id: "e3", title: "Read\nthis" },
    { calendar_id: "primary", event_id: "e4", title: "Join at zoom.us/j/123" },
    { calendar_id: "primary", event_id: "e5", title: "   " },
    { calendar_id: "prim:ary", event_id: "e6", title: "Gym" },
    { calendar_id: "primary", event_id: "bad id!", title: "Gym" },
    { calendar_id: "primary", event_id: "good1", title: "Again" },
  ]);
  assert.deepEqual(out.rows, [{ cal_event_key: "primary:good1", title_ai: "Build XYZ" }]);
  assert.deepEqual(out.errors.map((e) => e.split(":")[0]), [
    "event_todos[1].title", "event_todos[2].title", "event_todos[3].title", "event_todos[4].title",
    "event_todos[5].calendar_id", "event_todos[6].event_id", "event_todos[7].event_id",
  ]);
  assert.deepEqual(checkEventTodos("nope").errors, ["event_todos: must be a list"]);
  assert.match(checkEventTodos(Array.from({ length: 81 }, (_, i) => ({ ...ok, event_id: `e${i}` }))).errors[0], /^event_todos: at most 80/);
});

test("dayRows: an approved block wins over a pending one for the same task", () => {
  const rows = dayRows({
    day: DAY, timeZone: TZ, todos: [],
    tasks: [task("lab", 1), task("essay", 2)],
    blocks: [
      { id: "b1", task_id: "lab", starts_at: "2026-11-04T20:00:00Z", ends_at: "2026-11-04T21:00:00Z", proposed: false, gcal_id: null }, // 3:00 pm approved
      { id: "b2", task_id: "lab", starts_at: "2026-11-04T14:00:00Z", ends_at: "2026-11-04T15:00:00Z", proposed: true, gcal_id: null }, // 9:00 am pending
      { id: "b3", task_id: "essay", starts_at: "2026-11-04T17:00:00Z", ends_at: "2026-11-04T18:00:00Z", proposed: true, gcal_id: null }, // noon pending
    ],
    events: [],
  });
  assert.deepEqual(shape(rows), ["essay", "lab"]);
});
