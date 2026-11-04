// Verification tests for v5 H1, habits: the habits read_planner gives (planSnapshot) and
// checkProposal's habit blocks (src/sheet/proposal.mjs): the ideal ± flex window, the day rules,
// and habits counting toward the workload cap. That /now never shows a habit is checked in SQL,
// in tools/test-schema.sh ("v5 H1"), since public_now is what /now reads. Written before the code
// from docs/sheet-v5.md "Contracts" and spec 47. Every test starts as `todo`; the implementer
// removes `todo` and must not change an expectation. Expected values are written out by hand. The
// module is imported inside each test, so this file loads before the code exists.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5). The snapshot is test/v5-day.verify.test.mjs's: a
// replan at 10:02 am, busy 2:00-3:20 pm, approved Reading 8:30-9:30 am and Gym 11:30 am-12:30 pm.
// The proposal here places OS homework at 10:15 and HW3 at 3:30 pm (Office hours left out), so
// 60 + 60 approved and 45 + 45 proposed make 210 planned minutes before any habit.
//
// Readings chosen where the contract leaves room (closest to its words):
// - Tests match an error's field name and a key word, not its wording.
// - "Firm before flexible" is read_planner's order (docs/sheet-v5.md, planSnapshot's `habits`):
//   the morning task places habits in the order given.
import { test } from "node:test";
import assert from "node:assert/strict";

const proposal = () => import("../src/sheet/proposal.mjs");
const todo = { todo: true };

const TZ = "America/New_York";
const DAY = "2026-11-04";
const SBU = "lisul.elvitigala@stonybrook.edu";
const PERSONAL = "elvitigalalis@gmail.com";

const T1 = "6f1c2a3b-0000-4000-8000-000000000001"; // OS homework, 45 min
const T2 = "6f1c2a3b-0000-4000-8000-000000000002"; // Gym, its approved block 11:30 am-12:30 pm
const T3 = "6f1c2a3b-0000-4000-8000-000000000003"; // Office hours, fixed at 1:00 pm
const T4 = "6f1c2a3b-0000-4000-8000-000000000004"; // HW3, a course task: est 30, paced 45
const T5 = "6f1c2a3b-0000-4000-8000-000000000005"; // Lab 4, at risk, 60 min
const T6 = "6f1c2a3b-0000-4000-8000-000000000006"; // turned down today
const T7 = "6f1c2a3b-0000-4000-8000-000000000007"; // Reading, done 8:30-9:30 am

const H1 = "7a1c2a3b-0000-4000-8000-000000000001"; // Lunch, firm: 30 min, 12:50-1:20 pm start
const H2 = "7a1c2a3b-0000-4000-8000-000000000002"; // Walk, 11:00 am sharp, 30 min
const H3 = "7a1c2a3b-0000-4000-8000-000000000003"; // Coffee, 1:40 pm sharp, 15 min
const H4 = "7a1c2a3b-0000-4000-8000-000000000004"; // Stretch, noon ± 30, 15 min
const H5 = "7a1c2a3b-0000-4000-8000-000000000005"; // Review, 10:00 ± 15, 15 min
const H6 = "7a1c2a3b-0000-4000-8000-000000000006"; // Water, 1:00 pm ± 4 h, 15 min
const habit = (id, name, ideal, minutes, flex_min, defence = "flexible") => ({ id, name, ideal, minutes, flex_min, defence });
const HABITS = [
  habit(H1, "Lunch", "13:05", 30, 15, "firm"),
  habit(H2, "Walk", "11:00", 30, 0),
  habit(H3, "Coffee", "13:40", 15, 0),
  habit(H4, "Stretch", "12:00", 15, 30),
  habit(H5, "Review", "10:00", 15, 15),
  habit(H6, "Water", "13:00", 15, 240),
];

