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

// --- submit_proposal ---------------------------------------------------------------------------

const submit = (s, blocks, extra = {}) => checkProposal({ day: DAY, replaces: null, blocks, ...extra }, s);

test("light start: a course task over 30 minutes can't start before light_until; a light or unknown one can", () => {
  const s = snap({ tasks: [task("c1", "CSE 320 HW4", 60, { source: "brightspace", due: "2026-11-06" }), task("c2", "CSE 320 quiz prep", 30, { source: "brightspace", due: "2026-11-06" }),
    task("t1", "OS homework", 45), task("m1", "Reply to Prof. Kim", 45)] });
  const early = submit(s, [{ task_id: "c1", start: "08:45", minutes: 60 }]);
  assert.equal(early.ok, false);
  assert.match(errs(early), /^blocks\[0\]: starts before 09:35, and until then only light tasks go \(mail, admin, or 30 minutes or less\); start it at 09:35 or later$/m);
  assert.equal(submit(s, [{ task_id: "c1", start: "09:35", minutes: 60 }]).ok, true);
  assert.equal(submit(s, [{ task_id: "c2", start: "08:45", minutes: 30 }]).ok, true);
  assert.equal(submit(s, [{ task_id: "m1", start: "08:45", minutes: 45 }]).ok, true);
  // Its kind unknown, the code lets it through; the prompt asks for light tasks.
  assert.equal(submit(s, [{ task_id: "t1", start: "08:45", minutes: 45 }]).ok, true);
});

test("light start: a task fixed at a time before light_until still starts then", () => {
  const s = snap({ tasks: [task("c1", "CSE 320 lab", 60, { source: "brightspace", due: "2026-11-06", at_time: "09:00:00" })] });
  assert.equal(submit(s, [{ task_id: "c1", start: "09:00", minutes: 60 }]).ok, true);
});

const four = ["a", "b", "c", "d", "e"].map((id) => task(id, `Task ${id}`, 60));

test("long break: about 3 hours of blocks need a 15-minute break; 10-minute gaps don't make one", () => {
  const s = snap({ tasks: four });
  const at = (...starts) => starts.map((start, i) => ({ task_id: four[i].id, start, minutes: 60 }));
  const r = submit(s, at("09:45", "10:55", "12:05", "13:15"));
  assert.equal(r.ok, false);
  assert.match(errs(r), /^blocks\[3\]: makes 240 minutes of blocks with no break of 15 minutes or more; leave a 15-minute break after about 180 minutes of blocks$/m);
  assert.equal(submit(s, at("09:45", "10:55", "12:05", "13:20")).ok, true);
});

test("long break: an approved block counts toward the 3 hours", () => {
  const blocks = [{ task_id: "a", starts_at: "2026-11-04T14:45:00Z", ends_at: "2026-11-04T15:45:00Z", proposed: false }]; // 9:45-10:45
  const s = snap({ tasks: four, blocks });
  const r = submit(s, [{ task_id: "b", start: "10:55", minutes: 60 }, { task_id: "c", start: "12:05", minutes: 60 }, { task_id: "d", start: "13:15", minutes: 60 }]);
  assert.match(errs(r), /blocks\[2\]: makes 240 minutes of blocks/);
});

test("meal break: a day of 4 hours or more keeps 30 minutes free in the window's middle third", () => {
  const s = snap({ tasks: four });
  const at = (...starts) => starts.map((start, i) => ({ task_id: four[i].id, start, minutes: 60 }));
  // 13:20-17:55 holds only 15-minute gaps.
  const r = submit(s, at("12:00", "13:15", "14:30", "15:45", "17:00"));
  assert.equal(r.ok, false);
  assert.match(errs(r), /^blocks\[1\]: leaves no 30-minute break between 13:20 and 17:55, the middle third of the plan window, on a day with 5h00 of blocks; leave one for a meal$/m);
  assert.equal(submit(s, at("12:00", "13:15", "14:30", "16:00", "17:15")).ok, true);
  // Under 4 hours of blocks, no meal break is needed.
  assert.equal(submit(s, at("12:00", "13:15", "14:30")).ok, true);
});

test("meal break: a meal habit is a break; busy time is not", () => {
  const habits = [{ id: "h1", name: "Lunch", days: [3], ideal: "15:35:00", minutes: 30, flex_min: 0, defence: "firm" }];
  const at = (...starts) => starts.map((start, i) => ({ task_id: four[i].id, start, minutes: 60 }));
  const blocks = at("12:00", "13:15", "14:25", "16:15", "17:30");
  assert.equal(submit(snap({ tasks: four, habits }), blocks, { habits: [{ habit_id: "h1", start: "15:35" }] }).ok, true);
  const busy = [{ starts_at: "2026-11-04T20:40:00Z", ends_at: "2026-11-04T21:00:00Z" }]; // 3:40-4:00 pm
  assert.match(errs(submit(snap({ tasks: four, busy }), blocks)), /no 30-minute break/);
});

test("mail and admin: at most 2 batches a day; back to back is one", () => {
  const mails = ["Reply to Ana", "Reply to Ben", "Email the TA"].map((title, i) => task(`m${i}`, title, 15));
  const s = snap({ tasks: mails });
  const at = (...starts) => starts.map((start, i) => ({ task_id: mails[i].id, start, minutes: 15 }));
  const r = submit(s, at("10:00", "12:00", "15:00"));
  assert.equal(r.ok, false);
  assert.match(errs(r), /^blocks\[2\]: starts a third batch of mail and admin tasks; put them in at most 2 batches a day, back to back$/m);
  assert.equal(submit(s, at("10:00", "10:15", "15:00")).ok, true);
});

test("gym: a gym habit ends by an hour before bed, since the window does", () => {
  const habits = [{ id: "g", name: "Gym", days: [3], ideal: "21:45:00", minutes: 60, flex_min: 60, defence: "flexible" }];
  const s = snap({ tasks: [], habits });
  const r = submit(s, [], { habits: [{ habit_id: "g", start: "21:45" }] });
  assert.match(errs(r), /habits\[0\]: ends after 22:30, when wind-down starts \(bed 11:30 pm\)/);
  assert.equal(submit(s, [], { habits: [{ habit_id: "g", start: "21:30" }] }).ok, true);
});
