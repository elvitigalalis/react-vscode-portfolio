// Verification tests for v5 D2, a realistic day: checkProposal's workload cap, 90-minute break
// rule, travel gap and couldn't-fit ids (src/sheet/proposal.mjs), and the "Couldn't fit" line
// proposalLines adds to the brief and the plan message. Written before the code from
// docs/sheet-v5.md "Contracts" and spec 47. Every test starts as `todo`; the implementer removes
// `todo` and must not change an expectation. Expected values are written out by hand. The module
// is imported inside each test, so this file loads before the code exists.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5). The snapshot and the valid proposal are the
// same as in test/v5-revisions.verify.test.mjs: a replan at 10:02 am, busy 2:00-3:20 pm, approved
// Reading 8:30-9:30 am and Gym 11:30 am-12:30 pm, and OS homework 10:15, Office hours 1:00 pm and
// HW3 3:30 pm proposed. Planned work: 60 + 60 approved, 45 + 30 + 45 proposed = 240 minutes.
//
// Readings chosen where the contract leaves room (closest to its words):
// - Tests match an error's field name and a key word ("cap", "90", "travel"), not its wording.
// - The pending revision's own proposed blocks (OS homework 3:30-4:15 pm) count toward neither the
//   cap nor a run of blocks: the new revision replaces them.
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

// A replan at 10:02 am. Busy 2:00-3:20 pm. Approved: Reading 8:30-9:30 am (done) and Gym
// 11:30 am-12:30 pm. Revision 1, the morning plan, is pending, with OS homework proposed at
// 3:30-4:15 pm.
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
  habits: [],
  triage_rules: [],
  reply_state: { owed: [], awaiting: [] },
  weather: [],
  academic: [],
  ...extra,
});

// 10:15 am OS homework, 1:00 pm Office hours, 3:30 pm HW3 (over revision 1's proposed block,
// which this replaces). Lab 4 can't fit in the 45 minutes left before shutdown.
const good = (extra = {}) => ({
  day: DAY,
  replaces: 1,
  blocks: [
    { task_id: T1, start: "10:15", minutes: 45 },
    { task_id: T3, start: "13:00", minutes: 30 },
    { task_id: T4, start: "15:30", minutes: 45 },
  ],
  needs_you: [],
  picks: [],
  note: "Lab 4 (1 h) didn't fit before shutdown.",
  couldnt_fit: [T5],
  ...extra,
});
const withBlock = (i, fields) => good().blocks.map((b, j) => (j === i ? { ...b, ...fields } : b));

function refused(result, ...patterns) {
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "expected errors");
  assert.ok(result.errors.some((e) => patterns.every((p) => p.test(e))), `no error matching ${patterns.join(" and ")}: ${JSON.stringify(result.errors)}`);
}

// =============================================================================================
// The workload cap
// =============================================================================================

test("cap: planned minutes exactly at the cap are allowed, and the pending revision's blocks don't count", async () => {
  const { checkProposal } = await proposal();
  // 240 planned; with revision 1's 45-minute proposed block it would be 285.
  const tight = snap({ day_rules: { ...snap().day_rules, workload_cap_min: 240 } });
  assert.equal(checkProposal(good(), tight).ok, true);
});

test("cap: planned minutes over the cap are refused, naming blocks and the cap", async () => {
  const { checkProposal } = await proposal();
  const tight = snap({ day_rules: { ...snap().day_rules, workload_cap_min: 225 } });
  refused(checkProposal(good(), tight), /^blocks/, /cap/i);
});

test("cap: approved blocks earlier in the day count toward it", async () => {
  const { checkProposal } = await proposal();
  // Without the 8:30 am Reading block the day holds 180 minutes, under a 200-minute cap; with it, 240.
  const cap = { ...snap().day_rules, workload_cap_min: 200 };
  assert.equal(checkProposal(good(), snap({ day_rules: cap, blocks: snap().blocks.slice(1) })).ok, true);
  refused(checkProposal(good(), snap({ day_rules: cap })), /^blocks/, /cap/i);
});

// =============================================================================================
// The break rule: 10 minutes after every 90 minutes of blocks in a row
// =============================================================================================

