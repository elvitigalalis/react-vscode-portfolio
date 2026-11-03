// Verification tests for v4, the morning plan in Telegram: the extensions to src/sheet/nudges.mjs
// (the brief with a proposal, the `proposal` message, the pa:/ps: taps, the check-in's extra
// lines) and googleStep's off-page approval rule in src/sheet/logic.mjs. Written before the code
// from docs/sheet-morning.md "Contracts". Every test starts as `todo`; the implementer removes
// `todo` and must not change an expectation. Expected values are written out by hand. Modules are
// imported inside each test, so this file loads before the code exists.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5), so the brief's 8:00 am is 13:00 UTC and the
// default 5:00 pm check-in is 22:00 UTC.
//
// The snapshot whatToSend and handleTap take: today's shape (test/nudges.test.mjs), plus new
// fields. The new ones are additive; a snapshot without them reads as none.
//   {
//     settings:  { time_zone, telegram_chat_id, nudges_on, morning_on },   // + morning_on
//     day:       today's days row, or null
//     tasks:     today's tasks, plus every undone task with a due date
//     blocks:    today's blocks (proposed ones too), plus every block of those tasks
//     log:       today's nudges rows
//     proposal:  { day, status, created_at, note, picks: [{ uid, why }] } | null   // new
//     needsOpen: needs_you rows not done                                          // new
//     campus:    the campus_events rows the picks name                            // new
//   }
// `proposal` is today's row for whatToSend. For a pa:/ps: tap it is the tapped day's row (the
// webhook loads it, as it loads a tapped block from another day).
//
// Readings chosen where the contract leaves room (closest to its words):
// - `campus` is added to the snapshot: proposalLines needs the events to write "Campus pick".
// - readTap reads "pa:<day>" and "ps:<day>" as { action: "pa" | "ps", day, query_id, chat_id,
//   message_id }, the prefix as the action, as "done:" and "snooze:" are.
// - A tap's change to the proposals row is { table: "proposals", id: <day>, update: { status } }
//   (day is its primary key). The order of changes isn't part of the contract; tests sort them.
// - Approve all's text counts the blocks it approved ("✓ Approved 2 blocks").
// - The `proposal` message is { kind: "proposal", block_id: null, day, send_at: created_at, ... }:
//   the log's unique key then gives "once per created_at". "Gone out without it" means the
//   brief's log row was sent before the proposal's created_at. It is outside the nudge budget,
//   like the brief.
// - "No morning plan came in today" is tested only where "Nothing planned yet" would show.
// - Check-in titles are cut to 30 characters with no ellipsis (as cutTitle cuts), in snapshot
//   order; the count is all of them, the list the first 3.
// - googleStep takes `now` as a second argument to tell whether a block has ended.
import { test } from "node:test";
import assert from "node:assert/strict";

const nudges = () => import("../src/sheet/nudges.mjs");
const logic = () => import("../src/sheet/logic.mjs");
const todo = { todo: true };

