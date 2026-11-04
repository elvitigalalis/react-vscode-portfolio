// courseEventChanges and courseRemovals (src/sheet/feeds.mjs): Brightspace's items that aren't due
// dates (exams, quizzes, class events, holidays) and items cancelled or gone from the feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIcs } from "../src/sheet/ical.mjs";
import { courseChanges, courseEventChanges, courseRemovals, courseTaskChanges } from "../src/sheet/feeds.mjs";

const TZ = "America/New_York";
const TODAY = "2026-11-04";
const feed = () => parseIcs(readFileSync(new URL("fixtures/brightspace-events.ics", import.meta.url), "utf8"),
  { from: "2026-11-03T12:00:00.000Z", to: "2027-05-05T12:00:00.000Z" });
const timed = (uid, summary, start, end, location = "AMS 261.01 - Fall 2026") => ({ uid, summary, description: "", location, url: "", categories: [], start, end, allDay: false });
const task = (id, uid, fields) => ({ id, title: "x", day: null, list: "Brightspace", due: null, at_time: null, est_min: null, done: false, source: "brightspace", source_uid: uid, ...fields });
const row = (r) => [r.source_uid.split("@")[0], r.title, r.day, r.at_time, r.est_min];

test("course events: the fixture's exams, quizzes and events become tasks on their day, at their time", () => {
  const out = courseEventChanges(feed(), { tasks: [], seen: [], timeZone: TZ, today: TODAY });
  assert.deepEqual(out.insert.map(row), [
    ["6686-2001", "AMS 261 Exam 2", "2026-11-10", "08:30", 90], // TZID, local time
    ["6686-2002", "CSE 320 Midterm 2", "2026-11-19", "20:30", 80], // Z and DURATION, folded SUMMARY
    ["6686-2004", "Thanksgiving Break - No Classes", "2026-11-25", null, null], // all-day DATE, no course
    ["6686-2005", "AMS261 review session", "2026-11-16", "15:00", 60], // names its course already; listed twice
    ["6686-2009", "CSE 320 Quiz 7", "2026-12-03", "11:00", null], // zero length: a time, no estimate
  ]);
  // Skipped: the cancelled quiz, the due item and the start date (courseTaskChanges' business), and
  // yesterday's check-off.
  for (const r of out.insert) {
    assert.equal(r.list, null);
    assert.equal(r.due, null);
    assert.equal(r.public, false);
    assert.equal(r.source, "brightspace");
  }
  assert.deepEqual(out.seen.map((s) => s.uid.split("@")[0]), ["6686-2001", "6686-2002", "6686-2004", "6686-2005", "6686-2009"]);
  assert.deepEqual(out.update, []);
  // The due item still comes through the due-date path, unchanged.
  assert.deepEqual(courseTaskChanges(feed(), { tasks: [], seen: [], timeZone: TZ }).insert.map((r) => [r.title, r.due]), [["Homework 7", "2026-11-20"]]);
});

test("course events: a moved or renamed event updates its undone task; a done or deleted one is left alone", () => {
  const events = [timed("e1", "Exam 2", "2026-11-11T14:00:00.000Z", "2026-11-11T15:30:00.000Z"), timed("e2", "Exam 3", "2026-12-08T14:00:00.000Z", "2026-12-08T15:00:00.000Z"),
    timed("e3", "Exam 1 makeup", "2026-11-20T14:00:00.000Z", "2026-11-20T15:00:00.000Z")];
  const tasks = [task("t1", "e1", { title: "AMS 261 Exam 2", day: "2026-11-10", list: null, at_time: "08:30:00", est_min: 90 }), task("t2", "e2", { done: true, day: "2026-12-01" })];
  const out = courseEventChanges(events, { tasks, seen: ["e1", "e2", "e3"], timeZone: TZ, today: TODAY });
  assert.deepEqual(out.insert, []);
  assert.deepEqual(out.update, [{ id: "t1", title: "AMS 261 Exam 2", day: "2026-11-11", list: null, at_time: "09:00", est_min: 90 }]);
  const same = courseEventChanges([events[0]], { tasks: [{ ...tasks[0], day: "2026-11-11", at_time: "09:00:00" }], seen: ["e1"], timeZone: TZ, today: TODAY });
  assert.deepEqual(same.update, [], "an unchanged task gets no update");
});

test("course events: an estimate is capped at 4 hours", () => {
  const [r] = courseEventChanges([timed("long", "Final exam", "2026-12-10T13:00:00.000Z", "2026-12-10T19:00:00.000Z")], { tasks: [], seen: [], timeZone: TZ, today: TODAY }).insert;
  assert.equal(r.est_min, 240);
});

test("course removals: an undone task whose item is cancelled or gone from the feed goes; past, done and hand-made ones stay", () => {
  const events = feed();
  const tasks = [
    task("cancelled", "6686-2003@mycourses.example.edu", { day: "2026-11-12", at_time: "14:00:00" }),
    task("gone", "6686-9999@mycourses.example.edu", { due: "2026-11-20", day: "2026-11-06" }),
    task("kept", "6686-2001@mycourses.example.edu", { day: "2026-11-10" }),
    task("past", "6686-9998@mycourses.example.edu", { due: "2026-11-01" }),
    task("done", "6686-9997@mycourses.example.edu", { due: "2026-11-20", done: true }),
    task("beyond", "6686-9996@mycourses.example.edu", { due: "2027-08-01" }),
    { id: "mine", title: "AMS261 Exam", day: "2026-11-10", done: false, source: null, source_uid: null },
  ];
  const out = courseRemovals(events, { tasks, today: TODAY, until: "2027-05-04" });
  assert.deepEqual(out, [{ id: "cancelled", uid: "6686-2003@mycourses.example.edu" }, { id: "gone", uid: "6686-9999@mycourses.example.edu" }]);
  assert.deepEqual(courseRemovals([], { tasks, today: TODAY, until: "2027-05-04" }), [], "an empty feed removes nothing");
});

test("course removals: a cancelled due item is not inserted either", () => {
  const e = { ...timed("q", "Quiz 5 - Due", "2026-11-12T04:59:00.000Z", "2026-11-12T04:59:00.000Z"), status: "CANCELLED" };
  assert.deepEqual(courseTaskChanges([e], { tasks: [], seen: [], timeZone: TZ }).insert, []);
});

test("courseChanges: event tasks count by their day, and a removal is a course change", () => {
  const rows = courseChanges({ insert: [{ due: null, day: "2026-11-05", source_uid: "a" }], update: [{ id: "t1", day: "2026-11-20" }], removed: [{ id: "t2", uid: "c" }] },
    [{ id: "t1", source_uid: "b" }], TODAY);
  assert.deepEqual(rows.map((c) => [c.reason, c.ref]), [["course_due_soon", "a"], ["course_change", "b"], ["course_change", "c"]]);
});
