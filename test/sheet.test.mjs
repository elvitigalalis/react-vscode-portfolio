// The Sheet's logic (src/sheet/logic.mjs): the parts that decide, without a DOM or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, weekStart, weekDays, localNow, dayLabel, zonedIso, minutesOn, parseEntry, formatMinutes, formatClock, formatSpan,
  rowCount, positionBetween, load, planningDay, snap, blockOnComplete, proposedOn, googleStep, rollMark, barWidth, rightNow,
  eventsOnDay, freeMinutes, clashWith, visibleEvents, atRisk, dueLabel,
} from "../src/sheet/logic.mjs";

test("dates: weeks start on Monday and cross month ends", () => {
  assert.equal(weekStart("2026-10-20"), "2026-10-19");
  assert.equal(weekStart("2026-10-25"), "2026-10-19");
  assert.equal(weekStart("2026-10-19"), "2026-10-19");
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.deepEqual(weekDays("2026-10-30").slice(-2), ["2026-10-31", "2026-11-01"]);
  assert.deepEqual(dayLabel("2026-10-20"), { weekday: "TUE", date: "Oct 20" });
});

test("dates: today follows the owner's time zone, not UTC", () => {
  const now = new Date("2026-10-21T02:30:00Z"); // 10:30 pm on the 20th in New York
  assert.deepEqual(localNow(now, "America/New_York"), { day: "2026-10-20", minutes: 22 * 60 + 30 });
});

test("dates: a local clock time becomes the right instant, across daylight saving", () => {
  const tz = "America/New_York";
  assert.equal(zonedIso("2026-10-20", 9 * 60, tz), "2026-10-20T13:00:00.000Z"); // EDT
  assert.equal(zonedIso("2026-11-02", 9 * 60, tz), "2026-11-02T14:00:00.000Z"); // EST
  assert.equal(zonedIso("2026-11-01", 23 * 60, tz), "2026-11-02T04:00:00.000Z"); // the change day
  assert.equal(minutesOn("2026-10-20T13:00:00.000Z", "2026-10-20", tz), 9 * 60);
  assert.equal(minutesOn("2026-10-21T04:30:00.000Z", "2026-10-20", tz), 24 * 60 + 30);
});

test("typed details: estimate, time, tag and visibility come out of the title", () => {
  assert.deepEqual(parseEntry("Ship WorkIt auth ~45m #workit"),
    { title: "Ship WorkIt auth", est_min: 45, at_time: null, tag: "workit", public: true, due: null });
  assert.deepEqual(parseEntry("Dentist @3pm !private"),
    { title: "Dentist", est_min: null, at_time: "15:00", tag: null, public: false, due: null });
  assert.equal(parseEntry("Read ~1h30").est_min, 90);
  assert.equal(parseEntry("Read ~2h").est_min, 120);
  assert.equal(parseEntry("Read ~90").est_min, 90);
  assert.equal(parseEntry("Standup @9:30").at_time, "09:30");
  assert.equal(parseEntry("Lunch @12am").at_time, "00:00");
  assert.equal(parseEntry("Post #workit update !private").public, false);
  assert.equal(parseEntry("Gym !p").public, false);
  assert.equal(parseEntry("Gym !p").title, "Gym");
  assert.equal(parseEntry("Gym #life !public").public, true);
});

test("typed details: tasks are public by default and odd text stays in the title", () => {
  assert.equal(parseEntry("Call mom").public, true);
  assert.equal(parseEntry("Wow!p").title, "Wow!p");
  assert.equal(parseEntry("Email me@site.com about ~").title, "Email me@site.com about ~");
  assert.equal(parseEntry("Room @3").title, "Room @3");
  assert.equal(parseEntry("C# notes").title, "C# notes");
});

test("due dates: ^tomorrow is the day after the task's day", () => {
  const e = parseEntry("Essay ^tomorrow", "2026-10-31");
  assert.equal(e.due, "2026-11-01");
  assert.equal(e.title, "Essay");
});

test("due dates: a weekday rolls to its next occurrence from the task's day", () => {
  // 2026-10-28 is a Wednesday.
  assert.equal(parseEntry("Lab report ^fri", "2026-10-28").due, "2026-10-30");
  assert.equal(parseEntry("Lab report ^Friday", "2026-10-28").due, "2026-10-30");
  assert.equal(parseEntry("Lab report ^wed", "2026-10-28").due, "2026-10-28");
  assert.equal(parseEntry("Lab report ^tue", "2026-10-28").due, "2026-11-03");
  // Across the weekend: from Saturday, "mon" is two days on and "sat" is the same day.
  assert.equal(parseEntry("Pset ^mon", "2026-10-31").due, "2026-11-02");
  assert.equal(parseEntry("Pset ^sat", "2026-10-31").due, "2026-10-31");
  assert.equal(parseEntry("Pset ^sun", "2026-10-31").due, "2026-11-01");
  assert.equal(parseEntry("Pset ^thurs", "2026-10-31").due, "2026-11-05");
});

