// Horizon planning, part 2: what read_planner shows of the horizon, how submit_proposal holds a
// plan to it, and at risk read from the horizon's states (docs/sheet-horizon.md, "Part 2").
import { test } from "node:test";
import assert from "node:assert/strict";
import { atRisk } from "../src/sheet/logic.mjs";
import { checkProposal, planSnapshot } from "../src/sheet/proposal.mjs";

const TZ = "America/New_York";
const DAY = "2026-11-04";
const sixOhSeven = new Date("2026-11-04T11:07:00Z"); // 6:07 am EST, so plan_day is today
const settings = { time_zone: TZ, busy_as_of: null, interests: null };
const taskRow = (id, extra = {}) => ({ id, title: id, day: DAY, list: null, est_min: 60, at_time: null, tag: null, done: false, due: null, source: null, ...extra });
const state = (task_id, extra = {}) => ({ task_id, state: "on_track", slack_min: 300, short_min: 0, remaining_min: 240, finish_day: "2026-11-06", target_day: "2026-11-08", ...extra });
const rows = (extra = {}) => ({ settings, tasks: [], blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [], ...extra });

test("atRisk: a task with a horizon state is at risk when tight or won't fit, whatever its blocks", () => {
  const far = { id: "a", due: "2026-11-20", done: false };
  assert.equal(atRisk(far, [], DAY, TZ, state("a", { state: "tight" })), true);
  assert.equal(atRisk(far, [], DAY, TZ, state("a", { state: "wont_fit" })), true);
  const near = { id: "a", due: DAY, done: false };
  const approved = [{ task_id: "a", starts_at: "2026-11-04T20:00:00Z", proposed: false }];
  assert.equal(atRisk(near, approved, DAY, TZ, state("a")), false);
  // Due today (or overdue) with no approved block: it didn't fit today, whatever the state says.
  assert.equal(atRisk(near, [], DAY, TZ, state("a")), true);
  assert.equal(atRisk({ ...near, due: "2026-11-03" }, [], DAY, TZ, state("a")), true);
  assert.equal(atRisk({ ...near, due: "2026-11-05" }, [], DAY, TZ, state("a")), false);
  assert.equal(atRisk({ ...far, done: true }, [], DAY, TZ, state("a", { state: "tight" })), false);
  // Without a state, the old rule.
  assert.equal(atRisk(near, [], DAY, TZ), true);
});

test("planSnapshot: each horizon task carries its minutes on plan_day and its state, at-risk ones first", () => {
  const tasks = [
    taskRow("plain"),
    taskRow("os", { day: null, list: "Projects", due: "2026-11-20", est_min: 600 }),
    taskRow("essay", { day: null, list: "Inbox", due: "2026-11-06", est_min: 180 }),
    taskRow("later", { day: null, list: "Inbox", due: "2026-11-25" }),
  ];
  const horizon = {
    alloc: [
      { task_id: "os", day: DAY, minutes: 90, over_min: 0 },
      { task_id: "essay", day: DAY, minutes: 120, over_min: 30 },
      { task_id: "later", day: "2026-11-05", minutes: 60, over_min: 0 },
    ],
    states: [state("os"), state("essay", { state: "wont_fit", short_min: 30, slack_min: -30 }), state("later")],
  };
  const s = planSnapshot(rows({ tasks, horizon }), sixOhSeven);
  // A Someday task with minutes today joins; one with none today doesn't.
  assert.deepEqual(s.tasks.map((t) => t.id), ["essay", "plain", "os"]);
  const essay = s.tasks[0];
  assert.deepEqual(essay.horizon, { today_min: 90, state: "wont_fit", slack_min: -30, short_min: 30, finish_day: "2026-11-06" });
  assert.equal(essay.at_risk, true);
  assert.equal(s.tasks[2].horizon.today_min, 90);
  assert.equal("horizon" in s.tasks[1], false);
});

const proposalFor = (snap, blocks, extra = {}) => checkProposal({ day: DAY, replaces: null, blocks, needs_you: [], picks: [], ...extra }, snap);

