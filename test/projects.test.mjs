// Projects that split into steps (docs/sheet-projects.md): the engine places a project's steps in
// order, and the pieces around it read and show them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planHorizon } from "../src/sheet/horizon.mjs";
import { horizonInput, horizonQueries } from "../src/sheet/horizon-io.mjs";

const TODAY = "2026-11-05"; // a Thursday
const days = (n, minutes = 240, from = TODAY) => Object.fromEntries(Array.from({ length: n }, (_, i) => {
  const d = new Date(`${from}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
  return [d.toISOString().slice(0, 10), minutes];
}));
const step = (id, project, n, minutes, due = "2026-11-20") => ({ id, due, minutes, done_min: 0, project, step: n });
const plan = (input) => planHorizon({ today: TODAY, free: days(30), locked: [], frozen_days: [], previous: [], ...input });
const on = (r, id) => r.allocations.filter((a) => a.task_id === id).map(({ day, minutes }) => [day, minutes]);

// ---------------------------------------------------------------- the engine

test("a step's minutes never land before its predecessor's finish day", () => {
  // Plain EDF would put the short second step first (fewer minutes, then id "a" < "z").
  const r = plan({ tasks: [step("z", "p", 1, 180), step("a", "p", 2, 60)] });
  assert.deepEqual(on(r, "z"), [["2026-11-05", 90], ["2026-11-06", 90]]);
  assert.deepEqual(on(r, "a"), [["2026-11-06", 60]]);
  assert.equal(r.tasks.a.state, "on_track");
});

test("steps keep their order through a chain, whatever their ids", () => {
  const r = plan({ tasks: [step("c", "p", 3, 90), step("b", "p", 1, 180), step("a", "p", 2, 120)] });
  const first = (id) => on(r, id)[0][0];
  const last = (id) => on(r, id).at(-1)[0];
  assert.ok(first("a") >= last("b"));
  assert.ok(first("c") >= last("a"));
});

test("a step's kept minutes from before its predecessor's new finish move later", () => {
  // Step 1 grew: last plan had it all today and step 2 tomorrow.
  const previous = [{ task_id: "s1", day: "2026-11-05", minutes: 90, over_min: 0 }, { task_id: "s2", day: "2026-11-06", minutes: 60, over_min: 0 }];
  const free = { ...days(30, 240), "2026-11-06": 106, "2026-11-07": 106 };
  const r = plan({ tasks: [step("s1", "p", 1, 270), step("s2", "p", 2, 60)], previous, free });
  const finish1 = on(r, "s1").at(-1)[0];
  assert.ok(on(r, "s2").every(([d]) => d >= finish1), JSON.stringify(r.allocations));
});

test("steps share one buffer, sized by the whole project", () => {
  // 2h a day free (85% later is 1h30): seven 90-minute steps due in 8 days keep two days spare,
  // as one 10.5-hour task would, not the one day a single 90-minute step keeps.
  const free = days(30, 120);
  const r = plan({ free, tasks: [1, 2, 3, 4, 5, 6, 7].map((n) => step(`s${n}`, "p", n, 90, "2026-11-13")) });
  assert.equal(r.tasks.s7.target_day, "2026-11-11");
  const single = plan({ free, tasks: [{ id: "x", due: "2026-11-13", minutes: 90, done_min: 0 }] });
  assert.equal(single.tasks.x.target_day, "2026-11-12");
});

test("tasks outside a project plan as before", () => {
  const r = plan({ tasks: [{ id: "z", due: "2026-11-20", minutes: 180, done_min: 0 }, { id: "a", due: "2026-11-20", minutes: 60, done_min: 0 }] });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 60]]);
});

// ---------------------------------------------------------------- the re-flow's input

test("horizonInput: a step carries its project and position; other tasks don't", () => {
  const settings = { time_zone: "America/New_York", workload_cap_min: 600, wind_down_on: false, horizon_key: null };
  const row = (id, extra = {}) => ({ id, title: id, day: null, list: "Inbox", due: "2026-11-20", est_min: 60, at_time: null, done: false, source: null, tag: null, ...extra });
  const tasks = [row("s2", { project_id: "p", step: 2 }), row("x"), row("s1", { project_id: "p", step: 1 })];
  const input = horizonInput({ settings, tasks, blocks: [], busy: [], habits: [], actuals: [], feedback: [], day: null, sleepDay: null, previous: [] }, new Date("2026-11-05T13:00:00Z"));
  const by = Object.fromEntries(input.tasks.map((t) => [t.id, [t.project, t.step]]));
  assert.deepEqual(by, { s1: ["p", 1], s2: ["p", 2], x: [undefined, undefined] });
  assert.ok(!("project" in input.tasks.find((t) => t.id === "x")));
  assert.match(horizonQueries("2026-11-05", "America/New_York").tasks.select, /\bproject_id\b.*\bstep\b/);
});
