// Verification tests for v5 V1, revisions and locked blocks: checkProposal's plan window, locked
// blocks, turned-down tasks and `replaces` (src/sheet/proposal.mjs), and the revision buttons and
// stale-revision taps (src/sheet/nudges.mjs). Written before the code from docs/sheet-v5.md
// "Contracts" and spec 47. Every test starts as `todo`; the implementer removes `todo` and must
// not change an expectation. Expected values are written out by hand. Modules are imported inside
// each test, so this file loads before the code exists.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5), so 10:15 am is 15:15 UTC.
//
// The v5 snapshot below is the one test/v5-day.verify.test.mjs uses too. Its valid proposal obeys
// every v5 rule (window, locked blocks, travel gap, break rule, workload cap, paced minutes), so
// each ticket's tests hold once all of them are built.
//
// Readings chosen where the contract leaves room (closest to its words):
// - Tests match an error's field name and a key word, not its wording.
// - The order of a tap's changes isn't part of the contract; there is only one here.
import { test } from "node:test";
import assert from "node:assert/strict";

const proposal = () => import("../src/sheet/proposal.mjs");
const nudges = () => import("../src/sheet/nudges.mjs");
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

// =============================================================================================
// checkProposal, v5
// =============================================================================================

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

test("checkProposal v5: a valid replan gives apply_proposal's named arguments", async () => {
  const { checkProposal } = await proposal();
  assert.deepEqual(checkProposal(good(), snap()), {
    ok: true,
    errors: [],
    rows: {
      d: DAY,
      replaces: 1,
      blocks: [
        { task_id: T1, starts_at: "2026-11-04T15:15:00.000Z", ends_at: "2026-11-04T16:00:00.000Z" },
        { task_id: T3, starts_at: "2026-11-04T18:00:00.000Z", ends_at: "2026-11-04T18:30:00.000Z" },
        { task_id: T4, starts_at: "2026-11-04T20:30:00.000Z", ends_at: "2026-11-04T21:15:00.000Z" },
      ],
      habit_blocks: [],
      needs: [],
      picks: [],
      note: "Lab 4 (1 h) didn't fit before shutdown.",
      couldnt_fit: [T5],
      suggested: [],
      run_trigger: "replan",
      reasons: ["busy_overlap"],
    },
    dropped: [],
    // Every to-do gets a time (docs/sheet-v5.md): the tasks moved to the next day, none here.
    next_day: [],
  });
});

test("checkProposal v5: a snapshot without version 5 is checked and shaped as in v4", async () => {
  const { checkProposal } = await proposal();
  const { version, ...v4 } = snap();
  const r = checkProposal(good(), v4);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.rows).sort(), ["blocks", "d", "needs", "note", "picks"]);
  assert.equal("dropped" in r, false);
});

// --- The plan window -------------------------------------------------------------------------

test("window: a block starting before the window's start is refused, naming it", async () => {
  const { checkProposal } = await proposal();
  // 10:00 am is after 07:00 (v4's rule) but before 10:15, the replan's window.
  refused(checkProposal(good({ blocks: withBlock(0, { start: "10:00" }) }), snap()), /blocks\[0\]/, /10:15/);
});

test("window: a block may start exactly at the window's start", async () => {
  const { checkProposal } = await proposal();
  assert.equal(checkProposal(good(), snap()).ok, true); // OS homework at 10:15
});

test("window: a block ending after the window's end is refused", async () => {
  const { checkProposal } = await proposal();
  // Shutdown moved to 4:00 pm: HW3 at 3:30-4:15 pm runs past it.
  const early = snap({ shutdown: "16:00", window: { from: "10:15", to: "16:00" } });
  refused(checkProposal(good(), early), /blocks\[2\]/, /16:00/);
});

