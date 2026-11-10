// The phone's Doing view (src/sheet/doing.mjs). Times are minutes past midnight; expected values
// are written out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { doingPick, doingMode, minutesLeft } from "../src/sheet/doing.mjs";

const H = (h, m = 0) => h * 60 + m;
const task = (id, start = null, end = null, done = false) => ({ kind: "task", task: { id, title: id, done }, start, end });
const event = (key, start, end, extra = {}) => ({ kind: "event", key, title: key, start, end, done: false, allDay: false, ...extra });
const ids = (rows) => rows.map((r) => r.task?.id ?? r.key);

const rows = [
  event("allday", null, null, { allDay: true }),
  task("missed", H(9), H(10)),
  event("lecture", H(11), H(11, 50)),
  task("essay", H(12), H(13)),
  task("gym", H(17), H(18)),
  task("laundry"),
  task("email"),
  task("done", H(14), H(15), true),
];

test("doingPick: the row on now is the card; the next two to start follow", () => {
  const p = doingPick(rows, H(11, 10));
  assert.equal(p.kind, "now");
  assert.equal(p.card.key, "lecture");
  assert.deepEqual(ids(p.next), ["essay", "gym"]);
});

test("doingPick: between rows, the next to start; untimed tasks fill the list after timed ones", () => {
  const p = doingPick(rows, H(13, 30));
  assert.equal(p.kind, "next");
  assert.equal(p.card.task.id, "gym");
  assert.deepEqual(ids(p.next), ["laundry", "email"]);
});

test("doingPick: with nothing timed left, the first untimed task; a missed row never shows", () => {
  const p = doingPick(rows, H(19));
  assert.equal(p.kind, "untimed");
  assert.equal(p.card.task.id, "laundry");
  assert.deepEqual(ids(p.next), ["email"]);
  assert.ok(!ids(doingPick(rows, H(10, 30)).next).includes("missed"));
});

test("doingPick: a running focus session's task is the card, whatever is on now", () => {
  const p = doingPick(rows, H(11, 10), "gym");
  assert.equal(p.kind, "focus");
  assert.equal(p.card.task.id, "gym");
  assert.deepEqual(ids(p.next), ["essay", "laundry"]);
});

test("doingPick: nothing open, no card", () => {
  assert.deepEqual(doingPick([task("done", null, null, true)], H(12)), { card: null, kind: null, next: [] });
});

test("doingMode: Doing by day on a phone, the week outside it, and his pick for today wins", () => {
  const day = { today: "2026-11-09", dayStart: H(9, 30), shutdown: H(22), hasCard: true };
  assert.equal(doingMode({ ...day, minutes: H(12) }), "doing");
  assert.equal(doingMode({ ...day, minutes: H(8) }), "week");
  assert.equal(doingMode({ ...day, minutes: H(22, 30) }), "week");
  assert.equal(doingMode({ ...day, minutes: H(12), shutDown: true }), "week");
  assert.equal(doingMode({ ...day, minutes: H(12), hasCard: false }), "week");
  assert.equal(doingMode({ ...day, minutes: H(12), stored: { day: "2026-11-09", mode: "week" } }), "week");
  assert.equal(doingMode({ ...day, minutes: H(8), stored: { day: "2026-11-09", mode: "doing" } }), "doing");
  // dayStart on today is held to now rounded up to the quarter hour: 10:30 at 10:20 has begun.
  assert.equal(doingMode({ ...day, dayStart: H(10, 30), minutes: H(10, 20) }), "doing");
  assert.equal(doingMode({ ...day, dayStart: H(11), minutes: H(10, 20) }), "week");
  // Yesterday's pick doesn't carry over.
  assert.equal(doingMode({ ...day, minutes: H(12), stored: { day: "2026-11-08", mode: "week" } }), "doing");
});

test("minutesLeft: rounded up, hours from 60", () => {
  assert.equal(minutesLeft(24 * 60_000 + 1), "25 min");
  assert.equal(minutesLeft(0), "0 min");
  assert.equal(minutesLeft(65 * 60_000), "1h05");
});