const task = (id, title, est_min, paced_min, extra = {}) => ({
  id, title, est_min, at_time: null, due: null, tag: null, source: null, day: DAY, list: null, at_risk: false, paced_min, ...extra,
});
const snap = (extra = {}) => ({
  version: 5,
  now: "2026-11-04T15:02:00.000Z",
  time_zone: TZ,
  plan_day: DAY,
  shutdown: "17:00",
  window: { from: "10:15", to: "17:00" },
  run: { trigger: "replan", reasons: ["busy_overlap"], changes: { busy: 1 } },
  day_rules: { workload_cap_min: 360, travel_min: 10, break_after_min: 90, break_min: 10 },
  tasks: [
    task(T1, "OS homework", 45, 45, { due: "2026-11-05", at_risk: true }),
    task(T2, "Gym", 60, 60),
    task(T3, "Office hours", 30, 30, { at_time: "13:00:00" }),
    task(T4, "HW3", 30, 45, { due: "2026-11-09", source: "brightspace", day: null, list: "Brightspace" }),
    task(T5, "Lab 4", 40, 60, { due: "2026-11-05", source: "brightspace", day: null, list: "Brightspace", at_risk: true }),
  ],
  blocks: [
    { task_id: T7, starts_at: "2026-11-04T13:30:00Z", ends_at: "2026-11-04T14:30:00Z", proposed: false }, // 8:30-9:30 am
    { task_id: T2, starts_at: "2026-11-04T16:30:00Z", ends_at: "2026-11-04T17:30:00Z", proposed: false }, // 11:30 am-12:30 pm
    { task_id: T1, starts_at: "2026-11-04T20:30:00Z", ends_at: "2026-11-04T21:15:00Z", proposed: true },  // 3:30-4:15 pm, rev 1
  ],
  busy: [{ starts_at: "2026-11-04T19:00:00Z", ends_at: "2026-11-04T20:20:00Z" }], // 2:00-3:20 pm
  busy_as_of: "2026-11-04T15:00:00Z",
  interests: null,
  campus: [],
  proposal: { rev: 1, status: "pending", created_at: "2026-11-04T11:09:00Z", run_trigger: "morning" },
  needs_you_open: [],
  accounts: [SBU, PERSONAL],
  pace: { course: { pace: 1.5, n: 6 }, campus: { pace: null, n: 0 }, github: { pace: null, n: 0 }, jira: { pace: null, n: 0 }, other: { pace: null, n: 2 } },
  planned_vs_done: [],
  turned_down: [T6],
  habits: HABITS,
  triage_rules: [],
  reply_state: { owed: [], awaiting: [] },
  weather: [],
  academic: [],
  ...extra,
});

const good = (habits, extra = {}) => ({
  day: DAY,
  replaces: 1,
  blocks: [
    { task_id: T1, start: "10:15", minutes: 45 },
    { task_id: T4, start: "15:30", minutes: 45 },
  ],
  habits,
  needs_you: [],
  picks: [],
  note: null,
  couldnt_fit: [T5],
  ...extra,
});

function refused(result, ...patterns) {
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "expected errors");
  assert.ok(result.errors.some((e) => patterns.every((p) => p.test(e))), `no error matching ${patterns.join(" and ")}: ${JSON.stringify(result.errors)}`);
}

// =============================================================================================
// read_planner: the day's habits
// =============================================================================================

test("planSnapshot: plan_day's habits, firm first, then flexible, each by ideal time", async () => {
  const { planSnapshot } = await proposal();
  const row = (id, name, days, ideal, minutes, flex_min, defence, position) => ({ id, name, days, ideal, minutes, flex_min, defence, position, created_at: "2026-11-01T12:00:00Z" });
  const rows = {
    settings: { time_zone: TZ, busy_as_of: null, interests: null },
    tasks: [], blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [],
    habits: [
      row(H2, "Gym", [1, 3, 5], "07:30:00", 60, 30, "flexible", 0),
      row(H3, "Weekly review", [7], "16:00:00", 45, 60, "firm", 1), // Sundays only
      row(H1, "Lunch", [1, 2, 3, 4, 5], "12:30:00", 30, 30, "firm", 2),
      row(H4, "Meditate", [3], "06:45:00", 15, 15, "firm", 3),
      row(H5, "Reading", [1, 2, 3, 4, 5, 6, 7], "07:30:00", 30, 60, "flexible", -1),
    ],
  };
  // 6:07 am on Wednesday, ISO weekday 3.
  assert.deepEqual(planSnapshot(rows, new Date("2026-11-04T11:07:00Z")).habits, [
    { id: H4, name: "Meditate", ideal: "06:45", minutes: 15, flex_min: 15, defence: "firm" },
    { id: H1, name: "Lunch", ideal: "12:30", minutes: 30, flex_min: 30, defence: "firm" },
    // Both at 7:30: by position.
    { id: H5, name: "Reading", ideal: "07:30", minutes: 30, flex_min: 60, defence: "flexible" },
    { id: H2, name: "Gym", ideal: "07:30", minutes: 60, flex_min: 30, defence: "flexible" },
  ]);
});

test("planSnapshot: with no habits rows, habits is empty", async () => {
  const { planSnapshot } = await proposal();
  const rows = { settings: { time_zone: TZ }, tasks: [], blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [] };
  assert.deepEqual(planSnapshot(rows, new Date("2026-11-04T11:07:00Z")).habits, []);
});

// =============================================================================================
// checkProposal: habit blocks
// =============================================================================================

test("habits: a habit inside its window becomes a habit block in rows", todo, async () => {
  const { checkProposal } = await proposal();
  // Lunch at 12:50-1:20 pm: 20 minutes after Gym, 40 before the travel gap at 1:50.
  const r = checkProposal(good([{ habit_id: H1, start: "12:50" }]), snap());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.rows.habit_blocks, [{ habit_id: H1, starts_at: "2026-11-04T17:50:00.000Z", ends_at: "2026-11-04T18:20:00.000Z" }]);
  assert.deepEqual(r.rows.blocks, [
    { task_id: T1, starts_at: "2026-11-04T15:15:00.000Z", ends_at: "2026-11-04T16:00:00.000Z" },
    { task_id: T4, starts_at: "2026-11-04T20:30:00.000Z", ends_at: "2026-11-04T21:15:00.000Z" },
  ]);
});

