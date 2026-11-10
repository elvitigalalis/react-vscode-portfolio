// Reflow rest of today (src/sheet/reflow.mjs). Times are minutes past midnight; expected values
// are written out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reflowPlan } from "../src/sheet/reflow.mjs";

const H = (h, m = 0) => h * 60 + m;
const tasks = (...list) => new Map(list.map((t) => [t.id, { done: false, at_time: null, ...t }]));
const B = (id, task_id, start, end, extra = {}) => ({ id, task_id, start, end, proposed: false, ...extra });
const to = (plan) => Object.fromEntries(plan.moves.map((m) => [m.id, [m.to.start, m.to.end]]));

test("reflowPlan: a missed block goes after now, on the next 5-minute mark", () => {
  const plan = reflowPlan({ blocks: [B("b1", "t1", H(9), H(10))], tasks: tasks({ id: "t1" }), busy: [], now: H(11, 2), shutdown: H(22) });
  assert.deepEqual(to(plan), { b1: [H(11, 5), H(12, 5)] });
  assert.deepEqual(plan.moves[0].from, { start: H(9), end: H(10) });
  assert.deepEqual(plan.unfit, []);
});

test("reflowPlan: blocks keep their order and length and step around busy events", () => {
  const plan = reflowPlan({
    blocks: [B("b1", "t1", H(9), H(10)), B("b2", "t2", H(10), H(10, 30))],
    tasks: tasks({ id: "t1" }, { id: "t2" }),
    busy: [{ start: H(11, 30), end: H(12, 20) }],
    now: H(11), shutdown: H(22),
  });
  // b1 doesn't fit before the lecture (11:00-12:00 hits 11:30), so it waits until 12:20.
  assert.deepEqual(to(plan), { b1: [H(12, 20), H(13, 20)], b2: [H(13, 20), H(13, 50)] });
});

test("reflowPlan: a later block moves only when pushed or clashing; it never moves earlier", () => {
  const free = reflowPlan({ blocks: [B("b1", "t1", H(15), H(16))], tasks: tasks({ id: "t1" }), busy: [], now: H(11), shutdown: H(22) });
  assert.deepEqual(free.moves, []);
  const pushed = reflowPlan({
    blocks: [B("b0", "t0", H(8), H(10)), B("b1", "t1", H(12), H(13))],
    tasks: tasks({ id: "t0" }, { id: "t1" }),
    busy: [], now: H(11), shutdown: H(22),
  });
  assert.deepEqual(to(pushed), { b0: [H(11), H(13)], b1: [H(13), H(14)] });
  const clash = reflowPlan({ blocks: [B("b1", "t1", H(15), H(16))], tasks: tasks({ id: "t1" }), busy: [{ start: H(15, 30), end: H(16, 30) }], now: H(11), shutdown: H(22) });
  assert.deepEqual(to(clash), { b1: [H(16, 30), H(17, 30)] });
});

test("reflowPlan: what stays put (running, done, fixed time, habit, focus, proposed) is worked around", () => {
  const plan = reflowPlan({
    blocks: [
      B("run", "t1", H(10, 30), H(11, 30)),       // on now: stays
      B("gym", null, H(11, 30), H(12)),            // a habit block: stays
      B("fixed", "t3", H(12), H(12, 30)),          // a task @12pm: stays
      B("done", "t4", H(9), H(9, 30)),             // a done task's block: stays
      B("focus", "t5", H(8), H(8, 30)),            // a focus session is on it: stays
      B("prop", "t6", H(12, 30), H(13), { proposed: true }), // Claude's suggestion: takes no time
      B("miss", "t7", H(9, 30), H(10)),            // missed: moves
    ],
    tasks: tasks({ id: "t1" }, { id: "t3", at_time: "12:00:00" }, { id: "t4", done: true }, { id: "t5" }, { id: "t6" }, { id: "t7" }),
    busy: [], now: H(11), shutdown: H(22), keep: ["focus"],
  });
  assert.deepEqual(to(plan), { miss: [H(12, 30), H(13)] });
});

test("reflowPlan: nothing goes past shutdown; what doesn't fit stays and is named", () => {
  const plan = reflowPlan({
    blocks: [B("b1", "t1", H(9), H(10)), B("b2", "t2", H(10), H(12))],
    tasks: tasks({ id: "t1" }, { id: "t2" }),
    busy: [], now: H(20), shutdown: H(22),
  });
  assert.deepEqual(to(plan), { b1: [H(20), H(21)] });
  assert.deepEqual(plan.unfit, ["b2"]);
});

test("reflowPlan: a later block that can't fit keeps its time, and nothing is laid over it", () => {
  const plan = reflowPlan({
    blocks: [B("b0", "t0", H(8), H(8, 30)), B("b1", "t1", H(9), H(10, 30)), B("b2", "t2", H(20, 30), H(21, 45))],
    tasks: tasks({ id: "t0" }, { id: "t1" }, { id: "t2" }),
    busy: [], now: H(19), shutdown: H(22),
  });
  // A first pass puts b1 at 7:30-9 pm, pushing b2 past 10 pm. b2 then stays at 8:30-9:45 pm, and
  // the plan is laid again around it: b1 (1h30) no longer fits before it or after it.
  assert.deepEqual(to(plan), { b0: [H(19), H(19, 30)] });
  assert.deepEqual(plan.unfit.sort(), ["b1", "b2"]);
  const placed = [...plan.moves.map((m) => m.to), { start: H(20, 30), end: H(21, 45) }];
  for (const a of placed) for (const b of placed) if (a !== b) assert.ok(a.end <= b.start || b.end <= a.start, "no overlap");
});
