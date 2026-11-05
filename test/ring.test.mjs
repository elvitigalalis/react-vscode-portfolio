// Ring workouts and Rest Mode (src/sheet/ring.mjs), with made-up rows. Wednesday 2026-11-04,
// New York (EST, UTC-5). Expected values by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gymMatches, restMode, ringLine } from "../src/sheet/ring.mjs";

const TZ = "America/New_York";
const D = "2026-11-04";
const at = (hhmm) => new Date(`${D}T${hhmm}:00-05:00`).toISOString();
const habits = [{ id: "h1", name: "Gym" }, { id: "h2", name: "Lunch" }];
const block = (id, habit_id, from, to, extra = {}) => ({ id, habit_id, task_id: null, starts_at: at(from), ends_at: at(to), proposed: false, ...extra });
const workout = (activity, from, to) => ({ oura_id: `w-${from}`, day: D, activity, starts_at: at(from), ends_at: at(to) });

test("gymMatches: a ring workout over the Gym block ends it at the workout's end", () => {
  assert.deepEqual(gymMatches([workout("other", "17:10", "18:00")], [block("b1", "h1", "17:00", "18:30")], habits, TZ),
    [{ block_id: "b1", action: "shrink", ends_at: at("18:00") }]);
});

test("gymMatches: a lifting workout anywhere that day counts; a generic one only overlapping", () => {
  const blocks = [block("b1", "h1", "17:00", "18:30")];
  assert.deepEqual(gymMatches([workout("strengthTraining", "08:00", "09:10")], blocks, habits, TZ), [{ block_id: "b1", action: "delete" }]);
  assert.deepEqual(gymMatches([workout("other", "08:00", "09:10")], blocks, habits, TZ), []);
});

test("gymMatches: other habits, proposed blocks and a block already past stay", () => {
  const w = [workout("weightlifting", "17:00", "18:00")];
  assert.deepEqual(gymMatches(w, [block("b2", "h2", "17:00", "18:00")], habits, TZ), []);
  assert.deepEqual(gymMatches(w, [block("b1", "h1", "17:00", "18:00", { proposed: true })], habits, TZ), []);
  // The workout ended after the block: nothing left to change.
  assert.deepEqual(gymMatches(w, [block("b1", "h1", "16:00", "17:30")], habits, TZ), []);
});

test("ringLine: the day's matched ring time, length only", () => {
  const w = [workout("strengthTraining", "17:00", "18:12"), workout("walking", "12:00", "12:30")];
  assert.equal(ringLine(w, D), "Ring: 1h 12m");
  assert.equal(ringLine([workout("other", "17:00", "17:45")], D, { started_at: at("17:05"), finished_at: at("17:50") }), "Ring: 45m");
  assert.equal(ringLine([workout("other", "09:00", "09:45")], D, { started_at: at("17:05"), finished_at: at("17:50") }), null);
  assert.equal(ringLine([], D), null);
});

test("restMode: essentials while on, then easing back as many days as it lasted, at most 7", () => {
  assert.deepEqual(restMode(D, [{ start_day: "2026-11-03", end_day: null }]), { factor: 0.4, firm_only: true, reason: "rest mode" });
  // On Nov 1-3 (3 days): Nov 4 is 1 of 3 days back, 0.4 + 0.6 × 1/4 = 0.55; Nov 6 is 0.85; Nov 7 none.
  const p = [{ start_day: "2026-11-01", end_day: "2026-11-03" }];
  assert.deepEqual(restMode(D, p), { factor: 0.55, firm_only: false, reason: "easing back from rest mode" });
  assert.equal(restMode("2026-11-06", p).factor, 0.85);
  assert.equal(restMode("2026-11-07", p), null);
  // Fourteen days on eases back over 7.
  assert.equal(restMode("2026-11-09", [{ start_day: "2026-10-21", end_day: "2026-11-03" }]).factor, 0.85);
  assert.equal(restMode("2026-11-11", [{ start_day: "2026-10-21", end_day: "2026-11-03" }]), null);
  assert.equal(restMode(D, []), null);
});
