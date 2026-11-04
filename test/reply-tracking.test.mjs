// Reply tracking beyond the verification tests (test/v5-mail.verify.test.mjs; docs/sheet-v5.md,
// M1): read_planner's `reply_state` (proposal.mjs, planSnapshot), the brief on an empty day, and
// how the mail sync reads Gmail's metadata (mail.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSnapshot } from "../src/sheet/proposal.mjs";
import { whatToSend } from "../src/sheet/nudges.mjs";

const TZ = "America/New_York";
const settings = { id: true, time_zone: TZ, interests: null, busy_as_of: null };
const rows = (extra = {}) => ({ settings, tasks: [], blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [], ...extra });
const sixOhSeven = new Date("2026-11-04T11:07:00Z");
const row = (state, who, since) => ({ account: "owner@example.com", thread_id: `t-${who}`, state, since, message_id: `m-${who}`, who, updated_at: since });

test("planSnapshot: reply_state splits the rows into owed and awaiting, oldest first, without message ids", () => {
  const replyState = [
    row("owed", "Ana Ruiz", "2026-10-30T15:00:00Z"),
    row("awaiting", "Prof. Kim", "2026-10-29T15:00:00Z"),
    row("owed", "Dana Lee", "2026-10-28T15:00:00Z"),
  ];
  assert.deepEqual(planSnapshot(rows({ replyState }), sixOhSeven).reply_state, {
    owed: [
      { account: "owner@example.com", thread_id: "t-Dana Lee", who: "Dana Lee", since: "2026-10-28T15:00:00Z" },
      { account: "owner@example.com", thread_id: "t-Ana Ruiz", who: "Ana Ruiz", since: "2026-10-30T15:00:00Z" },
    ],
    awaiting: [{ account: "owner@example.com", thread_id: "t-Prof. Kim", who: "Prof. Kim", since: "2026-10-29T15:00:00Z" }],
  });
  assert.deepEqual(planSnapshot(rows(), sixOhSeven).reply_state, { owed: [], awaiting: [] });
});

test("brief: an empty day still names who he's waiting on", () => {
  const snap = { settings: { time_zone: TZ, telegram_chat_id: 42, nudges_on: true }, day: null, tasks: [], blocks: [], log: [],
    awaiting: [row("awaiting", "Prof. Kim", "2026-10-29T15:00:00Z")] };
  const brief = whatToSend(snap, new Date("2026-11-04T13:00:00Z")).find((m) => m.kind === "brief");
  assert.equal(brief.text, "Nothing on today.\nAwaiting reply: 1 (Prof. Kim).");
});

test("brief: an address-like name is left out, the thread still counted", () => {
  const snap = { settings: { time_zone: TZ, telegram_chat_id: 42, nudges_on: true }, day: null, tasks: [], blocks: [], log: [],
    awaiting: [row("awaiting", "https://evil.example", "2026-10-29T15:00:00Z")] };
  const brief = whatToSend(snap, new Date("2026-11-04T13:00:00Z")).find((m) => m.kind === "brief");
  assert.equal(brief.text, "Nothing on today.\nAwaiting reply: 1.");
});
