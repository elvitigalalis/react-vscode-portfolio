// v5 L1, beyond the verification tests: the feedback row a Telegram tap logs (tapFeedback, in
// src/sheet/triage.mjs), and the rows Needs you taps in /plan log (needsFeedback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tapFeedback, needsFeedback } from "../src/sheet/triage.mjs";

const DAY = "2026-11-04";
const T1 = "6f1c2a3b-0000-4000-8000-000000000001";
const B1 = "7a1c2a3b-0000-4000-8000-000000000001";
const snap = (extra = {}) => ({
  proposal: { day: DAY, rev: 2, status: "pending" },
  blocks: [{ id: B1, task_id: T1 }],
  tasks: [{ id: T1, title: "OS homework", done: false }],
  ...extra,
});

test("tapFeedback: Approve all and Skip on the pending revision log it by day and rev", () => {
  assert.deepEqual(tapFeedback({ action: "pa", day: DAY, rev: 2 }, snap()), { item: "proposal", action: "approve", ref: { day: DAY, rev: 2 } });
  assert.deepEqual(tapFeedback({ action: "ps", day: DAY, rev: 2 }, snap()), { item: "proposal", action: "skip", ref: { day: DAY, rev: 2 } });
  // A v4 proposal, with no rev, is revision 1.
  assert.deepEqual(tapFeedback({ action: "pa", day: DAY }, snap({ proposal: { day: DAY, status: "pending" } })), { item: "proposal", action: "approve", ref: { day: DAY, rev: 1 } });
});

test("tapFeedback: a plan tap that decides nothing logs nothing", () => {
  assert.equal(tapFeedback({ action: "pa", day: DAY, rev: 1 }, snap()), null); // a newer plan is out
  assert.equal(tapFeedback({ action: "pa", day: DAY, rev: 2 }, snap({ proposal: { day: DAY, rev: 2, status: "approved" } })), null);
  assert.equal(tapFeedback({ action: "ps", day: "2026-11-03", rev: 2 }, snap()), null);
  assert.equal(tapFeedback({ action: "pa", day: DAY, rev: 2 }, snap({ proposal: null })), null);
});

test("tapFeedback: each Finished? answer logs its block and task", () => {
  for (const action of ["finished", "more", "nostart", "tomorrow"]) {
    assert.deepEqual(tapFeedback({ action, block_id: B1 }, snap()), { item: "finished", action, ref: { block_id: B1, task_id: T1 } });
  }
});

test("tapFeedback: no row for a nudge's Done or Snooze, a gone block or a task already done", () => {
  assert.equal(tapFeedback({ action: "done", block_id: B1 }, snap()), null);
  assert.equal(tapFeedback({ action: "snooze", block_id: B1 }, snap()), null);
  assert.equal(tapFeedback({ action: "finished", block_id: "gone" }, snap()), null);
  assert.equal(tapFeedback({ action: "finished", block_id: B1 }, snap({ tasks: [{ id: T1, done: true }] })), null);
});

test("needsFeedback: a needs_you row's ids, with its From address", () => {
  const row = { id: "x", account: "a@b.com", message_id: "18f2a3b4c5d6e7f1", from_address: "jobs@acme.com", subject: "Hi" };
  assert.deepEqual(needsFeedback(row, "not_needed"), { item: "needs_you", action: "not_needed", ref: { account: "a@b.com", message_id: "18f2a3b4c5d6e7f1", from_address: "jobs@acme.com" } });
  assert.deepEqual(needsFeedback({ ...row, from_address: undefined }, "done").ref.from_address, null);
});

// --- tools/triage-score.mjs ---------------------------------------------------------------------

test("triage-score: a run file is a list of items or a submit_proposal input", async () => {
  const { runItems } = await import("../tools/triage-score.mjs");
  const item = { account: "a@b.com", message_id: "18f2a3b4c5d6e7f1", subject: "dropped" };
  assert.deepEqual(runItems([item]), [{ account: "a@b.com", message_id: "18f2a3b4c5d6e7f1" }]);
  assert.deepEqual(runItems({ needs_you: [item, { account: "a@b.com", message_id: "not hex" }] }), [{ account: "a@b.com", message_id: "18f2a3b4c5d6e7f1" }]);
  assert.throws(() => runItems({}), /expected a list/);
});

test("triage-score: counts, then keys, and the feedback query reads ids only", async () => {
  const { scoreLines, feedbackSql } = await import("../tools/triage-score.mjs");
  assert.deepEqual(scoreLines({ caught: ["a 1"], missed: [], wrongly_shown: ["a 2", "a 3"] }),
    ["caught: 1", "  a 1", "missed: 0", "wrongly shown: 2", "  a 2", "  a 3"]);
  assert.equal(feedbackSql(14), "select at, item, action, ref from feedback where item = 'needs_you' and at > now() - interval '14 days' order by at");
});
