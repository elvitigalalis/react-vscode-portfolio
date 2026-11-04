// The Gym tracker's logic (src/sheet/gym.mjs, docs/sheet-gym.md): e1RM and records, the
// suggestion, the session order, plate math. Every exercise and number here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { e1rm, records, prsFor, historyFor, suggest } from "../src/sheet/gym.mjs";

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

// --- The suggestion ---------------------------------------------------------------------------

const rx = { rep_min: 4, rep_max: 6, rpe_target: 9, reps: "4-6", rpe: "8-10" };
const widget = { id: "wp", step_lb: 5 };
const NOW = new Date("2026-02-01T15:00:00Z");
// A session of Widget Press `days` days before NOW, on `day_key`, with [weight, reps, rpe] sets.
const past = (days, day_key, ...sets) => ({
  day_key, started_at: new Date(NOW - days * 864e5).toISOString(),
  sets: sets.map(([weight_lb, reps, rpe = null]) => ({ exercise_id: "wp", weight_lb, reps, rpe, warmup: false })),
});

test("suggest: every set at the top of the range, at or under the RPE: add a step", () => {
  const s = suggest(rx, widget, [past(3, "push1", [100, 6, 9], [100, 6, 9.5])], { dayKey: "push1", now: NOW });
  assert.deepEqual(s, { kind: "up", weight_lb: 105, reps: 4, reason: "You hit 6/6 on both sets, +5 lb" });
  assert.equal(suggest(rx, widget, [past(3, "push1", [100, 6], [100, 6], [100, 7])], { dayKey: "push1", now: NOW }).reason,
    "You hit 6/6/7 on all 3 sets, +5 lb");
});

test("suggest: in the range: same weight, one more rep on the weakest set", () => {
  const s = suggest(rx, widget, [past(3, "push1", [100, 6, 9], [100, 5, 9])], { dayKey: "push1", now: NOW });
  assert.deepEqual(s, { kind: "same", weight_lb: 100, reps: 6, reason: "Same weight, aim for 6" });
  // The top of the range at too high an RPE is not enough to go up.
  assert.equal(suggest(rx, widget, [past(3, "push1", [100, 6, 10], [100, 6, 10])], { dayKey: "push1", now: NOW }).kind, "same");
});

test("suggest: below the range or far over the RPE holds; twice in a row steps down", () => {
  const short = suggest(rx, widget, [past(3, "push1", [100, 5], [100, 3])], { dayKey: "push1", now: NOW });
  assert.deepEqual(short, { kind: "hold", weight_lb: 100, reps: 4, reason: "5/3 last time, under 4: hold 100 lb" });
  const hard = suggest(rx, widget, [past(3, "push1", [100, 5, 10.5])], { dayKey: "push1", now: NOW });
  assert.deepEqual(hard, { kind: "hold", weight_lb: 100, reps: 4, reason: "RPE 10.5 last time, over 9: hold 100 lb" });
  const twice = suggest(rx, widget, [past(3, "push1", [100, 3]), past(10, "push1", [100, 3])], { dayKey: "push1", now: NOW });
  assert.deepEqual(twice, { kind: "down", weight_lb: 95, reps: 4, reason: "Short two sessions in a row: 95 lb (−5)" });
});

test("suggest: the same program day comes first, then any day", () => {
  const history = [past(2, "push2", [80, 6], [80, 6]), past(5, "push1", [100, 5], [100, 5])];
  assert.equal(suggest(rx, widget, history, { dayKey: "push1", now: NOW }).weight_lb, 100);
  assert.equal(suggest(rx, widget, history, { dayKey: "legs1", now: NOW }).weight_lb, 85);
});

test("suggest: the first time shows only the target, and the sheet number if there is one", () => {
  assert.deepEqual(suggest(rx, widget, [], { dayKey: "push1", now: NOW }),
    { kind: "first", weight_lb: null, reps: 4, reason: "First time: 4–6 @ RPE 8–10" });
  assert.deepEqual(suggest(rx, widget, [], { dayKey: "push1", now: NOW, baseline: { weight_lb: 120 } }),
    { kind: "first", weight_lb: null, reps: 4, reason: "First time: 4–6 @ RPE 8–10 · From your sheet: 120 lb" });
});

test("suggest: after 14 days or more, about 90% of the last weight, to the step", () => {
  assert.deepEqual(suggest(rx, widget, [past(22, "push1", [100, 6], [100, 6])], { dayKey: "push1", now: NOW }),
    { kind: "gap", weight_lb: 90, reps: 4, reason: "Back after 3 weeks" });
  assert.equal(suggest(rx, widget, [past(14, "push1", [137.5, 5])], { dayKey: "push1", now: NOW }).weight_lb, 125);
  assert.equal(suggest(rx, widget, [past(13, "push1", [100, 5])], { dayKey: "push1", now: NOW }).kind, "same");
});

test("historyFor: an exercise's sessions, newest first, working sets only, without today's", () => {
  const sessions = [
    { id: "s1", program_day_id: "d1", started_at: "2026-01-01T15:00:00Z", finished_at: "2026-01-01T16:00:00Z" },
    { id: "s2", program_day_id: "d2", started_at: "2026-01-03T15:00:00Z", finished_at: null },
    { id: "s3", program_day_id: "d1", started_at: "2026-01-05T15:00:00Z", finished_at: "2026-01-05T16:00:00Z" },
  ];
  const sets = [
    { session_id: "s1", exercise_id: "wp", weight_lb: 90, reps: 5, warmup: false, set_index: 1 },
    { session_id: "s3", exercise_id: "wp", weight_lb: 45, reps: 8, warmup: true, set_index: 0 },
    { session_id: "s3", exercise_id: "wp", weight_lb: 95, reps: 5, warmup: false, set_index: 2 },
    { session_id: "s3", exercise_id: "wp", weight_lb: 95, reps: 6, warmup: false, set_index: 1 },
    { session_id: "s3", exercise_id: "other", weight_lb: 10, reps: 5, warmup: false, set_index: 3 },
    { session_id: "s2", exercise_id: "wp", weight_lb: 99, reps: 5, warmup: false, set_index: 1 },
  ];
  const h = historyFor("wp", sessions, sets, { d1: "push1", d2: "pull1" });
  assert.deepEqual(h.map((x) => [x.day_key, x.sets.map((s) => s.reps)]), [["push1", [6, 5]], ["pull1", [5]], ["push1", [5]]]);
  assert.deepEqual(historyFor("wp", sessions, sets, { d1: "push1", d2: "pull1" }, "s2").map((x) => x.day_key), ["push1", "push1"]);
});