test("breaks: a block that runs into an approved block, making 105 minutes in a row, is refused", async () => {
  const { checkProposal } = await proposal();
  // OS homework 10:45-11:30 am, then Gym 11:30 am-12:30 pm: 10:45 to 12:30 with no gap.
  refused(checkProposal(good({ blocks: withBlock(0, { start: "10:45" }) }), snap()), /blocks\[0\]/, /90/);
});

test("breaks: a gap under 10 minutes still joins the run", async () => {
  const { checkProposal } = await proposal();
  // OS homework 10:40-11:25 am: a 5-minute gap before Gym, so 10:40 to 12:30 is one 110-minute run.
  refused(checkProposal(good({ blocks: withBlock(0, { start: "10:40" }) }), snap()), /blocks\[0\]/, /90/);
});

test("breaks: a 10-minute gap is a break", async () => {
  const { checkProposal } = await proposal();
  // OS homework 10:35-11:20 am, then 10 minutes before Gym at 11:30.
  assert.equal(checkProposal(good({ blocks: withBlock(0, { start: "10:35" }) }), snap()).ok, true);
});

test("breaks: exactly 90 minutes in a row is allowed", async () => {
  const { checkProposal } = await proposal();
  // HW3 3:30-4:15 pm, then OS homework 4:15-5:00 pm.
  const blocks = [
    { task_id: T3, start: "13:00", minutes: 30 },
    { task_id: T4, start: "15:30", minutes: 45 },
    { task_id: T1, start: "16:15", minutes: 45 },
  ];
  assert.equal(checkProposal(good({ blocks }), snap()).ok, true);
});

test("breaks: the error names the proposed block that carries the run past 90 minutes", async () => {
  const { checkProposal } = await proposal();
  // With shutdown at 6:00 pm: HW3 3:30-4:15, OS homework 4:15-5:00 (90 so far), Lab 4 5:00-6:00 pm (150).
  const late = snap({ shutdown: "18:00", window: { from: "10:15", to: "18:00" } });
  const blocks = [
    { task_id: T3, start: "13:00", minutes: 30 },
    { task_id: T4, start: "15:30", minutes: 45 },
    { task_id: T1, start: "16:15", minutes: 45 },
    { task_id: T5, start: "17:00", minutes: 60 },
  ];
  const r = checkProposal(good({ blocks, couldnt_fit: [] }), late);
  refused(r, /blocks\[3\]/, /90/);
  assert.equal(r.errors.some((e) => /blocks\[[012]\]/.test(e) && /90/.test(e)), false, JSON.stringify(r.errors));
});

// =============================================================================================
// The travel gap: 10 minutes before and after each busy time
// =============================================================================================

test("travel: a block starting 5 minutes after a busy time ends is refused, naming the travel gap", todo, async () => {
  const { checkProposal } = await proposal();
  // HW3 at 3:25 pm; the 2:00-3:20 pm busy time needs 10 minutes after it.
  const r = checkProposal(good({ blocks: withBlock(2, { start: "15:25" }) }), snap());
  refused(r, /blocks\[2\]/, /travel/);
  // It doesn't overlap the busy time itself, so v4's overlap error isn't given.
  assert.equal(r.errors.includes("blocks[2]: overlaps a busy time 2:00–3:20 pm"), false);
});

test("travel: a block ending 5 minutes before a busy time starts is refused; 10 minutes before is allowed", todo, async () => {
  const { checkProposal } = await proposal();
  // Office hours left out. OS homework 1:10-1:55 pm runs into the gap before 2:00; 1:05-1:50 pm doesn't.
  const blocks = (start) => [{ task_id: T1, start, minutes: 45 }, { task_id: T4, start: "15:30", minutes: 45 }];
  refused(checkProposal(good({ blocks: blocks("13:10") }), snap()), /blocks\[0\]/, /travel/);
  assert.equal(checkProposal(good({ blocks: blocks("13:05") }), snap()).ok, true);
});

test("travel: a block over the busy time itself keeps v4's error", todo, async () => {
  const { checkProposal } = await proposal();
  const r = checkProposal(good({ blocks: [{ task_id: T1, start: "14:30", minutes: 45 }] }), snap());
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("blocks[0]: overlaps a busy time 2:00–3:20 pm"), JSON.stringify(r.errors));
});