test("due dates: month/day is the next such date, crossing the year end", () => {
  assert.equal(parseEntry("Essay ^10/30", "2026-10-26").due, "2026-10-30");
  assert.equal(parseEntry("Essay ^1/5", "2026-12-20").due, "2027-01-05");
  assert.equal(parseEntry("Essay ^10/26", "2026-10-26").due, "2026-10-26");
  assert.equal(parseEntry("Essay ^2/29", "2026-10-26").due, "2028-02-29");
});

test("due dates: text that is not a date stays in the title", () => {
  assert.deepEqual(parseEntry("Read ^fr", "2026-10-26"), { title: "Read ^fr", est_min: null, at_time: null, tag: null, public: true, due: null });
  assert.equal(parseEntry("Read ^13/40", "2026-10-26").title, "Read ^13/40");
  assert.equal(parseEntry("Read ^2/30", "2026-10-26").title, "Read ^2/30");
  assert.equal(parseEntry("x^2 practice", "2026-10-26").title, "x^2 practice");
  assert.equal(parseEntry("Read ^", "2026-10-26").title, "Read ^");
  assert.equal(parseEntry("Read ^someday", "2026-10-26").due, null);
});

test("due dates: combine with the other typed details in any order", () => {
  assert.deepEqual(parseEntry("OS homework ^fri ~45m @3pm #cse !p", "2026-10-26"),
    { title: "OS homework", est_min: 45, at_time: "15:00", tag: "cse", public: false, due: "2026-10-30" });
  assert.deepEqual(parseEntry("#cse ^10/30 Lab ~1h", "2026-10-26"),
    { title: "Lab", est_min: 60, at_time: null, tag: "cse", public: true, due: "2026-10-30" });
});

test("formatting minutes and clock times", () => {
  assert.equal(formatMinutes(200), "3h20");
  assert.equal(formatMinutes(330), "5h30");
  assert.equal(formatMinutes(120), "2h");
  assert.equal(formatMinutes(45), "45m");
  assert.equal(formatClock(16 * 60 + 40), "4:40 pm");
  assert.equal(formatClock(0), "12:00 am");
  assert.equal(formatSpan(8 * 60, 9 * 60 + 20), "8–9:20 am");
  assert.equal(formatSpan(11 * 60 + 30, 13 * 60), "11:30 am–1 pm");
  assert.equal(formatSpan(22 * 60, 26 * 60), "10 pm–12 am");
});

test("the week grid: rows line up at the busiest day plus one", () => {
  assert.equal(rowCount({ a: [1, 2, 3], b: [1], c: [] }), 4);
  assert.equal(rowCount({}), 1);
  assert.equal(positionBetween(1, 2), 1.5);
  assert.equal(positionBetween(null, 1), 0);
  assert.equal(positionBetween(4, null), 5);
  assert.equal(positionBetween(null, null), 1);
});

test("plan today: the load meter turns amber near capacity and red over it", () => {
  const t = (est_min, done = false) => ({ est_min, done });
  assert.equal(load([t(60), t(60)], 330).level, "ok");
  assert.equal(load([t(200), t(90)], 330).level, "near");
  assert.equal(load([t(200), t(200)], 330).level, "over");
  assert.equal(load([t(200), t(200, true), t(null)], 330).total, 200);
});

test("plan today: after 3 pm it plans tomorrow; blocks snap to 15 minutes", () => {
  assert.equal(planningDay({ day: "2026-10-20", minutes: 9 * 60 }), "2026-10-20");
  assert.equal(planningDay({ day: "2026-10-20", minutes: 15 * 60 }), "2026-10-21");
  assert.equal(snap(607), 600);
  assert.equal(snap(608), 615);
});

test("block rules: completing early deletes, during shrinks, after keeps", () => {
  const block = { starts_at: "2026-10-20T17:00:00Z", ends_at: "2026-10-20T18:00:00Z" };
  assert.deepEqual(blockOnComplete(block, new Date("2026-10-20T16:00:00Z")), { action: "delete" });
  assert.deepEqual(blockOnComplete(block, new Date("2026-10-20T17:30:00Z")), { action: "shrink", ends_at: "2026-10-20T17:30:00.000Z" });
  assert.deepEqual(blockOnComplete(block, new Date("2026-10-20T19:00:00Z")), { action: "keep" });
});

