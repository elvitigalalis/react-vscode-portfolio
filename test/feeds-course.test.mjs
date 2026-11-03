// Extra cases for courseTaskChanges (src/sheet/feeds.mjs) beyond test/v3-b.verify.test.mjs:
// odd feed items and a database that half-finished an earlier sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIcs } from "../src/sheet/ical.mjs";
import { courseTaskChanges } from "../src/sheet/feeds.mjs";

const TZ = "America/New_York";
const timed = (uid, summary, at) => ({ uid, summary, description: "", location: "", url: "", categories: [], start: at, end: at, allDay: false });
const task = (id, uid, title, due, done = false) => ({ id, title, day: null, list: "Brightspace", position: 0, due, done, public: false, source: "brightspace", source_uid: uid });

test("course tasks: items with no UID, no title or an unreadable start are skipped", () => {
  const events = [
    timed("", "No UID - Due", "2026-11-06T04:59:00.000Z"),
    timed("blank", "   ", "2026-11-06T04:59:00.000Z"),
    timed("bad", "Bad date - Due", "not a date"),
    null,
    timed("ok", "Lab 9 - Due", "2026-11-06T04:59:00.000Z"),
  ];
  const out = courseTaskChanges(events, { tasks: [], seen: [], timeZone: TZ });
  assert.deepEqual(out.insert.map((r) => r.source_uid), ["ok"]);
});

test("course tasks: a task that already holds the UID is not inserted again, even unseen", () => {
  // An earlier run inserted the task but died before writing feed_seen.
  const out = courseTaskChanges([timed("hw", "Homework 6 - Due", "2026-11-06T04:59:00.000Z")], { tasks: [task("t1", "hw", "Homework 6 - Due", "2026-11-05")], seen: [], timeZone: TZ });
  assert.deepEqual(out, { insert: [], update: [], seen: [] });
});

test("course tasks: an unchanged task gets no update", () => {
  const out = courseTaskChanges([timed("hw", "Homework 6 - Due", "2026-11-06T04:59:00.000Z")], { tasks: [task("t1", "hw", "Homework 6 - Due", "2026-11-05")], seen: ["hw"], timeZone: TZ });
  assert.deepEqual(out.update, []);
});

test("course tasks: the Brightspace sample feed (TZID, Z, DURATION, RRULE, all-day) gives its due dates", () => {
  const events = parseIcs(readFileSync(new URL("fixtures/brightspace-sample.ics", import.meta.url), "utf8"), { from: "2026-10-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
  const out = courseTaskChanges(events, { tasks: [], seen: [], timeZone: TZ });
  assert.deepEqual(out.insert.map((r) => [r.title, r.due]), [
    ["Project 2 - Due", "2026-10-30"], // TZID local 11:59 pm, EDT
    ["Homework 4 - Due", "2026-11-05"], // TZID local, no DTEND
    ["Quiz 6 - Availability Ends", "2026-11-06"], // 04:59Z, 11:59 pm EST the day before
    ["Midterm 2", "2026-11-12"], // 8:30 pm local with a DURATION
    ["Recitation", "2026-11-04"], // weekly: the first one only
    ["Thanksgiving Break - No Classes", "2026-11-25"], // all-day, several days
  ]);
});