const day = "2026-11-04";
const settings = { time_zone: "America/New_York", telegram_chat_id: 42, nudges_on: true, morning_on: true };
const task = (id, title, extra = {}) => ({ id, title, day, done: false, due: null, public: true, ...extra });
const block = (id, task_id, starts_at, ends_at, extra = {}) => ({ id, task_id, starts_at, ends_at, proposed: false, gcal_id: null, ...extra });
const snapshot = (extra = {}) => ({ settings, day: null, tasks: [], blocks: [], log: [], proposal: null, needsOpen: [], campus: [], ...extra });
const at = (iso) => new Date(iso);
const openPlan = { text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" };
const planButtons = (d) => [{ text: "Approve all", callback_data: `pa:${d}` }, openPlan, { text: "Skip", callback_data: `ps:${d}` }];

// Today: OS homework (due Thu, so at risk), Gym, Office hours; HW3 is a course task due Monday.
const tasks = [
  task("t1", "OS homework", { due: "2026-11-05", est_min: 45 }),
  task("t2", "Gym", { est_min: 60 }),
  task("t3", "Office hours", { at_time: "13:00:00" }),
  task("t4", "HW3", { day: null, list: "Brightspace", due: "2026-11-09", public: false, source: "brightspace" }),
];
// The morning plan's blocks: 9:30 am OS homework (45), 1:00 pm Office hours (30), 2:30 pm Gym
// (60), 3:30-4:00 pm HW3 (30).
const proposed = (id, task_id, starts_at, ends_at) => block(id, task_id, starts_at, ends_at, { proposed: true });
const planBlocks = [
  proposed("p1", "t1", "2026-11-04T14:30:00Z", "2026-11-04T15:15:00Z"),
  proposed("p2", "t3", "2026-11-04T18:00:00Z", "2026-11-04T18:30:00Z"),
  proposed("p3", "t2", "2026-11-04T19:30:00Z", "2026-11-04T20:30:00Z"),
  proposed("p4", "t4", "2026-11-04T20:30:00Z", "2026-11-04T21:00:00Z"),
];
const campus = [{
  uid: "evt-1", title: "Art Club - Oil Pastels", starts_at: "2026-11-05T00:00:00Z", ends_at: "2026-11-05T02:00:00Z",
  group_name: "Art Club", tags: ["Free Food & Refreshments"], rsvp_count: 22,
}];
const SBU = "lisul.elvitigala@stonybrook.edu";
const openNeed = (id) => ({
  id, day, account: SBU, message_id: id, link: `https://mail.google.com/mail/?authuser=lisul.elvitigala%40stonybrook.edu#all/${id}`,
  sender: "Ana Ruiz", subject: "Demo moved", why: "Reply by Thursday.", kind: "reply", due: null, done: false,
});
const threeNeeds = [openNeed("19a4f2c3b5d6e701"), openNeed("19a4f2c3b5d6e702"), openNeed("19a4f2c3b5d6e703")];
const pending = (extra = {}) => ({
  day, status: "pending", created_at: "2026-11-04T11:09:00Z", note: "Lab 4 didn't fit before shutdown.",
  picks: [{ uid: "evt-1", why: "Painting, and free food." }], ...extra,
});
const withPlan = (extra = {}) => snapshot({ tasks, blocks: planBlocks, proposal: pending(), needsOpen: threeNeeds, campus, ...extra });

const PLAN_LINES = [
  "Morning plan: 4 blocks, 9:30 am–4:00 pm.",
  "9:30 am · OS homework (45 min)",
  "1:00 pm · Office hours (30 min)",
  "2:30 pm · Gym (60 min)",
  "3:30 pm · HW3 (30 min)",
  "Didn't fit: Lab 4 didn't fit before shutdown.",
  "Campus pick: Art Club - Oil Pastels (7:00 pm, 22 going)",
  "Mail: 3 need you.",
];

const briefSent = { block_id: null, kind: "brief", day, send_at: "2026-11-04T13:00:00.000Z", sent_at: "2026-11-04T13:00:01Z" };
const sent = (block_id, kind, send_at) => ({ block_id, kind, day, send_at, sent_at: send_at });

// =============================================================================================
// The brief
// =============================================================================================

test("brief: with today's proposal pending, it keeps its first and at-risk lines and adds the plan", async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(withPlan(), at("2026-11-04T13:00:00Z")), [{
    kind: "brief", block_id: null, day, send_at: "2026-11-04T13:00:00.000Z",
    text: [
      "Today: 3 tasks, 0 blocks.",
      "At risk: OS homework (due Thu).",
      ...PLAN_LINES,
    ].join("\n"),
    buttons: [
      { text: "Approve all", callback_data: "pa:2026-11-04" },
      { text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" },
      { text: "Skip", callback_data: "ps:2026-11-04" },
    ],
  }]);
});

test("brief: with a pending proposal, \"Nothing planned yet\" is dropped", async () => {
  const { whatToSend } = await nudges();
  const snap = withPlan({ proposal: pending({ note: null, picks: [] }), needsOpen: [] });
  const [brief] = whatToSend(snap, at("2026-11-04T13:00:00Z"));
  assert.equal(brief.text.includes("Nothing planned yet"), false);
  assert.equal(brief.text.includes("No morning plan came in today"), false);
  assert.deepEqual(brief.text.split("\n").slice(0, 3), ["Today: 3 tasks, 0 blocks.", "At risk: OS homework (due Thu).", "Morning plan: 4 blocks, 9:30 am–4:00 pm."]);
});

test("brief: a pending proposal made in chat shows even with morning_on false", async () => {
  const { whatToSend } = await nudges();
  const snap = withPlan({ settings: { ...settings, morning_on: false } });
  const [brief] = whatToSend(snap, at("2026-11-04T13:00:00Z"));
  assert.equal(brief.text, ["Today: 3 tasks, 0 blocks.", "At risk: OS homework (due Thu).", ...PLAN_LINES].join("\n"));
  assert.deepEqual(brief.buttons, planButtons(day));
});