test("block rules: completing a task turns down its proposed blocks, whenever it happens", () => {
  const block = { starts_at: "2026-10-20T17:00:00Z", ends_at: "2026-10-20T18:00:00Z", proposed: true };
  assert.deepEqual(blockOnComplete(block, new Date("2026-10-20T16:00:00Z")), { action: "delete" });
  assert.deepEqual(blockOnComplete(block, new Date("2026-10-20T17:30:00Z")), { action: "delete" });
  assert.deepEqual(blockOnComplete(block, new Date("2026-10-20T19:00:00Z")), { action: "delete" });
});

test("proposals: a day's proposed blocks, by start, in the owner's time zone", () => {
  const tz = "America/New_York";
  const blocks = [
    { id: "late", starts_at: "2026-10-21T03:30:00Z", proposed: true },  // 11:30 pm on the 20th
    { id: "real", starts_at: "2026-10-20T14:00:00Z", proposed: false },
    { id: "early", starts_at: "2026-10-20T13:00:00Z", proposed: true }, // 9 am
    { id: "next", starts_at: "2026-10-21T04:30:00Z", proposed: true },  // 12:30 am on the 21st
  ];
  assert.deepEqual(proposedOn(blocks, "2026-10-20", tz).map((b) => b.id), ["early", "late"]);
  assert.deepEqual(proposedOn(blocks, "2026-10-21", tz).map((b) => b.id), ["next"]);
  assert.deepEqual(proposedOn(blocks, "2026-10-22", tz), []);
});

test("proposals: moving or resizing a proposed block approves it, making its Google event", () => {
  assert.equal(googleStep({ proposed: true, gcal_id: null }), "create");
  assert.equal(googleStep({ proposed: false, gcal_id: "ev1" }), "patch");
  // A block made while Google was off has no event to change.
  assert.equal(googleStep({ proposed: false, gcal_id: null }), null);
});

test("rollover marks and the public view's redaction", () => {
  assert.equal(rollMark(0), "");
  assert.equal(rollMark(1), "②");
  assert.equal(rollMark(2), "③");
  assert.equal(barWidth(2), 4);
  assert.equal(barWidth(40), 24);
  assert.equal(rightNow({ public: true, title: "WorkIt auth" }), "WorkIt auth");
  assert.equal(rightNow({ public: false, title: null }), "Heads down");
  assert.equal(rightNow({ public: null }), null);
});

test("calendar events: placed on their days, all-day first", () => {
  const tz = "America/New_York";
  const events = [
    { title: "Hitachi sync", allDay: false, busy: true, starts_at: "2026-10-21T17:00:00Z", ends_at: "2026-10-21T18:00:00Z" },
    { title: "Lecture", allDay: false, busy: true, starts_at: "2026-10-21T13:30:00Z", ends_at: "2026-10-21T14:50:00Z" },
    { title: "Trip", allDay: true, busy: false, starts_at: "2026-10-21", ends_at: "2026-10-23" },
    { title: "Late show", allDay: false, busy: true, starts_at: "2026-10-22T03:00:00Z", ends_at: "2026-10-22T05:00:00Z" },
  ];
  const wed = eventsOnDay(events, "2026-10-21", tz);
  assert.deepEqual(wed.map((e) => [e.title, e.start]), [["Trip", 0], ["Lecture", 570], ["Hitachi sync", 780], ["Late show", 1380]]);
  // The all-day trip covers Thursday too; the show that runs past midnight spills into it.
  assert.deepEqual(eventsOnDay(events, "2026-10-22", tz).map((e) => e.title), ["Trip", "Late show"]);
  assert.deepEqual(eventsOnDay(events, "2026-10-23", tz), []);
});

test("calendar events: free time skips overlaps, all-day and free events", () => {
  const day = [
    { busy: true, allDay: false, start: 600, end: 690 },  // 10:00-11:30
    { busy: true, allDay: false, start: 660, end: 720 },  // 11:00-12:00, overlaps
    { busy: false, allDay: false, start: 800, end: 900 }, // marked free in Google
    { busy: true, allDay: true, start: 0, end: 1440 },
    { busy: true, allDay: false, start: 1300, end: 1400 }, // runs past the window's end
  ];
  // 9:30 am to 10 pm is 750 minutes; 120 are taken before noon and 20 at the end.
  assert.equal(freeMinutes(day, 570, 1320), 610);
  assert.equal(freeMinutes([], 1400, 1320), 0);
  assert.equal(clashWith(675, day).start, 600);
  assert.equal(clashWith(850, day), null);
  assert.equal(clashWith(500, day), null);
});