test("travel: no gap is needed next to an approved block", todo, async () => {
  const { checkProposal } = await proposal();
  // Office hours fixed at 12:30 pm instead, right as Gym's approved block ends: 90 minutes in a row.
  const s = snap({ tasks: snap().tasks.map((t) => (t.id === T3 ? { ...t, at_time: "12:30:00" } : t)) });
  assert.equal(checkProposal(good({ blocks: withBlock(1, { start: "12:30" }) }), s).ok, true);
});

// =============================================================================================
// Couldn't fit
// =============================================================================================

test("couldnt_fit: ids from the task list pass through to rows", todo, async () => {
  const { checkProposal } = await proposal();
  assert.deepEqual(checkProposal(good(), snap()).rows.couldnt_fit, [T5]);
  const { couldnt_fit, ...none } = good();
  assert.deepEqual(checkProposal(none, snap()).rows.couldnt_fit, []);
});

test("couldnt_fit: an id that isn't one of the tasks is refused, naming it", todo, async () => {
  const { checkProposal } = await proposal();
  refused(checkProposal(good({ couldnt_fit: ["6f1c2a3b-0000-4000-8000-0000000000ff"] }), snap()), /couldnt_fit\[0\]/);
  // A turned-down task isn't in the task list either.
  refused(checkProposal(good({ couldnt_fit: [T5, T6] }), snap()), /couldnt_fit\[1\]/);
});

test("couldnt_fit: an id given twice, or also placed in blocks, is refused", todo, async () => {
  const { checkProposal } = await proposal();
  refused(checkProposal(good({ couldnt_fit: [T5, T5] }), snap()), /couldnt_fit\[1\]/);
  refused(checkProposal(good({ couldnt_fit: [T1] }), snap()), /couldnt_fit\[0\]/);
});

test("couldnt_fit: more than 12 ids are refused", todo, async () => {
  const { checkProposal } = await proposal();
  const many = Array.from({ length: 13 }, () => T5);
  refused(checkProposal(good({ couldnt_fit: many }), snap()), /couldnt_fit/);
});

// =============================================================================================
// The "Couldn't fit" line
// =============================================================================================

const T8 = "6f1c2a3b-0000-4000-8000-000000000008";
const lineTasks = [
  { id: T1, title: "OS homework" }, { id: T4, title: "HW3" }, { id: T5, title: "Lab 4" },
  { id: T8, title: "Read chapter 4 of Operating Systems: Three Easy Pieces" },
];
const pendingRow = (extra = {}) => ({ day: DAY, rev: 1, status: "pending", created_at: "2026-11-04T11:09:00Z", note: null, picks: [], couldnt_fit: [], suggested: [], ...extra });
const oneBlock = [{ id: "p1", task_id: T1, starts_at: "2026-11-04T14:30:00Z", ends_at: "2026-11-04T15:15:00Z", proposed: true }];

test("proposalLines: \"Couldn't fit\" follows \"Didn't fit\", naming the tasks", todo, async () => {
  const { proposalLines } = await proposal();
  const p = pendingRow({ note: "Gym got squeezed.", couldnt_fit: [T5, T4] });
  assert.deepEqual(proposalLines(p, oneBlock, lineTasks, [], [], [], TZ), [
    "Morning plan: 1 block, 9:30–10:15 am.",
    "9:30 am · OS homework (45 min)",
    "Didn't fit: Gym got squeezed.",
    "Couldn't fit: Lab 4, HW3.",
  ]);
});

test("proposalLines: titles cut to 30 characters, at most 3, then the rest counted", todo, async () => {
  const { proposalLines } = await proposal();
  const p = pendingRow({ couldnt_fit: [T8, T5, T4, T1] });
  assert.deepEqual(proposalLines(p, oneBlock, lineTasks, [], [], [], TZ), [
    "Morning plan: 1 block, 9:30–10:15 am.",
    "9:30 am · OS homework (45 min)",
    "Couldn't fit: Read chapter 4 of Operating Sy, Lab 4, HW3 +1 more.",
  ]);
});

test("proposalLines: an empty couldn't-fit list adds no line", todo, async () => {
  const { proposalLines } = await proposal();
  assert.deepEqual(proposalLines(pendingRow(), oneBlock, lineTasks, [], [], [], TZ), [
    "Morning plan: 1 block, 9:30–10:15 am.",
    "9:30 am · OS homework (45 min)",
  ]);
});
