// The morning plan's checks (src/sheet/proposal.mjs), past what the verification tests pin:
// whitespace, a lapsed proposal and input that isn't a list. Wednesday 2026-11-04 in New York
// (EST, UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProposal } from "../src/sheet/proposal.mjs";

const DAY = "2026-11-04";
const SBU = "lisul.elvitigala@stonybrook.edu";
const snap = (extra = {}) => ({
  now: "2026-11-04T11:07:00.000Z", time_zone: "America/New_York", plan_day: DAY, shutdown: "17:00",
  tasks: [{ id: "t1", title: "OS homework", est_min: 45, at_time: null, due: null, tag: null, source: null, day: DAY, list: null, at_risk: false }],
  blocks: [], busy: [], busy_as_of: null, interests: null, campus: [], proposal: null, needs_you_open: [], accounts: [SBU],
  ...extra,
});
const need = (extra = {}) => ({
  account: SBU, message_id: "19a4f2c3b5d6e7f8", link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(SBU)}#all/19a4f2c3b5d6e7f8`,
  sender: "Ana Ruiz", subject: "Demo moved", why: "Reply by Thursday.", kind: "reply", ...extra,
});

test("checkProposal: runs of spaces collapse and the ends are trimmed in the rows", () => {
  const r = checkProposal({ day: DAY, blocks: [], needs_you: [need({ subject: "  Demo   moved  " })], picks: [], note: " Lab 4  didn't fit. " }, snap());
  assert.equal(r.ok, true);
  assert.equal(r.rows.needs[0].subject, "Demo moved");
  assert.equal(r.rows.note, "Lab 4 didn't fit.");
});

test("checkProposal: a tab is a control character, refused like a newline", () => {
  const r = checkProposal({ day: DAY, blocks: [], needs_you: [need({ why: "Reply\tnow." })], picks: [], note: null }, snap());
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^needs_you\[0\]\.why: /);
});

test("checkProposal: a lapsed proposal can't be replaced", () => {
  const r = checkProposal({ day: DAY, blocks: [], needs_you: [], picks: [], note: null }, snap({ proposal: { status: "lapsed", created_at: "2026-11-04T10:30:00Z" } }));
  assert.deepEqual(r.errors, ["day: the proposal for 2026-11-04 is already lapsed"]);
});

test("checkProposal: missing lists count as empty; lists that aren't lists are refused", () => {
  assert.equal(checkProposal({ day: DAY }, snap()).ok, true);
  const r = checkProposal({ day: DAY, blocks: "09:00 OS homework", needs_you: {}, picks: 3 }, snap());
  assert.deepEqual(r.errors, ["blocks: must be a list", "needs_you: must be a list", "picks: must be a list"]);
});

test("checkProposal: a block over an approved block names it, both ends in the morning", () => {
  const r = checkProposal({ day: DAY, blocks: [{ task_id: "t1", start: "10:30", minutes: 45 }] },
    snap({ blocks: [{ task_id: "t1", starts_at: "2026-11-04T15:00:00Z", ends_at: "2026-11-04T16:00:00Z", proposed: false }] }));
  assert.deepEqual(r.errors, ["blocks[0]: overlaps an approved block 10:00–11:00 am"]);
});
