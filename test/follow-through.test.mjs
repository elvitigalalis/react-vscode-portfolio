// Follow-through (docs/sheet-v5.md, "Day rules and first steps"): a block's first step, from
// submit_proposal to its start nudge; the next free slot a Didn't start answer offers; and the
// minutes a late Finished? tap records. Wednesday 2026-11-04 in New York, EST (UTC-5). Expected
// values are written out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProposal } from "../src/sheet/proposal.mjs";
import { handleTap, readTap, whatToSend } from "../src/sheet/nudges.mjs";

const TZ = "America/New_York";
const day = "2026-11-04";
const B = (n) => `0b0b0b0b-0000-4000-8000-00000000000${n}`;
const at = (iso) => new Date(iso);

// --- first_step: submit_proposal ---------------------------------------------------------------

const planSnap = {
  version: 5, now: "2026-11-04T13:00:00.000Z", time_zone: TZ, plan_day: day, shutdown: "17:00", window: { from: "08:00", to: "17:00" },
  run: { trigger: "morning", reasons: [], changes: {} }, turned_down: [], proposal: null, blocks: [], busy: [], campus: [], accounts: [], habits: [],
  tasks: [{ id: "t1", title: "OS homework", est_min: 60, paced_min: 60, day }],
  day_rules: { workload_cap_min: 360, travel_min: 10, break_after_min: 90, break_min: 10 },
};
const submit = (first_step) => checkProposal({ day, replaces: null, blocks: [{ task_id: "t1", start: "09:00", minutes: 60, first_step }] }, planSnap);

test("first_step: kept on its block, collapsed to one line; optional", () => {
  assert.deepEqual(submit("Open  HW4, do Q1").rows.blocks, [{ task_id: "t1", starts_at: "2026-11-04T14:00:00.000Z", ends_at: "2026-11-04T15:00:00.000Z", first_step: "Open HW4, do Q1" }]);
  assert.deepEqual(submit(undefined).rows.blocks, [{ task_id: "t1", starts_at: "2026-11-04T14:00:00.000Z", ends_at: "2026-11-04T15:00:00.000Z" }]);
  assert.equal(submit(null).ok, true);
});

test("first_step: at most 80 characters, one line, no link, not blank", () => {
  assert.match(submit("x".repeat(81)).errors.join("\n"), /^blocks\[0\]\.first_step: at most 80 characters, got 81$/m);
  assert.match(submit("open\nHW4").errors.join("\n"), /^blocks\[0\]\.first_step: must be one line/m);
  assert.match(submit("open hw4.example.com").errors.join("\n"), /^blocks\[0\]\.first_step: must not hold a link/m);
  assert.match(submit("  ").errors.join("\n"), /^blocks\[0\]\.first_step: an action to start with, such as "open HW4, do Q1"; leave it out when there is none$/m);
});

// --- first_step: the start nudge --------------------------------------------------------------

const settings = { time_zone: TZ, telegram_chat_id: 42, nudges_on: true, morning_on: false };
const task = (id, title, extra = {}) => ({ id, title, day, done: false, due: null, public: true, est_min: 45, at_time: null, rolls: 0, ...extra });
const block = (id, task_id, starts_at, ends_at, extra = {}) => ({ id, task_id, starts_at, ends_at, proposed: false, gcal_id: null, ...extra });
const sent = (block_id, kind, send_at) => ({ block_id, kind, day, send_at, sent_at: send_at });
const briefSent = sent(null, "brief", "2026-11-04T13:00:00.000Z");
const os = task("t1", "OS homework");
const b1 = block(B(1), "t1", "2026-11-04T19:00:00Z", "2026-11-04T19:45:00Z", { gcal_id: "ev1" }); // 2:00-2:45 pm
const snapshot = (extra = {}) => ({ settings, day: null, tasks: [os], blocks: [b1], log: [briefSent], busy: [], proposal: null, needsOpen: [], campus: [], ...extra });

test("start nudge: a block with a first step leads with it", () => {
  const blocks = [{ ...b1, first_step: "open HW4, do Q1" }];
  const [nudge] = whatToSend(snapshot({ blocks }), at("2026-11-04T19:00:00Z"));
  assert.equal(nudge.text, "Now: OS homework — first: open HW4, do Q1 (2:00 pm, 45 min)");
  // Without one, as before.
  assert.equal(whatToSend(snapshot(), at("2026-11-04T19:00:00Z"))[0].text, "▶ 2:00 pm · OS homework (45 min)");
});