test("window: a morning plan made at 6:07 am may use the whole day from 07:00", async () => {
  const { checkProposal } = await proposal();
  const morning = snap({
    now: "2026-11-04T11:07:00.000Z",
    window: { from: "07:00", to: "17:00" },
    run: { trigger: "morning", reasons: [], changes: {} },
    blocks: [snap().blocks[1]],
    proposal: null,
  });
  const r = checkProposal(good({ replaces: null, blocks: withBlock(0, { start: "07:00" }) }), morning);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.blocks[0], { task_id: T1, starts_at: "2026-11-04T12:00:00.000Z", ends_at: "2026-11-04T12:45:00.000Z" });
  assert.equal(r.rows.run_trigger, "morning");
  assert.deepEqual(r.rows.reasons, []);
});

// --- Locked blocks ---------------------------------------------------------------------------

test("locked: a block over an approved block is refused, naming the block and the approved block", async () => {
  const { checkProposal } = await proposal();
  // OS homework at 11:45 am-12:30 pm, over Gym's approved 11:30 am-12:30 pm.
  refused(checkProposal(good({ blocks: withBlock(0, { start: "11:45" }) }), snap()), /blocks\[0\]/, /approved block/, /11:30 am/);
});

test("locked: a block over the pending revision's own proposed blocks is allowed, since it replaces them", async () => {
  const { checkProposal } = await proposal();
  // HW3 at 3:30-4:15 pm sits exactly on revision 1's proposed OS homework block.
  const r = checkProposal(good(), snap());
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.blocks[2], { task_id: T4, starts_at: "2026-11-04T20:30:00.000Z", ends_at: "2026-11-04T21:15:00.000Z" });
});

// --- Turned down -----------------------------------------------------------------------------

test("turned down: a block for a task turned down today is refused", async () => {
  const { checkProposal } = await proposal();
  const blocks = [...good().blocks, { task_id: T6, start: "16:15", minutes: 45 }];
  refused(checkProposal(good({ blocks }), snap()), /blocks\[3\]/, /turned down/);
});

test("turned down: the check holds even if the task is still in the task list", async () => {
  const { checkProposal } = await proposal();
  const s = snap({ tasks: [...snap().tasks, task(T6, "Laundry", 45, 45)] });
  const blocks = [...good().blocks, { task_id: T6, start: "16:15", minutes: 45 }];
  refused(checkProposal(good({ blocks }), s), /blocks\[3\]/, /turned down/);
});

// --- Revisions -------------------------------------------------------------------------------

test("replaces: it must name the newest revision", async () => {
  const { checkProposal } = await proposal();
  refused(checkProposal(good({ replaces: 2 }), snap()), /replaces/);
  refused(checkProposal(good({ replaces: 0 }), snap()), /replaces/);
  refused(checkProposal(good({ replaces: null }), snap()), /replaces/);
  const { replaces, ...missing } = good();
  refused(checkProposal(missing, snap()), /replaces/);
});

test("replaces: with no revision yet it is null, and rows say so", async () => {
  const { checkProposal } = await proposal();
  const first = snap({ proposal: null, blocks: snap().blocks.slice(0, 2) });
  const r = checkProposal(good({ replaces: null }), first);
  assert.equal(r.ok, true);
  assert.equal(r.rows.replaces, null);
});

test("replaces: a replan after the newest revision was approved is accepted", async () => {
  const { checkProposal } = await proposal();
  // Revision 2 was approved; its blocks are the approved ones.
  const approved = snap({ proposal: { rev: 2, status: "approved", created_at: "2026-11-04T13:30:00Z", run_trigger: "replan" }, blocks: snap().blocks.slice(0, 2) });
  const r = checkProposal(good({ replaces: 2 }), approved);
  assert.equal(r.ok, true);
  assert.equal(r.rows.replaces, 2);
});

test("replaces: a day whose newest revision was skipped or has lapsed is refused", async () => {
  const { checkProposal } = await proposal();
  const skipped = snap({ proposal: { rev: 1, status: "skipped", created_at: "2026-11-04T11:09:00Z", run_trigger: "morning" } });
  refused(checkProposal(good(), skipped), /day/, /skipped/);
  const lapsed = snap({ proposal: { rev: 1, status: "lapsed", created_at: "2026-11-04T11:09:00Z", run_trigger: "morning" } });
  refused(checkProposal(good(), lapsed), /day/, /lapsed/);
});

