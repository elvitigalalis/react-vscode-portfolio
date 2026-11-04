// v5 P1, pace in read_planner and submit_proposal: planSnapshot's paced_min, pace and
// planned_vs_done, checkProposal's paced-minutes rule, and the rows planner-mcp reads for them
// (docs/sheet-v5.md, "pace.mjs" and "proposal.mjs"). The Finished? side is in
// test/v5-pace.verify.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSnapshot, checkProposal } from "../src/sheet/proposal.mjs";
import { paceQueries, queryPath } from "../src/sheet/proposal-io.mjs";

const TZ = "America/New_York";
const DAY = "2026-11-04";
const sixOhSeven = new Date("2026-11-04T11:07:00Z"); // 6:07 am EST, so plan_day is today
const T1 = "6f1c2a3b-0000-4000-8000-000000000001";
const T4 = "6f1c2a3b-0000-4000-8000-000000000004";

const settings = { time_zone: TZ, busy_as_of: null, interests: null };
const taskRow = (id, title, extra = {}) => ({ id, title, day: DAY, list: null, est_min: null, at_time: null, tag: null, done: false, due: null, source: null, ...extra });
const rows = (extra = {}) => ({ settings, tasks: [], blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [], ...extra });
const actual = (i, kind, est_min, minutes) => ({ at: `2026-10-${String(10 + i).padStart(2, "0")}T15:00:00Z`, kind, est_min, minutes });

test("planSnapshot: each task's paced_min, pace per kind, and a snapshot without actuals reads as no pace", () => {
  const actuals = Array.from({ length: 5 }, (_, i) => actual(i, "course", 30, 45)); // 1.5 each
  const tasks = [taskRow(T1, "OS homework", { est_min: 45 }), taskRow(T4, "HW3", { est_min: 30, source: "brightspace" })];
  const s = planSnapshot(rows({ tasks, actuals }), sixOhSeven);
  assert.deepEqual(s.tasks.map((t) => t.paced_min), [45, 45]);
  assert.deepEqual(s.pace.course, { pace: 1.5, n: 5 });
  assert.deepEqual(s.pace.other, { pace: null, n: 0 });
  const bare = planSnapshot(rows({ tasks }), sixOhSeven);
  assert.deepEqual(bare.tasks.map((t) => t.paced_min), [45, 30]);
  assert.deepEqual(bare.planned_vs_done, []);
});

test("planSnapshot: planned_vs_done from the past blocks and their tasks' done", () => {
  const past = [
    { task_id: T1, starts_at: "2026-11-02T14:00:00Z", ends_at: "2026-11-02T15:00:00Z", proposed: false, task: { done: true } },
    { task_id: T4, starts_at: "2026-11-02T16:00:00Z", ends_at: "2026-11-02T16:30:00Z", proposed: false, task: { done: false } },
  ];
  assert.deepEqual(planSnapshot(rows({ past }), sixOhSeven).planned_vs_done, [{ day: "2026-11-02", planned_min: 90, done_min: 60 }]);
});

// A v5 snapshot, hand-built: OS homework paced to 60.
const v5 = () => ({
  ...planSnapshot(rows({ tasks: [taskRow(T1, "OS homework", { est_min: 45 })] }), sixOhSeven),
  version: 5,
  tasks: [{ ...taskRow(T1, "OS homework", { est_min: 45 }), at_risk: false, paced_min: 60 }],
});
const paced = (r) => r.errors.filter((e) => /paced/.test(e));
const input = (minutes) => ({ day: DAY, blocks: [{ task_id: T1, start: "10:00", minutes }] });

test("checkProposal v5: a block runs the task's paced_min, and nothing else", () => {
  assert.deepEqual(paced(checkProposal(input(60), v5())), []);
  assert.deepEqual(paced(checkProposal(input(45), v5())), ["blocks[0]: minutes must be 60, the task's paced estimate"]);
});

test("checkProposal v4: without version 5, block minutes aren't held to paced_min", () => {
  const v4 = { ...v5(), version: undefined };
  assert.equal(checkProposal(input(45), v4).ok, true);
});

test("paceQueries: every actuals row, and the approved blocks of the 14 days before plan_day with their task's done", () => {
  const q = paceQueries(sixOhSeven, TZ);
  assert.equal(queryPath(q.actuals), "actuals?select=at,kind,est_min,minutes&order=at");
  assert.equal(queryPath(q.past),
    "blocks?select=task_id,starts_at,ends_at,proposed,task:tasks(done)&proposed=is.false&starts_at=gte.2026-10-21T04:00:00.000Z&starts_at=lt.2026-11-04T05:00:00.000Z&order=starts_at");
});

test("paceLine: Settings shows a kind's pace and samples, or how many it still needs", async () => {
  const { paceLine } = await import("../src/sheet/pace.mjs");
  assert.equal(paceLine("course", { pace: 1.4, n: 12 }), "Course ×1.4 (12)");
  assert.equal(paceLine("github", { pace: null, n: 3 }), "GitHub: 3 of 5 needed");
  assert.equal(paceLine("other", { pace: null, n: 0 }), "Other: 0 of 5 needed");
});