test("brief: with morning_on and no proposal for today, it says no morning plan came in", async () => {
  const { whatToSend } = await nudges();
  const snap = snapshot({ tasks: [task("t2", "Gym"), task("t3", "Office hours")] });
  assert.deepEqual(whatToSend(snap, at("2026-11-04T13:00:00Z")), [{
    kind: "brief", block_id: null, day, send_at: "2026-11-04T13:00:00.000Z",
    text: 'Today: 2 tasks, 0 blocks.\nNo morning plan came in today: say "plan my day" to Claude.',
    buttons: [{ text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" }],
  }]);
});

test("brief: with morning_on false and no proposal, it is unchanged", async () => {
  const { whatToSend } = await nudges();
  const snap = snapshot({ settings: { ...settings, morning_on: false }, tasks: [task("t2", "Gym"), task("t3", "Office hours")] });
  assert.deepEqual(whatToSend(snap, at("2026-11-04T13:00:00Z")), [{
    kind: "brief", block_id: null, day, send_at: "2026-11-04T13:00:00.000Z",
    text: 'Today: 2 tasks, 0 blocks.\nNothing planned yet: say "plan my day" to Claude.',
    buttons: [{ text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" }],
  }]);
});

test("brief: a snapshot without the new fields reads as morning_on false, no proposal, no mail", async () => {
  const { whatToSend } = await nudges();
  const old = { settings: { time_zone: "America/New_York", telegram_chat_id: 42, nudges_on: true }, day: null, tasks: [task("t2", "Gym")], blocks: [], log: [] };
  const [brief] = whatToSend(old, at("2026-11-04T13:00:00Z"));
  assert.equal(brief.text, 'Today: 1 task, 0 blocks.\nNothing planned yet: say "plan my day" to Claude.');
  assert.deepEqual(brief.buttons, [openPlan]);
});

// =============================================================================================
// The `proposal` message
// =============================================================================================

// The brief went out at 8:00 without a plan; a run of "plan my day" at 10:42 am made one.
const late = (extra = {}) => withPlan({ proposal: pending({ created_at: "2026-11-04T15:42:00Z" }), log: [briefSent], ...extra });

test("proposal message: a plan landing after the brief is sent on its own, with the three buttons", async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(late(), at("2026-11-04T15:42:30Z")), [{
    kind: "proposal", block_id: null, day, send_at: "2026-11-04T15:42:00.000Z",
    text: PLAN_LINES.join("\n"),
    buttons: [
      { text: "Approve all", callback_data: "pa:2026-11-04" },
      { text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" },
      { text: "Skip", callback_data: "ps:2026-11-04" },
    ],
  }]);
});

test("proposal message: once per created_at", async () => {
  const { whatToSend } = await nudges();
  const snap = late({ log: [briefSent, sent(null, "proposal", "2026-11-04T15:42:00.000Z")] });
  assert.deepEqual(whatToSend(snap, at("2026-11-04T15:43:00Z")), []);
  assert.deepEqual(whatToSend(snap, at("2026-11-04T18:00:00Z")), []);
});

test("proposal message: a resubmitted proposal (a new created_at) is sent again", async () => {
  const { whatToSend } = await nudges();
  const snap = late({
    proposal: pending({ created_at: "2026-11-04T16:05:00Z" }),
    log: [briefSent, sent(null, "proposal", "2026-11-04T15:42:00.000Z")],
  });
  assert.deepEqual(whatToSend(snap, at("2026-11-04T16:05:20Z")).map((m) => [m.kind, m.send_at]), [["proposal", "2026-11-04T16:05:00.000Z"]]);
});

test("proposal message: none while the brief is still to go out; the brief carries the plan", async () => {
  const { whatToSend } = await nudges();
  // The 6:07 am plan, and the 8:00 run.
  assert.deepEqual(whatToSend(withPlan(), at("2026-11-04T13:00:00Z")).map((m) => m.kind), ["brief"]);
});

test("proposal message: none when the brief already went out with the plan", async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(withPlan({ log: [briefSent] }), at("2026-11-04T13:30:00Z")), []);
});

test("proposal message: only from 8 am to 11 pm", async () => {
  const { whatToSend } = await nudges();
  // Made at 10:50 pm (03:50 UTC on the 5th); the check-in went out at 5 pm.
  const snap = late({
    proposal: pending({ created_at: "2026-11-05T03:50:00Z" }),
    log: [briefSent, sent(null, "checkin", "2026-11-04T22:00:00.000Z")],
  });
  assert.deepEqual(whatToSend(snap, at("2026-11-05T03:55:00Z")).map((m) => m.kind), ["proposal"]); // 10:55 pm
  assert.deepEqual(whatToSend(snap, at("2026-11-05T04:00:00Z")), []);                               // 11:00 pm
});

test("proposal message: only while the proposal is pending", async () => {
  const { whatToSend } = await nudges();
  // Approved in /plan before the run; its blocks are no longer proposed.
  const approvedBlocks = planBlocks.map((b) => ({ ...b, proposed: false }));
  const snap = late({ proposal: pending({ created_at: "2026-11-04T15:42:00Z", status: "approved" }), blocks: approvedBlocks });
  assert.deepEqual(whatToSend(snap, at("2026-11-04T15:42:30Z")).filter((m) => m.kind === "proposal"), []);
});

test("proposal message: outside the nudge budget, it goes out once the six are spent", async () => {
  const { whatToSend } = await nudges();
  const log = [briefSent, ...["a", "b", "c", "d", "e", "f"].map((id, i) => sent(id, "start", `2026-11-04T1${3 + i}:00:00.000Z`))];
  assert.deepEqual(whatToSend(late({ log }), at("2026-11-04T15:42:30Z")).map((m) => m.kind), ["proposal"]);
});

// =============================================================================================
// The taps: pa: and ps:
// =============================================================================================

const update = (data, chat = 42) => ({ callback_query: { id: "q1", data, message: { message_id: 7, chat: { id: chat } } } });

test("reading a tap: pa: and ps: from Lisul's chat name the action and the day", async () => {
  const { readTap } = await nudges();
  assert.deepEqual(readTap(update("pa:2026-11-04"), settings), { action: "pa", day: "2026-11-04", query_id: "q1", chat_id: 42, message_id: 7 });
  assert.deepEqual(readTap(update("ps:2026-11-04"), settings), { action: "ps", day: "2026-11-04", query_id: "q1", chat_id: 42, message_id: 7 });
});

test("reading a tap: pa:/ps: from another chat, or without a plain date, is ignored", async () => {
  const { readTap } = await nudges();
  assert.equal(readTap(update("pa:2026-11-04", 99), settings), null);
  assert.equal(readTap(update("pa:"), settings), null);
  assert.equal(readTap(update("pa:tomorrow"), settings), null);
  assert.equal(readTap(update("pa:2026-11-4"), settings), null);
  assert.equal(readTap(update("ps:2026-11-04),status.eq.approved"), settings), null);
  assert.equal(readTap(update("px:2026-11-04"), settings), null);
});

// Sorted by table and id, since the contract doesn't fix their order.
const sorted = (r) => ({ ...r, changes: [...r.changes].sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`)) });
const tapAt = at("2026-11-04T13:05:00Z");
// Gym also has a real block from an earlier day's plan, which no tap touches.
const tapSnap = (extra = {}) => withPlan({ log: [briefSent], blocks: [...planBlocks, block("a1", "t2", "2026-11-03T16:00:00Z", "2026-11-03T17:00:00Z", { gcal_id: "ev0" })], ...extra });

test("Approve all: clears proposed on the day's proposed blocks and approves the proposal", async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(sorted(handleTap({ action: "pa", day }, tapSnap(), tapAt)), {
    changes: [
      { table: "blocks", id: "p1", update: { proposed: false } },
      { table: "blocks", id: "p2", update: { proposed: false } },
      { table: "blocks", id: "p3", update: { proposed: false } },
      { table: "blocks", id: "p4", update: { proposed: false } },
      { table: "proposals", id: "2026-11-04", update: { status: "approved" } },
    ],
    text: "✓ Approved 4 blocks",
  });
});

test("Approve all: approves only what's still proposed, on that day", async () => {
  const { handleTap } = await nudges();
  // In /plan since: p2 approved (it has its event), p3 turned down. Tomorrow has a proposed block too.
  const blocks = [
    planBlocks[0],
    { ...planBlocks[1], proposed: false, gcal_id: "ev2" },
    planBlocks[3],
    proposed("q1", "t4", "2026-11-05T14:30:00Z", "2026-11-05T15:00:00Z"),
  ];
  assert.deepEqual(sorted(handleTap({ action: "pa", day }, tapSnap({ blocks }), tapAt)), {
    changes: [
      { table: "blocks", id: "p1", update: { proposed: false } },
      { table: "blocks", id: "p4", update: { proposed: false } },
      { table: "proposals", id: "2026-11-04", update: { status: "approved" } },
    ],
    text: "✓ Approved 2 blocks",
  });
});

test("Skip: deletes the day's proposed blocks and skips the proposal", async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(sorted(handleTap({ action: "ps", day }, tapSnap(), tapAt)), {
    changes: [
      { table: "blocks", id: "p1", delete: true },
      { table: "blocks", id: "p2", delete: true },
      { table: "blocks", id: "p3", delete: true },
      { table: "blocks", id: "p4", delete: true },
      { table: "proposals", id: "2026-11-04", update: { status: "skipped" } },
    ],
    text: "Skipped. Plan in /plan when you're ready.",
  });
});

test("Skip: blocks approved in /plan in the meantime stay", async () => {
  const { handleTap } = await nudges();
  const blocks = [planBlocks[0], { ...planBlocks[1], proposed: false, gcal_id: "ev2" }, planBlocks[2], planBlocks[3]];
  assert.deepEqual(sorted(handleTap({ action: "ps", day }, tapSnap({ blocks }), tapAt)), {
    changes: [
      { table: "blocks", id: "p1", delete: true },
      { table: "blocks", id: "p3", delete: true },
      { table: "blocks", id: "p4", delete: true },
      { table: "proposals", id: "2026-11-04", update: { status: "skipped" } },
    ],
    text: "Skipped. Plan in /plan when you're ready.",
  });
});

test("a tap on a proposal already approved changes nothing and says so", async () => {
  const { handleTap } = await nudges();
  const snap = tapSnap({ proposal: pending({ status: "approved" }), blocks: planBlocks.map((b) => ({ ...b, proposed: false })) });
  assert.deepEqual(handleTap({ action: "pa", day }, snap, tapAt), { changes: [], text: "Already approved" });
  assert.deepEqual(handleTap({ action: "ps", day }, snap, tapAt), { changes: [], text: "Already approved" });
});

test("a tap on a proposal already skipped changes nothing and says so", async () => {
  const { handleTap } = await nudges();
  const snap = tapSnap({ proposal: pending({ status: "skipped" }), blocks: [] });
  assert.deepEqual(handleTap({ action: "pa", day }, snap, tapAt), { changes: [], text: "Already skipped" });
  assert.deepEqual(handleTap({ action: "ps", day }, snap, tapAt), { changes: [], text: "Already skipped" });
});

test("a tap on yesterday's lapsed proposal changes nothing and says so", async () => {
  const { handleTap } = await nudges();
  // Tuesday's brief, tapped on Wednesday after the nightly roll lapsed it.
  const snap = tapSnap({ proposal: { day: "2026-11-03", status: "lapsed", created_at: "2026-11-03T11:08:00Z", note: null, picks: [] } });
  assert.deepEqual(handleTap({ action: "pa", day: "2026-11-03" }, snap, tapAt), { changes: [], text: "That plan has lapsed" });
  assert.deepEqual(handleTap({ action: "ps", day: "2026-11-03" }, snap, tapAt), { changes: [], text: "That plan has lapsed" });
});

test("Done and Snooze taps still read as before", async () => {
  const { readTap } = await nudges();
  const ID = "0b6c1f9e-3d1a-4c55-9a43-2f7d8e6b1c20";
  assert.deepEqual(readTap(update(`done:${ID}`), settings), { action: "done", block_id: ID, query_id: "q1", chat_id: 42, message_id: 7 });
});

// =============================================================================================
// The check-in's extra lines
// =============================================================================================

// Six of today's tasks, four done; the check-in is at the default 5:00 pm (22:00 UTC).
const sixTasks = ["a", "b", "c", "d", "e", "f"].map((id, i) => task(id, `Task ${id}`, { done: i < 4 }));
const checkinAt = at("2026-11-04T22:00:00Z");
const checkinText = async (extra) => {
  const { whatToSend } = await nudges();
  const [m] = whatToSend(snapshot({ log: [briefSent], ...extra }), checkinAt);
  assert.equal(m.kind, "checkin");
  return m.text;
};

test("check-in: it says what's due tomorrow, undone tasks only", async () => {
  const text = await checkinText({ tasks: [...sixTasks,
    task("h", "HW3", { day: null, list: "Brightspace", due: "2026-11-05" }),
    task("l", "Lab 4", { day: "2026-11-05", due: "2026-11-05" }),
    task("q", "Quiz", { day: null, list: "Inbox", due: "2026-11-05", done: true }),
    task("x", "Essay", { day: null, list: "Inbox", due: "2026-11-06" }),
  ] });
  assert.equal(text, "Shutdown time. 4 done, 2 left.\nTomorrow: 2 due (HW3, Lab 4).");
});

test("check-in: a title is cut to 30 characters", async () => {
  const text = await checkinText({ tasks: [...sixTasks,
    task("r", "Read chapters 4 through 9 of Operating Systems", { day: null, list: "Inbox", due: "2026-11-05" }),
  ] });
  assert.equal(text, "Shutdown time. 4 done, 2 left.\nTomorrow: 1 due (Read chapters 4 through 9 of O).");
});

test("check-in: at most 3 titles, with the full count", async () => {
  const text = await checkinText({ tasks: [...sixTasks,
    task("h", "HW3", { day: null, list: "Brightspace", due: "2026-11-05" }),
    task("l", "Lab 4", { day: "2026-11-05", due: "2026-11-05" }),
    task("s", "Essay draft", { day: null, list: "Inbox", due: "2026-11-05" }),
    task("p", "Problem set 5", { day: null, list: "Brightspace", due: "2026-11-05" }),
  ] });
  assert.equal(text, "Shutdown time. 4 done, 2 left.\nTomorrow: 4 due (HW3, Lab 4, Essay draft).");
});

test("check-in: \"Mail: 1 still needs you.\" while a needs_you row isn't done", async () => {
  const text = await checkinText({ tasks: sixTasks, needsOpen: [openNeed("19a4f2c3b5d6e701")] });
  assert.equal(text, "Shutdown time. 4 done, 2 left.\nMail: 1 still needs you.");
});

test("check-in: both lines, tomorrow first", async () => {
  const text = await checkinText({
    tasks: [...sixTasks, task("h", "HW3", { day: null, list: "Brightspace", due: "2026-11-05" }), task("l", "Lab 4", { day: "2026-11-05", due: "2026-11-05" })],
    needsOpen: [openNeed("19a4f2c3b5d6e701")],
  });
  assert.equal(text, "Shutdown time. 4 done, 2 left.\nTomorrow: 2 due (HW3, Lab 4).\nMail: 1 still needs you.");
});

test("check-in: nothing due tomorrow and no open mail leaves it as it was", async () => {
  const text = await checkinText({ tasks: [...sixTasks, task("x", "Essay", { day: null, list: "Inbox", due: "2026-11-06" })] });
  assert.equal(text, "Shutdown time. 4 done, 2 left.");
});

// =============================================================================================
// Off-page approvals: googleStep
// =============================================================================================

test("googleStep: an approved block with no Google event that hasn't ended is created", async () => {
  const { googleStep } = await logic();
  // Approved from Telegram: 9:30-10:15 am, no gcal_id.
  const b = { proposed: false, gcal_id: null, starts_at: "2026-11-04T14:30:00Z", ends_at: "2026-11-04T15:15:00Z" };
  assert.equal(googleStep(b, at("2026-11-04T13:05:00Z")), "create"); // before it starts
  assert.equal(googleStep(b, at("2026-11-04T15:00:00Z")), "create"); // while it runs
});

test("googleStep: once it has ended, it gets no event", async () => {
  const { googleStep } = await logic();
  const b = { proposed: false, gcal_id: null, starts_at: "2026-11-04T14:30:00Z", ends_at: "2026-11-04T15:15:00Z" };
  assert.equal(googleStep(b, at("2026-11-04T15:15:00Z")), null);
  assert.equal(googleStep(b, at("2026-11-04T20:00:00Z")), null);
});

test("googleStep: a block with an event is patched, and a proposed one is created, as before", async () => {
  const { googleStep } = await logic();
  const now = at("2026-11-04T13:05:00Z");
  assert.equal(googleStep({ proposed: false, gcal_id: "ev1", starts_at: "2026-11-04T14:30:00Z", ends_at: "2026-11-04T15:15:00Z" }, now), "patch");
  assert.equal(googleStep({ proposed: true, gcal_id: null, starts_at: "2026-11-04T14:30:00Z", ends_at: "2026-11-04T15:15:00Z" }, now), "create");
});