// =============================================================================================
// Telegram: revision buttons and stale taps
// =============================================================================================

const day = DAY;
const B = (n) => `0b0b0b0b-0000-4000-8000-00000000000${n}`;
const settings = { time_zone: TZ, telegram_chat_id: 42, nudges_on: true, morning_on: true };
const ttask = (id, title, extra = {}) => ({ id, title, day, done: false, due: null, public: true, ...extra });
const block = (id, task_id, starts_at, ends_at, extra = {}) => ({ id, task_id, starts_at, ends_at, proposed: false, gcal_id: null, ...extra });
const proposed = (id, task_id, starts_at, ends_at) => block(id, task_id, starts_at, ends_at, { proposed: true });
const tasks = [ttask("t1", "OS homework", { est_min: 45 }), ttask("t2", "Gym", { est_min: 60 }), ttask("t3", "Office hours")];
// Three proposed blocks today, and one tomorrow that no tap on today's plan counts.
const planBlocks = [
  proposed(B(1), "t1", "2026-11-04T14:30:00Z", "2026-11-04T15:15:00Z"),
  proposed(B(2), "t3", "2026-11-04T18:00:00Z", "2026-11-04T18:30:00Z"),
  proposed(B(3), "t2", "2026-11-04T19:30:00Z", "2026-11-04T20:30:00Z"),
  proposed(B(4), "t1", "2026-11-05T14:30:00Z", "2026-11-05T15:15:00Z"),
];
const revision = (rev, extra = {}) => ({
  day, rev, status: "pending", created_at: "2026-11-04T11:09:00Z", note: null, picks: [], couldnt_fit: [], suggested: [],
  run_trigger: "morning", reasons: [], ...extra,
});
const snapshot = (extra = {}) => ({ settings, day: null, tasks, blocks: planBlocks, log: [], proposal: revision(1), needsOpen: [], campus: [], ...extra });
const openPlan = { text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" };
const briefSent = { block_id: null, kind: "brief", day, send_at: "2026-11-04T13:00:00.000Z", sent_at: "2026-11-04T13:00:01Z" };

test("brief: Approve all and Skip carry the day and the revision", async () => {
  const { whatToSend } = await nudges();
  const [brief] = whatToSend(snapshot(), new Date("2026-11-04T13:00:00Z"));
  assert.equal(brief.kind, "brief");
  assert.deepEqual(brief.buttons, [
    { text: "Approve all", callback_data: "pa:2026-11-04:1" },
    openPlan,
    { text: "Skip", callback_data: "ps:2026-11-04:1" },
  ]);
});

test("proposal message: a morning revision 2 made after the brief carries revision 2", async () => {
  const { whatToSend } = await nudges();
  const snap2 = snapshot({ proposal: revision(2, { created_at: "2026-11-04T15:42:00Z" }), log: [briefSent] });
  const out = whatToSend(snap2, new Date("2026-11-04T15:42:30Z"));
  assert.deepEqual(out.map((m) => [m.kind, m.send_at]), [["proposal", "2026-11-04T15:42:00.000Z"]]);
  assert.deepEqual(out[0].buttons, [
    { text: "Approve all", callback_data: "pa:2026-11-04:2" },
    openPlan,
    { text: "Skip", callback_data: "ps:2026-11-04:2" },
  ]);
});

const update = (data, chat = 42) => ({ callback_query: { id: "q1", data, message: { message_id: 7, chat: { id: chat } } } });

test("readTap: pa: and ps: with a revision name the action, the day and the revision", async () => {
  const { readTap } = await nudges();
  assert.deepEqual(readTap(update("pa:2026-11-04:2"), settings), { action: "pa", day, rev: 2, query_id: "q1", chat_id: 42, message_id: 7 });
  assert.deepEqual(readTap(update("ps:2026-11-04:13"), settings), { action: "ps", day, rev: 13, query_id: "q1", chat_id: 42, message_id: 7 });
  assert.deepEqual(readTap(update("pa:2026-11-04:999"), settings), { action: "pa", day, rev: 999, query_id: "q1", chat_id: 42, message_id: 7 });
});

test("readTap: a revision that isn't 1-999 without leading zeros is ignored", async () => {
  const { readTap } = await nudges();
  for (const data of ["pa:2026-11-04:0", "pa:2026-11-04:02", "pa:2026-11-04:1000", "pa:2026-11-04:x", "pa:2026-11-04:", "pa:2026-11-04:2:3", "ps:2026-11-04:-1"]) {
    assert.equal(readTap(update(data), settings), null, data);
  }
  assert.equal(readTap(update("pa:2026-11-04:2", 99), settings), null);
});

const tapAt = new Date("2026-11-04T13:05:00Z");

test("Approve all on the current revision approves it through approve_proposal", async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(handleTap({ action: "pa", day, rev: 2 }, snapshot({ proposal: revision(2) }), tapAt), {
    changes: [{ rpc: "approve_proposal", args: { d: day, rev: 2 } }],
    text: "✓ Approved 3 blocks",
  });
});

