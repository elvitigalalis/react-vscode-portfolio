// Projects that split into steps (docs/sheet-projects.md): the engine places a project's steps in
// order, and the pieces around it read and show them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planHorizon } from "../src/sheet/horizon.mjs";
import { horizonInput, horizonQueries } from "../src/sheet/horizon-io.mjs";
import { addedLine, checkAnswers, itemLines } from "../src/sheet/messages.mjs";
import { receipt, undoChanges } from "../src/sheet/capture.mjs";

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

// ---------------------------------------------------------------- answer_messages

const M = "0c6a7f52-1111-4c3e-9a55-000000000001";
const TZ = "America/New_York";
const steps = (...mins) => mins.map((est_min, i) => ({ title: `Step ${i + 1}`, est_min }));
const project = (over = {}) => ({ title: "CSE 416 final project", due: "2026-12-10", est_min: 900, steps: steps(120, 240, 240, 180, 120), ...over });
const check = (projects, extra = {}) => checkAnswers({ answers: [{ id: M, tasks: [], events: [], reply: "Added it.", projects, ...extra }] }, [{ id: M }], TZ, new Date("2026-11-05T13:00:00Z"));

test("checkAnswers: a project with 3 to 10 ordered steps is added as given", () => {
  const out = check([project({ why: "15h, as given" })]);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.answers[0].projects, [{ title: "CSE 416 final project", due: "2026-12-10", est_min: 900, steps: steps(120, 240, 240, 180, 120), why: "15h, as given" }]);
  assert.deepEqual(out.answers[0].tasks, []);
});

test("checkAnswers: an answer without projects has no projects field", () => {
  assert.ok(!("projects" in check(undefined).answers[0]));
});

test("checkAnswers: a project's steps are 3 to 10, each 30 to 240 minutes, summing near its estimate", () => {
  const errs = (p) => check([project(p)]).errors.join("\n");
  assert.match(errs({ steps: steps(450, 450) }), /projects\[0\]\.steps: 3 to 10 steps/);
  assert.match(errs({ steps: steps(...Array(11).fill(90)) }), /projects\[0\]\.steps: 3 to 10 steps/);
  assert.match(errs({ steps: steps(300, 300, 300) }), /steps\[0\]\.est_min: must be 30 to 240/);
  assert.match(errs({ steps: steps(60, 60, 60) }), /add up to 180 minutes, too far from est_min 900/);
  assert.match(errs({ due: null }), /projects\[0\]\.due: must be a date/);
  assert.match(errs({ steps: [{ title: "", est_min: 60 }, ...steps(240, 240, 240)] }), /steps\[0\]\.title/);
  assert.match(check(Array(4).fill(project())).errors.join(), /projects: at most 3/);
  // 20% either way is near enough.
  assert.deepEqual(check([project({ steps: steps(240, 240, 240) })]).errors, []);
});

// ---------------------------------------------------------------- the receipt and Undo

const P = "0c6a7f52-2222-4c3e-9a55-000000000002";
const T = "0c6a7f52-3333-4c3e-9a55-000000000003";
const answered = {
  id: M, status: "done", reply: "Added the project in 7 steps and the lab report.", tasks_added: 2, events: [],
  tasks: [
    { id: T, title: "Lab report", day: null, list: "Inbox", due: "2026-11-06", at_time: null },
    { id: P, kind: "project", title: "CSE 416 final project", day: null, list: "Inbox", due: "2026-12-10", at_time: null, steps: 7, why: "15h, as given" },
  ],
};

test("a message's receipt counts and lists a project with its steps and due date", () => {
  assert.equal(addedLine(answered), "Added: 1 project, 1 task");
  assert.deepEqual(itemLines(answered, TZ)[1], { id: P, kind: "project", title: "CSE 416 final project", why: "15h, as given", when: "7 steps · due Thu Dec 10" });
  const { text, buttons } = receipt(answered, TZ);
  assert.match(text, /^Project: CSE 416 final project · 7 steps · due Thu Dec 10$/m);
  assert.equal(buttons[1][0].text, "Undo project: CSE 416 final project");
});

test("Undo on a project in Telegram deletes its steps' Google events, then the project", () => {
  const blocks = [{ id: "b1", task_id: "s1", gcal_id: "g1" }, { id: "b2", task_id: "s2", gcal_id: null }];
  assert.deepEqual(undoChanges(answered, P, blocks), {
    title: "CSE 416 final project",
    changes: [{ table: "gcal_pending", insert: { gcal_id: "g1", ends_at: null } }, { rpc: "undo_message_item", args: { m: M, item: P } }],
  });
});
