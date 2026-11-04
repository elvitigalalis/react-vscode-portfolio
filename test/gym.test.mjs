// The Gym tracker's logic (src/sheet/gym.mjs, docs/sheet-gym.md): e1RM and records, the
// suggestion, the session order, plate math. Every exercise and number here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { e1rm, records, prsFor } from "../src/sheet/gym.mjs";

// A made-up exercise, "Widget Press", and its sets.
const set = (weight_lb, reps, more = {}) => ({ exercise_id: "wp", weight_lb, reps, warmup: false, done_at: "2026-01-05T15:00:00Z", ...more });

test("e1rm: Epley, exact up to 10 reps, approximate above", () => {
  assert.deepEqual(e1rm(100, 1), { value: 103.3, approx: false });
  assert.deepEqual(e1rm(150, 10), { value: 200, approx: false });
  assert.deepEqual(e1rm(90, 12), { value: 126, approx: true });
  assert.deepEqual(e1rm(50, 20), { value: 83.3, approx: true });
  assert.equal(e1rm(100, 0), null);
});

test("records: heaviest, best e1RM and best weight per rep count, warm-ups left out", () => {
  const r = records([
    set(100, 8, { done_at: "2026-01-01T15:00:00Z" }),
    set(110, 5, { done_at: "2026-01-03T15:00:00Z" }),
    set(200, 5, { warmup: true }),
    set(105, 8, { done_at: "2026-01-05T15:00:00Z" }),
  ]).get("wp");
  assert.equal(r.heaviest.weight_lb, 110);
  assert.equal(r.e1rm.value, 133); // 105 × (1 + 8/30)
  assert.deepEqual(r.byReps.map((x) => [x.reps, x.weight_lb, x.beaten]), [[5, 110, false], [8, 105, false]]);
});

test("records: a heavier-or-equal set for more reps fades the lower-rep record", () => {
  const r = records([set(100, 5), set(100, 6), set(90, 8)]).get("wp");
  assert.deepEqual(r.byReps.map((x) => [x.reps, x.weight_lb, x.beaten]), [[5, 100, true], [6, 100, false], [8, 90, false]]);
});

test("records: e1RM never comes from a set above 12 reps", () => {
  const r = records([set(60, 15), set(50, 6)]).get("wp");
  assert.equal(r.e1rm.value, 60); // 50 × 1.2, not 60 × 1.5
});

test("records: sheet baselines count only once confirmed", () => {
  const baselines = [{ exercise_id: "wp", weight_lb: 150, reps: null, confirmed: false }];
  assert.equal(records([set(100, 5)], baselines).get("wp").heaviest.weight_lb, 100);
  const confirmed = [{ ...baselines[0], confirmed: true }];
  assert.equal(records([set(100, 5)], confirmed).get("wp").heaviest.weight_lb, 150);
  assert.equal(records([], confirmed).get("wp").heaviest.weight_lb, 150);
});

test("prsFor: heavier is a weight PR, and the e1RM PR comes first", () => {
  const before = [set(100, 5), set(95, 8)];
  assert.deepEqual(prsFor(set(105, 5), before).map((p) => p.type), ["e1rm", "weight"]);
  assert.deepEqual(prsFor(set(105, 1), before).map((p) => p.type), ["weight"]);
});

test("prsFor: more reps at a weight is a rep PR", () => {
  const before = [set(100, 5), set(100, 6)];
  const prs = prsFor(set(100, 7), before);
  assert.deepEqual(prs.map((p) => p.type), ["e1rm", "reps"]);
  assert.deepEqual(prs[1], { type: "reps", weight_lb: 100, reps: 7, was: 6 });
  // 7 at 95 beats nothing at or above 95 with 7+ reps: no 95 lb set had more than 6.
  assert.deepEqual(prsFor(set(95, 7), before).map((p) => p.type), ["reps"]);
  assert.deepEqual(prsFor(set(95, 6), before), []);
});

test("prsFor: no PRs from warm-ups, a first log, an unconfirmed baseline or past 12 reps", () => {
  assert.deepEqual(prsFor(set(300, 5, { warmup: true }), [set(100, 5)]), []);
  assert.deepEqual(prsFor(set(100, 5), []), []);
  assert.deepEqual(prsFor(set(100, 5), [], [{ exercise_id: "wp", weight_lb: 90, confirmed: false }]), []);
  assert.deepEqual(prsFor(set(100, 5), [], [{ exercise_id: "wp", weight_lb: 90, confirmed: true }]).map((p) => p.type), ["e1rm", "weight"]);
  // 13 reps at the same weight: a rep PR, never an e1RM PR.
  assert.deepEqual(prsFor(set(100, 13), [set(100, 5)]).map((p) => p.type), ["reps"]);
  // Another exercise's sets don't count.
  assert.deepEqual(prsFor(set(100, 5), [set(90, 5, { exercise_id: "other" })]), []);
});
