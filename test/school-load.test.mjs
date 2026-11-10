import { test } from "node:test";
import assert from "node:assert/strict";
import { isSchool, isSchoolWork, isSchoolTag, guessMinutes, schoolMinutes, schoolDue, freeOn, weekLoad, QUICK_EST, DEFAULT_SCHOOL_EST } from "../src/sheet/school-load.mjs";
import { weekDays } from "../src/sheet/logic.mjs";

const T = (title, extra = {}) => ({ id: title, title, day: null, list: "Brightspace", due: null, est_min: null, at_time: null, tag: null, done: false, source: null, project_id: null, ...extra });
const days = weekDays("2026-11-09"); // Mon Nov 9 – Sun Nov 15

test("school is Brightspace's or tagged with a course or #school", () => {
  assert.ok(isSchool(T("Quiz 6", { source: "brightspace" })));
  for (const tag of ["cse316", "AMS 261", "ams-261", "school", "Class"]) assert.ok(isSchoolTag(tag), tag);
  for (const tag of [null, "", "workit", "campus", "cse", "c3160"]) assert.ok(!isSchoolTag(tag), String(tag));
  assert.ok(isSchool(T("Lab writeup", { tag: "cse320" })));
  assert.ok(!isSchool(T("Ship auth", { tag: "workit", source: "github" })));
  // A timed Brightspace event is something he goes to, not work due.
  assert.ok(!isSchoolWork(T("AMS 261 Exam 2", { source: "brightspace", day: "2026-11-10", at_time: "14:00:00", est_min: 80 })));
});

test("a missing estimate falls back to a guess by kind", () => {
  assert.equal(guessMinutes(T("CSE 416 final project report")), 240);
  assert.equal(guessMinutes(T("Midterm 2")), 180);
  assert.equal(guessMinutes(T("Homework 5")), 120);
  assert.equal(guessMinutes(T("Lab 7")), 120);
  assert.equal(guessMinutes(T("Quiz 6")), 60);
  assert.equal(guessMinutes(T("Discussion week 10")), 30);
  assert.equal(guessMinutes(T("Unit 4 thing")), DEFAULT_SCHOOL_EST);
  assert.deepEqual(schoolMinutes(T("Quiz 6", { est_min: 45 })), { minutes: 45, guess: false });
  assert.deepEqual(schoolMinutes(T("Quiz 6")), { minutes: 60, guess: true });
  assert.deepEqual(QUICK_EST, [30, 60, 120, 240, 480]);
});

test("the week's school work: due in the week, overdue on the current week, earliest first", () => {
  const tasks = [
    T("HW 5", { source: "brightspace", due: "2026-11-12", est_min: 90 }),
    T("Quiz 6", { source: "brightspace", due: "2026-11-10" }),
    T("Late lab", { source: "brightspace", due: "2026-11-06" }),
    T("Long gone", { source: "brightspace", due: "2026-10-26" }),
    T("Two weeks late", { source: "brightspace", due: "2026-10-27" }),
    T("Next week's paper", { source: "brightspace", due: "2026-11-17" }),
    T("Done HW", { source: "brightspace", due: "2026-11-11", done: true }),
    T("Read ch. 7", { tag: "cse320", day: "2026-11-13", list: null }),
    T("Ship auth", { tag: "workit", day: "2026-11-11", list: null, est_min: 60 }),
    T("Exam", { source: "brightspace", day: "2026-11-11", at_time: "10:00:00", est_min: 80, list: null }),
    T("Step", { tag: "cse416", due: "2026-11-12", project_id: "p1" }),
  ];
  const now = schoolDue(tasks, days, "2026-11-10");
  // Overdue counts for 14 days: Oct 27 is in, Oct 26 is let go.
  assert.deepEqual(now.map((i) => i.task.title), ["Two weeks late", "Late lab", "Quiz 6", "HW 5", "Read ch. 7"]);
  assert.deepEqual(now.slice(1).map((i) => [i.minutes, i.guess]), [[120, true], [60, true], [90, false], [30, true]]);
  // Viewing a later week, the overdue lab belongs to the week it's in, not this one.
  assert.deepEqual(schoolDue(tasks, weekDays("2026-11-16"), "2026-11-10").map((i) => i.task.title), ["Next week's paper"]);
});

test("free time is the calendar's gaps less fixed-time tasks", () => {
  const events = [{ busy: true, allDay: false, start: 600, end: 660 }, { busy: false, allDay: false, start: 700, end: 760 }];
  assert.equal(freeOn(events, [], 540, 1320), 720); // 9:00–22:00 less an hour
  const fixed = [
    T("Exam", { at_time: "14:00:00", est_min: 80 }),
    T("Inside the event", { at_time: "10:15", est_min: 15 }),
    T("No estimate", { at_time: "18:00" }),
    T("Done", { at_time: "19:00", est_min: 60, done: true }),
    T("Untimed", { est_min: 60 }),
  ];
  assert.equal(freeOn(events, fixed, 540, 1320), 720 - 80 - 30);
  assert.equal(freeOn(events, fixed, 1320, 1320), 0);
  assert.equal(freeOn(events, fixed, 1400, 1320), 0);
  // Held to the workload cap, as the day chips are.
  assert.equal(freeOn(events, fixed, 540, 1320, 330), 330);
  assert.equal(freeOn(events, fixed, 540, 1320, 900), 720 - 80 - 30);
});

test("the week's load: need against free from today on, crunch when over", () => {
  const tasks = [T("HW 5", { source: "brightspace", due: "2026-11-12", est_min: 300 }), T("Quiz 6", { source: "brightspace", due: "2026-11-13" })];
  const free = Object.fromEntries(days.map((d) => [d, 120]));
  const w = weekLoad(tasks, days, "2026-11-12", free); // Thu: Thu–Sun left, 4 × 2h
  assert.equal(w.need, 360);
  assert.equal(w.free, 480);
  assert.equal(w.guessed, 1);
  assert.equal(w.level, "ok");
  assert.equal(w.pct, 75);
  assert.equal(w.crunch, false);
  const tight = weekLoad(tasks, days, "2026-11-14", free); // Sat: 4h left
  assert.equal(tight.level, "over");
  assert.equal(tight.crunch, true);
  assert.equal(tight.short, 120);
  assert.equal(tight.pct, 100);
  assert.equal(weekLoad(tasks, days, "2026-11-13", { ...free, "2026-11-13": 160 }).level, "near"); // 360 of 400
  assert.equal(weekLoad([], days, "2026-11-12", free).level, "ok");
  assert.equal(weekLoad(tasks, days, "2026-11-16", free), null); // a past week
  assert.equal(weekLoad(tasks, weekDays("2026-11-16"), "2026-11-12", free).need, 0);
});