test("calendar events: a full column hides ended events first", () => {
  const evs = [1, 2, 3, 4, 5, 6].map((h) => ({ title: `e${h}`, allDay: false, start: h * 120, end: h * 120 + 60 }));
  assert.deepEqual(visibleEvents(evs.slice(0, 3), 4), { shown: evs.slice(0, 3), hidden: 0 });
  assert.deepEqual(visibleEvents(evs, 4).shown.map((e) => e.title), ["e1", "e2", "e3", "e4"]);
  // At 7:30 the first three have ended, so the column shows what's left in the day.
  const later = visibleEvents(evs, 4, 450);
  assert.deepEqual(later.shown.map((e) => e.title), ["e3", "e4", "e5", "e6"]);
  assert.equal(later.hidden, 2);
});

test("at risk: due within two days with no block, across a weekend", () => {
  const tz = "America/New_York";
  const task = (due) => ({ id: "t1", due, done: false });
  // Friday 2026-10-30: due Friday, Saturday and Sunday are at risk; Monday is three days off.
  assert.equal(atRisk(task("2026-10-30"), [], "2026-10-30", tz), true);
  assert.equal(atRisk(task("2026-10-31"), [], "2026-10-30", tz), true);
  assert.equal(atRisk(task("2026-11-01"), [], "2026-10-30", tz), true);
  assert.equal(atRisk(task("2026-11-02"), [], "2026-10-30", tz), false);
  assert.equal(atRisk(task(null), [], "2026-10-30", tz), false);
});

test("at risk: done tasks never are", () => {
  assert.equal(atRisk({ id: "t1", due: "2026-10-30", done: true }, [], "2026-10-30", "America/New_York"), false);
});

test("at risk: a block before the due date ends clears it, one after doesn't", () => {
  const tz = "America/New_York";
  const task = { id: "t1", due: "2026-10-31", done: false };
  const block = (starts_at, task_id = "t1") => ({ task_id, starts_at, ends_at: new Date(Date.parse(starts_at) + 3_600_000).toISOString() });
  // 2 pm on Saturday the 31st, the due day itself, counts as before it is due.
  assert.equal(atRisk(task, [block("2026-10-31T18:00:00Z")], "2026-10-30", tz), false);
  // 9 am on Sunday the 1st is after it.
  assert.equal(atRisk(task, [block("2026-11-01T14:00:00Z")], "2026-10-30", tz), true);
  // Another task's block doesn't count.
  assert.equal(atRisk(task, [block("2026-10-31T18:00:00Z", "t2")], "2026-10-30", tz), true);
});

test("at risk: a proposed block doesn't clear it until it is approved", () => {
  const tz = "America/New_York";
  const task = { id: "t1", due: "2026-10-31", done: false };
  const proposed = { task_id: "t1", starts_at: "2026-10-31T18:00:00Z", ends_at: "2026-10-31T19:00:00Z", proposed: true };
  assert.equal(atRisk(task, [proposed], "2026-10-30", tz), true);
  assert.equal(atRisk(task, [{ ...proposed, proposed: false }], "2026-10-30", tz), false);
});

test("at risk: the due day's end follows daylight saving", () => {
  const tz = "America/New_York";
  // Clocks go back on Sunday 2026-11-01, so it ends at 05:00 UTC, not 04:00.
  const task = { id: "t1", due: "2026-11-01", done: false };
  const block = (starts_at) => ({ task_id: "t1", starts_at, ends_at: new Date(Date.parse(starts_at) + 1_800_000).toISOString() });
  assert.equal(atRisk(task, [block("2026-11-02T04:30:00Z")], "2026-10-31", tz), false); // 11:30 pm Sunday
  assert.equal(atRisk(task, [block("2026-11-02T05:00:00Z")], "2026-10-31", tz), true);  // 12:00 am Monday
});

test("due dates: shown as a weekday within the coming week, a date otherwise", () => {
  assert.equal(dueLabel("2026-10-30", "2026-10-26"), "due Fri");
  assert.equal(dueLabel("2026-10-26", "2026-10-26"), "due Mon");
  assert.equal(dueLabel("2026-11-02", "2026-10-26"), "due Nov 2");
  assert.equal(dueLabel("2026-10-25", "2026-10-26"), "due Oct 25");
});