test("habits: the window is ideal ± flex, both ends included", todo, async () => {
  const { checkProposal } = await proposal();
  // Lunch: 1:05 pm ± 15. 1:20-1:50 pm ends exactly where the travel gap before 2:00 starts.
  assert.equal(checkProposal(good([{ habit_id: H1, start: "12:50" }]), snap()).ok, true);
  assert.equal(checkProposal(good([{ habit_id: H1, start: "13:20" }]), snap()).ok, true);
});

test("habits: a start outside ideal ± flex is refused, naming the habit", todo, async () => {
  const { checkProposal } = await proposal();
  refused(checkProposal(good([{ habit_id: H1, start: "12:45" }]), snap()), /habits\[0\]/);
  // Without the busy time, so only the window is wrong.
  refused(checkProposal(good([{ habit_id: H1, start: "13:21" }]), snap({ busy: [] })), /habits\[0\]/);
});

test("habits: an id that isn't one of the day's habits is refused", todo, async () => {
  const { checkProposal } = await proposal();
  refused(checkProposal(good([{ habit_id: "7a1c2a3b-0000-4000-8000-0000000000ff", start: "12:50" }]), snap()), /habits\[0\]/);
});

test("habits: a habit placed twice is refused at the second", todo, async () => {
  const { checkProposal } = await proposal();
  // Water may start any time from 9:00 am to 5:00 pm; 4:20-4:35 pm follows HW3 within the break rule.
  const r = checkProposal(good([{ habit_id: H6, start: "12:50" }, { habit_id: H6, start: "16:20" }]), snap());
  refused(r, /habits\[1\]/);
  assert.equal(r.errors.some((e) => /habits\[0\]/.test(e)), false, JSON.stringify(r.errors));
});

test("habits: start must be \"HH:MM\"", todo, async () => {
  const { checkProposal } = await proposal();
  refused(checkProposal(good([{ habit_id: H1, start: "1:00 pm" }]), snap()), /habits\[0\]/);
});

test("habits: a habit block must lie inside the plan window", todo, async () => {
  const { checkProposal } = await proposal();
  // Review at 10:00 am is within 10:00 ± 15, but the replan's window starts at 10:15.
  refused(checkProposal(good([{ habit_id: H5, start: "10:00" }]), snap()), /habits\[0\]/, /10:15/);
});

test("habits: a habit block over an approved block is refused", todo, async () => {
  const { checkProposal } = await proposal();
  // Stretch at noon, inside Gym's 11:30 am-12:30 pm.
  refused(checkProposal(good([{ habit_id: H4, start: "12:00" }]), snap()), /habits\[0\]/, /approved/);
});

test("habits: a habit block over one of the proposal's blocks is refused", todo, async () => {
  const { checkProposal } = await proposal();
  // Water at 3:45 pm, inside HW3's 3:30-4:15 pm.
  refused(checkProposal(good([{ habit_id: H6, start: "15:45" }]), snap()), /habits\[0\]/);
});

test("habits: a habit block needs the travel gap around a busy time", todo, async () => {
  const { checkProposal } = await proposal();
  // Coffee 1:40-1:55 pm runs into the 10 minutes before the 2:00 pm busy time.
  refused(checkProposal(good([{ habit_id: H3, start: "13:40" }]), snap()), /habits\[0\]/, /travel/);
});

test("habits: a habit block counts in the break rule", todo, async () => {
  const { checkProposal } = await proposal();
  // Walk 11:00-11:30 am joins OS homework (10:15) and Gym (to 12:30) into 135 minutes in a row.
  // The approved Gym block carries it past 90, so the latest proposed block, the walk, is named.
  refused(checkProposal(good([{ habit_id: H2, start: "11:00" }]), snap()), /habits\[0\]/, /90/);
});

test("habits: habit blocks count toward the workload cap", todo, async () => {
  const { checkProposal } = await proposal();
  const cap = (m) => snap({ day_rules: { ...snap().day_rules, workload_cap_min: m } });
  const lunch = [{ habit_id: H1, start: "12:50" }];
  // 210 minutes without the habit, 240 with it.
  assert.equal(checkProposal(good([]), cap(210)).ok, true);
  refused(checkProposal(good(lunch), cap(210)), /^blocks/, /cap/i);
  refused(checkProposal(good(lunch), cap(225)), /^blocks/, /cap/i);
  assert.equal(checkProposal(good(lunch), cap(240)).ok, true);
});

test("habits: absent, the list is empty", todo, async () => {
  const { checkProposal } = await proposal();
  const { habits, ...none } = good([]);
  const r = checkProposal(none, snap());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.rows.habit_blocks, []);
});