// --- Didn't start: the next free slot ----------------------------------------------------------

const tapAt = at("2026-11-04T19:47:00Z"); // 2:47 pm, just after the block

test("Didn't start: offers the next free quarter hour today that fits the block, and Tomorrow", () => {
  // 3:00-3:30 pm is busy (travel to 3:40), and an approved block runs 3:45-4:15 pm.
  const busy = [{ starts_at: "2026-11-04T20:00:00Z", ends_at: "2026-11-04T20:30:00Z" }];
  const gym = block(B(2), "t2", "2026-11-04T20:45:00Z", "2026-11-04T21:15:00Z");
  const r = handleTap({ action: "nostart", block_id: B(1) }, snapshot({ busy, blocks: [b1, gym], tasks: [os, task("t2", "Gym")] }), tapAt);
  // 4:15 is the first quarter hour from which 45 free minutes run.
  assert.deepEqual(r, {
    changes: [],
    text: "Next free slot: 4:15 pm (45 min) · OS homework",
    buttons: [
      { text: "Move to 4:15 pm", callback_data: `move:${B(1)}:${Date.parse("2026-11-04T21:15:00Z") / 60_000}` },
      { text: "Tomorrow", callback_data: `tomorrow:${B(1)}` },
    ],
  });
});

test("Didn't start: with no free slot left before shutdown, it offers Tomorrow", () => {
  const busy = [{ starts_at: "2026-11-04T20:00:00Z", ends_at: "2026-11-04T22:00:00Z" }]; // 3:00-5:00 pm, shutdown at 5
  const r = handleTap({ action: "nostart", block_id: B(1) }, snapshot({ busy }), tapAt);
  assert.deepEqual(r, { changes: [], text: "No free slot left today · OS homework", buttons: [{ text: "Tomorrow", callback_data: `tomorrow:${B(1)}` }] });
});

test("move: readTap reads the slot; the tap moves the block, locks it and redoes its event", () => {
  const minute = Date.parse("2026-11-04T21:15:00Z") / 60_000;
  const update = { callback_query: { id: "q", data: `move:${B(1)}:${minute}`, message: { chat: { id: 42 }, message_id: 7 } } };
  const tap = readTap(update, settings);
  assert.deepEqual(tap, { action: "move", block_id: B(1), at: minute * 60_000, query_id: "q", chat_id: 42, message_id: 7 });
  assert.deepEqual(handleTap(tap, snapshot(), tapAt), {
    changes: [
      { table: "blocks", id: B(1), update: { starts_at: "2026-11-04T21:15:00.000Z", ends_at: "2026-11-04T22:00:00.000Z", auto: false, gcal_id: null } },
      { table: "gcal_pending", insert: { gcal_id: "ev1", ends_at: null } },
    ],
    text: "Moved to 4:15 pm · OS homework",
  });
});

test("move: a slot taken since, or already past, changes nothing", () => {
  const minute = Date.parse("2026-11-04T21:15:00Z") / 60_000;
  const busy = [{ starts_at: "2026-11-04T21:30:00Z", ends_at: "2026-11-04T22:00:00Z" }];
  assert.deepEqual(handleTap({ action: "move", block_id: B(1), at: minute * 60_000 }, snapshot({ busy }), tapAt), { changes: [], text: "That slot isn't free any more · OS homework" });
  assert.deepEqual(handleTap({ action: "move", block_id: B(1), at: minute * 60_000 }, snapshot(), at("2026-11-04T21:20:00Z")), { changes: [], text: "That slot isn't free any more · OS homework" });
});

// --- A late Finished? tap ---------------------------------------------------------------------

test("Finished: a tap long after the block records the block's minutes, on the block's day", () => {
  const late = block(B(3), "t1", "2026-11-05T03:00:00Z", "2026-11-05T03:45:00Z"); // 10:00-10:45 pm
  const r = handleTap({ action: "finished", block_id: B(3) }, snapshot({ blocks: [late] }), at("2026-11-05T06:30:00Z")); // 1:30 am
  assert.deepEqual(r.changes.find((c) => c.table === "actuals").insert, { day, task_id: "t1", block_id: B(3), kind: "other", est_min: 45, minutes: 45 });
  assert.equal(r.text, "✓ Done in 45 min · OS homework");
});
