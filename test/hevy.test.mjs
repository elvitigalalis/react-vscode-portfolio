// Hevy's side (src/sheet/hevy.mjs): the rows kept from the API, events folded newest-first, PRs
// from the synced history, the "Nice lift" text and the next routine. The fixtures in
// test/fixtures/hevy/ are made-up workouts. Expected values are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyEvents, asRingWorkouts, nextRoutine, prs, toLb, workoutRows, workoutText } from "../src/sheet/hevy.mjs";
import { gymMatches } from "../src/sheet/ring.mjs";

const TZ = "America/New_York";
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/hevy/${name}`, import.meta.url), "utf8"));
const LB = 2.20462;

test("workoutRows: workouts and sets as table rows, his local day, no notes, a workout with no end skipped", () => {
  const { workouts, sets } = workoutRows(fixture("workouts.json"), TZ);
  assert.deepEqual(workouts, [
    { id: "w-push-1", title: "Push #1", routine_id: "r-push", day: "2026-11-02", starts_at: "2026-11-02T22:30:00.000Z", ends_at: "2026-11-02T23:35:00.000Z", updated_at: "2026-11-02T23:36:00.000Z" },
    { id: "w-pull-1", title: "Pull #1", routine_id: "r-pull", day: "2026-11-04", starts_at: "2026-11-04T22:00:00.000Z", ends_at: "2026-11-04T23:00:00.000Z", updated_at: "2026-11-04T23:01:00.000Z" },
  ]);
  assert.equal(sets.length, 5);
  assert.deepEqual(sets[0], { workout_id: "w-push-1", exercise_index: 0, set_index: 0, template_id: "T-BENCH", exercise: "Bench Press (Barbell)", set_type: "warmup", weight_kg: 43.0913, reps: 8, rpe: null });
  assert.deepEqual(sets[3], { workout_id: "w-push-1", exercise_index: 1, set_index: 0, template_id: "T-PUSHUP", exercise: "Push Up", set_type: "failure", weight_kg: null, reps: 20, rpe: 10 });
  assert.doesNotMatch(JSON.stringify({ workouts, sets }), /felt heavy|elbows in/);
});

test("workoutRows: a late-evening start is that local day; titles clipped; odd values dropped", () => {
  const w = { id: "w1", title: "x".repeat(250), routine_id: "", start_time: "2026-11-08T04:30:00Z", end_time: "2026-11-08T05:30:00Z",
    exercises: [{ index: 0, title: "Curl", exercise_template_id: "T-CURL", sets: [{ index: 0, type: "giant", weight_kg: -5, reps: 2.5, rpe: 11 }] },
      { index: 1, title: "No template", sets: [{ index: 0, type: "normal", weight_kg: 10, reps: 5 }] }] };
  const { workouts, sets } = workoutRows([w, { ...w, id: "w2", end_time: "2026-11-08T04:00:00Z" }], TZ);
  assert.equal(workouts.length, 1);
  assert.equal(workouts[0].day, "2026-11-07");
  assert.equal(workouts[0].title.length, 200);
  assert.equal(workouts[0].routine_id, null);
  assert.equal(workouts[0].updated_at, "2026-11-08T05:30:00.000Z");
  assert.deepEqual(sets, [{ workout_id: "w1", exercise_index: 0, set_index: 0, template_id: "T-CURL", exercise: "Curl", set_type: "normal", weight_kg: null, reps: null, rpe: null }]);
});

test("applyEvents: each id once, by its newest event; a delete beats an older update", () => {
  const { updated, deleted } = applyEvents(fixture("events.json"));
  assert.deepEqual(updated.map((w) => [w.id, w.title]), [["w-push-2", "Push #2 (edited)"], ["w-pull-2", "Pull #2"]]);
  assert.deepEqual(deleted, ["w-old"]);
  assert.deepEqual(applyEvents([]), { updated: [], deleted: [] });
  // A plain list of events works too.
  assert.deepEqual(applyEvents([[{ type: "deleted", id: "a" }]]).deleted, ["a"]);
});

test("asRingWorkouts: Hevy rows end the Gym block as a ring strength workout does", () => {
  const { workouts } = workoutRows(fixture("workouts.json"), TZ);
  const ring = asRingWorkouts(workouts);
  assert.deepEqual(ring[0], { oura_id: "w-push-1", day: "2026-11-02", starts_at: "2026-11-02T22:30:00.000Z", ends_at: "2026-11-02T23:35:00.000Z", activity: "strength" });
  const block = { id: "b1", habit_id: "h1", starts_at: "2026-11-02T22:00:00.000Z", ends_at: "2026-11-03T00:00:00.000Z", proposed: false, gcal_id: "g1" };
  assert.deepEqual(gymMatches(ring, [block], [{ id: "h1", name: "Gym" }], TZ), [{ block_id: "b1", gcal_id: "g1", action: "shrink", ends_at: "2026-11-02T23:35:00.000Z" }]);
});

test("toLb: to the nearest half pound", () => {
  assert.equal(toLb(102.058), 225);
  assert.equal(toLb(81.6466), 180);
  assert.equal(toLb(20), 44);
  assert.equal(toLb(0), 0);
});

// A set row for the PR tests, in pounds.
const set = (workout_id, template_id, exercise, lb, reps, set_type = "normal", set_index = 0, exercise_index = 0) =>
  ({ workout_id, exercise_index, set_index, template_id, exercise, set_type, weight_kg: lb / LB, reps, rpe: null });
const W2 = { id: "w2", title: "Push #2", starts_at: "2026-11-07T22:30:00Z", ends_at: "2026-11-07T23:35:00Z" };
const history = [
  set("w1", "T-BENCH", "Bench Press", 180, 6), set("w1", "T-BENCH", "Bench Press", 180, 5, "normal", 1),
  set("w1", "T-BENCH", "Bench Press", 250, 1, "warmup", 2), set("w1", "T-BENCH", "Bench Press", 200, 15, "normal", 3),
  set("w1", "T-OHP", "Overhead Press", 100, 10, "normal", 0, 1), set("w1", "T-OHP", "Overhead Press", 80, 3, "normal", 1, 1),
];

test("prs: an e1RM above every earlier best, in his unit", () => {
  // 185 × 6: e1RM 222 beats 180 × 6 (216). The 250 warm-up and the 15-rep set never count.
  const mine = [set("w2", "T-BENCH", "Bench Press", 185, 6)];
  assert.deepEqual(prs(W2, mine, history), [{ exercise: "Bench Press", kind: "e1rm", weight_kg: 185 / LB, reps: 6, text: "Bench Press 185 × 6 (e1RM 222)" }]);
  assert.equal(prs(W2, mine, history, "kg")[0].text, "Bench Press 83.9 × 6 (e1RM 101)");
});

test("prs: a heavier weight at a rep count done before, when the e1RM stands", () => {
  // 85 × 3 (e1RM 93.5) is under 100 × 10 (133.3) but heavier than 80 × 3.
  const mine = [set("w2", "T-OHP", "Overhead Press", 85, 3), set("w2", "T-OHP", "Overhead Press", 70, 12, "normal", 1)];
  assert.deepEqual(prs(W2, mine, history).map((p) => [p.kind, p.text]), [["weight", "Overhead Press 85 × 3"]]);
});

test("prs: none for a first time, a warm-up, a set past 12 reps, or a tie", () => {
  assert.deepEqual(prs(W2, [set("w2", "T-SQUAT", "Squat", 300, 5)], history), []);
  assert.deepEqual(prs(W2, [set("w2", "T-BENCH", "Bench Press", 300, 5, "warmup")], history), []);
  assert.deepEqual(prs(W2, [set("w2", "T-BENCH", "Bench Press", 180, 13)], history), []);
  assert.deepEqual(prs(W2, [set("w2", "T-BENCH", "Bench Press", 180, 6)], history), []);
  // This workout's own sets in the history are ignored.
  assert.equal(prs(W2, [set("w2", "T-BENCH", "Bench Press", 185, 6)], [...history, set("w2", "T-BENCH", "Bench Press", 185, 6)]).length, 1);
});

test("workoutText: title, length, working sets, then at most 4 PRs", () => {
  const sets = [set("w2", "T-BENCH", "Bench Press", 95, 8, "warmup"), ...Array.from({ length: 18 }, (_, i) => set("w2", "T-BENCH", "Bench Press", 185, 6, "normal", i + 1))];
  const pr = prs(W2, [set("w2", "T-BENCH", "Bench Press", 185, 6)], history);
  assert.equal(workoutText(W2, sets, pr, "lbs"), "Nice lift · Push #2 · 1h 05m · 18 sets\nPRs: Bench Press 185 × 6 (e1RM 222)");
  assert.equal(workoutText(W2, sets, pr, "kg"), "Nice lift · Push #2 · 1h 05m · 18 sets\nPRs: Bench Press 83.9 × 6 (e1RM 101)");
  assert.equal(workoutText({ ...W2, ends_at: "2026-11-07T23:15:00Z" }, sets.slice(0, 2), []), "Nice lift · Push #2 · 45m · 1 set");
  const five = ["A", "B", "C", "D", "E"].map((x) => ({ exercise: x, kind: "weight", weight_kg: 100 / LB, reps: 5, text: "" }));
  assert.equal(workoutText(W2, [], five).split("\n")[1], "PRs: A 100 × 5, B 100 × 5, C 100 × 5, D 100 × 5");
});

const done = (id, routine_id, title, day) => ({ id, routine_id, title, starts_at: `2026-11-${day}T22:00:00Z` });

test("nextRoutine: the routine done after the last time the latest one was done", () => {
  const w = [done("1", "r-push", "Push", "01"), done("2", "r-pull", "Pull", "02"), done("3", null, "Run", "03"),
    done("4", "r-legs", "Legs", "04"), done("5", "r-push", "Push", "06")];
  assert.deepEqual(nextRoutine(w), { routine_id: "r-pull", title: "Pull" });
  // Order is by start, not by list order; a run with no routine in between is passed over.
  assert.deepEqual(nextRoutine([...w].reverse().concat(done("6", "r-pull", "Pull", "07"))), { routine_id: "r-legs", title: "Legs" });
});

test("nextRoutine: null with no routine on the last workout, or no earlier time", () => {
  assert.equal(nextRoutine([done("1", "r-push", "Push", "01"), done("2", null, "Free", "02")]), null);
  assert.equal(nextRoutine([done("1", "r-pull", "Pull", "01"), done("2", "r-push", "Push", "02")]), null);
  assert.equal(nextRoutine([]), null);
});