test("checkProposal: a horizon task's blocks run its minutes today, less what is locked", () => {
  const tasks = [taskRow("os", { due: "2026-11-20", est_min: 600 })];
  const horizon = { alloc: [{ task_id: "os", day: DAY, minutes: 90, over_min: 0 }], states: [state("os")] };
  const snap = planSnapshot(rows({ tasks, horizon }), sixOhSeven);
  assert.equal(proposalFor(snap, [{ task_id: "os", start: "09:00", minutes: 90 }]).ok, true);
  const r = proposalFor(snap, [{ task_id: "os", start: "09:00", minutes: 240 }]);
  assert.deepEqual(r.errors, ["blocks[0]: minutes must be 90, the task's horizon minutes on 2026-11-04"]);
  // 30 of its 90 already locked this morning.
  const locked = [{ task_id: "os", starts_at: "2026-11-04T12:00:00Z", ends_at: "2026-11-04T12:30:00Z", proposed: false }];
  const snap2 = planSnapshot(rows({ tasks, horizon, blocks: locked }), sixOhSeven);
  assert.equal(proposalFor(snap2, [{ task_id: "os", start: "09:00", minutes: 60 }]).ok, true);
  assert.deepEqual(proposalFor(snap2, [{ task_id: "os", start: "09:00", minutes: 90 }]).errors, ["blocks[0]: minutes must be 60, the task's horizon minutes on 2026-11-04 less the 30 locked"]);
});

test("checkProposal: a horizon task with no minutes on plan_day gets no block, and never goes in next_day", () => {
  const tasks = [taskRow("os", { due: "2026-11-20" }), taskRow("hw", { due: "2026-11-09" })];
  const horizon = { alloc: [{ task_id: "os", day: DAY, minutes: 60, over_min: 0 }], states: [state("os"), state("hw")] };
  const snap = planSnapshot(rows({ tasks, horizon }), sixOhSeven);
  assert.deepEqual(proposalFor(snap, [{ task_id: "hw", start: "09:00", minutes: 60 }]).errors,
    ["blocks[0]: no horizon minutes on 2026-11-04, so no block today"]);
  assert.deepEqual(proposalFor(snap, [], { next_day: ["os"] }).errors,
    ["next_day[0]: os has horizon minutes, which the server moves; leave it out"]);
  assert.equal(proposalFor(snap, [], { next_day: ["hw"] }).ok, true);
});

test("checkProposal: a task due on or before plan_day never goes in next_day, which would pass its deadline", () => {
  const tasks = [taskRow("webassign", { due: DAY, est_min: null }), taskRow("old", { due: "2026-11-02" }), taskRow("hw", { due: "2026-11-05" })];
  const snap = planSnapshot(rows({ tasks }), sixOhSeven);
  assert.deepEqual(proposalFor(snap, [], { next_day: ["webassign", "old"] }).errors, [
    "next_day[0]: webassign is due 2026-11-04, so moving it to the next day would pass its deadline; put it in couldnt_fit instead",
    "next_day[1]: old is due 2026-11-02, so moving it to the next day would pass its deadline; put it in couldnt_fit instead",
  ]);
  assert.equal(proposalFor(snap, [], { next_day: ["hw"], couldnt_fit: ["webassign"] }).ok, true);
});

test("checkProposal: horizon minutes over 240 (a due-day crunch) go in several blocks that add up", () => {
  const tasks = [taskRow("os", { due: DAY, est_min: 600 })];
  const horizon = { alloc: [{ task_id: "os", day: DAY, minutes: 300, over_min: 0 }], states: [state("os", { state: "tight" })] };
  const snap = { ...planSnapshot(rows({ tasks, horizon }), sixOhSeven), day_rules: { workload_cap_min: 600, travel_min: 10, break_after_min: 300, break_min: 10 } };
  snap.window = { from: "07:00", to: "23:00" };
  assert.deepEqual(proposalFor(snap, [{ task_id: "os", start: "09:00", minutes: 180 }, { task_id: "os", start: "13:00", minutes: 120 }]).errors, []);
  assert.deepEqual(proposalFor(snap, [{ task_id: "os", start: "09:00", minutes: 180 }, { task_id: "os", start: "13:00", minutes: 60 }]).errors,
    ["blocks[0]: os's blocks must add up to 300, the task's horizon minutes on 2026-11-04 (they add up to 240)"]);
});
