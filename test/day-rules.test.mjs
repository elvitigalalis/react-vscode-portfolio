// The day rules read_planner gives and submit_proposal holds a plan to (docs/sheet-v5.md, "Day
// rules and first steps"): the window's end, the light start, the long and meal breaks, mail and
// admin batches, the gym habit's end and the rolling sleep debt. Expected values are worked out
// by hand from the wake and bedtime below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSnapshot, checkProposal } from "../src/sheet/proposal.mjs";

const TZ = "America/New_York";
const DAY = "2026-11-04"; // a Wednesday, EST (UTC-5)
let n = 0;
const night = (wake, hours = 8) => {
  const end = new Date(`${wake}:00-05:00`);
  return { oura_id: `n${++n}`, day: wake.slice(0, 10), type: "long_sleep", bedtime_start: new Date(+end - hours * 3_600_000).toISOString(), bedtime_end: end.toISOString() };
};
// Up at 8:05 today; it is 8:15 am.
const NOW = new Date("2026-11-04T13:15:00Z");
const WOKE = [night("2026-11-02T09:30"), night("2026-11-03T09:50"), night("2026-11-04T08:05")];
const BED = { wind_down_on: true, bedtime_target: "23:30:00", bedtime_ease: false };
const task = (id, title, est_min, extra = {}) => ({ id, title, est_min, day: DAY, done: false, ...extra });
const rows = (extra = {}) => ({
  settings: { time_zone: TZ, ...BED }, tasks: [task("t1", "OS homework", 45)], blocks: [], busy: [], days: [], campus: [],
  proposal: null, needsOpen: [], accounts: [], sleep: WOKE, ...extra,
});
const snap = (extra = {}, now = NOW) => planSnapshot(rows(extra), now);
const errs = (r) => r.errors.join("\n");

// --- read_planner ----------------------------------------------------------------------------

test("window.to: at most 16 hours after his wake, as well as by shutdown and wind-down", () => {
  // Up at 6:00 with bed at 1:00 am: wind-down starts at midnight, shutdown is 11 pm, and 16
  // hours after the wake is 10 pm.
  const s = snap({ sleep: [night("2026-11-04T06:00")], settings: { time_zone: TZ, wind_down_on: true, bedtime_target: "01:00:00", bedtime_ease: false } });
  assert.equal(s.shutdown, "23:00");
  assert.equal(s.window.to, "22:00");
  // Up at 8:05: 16 hours on is past midnight, so wind-down (bed 11:30 pm) ends it.
  assert.equal(snap().window.to, "22:30");
});

test("day_rules: light_until is 90 minutes after his wake, 120 after a short night", () => {
  assert.equal(snap().day_rules.light_until, "09:35");
  assert.equal(snap({ sleepDays: [{ day: DAY, readiness: 75, sleep_s: 5 * 3600 }] }).day_rules.light_until, "10:05");
  // With no wake known, there is no light start.
  assert.equal(snap({ sleep: [] }).day_rules.light_until, null);
});

test("day_rules: three short nights give a lighter day, like one short night", () => {
  const h = (x) => x * 3600;
  const sleepDays = [{ day: DAY, readiness: 75, sleep_s: h(7) }, { day: "2026-11-03", sleep_s: h(6) }, { day: "2026-11-02", sleep_s: h(6) }];
  const r = snap({ sleepDays }).day_rules;
  assert.equal(r.workload_cap_min, 300);
  assert.equal(r.break_after_min, 60);
  assert.equal(r.cap_reason, "lighter day");
  assert.equal(r.light_until, "10:05");
});

test("day_rules: the preferred times for hard work and for gym and admin, from wake and bedtime", () => {
  const r = snap().day_rules;
  assert.equal(r.hard_work_from, "09:35");
  assert.equal(r.hard_work_to, "14:35");
  assert.equal(r.hard_work_ends_by, "21:30");
  assert.equal(r.gym_admin_from, "14:35");
  assert.equal(r.gym_admin_to, "17:05");
  // With no bedtime, nothing to end hard work by.
  assert.equal(snap({ settings: { time_zone: TZ } }).day_rules.hard_work_ends_by, null);
});

test("day_rules: the long break, the meal break in the window's middle third, and mail batches", () => {
  const r = snap().day_rules;
  assert.equal(r.long_break_after_min, 180);
  assert.equal(r.long_break_min, 15);
  assert.equal(r.meal_after_min, 240);
  assert.equal(r.meal_break_min, 30);
  // The window runs 08:45-22:30: thirds of 275 minutes.
  assert.equal(r.meal_from, "13:20");
  assert.equal(r.meal_to, "17:55");
  assert.equal(r.mail_admin_batches, 2);
  // A replan later in the day keeps the day's thirds, not the rest of the day's.
  assert.equal(snap({}, new Date("2026-11-04T19:00:00Z")).day_rules.meal_from, "13:20");
});

test("tasks: mail and admin tasks, and tasks of 30 minutes or less, are light", () => {
  const s = snap({ tasks: [task("t1", "OS homework", 45), task("t2", "Reply to Prof. Kim", 45), task("t3", "Housing form", 60, { tag: "admin" }),
    task("t4", "Read ch. 4", 30), task("t5", "Reply on the forum", 60, { source: "brightspace", due: "2026-11-06" })] });
  const of = (id) => s.tasks.find((t) => t.id === id);
  assert.equal(of("t1").light, undefined);
  assert.deepEqual([of("t2").light, of("t2").mail_admin], [true, true]);
  assert.deepEqual([of("t3").light, of("t3").mail_admin], [true, true]);
  assert.deepEqual([of("t4").light, of("t4").mail_admin], [true, undefined]);
  // A course task is never mail or admin, whatever its title says.
  assert.equal(of("t5").mail_admin, undefined);
});
