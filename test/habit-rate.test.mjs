// Habits as rates (src/sheet/habit-rate.mjs, docs/sheet-habits.md): the 4 am day boundary, the
// seven dots, "N of last 7" and the "Back on it today?" prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { habitDay, habitView, rateText, scheduledOn } from "../src/sheet/habit-rate.mjs";

const TZ = "America/New_York";
const daily = { days: [1, 2, 3, 4, 5, 6, 7] };
const mwf = { days: [1, 3, 5] };
// Monday 2026-11-09 is today in most tests; the week before runs Mon 11-02 to Sun 11-08.
const TODAY = "2026-11-09";
const set = (...days) => new Set(days);

test("habitDay: the day turns at 4 am local, not midnight", () => {
  assert.equal(habitDay(new Date("2026-11-09T08:59:00Z"), TZ), "2026-11-08"); // 3:59 am EST
  assert.equal(habitDay(new Date("2026-11-09T09:00:00Z"), TZ), "2026-11-09"); // 4:00 am EST
  assert.equal(habitDay(new Date("2026-11-09T05:30:00Z"), TZ), "2026-11-08"); // 12:30 am EST
  assert.equal(habitDay(new Date("2026-11-10T04:59:00Z"), TZ), "2026-11-09"); // 11:59 pm EST
});

test("habitDay: holds across the DST changes", () => {
  // Spring forward, Sun 2027-03-14: 3:30 am EDT is still Saturday's habit day, 4:00 am is Sunday's.
  assert.equal(habitDay(new Date("2027-03-14T07:30:00Z"), TZ), "2027-03-13");
  assert.equal(habitDay(new Date("2027-03-14T08:00:00Z"), TZ), "2027-03-14");
  // Fall back, Sun 2026-11-01: 1:30 am happens twice, both Saturday's; 4:00 am EST is Sunday's.
  assert.equal(habitDay(new Date("2026-11-01T05:30:00Z"), TZ), "2026-10-31");
  assert.equal(habitDay(new Date("2026-11-01T06:30:00Z"), TZ), "2026-10-31");
  assert.equal(habitDay(new Date("2026-11-01T09:00:00Z"), TZ), "2026-11-01");
});

test("scheduledOn: ISO weekdays, 1 = Monday", () => {
  assert.equal(scheduledOn(mwf, "2026-11-09"), true);  // Mon
  assert.equal(scheduledOn(mwf, "2026-11-10"), false); // Tue
  assert.equal(scheduledOn(mwf, "2026-11-15"), false); // Sun
  assert.equal(scheduledOn({ days: [7] }, "2026-11-15"), true);
});

test("habitView: seven dots ending today, oldest first", () => {
  const v = habitView(daily, set("2026-11-03", "2026-11-05", "2026-11-06"), TODAY);
  assert.deepEqual(v.dots.map((d) => d.day), ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
  assert.deepEqual(v.dots.map((d) => d.state), ["done", "missed", "done", "done", "missed", "missed", "due"]);
});

test("habitView: off days are off unless done, and never count", () => {
  const v = habitView(mwf, set("2026-11-06", "2026-11-07"), TODAY); // Fri done, Sat done (off day)
  assert.deepEqual(v.dots.map((d) => d.state), ["off", "missed", "off", "done", "done", "off", "due"]);
  // Last 7 scheduled days before today: Fri 11-06, Wed 11-04, Mon 11-02, Fri 10-30, Wed 10-28, Mon 10-26, Fri 10-23.
  assert.deepEqual([v.done, v.of], [1, 7]);
});

test("habitView: today counts only once done, so an open day is never a miss", () => {
  const before = set("2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-08");
  assert.equal(rateText(habitView(daily, before, TODAY)), "5 of last 7 sessions"); // 11-02..11-08
  const after = new Set([...before, TODAY]);
  assert.equal(rateText(habitView(daily, after, TODAY)), "6 of last 7 sessions"); // 11-03..11-09
});

test("habitView: a new habit counts from the day after it was made", () => {
  // Made Saturday and not ticked that day: Saturday is off, Sunday is the first that counts.
  const v = habitView(daily, set(), TODAY, "2026-11-07");
  assert.deepEqual(v.dots.map((d) => d.state), ["off", "off", "off", "off", "off", "missed", "due"]);
  assert.equal(rateText(v), "0 of last 1 session");
  // Made today: today is still open to tick, and nothing counts yet.
  const fresh = habitView(daily, set(), TODAY, TODAY);
  assert.equal(fresh.dots[6].state, "due");
  assert.equal(rateText(fresh), "");
  assert.equal(fresh.back, false);
});

test("habitView: a habit ticked on the day it was made counts that day", () => {
  const v = habitView(daily, set("2026-11-07"), TODAY, "2026-11-07");
  assert.deepEqual(v.dots.map((d) => d.state), ["off", "off", "off", "off", "done", "missed", "due"]);
  assert.equal(rateText(v), "1 of last 2 sessions");
  assert.equal(rateText(habitView(daily, set(TODAY), TODAY, TODAY)), "1 of last 1 session");
});

test("habitView: a once-a-week habit looks back seven weeks", () => {
  const sunday = { days: [7] };
  const v = habitView(sunday, set("2026-11-08", "2026-10-25"), TODAY);
  assert.deepEqual([v.done, v.of], [2, 7]); // Sundays 11-08 back to 09-27
});

test("habitView: a once-a-week habit on its open day still finds seven weeks behind it", () => {
  const monday = { days: [1] };
  // Today is Monday and still open: the last seven Mondays are 11-02 back to 09-21, the oldest
  // exactly 49 days ago.
  const v = habitView(monday, set("2026-09-21", "2026-11-02"), TODAY);
  assert.deepEqual([v.done, v.of], [2, 7]);
  assert.equal(v.dots[6].state, "due");
});

test("habitView: back asks after a missed scheduled day, only when today is scheduled and open", () => {
  assert.equal(habitView(daily, set("2026-11-07"), TODAY).back, true);             // missed Sun
  assert.equal(habitView(daily, set("2026-11-08"), TODAY).back, false);            // did Sun
  assert.equal(habitView(daily, set(TODAY), TODAY).back, false);                   // already back
  assert.equal(habitView(mwf, set("2026-11-06"), TODAY).back, false);              // did Fri; the weekend is off
  assert.equal(habitView(mwf, set(), TODAY).back, true);                           // missed Fri
  assert.equal(habitView(mwf, set(), "2026-11-10").back, false);                   // Tue is off
  assert.equal(habitView(daily, set(), TODAY, TODAY).back, false);                 // brand new
});