test("Skip on the current revision skips it through skip_proposal", async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(handleTap({ action: "ps", day, rev: 2 }, snapshot({ proposal: revision(2) }), tapAt), {
    changes: [{ rpc: "skip_proposal", args: { d: day, rev: 2 } }],
    text: "Skipped. Plan in /plan when you're ready.",
  });
});

test("a tap on an older revision says a newer plan is out and changes nothing", async () => {
  const { handleTap } = await nudges();
  const newer = { changes: [], text: "A newer plan is out" };
  assert.deepEqual(handleTap({ action: "pa", day, rev: 1 }, snapshot({ proposal: revision(2) }), tapAt), newer);
  assert.deepEqual(handleTap({ action: "ps", day, rev: 1 }, snapshot({ proposal: revision(3) }), tapAt), newer);
  // Even when the newer one was already approved.
  assert.deepEqual(handleTap({ action: "pa", day, rev: 1 }, snapshot({ proposal: revision(2, { status: "approved" }) }), tapAt), newer);
});

test("a v4 button with no revision acts as revision 1", async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(handleTap({ action: "pa", day }, snapshot({ proposal: revision(2) }), tapAt), { changes: [], text: "A newer plan is out" });
  assert.deepEqual(handleTap({ action: "pa", day }, snapshot(), tapAt), { changes: [{ rpc: "approve_proposal", args: { d: day, rev: 1 } }], text: "✓ Approved 3 blocks" });
});

test("a tap on the current revision once decided says so; a lapsed or missing plan says it lapsed", async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(handleTap({ action: "pa", day, rev: 2 }, snapshot({ proposal: revision(2, { status: "approved" }) }), tapAt), { changes: [], text: "Already approved" });
  assert.deepEqual(handleTap({ action: "pa", day, rev: 2 }, snapshot({ proposal: revision(2, { status: "skipped" }) }), tapAt), { changes: [], text: "Already skipped" });
  assert.deepEqual(handleTap({ action: "ps", day, rev: 2 }, snapshot({ proposal: revision(2, { status: "lapsed" }) }), tapAt), { changes: [], text: "That plan has lapsed" });
  // Lapsed comes first, even for an old revision.
  assert.deepEqual(handleTap({ action: "pa", day, rev: 1 }, snapshot({ proposal: revision(2, { status: "lapsed" }) }), tapAt), { changes: [], text: "That plan has lapsed" });
  assert.deepEqual(handleTap({ action: "pa", day, rev: 1 }, snapshot({ proposal: null }), tapAt), { changes: [], text: "That plan has lapsed" });
});
