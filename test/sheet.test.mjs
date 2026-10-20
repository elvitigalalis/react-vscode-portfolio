// The Sheet's logic (src/sheet/logic.mjs): the parts that decide, without a DOM or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, weekStart, weekDays, localNow, dayLabel, zonedIso, minutesOn, parseEntry, formatMinutes, formatClock,
  rowCount, positionBetween, load, planningDay, snap, blockOnComplete, rollMark, barWidth, rightNow,
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
    { title: "Ship WorkIt auth", est_min: 45, at_time: null, tag: "workit", public: true });
  assert.deepEqual(parseEntry("Dentist @3pm !private"),
    { title: "Dentist", est_min: null, at_time: "15:00", tag: null, public: false });
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

test("formatting minutes and clock times", () => {
  assert.equal(formatMinutes(200), "3h20");
  assert.equal(formatMinutes(330), "5h30");
  assert.equal(formatMinutes(120), "2h");
  assert.equal(formatMinutes(45), "45m");
  assert.equal(formatClock(16 * 60 + 40), "4:40 pm");
  assert.equal(formatClock(0), "12:00 am");
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
