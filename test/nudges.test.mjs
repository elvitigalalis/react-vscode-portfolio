// The Telegram messages (src/sheet/nudges.mjs): what is due at a given minute, worked out from a
// snapshot of the day, and what a tap changes. Monday 2026-10-26 in New York (EDT, UTC-4)
// unless a test says otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { whatToSend, handleTap, readTap, needsTappedBlock } from "../src/sheet/nudges.mjs";

const day = "2026-10-26";
const settings = { time_zone: "America/New_York", telegram_chat_id: 42, nudges_on: true };
const task = (id, title, extra = {}) => ({ id, title, day, done: false, due: null, public: true, ...extra });
const block = (id, task_id, starts_at, ends_at, extra = {}) => ({ id, task_id, starts_at, ends_at, proposed: false, ...extra });
const snapshot = (extra = {}) => ({ settings, day: null, tasks: [], blocks: [], log: [], ...extra });
const at = (iso) => new Date(iso);
const openPlan = [{ text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" }];

test("morning brief: at 8:00 it gives today's task and block counts", () => {
  const snap = snapshot({
    tasks: [task("t1", "OS homework"), task("t2", "Gym"), task("t3", "Read", { done: true })],
    blocks: [block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T18:45:00Z")],
  });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T12:00:00Z")), [{
    kind: "brief", block_id: null, day, send_at: "2026-10-26T12:00:00.000Z",
    text: "Today: 3 tasks, 1 block.", buttons: openPlan,
  }]);
});

test("morning brief: nothing before 8:00", () => {
  const snap = snapshot({ tasks: [task("t1", "Gym")] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T11:59:00Z")), []);
});

test("morning brief: a late run still sends it once, for 8:00", () => {
  const snap = snapshot({ tasks: [task("t1", "Gym")] });
  const [late] = whatToSend(snap, at("2026-10-26T12:07:30Z"));
  assert.equal(late.kind, "brief");
  assert.equal(late.send_at, "2026-10-26T12:00:00.000Z");
});

test("morning brief: never twice, even when the run repeats in the same minute or later", () => {
  const log = [{ block_id: null, kind: "brief", day, send_at: "2026-10-26T12:00:00.000Z", sent_at: "2026-10-26T12:00:02Z" }];
  const snap = snapshot({ tasks: [task("t1", "Gym")], log });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T12:00:40Z")), []);
  assert.deepEqual(whatToSend(snap, at("2026-10-26T15:00:00Z")), []);
});

test("morning brief: lists the at-risk tasks with their due dates", () => {
  const snap = snapshot({
    tasks: [
      task("t1", "OS homework", { due: "2026-10-27" }),
      task("t2", "Essay", { day: null, list: "Inbox", due: "2026-10-28", public: false }),
      task("t3", "Lab report", { due: "2026-10-27" }),      // has a block before it's due
      task("t4", "Taxes", { day: "2026-10-30", due: "2026-11-02" }), // a week off
    ],
    blocks: [block("b1", "t3", "2026-10-26T18:00:00Z", "2026-10-26T19:00:00Z")],
  });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text, "Today: 2 tasks, 1 block.\nAt risk: OS homework (due Tue), Essay (due Wed).");
});

test("morning brief: no blocks today prompts a plan", () => {
  const snap = snapshot({ tasks: [task("t1", "Gym"), task("t2", "Read")] });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text, 'Today: 2 tasks, 0 blocks.\nNothing planned yet: say "plan my day" to Claude.');
});

test("morning brief: proposed blocks don't count as planned", () => {
  const snap = snapshot({
    tasks: [task("t1", "Gym")],
    blocks: [block("b1", "t1", "2026-10-26T14:00:00Z", "2026-10-26T15:00:00Z", { proposed: true })],
  });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text, 'Today: 1 task, 0 blocks.\nNothing planned yet: say "plan my day" to Claude.');
});

test("morning brief: more than six blocks says which get nudged", () => {
  const tasks = [task("t1", "Study")];
  // Eight half-hour blocks from 9:00 am.
  const blocks = Array.from({ length: 8 }, (_, i) => block(`b${i}`, "t1",
    new Date(Date.parse("2026-10-26T13:00:00Z") + i * 3_600_000).toISOString(),
    new Date(Date.parse("2026-10-26T13:30:00Z") + i * 3_600_000).toISOString()));
  const [brief] = whatToSend(snapshot({ tasks, blocks }), at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text, "Today: 1 task, 8 blocks, nudging the first 6.");
});

test("morning brief: \"nudging the first 6\" counts only blocks that can be nudged", () => {
  const tasks = [task("t1", "Study"), task("t2", "Read", { done: true })];
  // Five half-hour blocks from 9:00 am, one at 7:00 am and one for a done task: five can be nudged.
  const blocks = [...Array.from({ length: 5 }, (_, i) => block(`b${i}`, "t1",
    new Date(Date.parse("2026-10-26T13:00:00Z") + i * 3_600_000).toISOString(),
    new Date(Date.parse("2026-10-26T13:30:00Z") + i * 3_600_000).toISOString())),
  block("b5", "t1", "2026-10-26T11:00:00Z", "2026-10-26T11:30:00Z"),
  block("b6", "t2", "2026-10-26T20:00:00Z", "2026-10-26T20:30:00Z")];
  const [brief] = whatToSend(snapshot({ tasks, blocks }), at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text, "Today: 2 tasks, 7 blocks.");
});

test("morning brief: an empty day says so and nothing else", () => {
  assert.deepEqual(whatToSend(snapshot(), at("2026-10-26T12:00:00Z")), [{
    kind: "brief", block_id: null, day, send_at: "2026-10-26T12:00:00.000Z",
    text: "Nothing on today.", buttons: openPlan,
  }]);
});

test("quiet hours: a brief still unsent at 11 pm waits for tomorrow", () => {
  const snap = snapshot({ tasks: [task("t1", "Gym")] });
  assert.deepEqual(whatToSend(snap, at("2026-10-27T02:59:00Z")).map((m) => m.kind), ["brief", "checkin"]); // 10:59 pm
  assert.deepEqual(whatToSend(snap, at("2026-10-27T03:00:00Z")), []);    // 11:00 pm
});

test("morning brief: 8:00 is the owner's clock, across daylight saving", () => {
  // Monday 2026-11-02 is in EST (UTC-5), so 8:00 is 13:00 UTC.
  const snap = snapshot({ tasks: [task("t1", "Gym", { day: "2026-11-02" })] });
  assert.deepEqual(whatToSend(snap, at("2026-11-02T12:59:00Z")), []);
  const [brief] = whatToSend(snap, at("2026-11-02T13:00:00Z"));
  assert.equal(brief.day, "2026-11-02");
  assert.equal(brief.send_at, "2026-11-02T13:00:00.000Z");
  assert.equal(brief.text, 'Today: 1 task, 0 blocks.\nNothing planned yet: say "plan my day" to Claude.');
});

test("switched off or not yet linked to a chat, nothing is sent", () => {
  const tasks = [task("t1", "Gym")];
  const off = snapshot({ tasks, settings: { ...settings, nudges_on: false } });
  const unlinked = snapshot({ tasks, settings: { ...settings, telegram_chat_id: null } });
  assert.deepEqual(whatToSend(off, at("2026-10-26T12:00:00Z")), []);
  assert.deepEqual(whatToSend(unlinked, at("2026-10-26T12:00:00Z")), []);
});

test("morning brief: a proposed block doesn't clear at risk", () => {
  const snap = snapshot({
    tasks: [task("t1", "OS homework", { due: "2026-10-27" })],
    blocks: [block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T19:00:00Z", { proposed: true })],
  });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text, 'Today: 1 task, 0 blocks.\nAt risk: OS homework (due Tue).\nNothing planned yet: say "plan my day" to Claude.');
});

// --- Nudges --------------------------------------------------------------------------------

// Today's brief has gone out, so these tests see only the nudges.
const briefSent = { block_id: null, kind: "brief", day, send_at: "2026-10-26T12:00:00.000Z", sent_at: "2026-10-26T12:00:01Z" };
const sent = (block_id, kind, send_at) => ({ block_id, kind, day, send_at, sent_at: send_at });
const tapButtons = (id) => [{ text: "Done", callback_data: `done:${id}` }, { text: "Snooze 10 min", callback_data: `snooze:${id}` }];
const homework = (extra = {}) => snapshot({
  tasks: [task("t1", "OS homework")],
  blocks: [block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T18:45:00Z")], // 2:00-2:45 pm
  log: [briefSent],
  ...extra,
});

test("nudge: an approved block's start brings a nudge with Done and Snooze", () => {
  assert.deepEqual(whatToSend(homework(), at("2026-10-26T18:00:00Z")), [{
    kind: "start", block_id: "b1", day, send_at: "2026-10-26T18:00:00.000Z",
    text: "▶ 2:00 pm · OS homework (45 min)", buttons: tapButtons("b1"),
  }]);
});

test("repeat: ten minutes after the nudge, one \"Still on\" follows", () => {
  const snap = homework({ log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z")] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:09:00Z")), []);
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:10:00Z")), [{
    kind: "repeat", block_id: "b1", day, send_at: "2026-10-26T18:10:00.000Z",
    text: "Still on: OS homework", buttons: tapButtons("b1"),
  }]);
});

test("nudge: none for a block whose task is already done", () => {
  const snap = homework({ tasks: [task("t1", "OS homework", { done: true })] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:00:00Z")), []);
});

test("repeat: none once the task is done", () => {
  const snap = homework({
    tasks: [task("t1", "OS homework", { done: true })],
    log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z")],
  });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:10:00Z")), []);
});

test("nudge: proposed blocks get none", () => {
  const snap = homework({ blocks: [block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T18:45:00Z", { proposed: true })] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:00:00Z")), []);
});

test("nudge: a private task shows its real title", () => {
  const snap = homework({ tasks: [task("t1", "Therapy", { public: false })] });
  const [nudge] = whatToSend(snap, at("2026-10-26T18:00:00Z"));
  assert.equal(nudge.text, "▶ 2:00 pm · Therapy (45 min)");
});

// A Snooze tap at 2:03 pm logs the snooze nudge for 2:13 pm, unsent until it goes out.
const snoozed = { block_id: "b1", kind: "snooze", day, send_at: "2026-10-26T18:13:00.000Z", sent_at: null };

test("snooze: no repeat once the nudge is snoozed", () => {
  const snap = homework({ log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z"), snoozed] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:10:00Z")), []);
});

test("snooze: the nudge comes again at the snoozed time", () => {
  const snap = homework({ log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z"), snoozed] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:12:00Z")), []);
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:13:00Z")), [{
    kind: "snooze", block_id: "b1", day, send_at: "2026-10-26T18:13:00.000Z",
    text: "▶ 2:00 pm · OS homework (45 min)", buttons: tapButtons("b1"),
  }]);
});

test("snooze: once it has gone out, it isn't sent again", () => {
  const snap = homework({ log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z"), { ...snoozed, sent_at: "2026-10-26T18:13:01Z" }] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:13:30Z")), []);
});

test("quiet hours: a block that starts before 8 am gets no nudge, even once 8:00 comes", () => {
  const snap = homework({ blocks: [block("b1", "t1", "2026-10-26T11:30:00Z", "2026-10-26T12:30:00Z")] }); // 7:30-8:30 am
  assert.deepEqual(whatToSend(snap, at("2026-10-26T12:00:00Z")), []);
  assert.deepEqual(whatToSend(snap, at("2026-10-26T12:10:00Z")), []);
});

test("quiet hours: a repeat that would fall after 11 pm isn't sent", () => {
  const snap = homework({
    blocks: [block("b1", "t1", "2026-10-27T02:55:00Z", "2026-10-27T03:40:00Z")], // 10:55-11:40 pm
    log: [briefSent, sent("b1", "start", "2026-10-27T02:55:00.000Z")],
  });
  assert.deepEqual(whatToSend(snap, at("2026-10-27T03:05:00Z")), []);
});

test("quiet hours: a repeat due at 11 pm exactly isn't sent", () => {
  const snap = homework({
    blocks: [block("b1", "t1", "2026-10-27T02:50:00Z", "2026-10-27T03:30:00Z")], // 10:50-11:30 pm
    log: [briefSent, sent("b1", "start", "2026-10-27T02:50:00.000Z"), sent(null, "checkin", "2026-10-26T21:00:00.000Z")],
  });
  assert.deepEqual(whatToSend(snap, at("2026-10-27T02:59:00Z")), []);
  assert.deepEqual(whatToSend(snap, at("2026-10-27T03:00:00Z")), []);
});

test("nudge: never twice, even when the run repeats in the same minute or later", () => {
  const snap = homework({ log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z")] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:00:40Z")), []);
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:05:00Z")), []);
});

test("nudge: a late run still sends it, for the block's start, until the block ends", () => {
  const [late] = whatToSend(homework(), at("2026-10-26T18:30:00Z"));
  assert.equal(late.kind, "start");
  assert.equal(late.send_at, "2026-10-26T18:00:00.000Z");
  assert.deepEqual(whatToSend(homework(), at("2026-10-26T18:45:00Z")), []);
});

test("nudge: moving a block before it starts moves its nudge", () => {
  const snap = homework({ blocks: [block("b1", "t1", "2026-10-26T19:00:00Z", "2026-10-26T19:45:00Z")] }); // moved to 3 pm
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:00:00Z")), []);
  const [nudge] = whatToSend(snap, at("2026-10-26T19:00:00Z"));
  assert.equal(nudge.text, "▶ 3:00 pm · OS homework (45 min)");
  assert.equal(nudge.send_at, "2026-10-26T19:00:00.000Z");
});

test("nudge: deleting a block cancels its nudge", () => {
  assert.deepEqual(whatToSend(homework({ blocks: [] }), at("2026-10-26T18:00:00Z")), []);
});

// --- The nudge budget ----------------------------------------------------------------------

// Eight half-hour blocks of "Study", on the hour from 9:00 am (13:00 UTC) to 4:00 pm.
const hour = (h) => `2026-10-26T${String(h).padStart(2, "0")}:00:00.000Z`;
const study = (log) => snapshot({
  tasks: [task("t1", "Study")],
  blocks: Array.from({ length: 8 }, (_, i) => block(`b${i}`, "t1", hour(13 + i), `2026-10-26T${13 + i}:30:00Z`)),
  log: [briefSent, ...log],
});

test("budget: the seventh nudge of the day is dropped", () => {
  const log = [0, 1, 2, 3, 4, 5].map((i) => sent(`b${i}`, "start", hour(13 + i)));
  assert.deepEqual(whatToSend(study(log), at(hour(19))), []);
});

test("repeat: a late run doesn't send it once the block is over", () => {
  const snap = homework({ log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z")] });
  assert.equal(whatToSend(snap, at("2026-10-26T18:44:00Z")).length, 1);
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:45:00Z")), []);
});

test("budget: repeats and snoozes count toward the six", () => {
  const log = [
    sent("b0", "start", hour(13)), sent("b0", "repeat", "2026-10-26T13:10:00.000Z"),
    sent("b1", "start", hour(14)), { block_id: "b1", kind: "snooze", day, send_at: "2026-10-26T14:15:00.000Z", sent_at: "2026-10-26T14:15:01Z" },
    sent("b2", "start", hour(15)), sent("b3", "start", hour(16)),
  ];
  assert.deepEqual(whatToSend(study(log), at(hour(17))), []);
});

test("budget: the first six blocks' nudges are kept for them, ahead of a repeat", () => {
  // Five gone out; a late run finds b4's repeat (1:10 pm) and b5's nudge (2:00 pm) both due.
  const log = [0, 1, 2, 3, 4].map((i) => sent(`b${i}`, "start", hour(13 + i)));
  const snap = study(log);
  snap.blocks[4] = block("b4", "t1", hour(17), hour(19)); // 1:00-3:00 pm, still on
  assert.deepEqual(whatToSend(snap, at(hour(18))).map((m) => [m.kind, m.block_id]), [["start", "b5"]]);
});

test("budget: with six blocks to nudge, no repeat takes a later block's nudge", () => {
  const snap = study([sent("b0", "start", hour(13))]);
  assert.deepEqual(whatToSend(snap, at("2026-10-26T13:10:00Z")), []);
});

test("budget: with fewer than six blocks, the slots left go to repeats", () => {
  const snap = study([sent("b0", "start", hour(13))]);
  snap.blocks = snap.blocks.slice(0, 3); // 9:00, 10:00 and 11:00 am: three nudges kept, three free
  assert.deepEqual(whatToSend(snap, at("2026-10-26T13:10:00Z")).map((m) => [m.kind, m.block_id]), [["repeat", "b0"]]);
});

test("budget: a block that can't be nudged keeps no slot", () => {
  // Seven blocks, but b6's task is done and b7 starts at 7:00 am: six can be nudged, then a seventh
  // block (b8) can't take a slot from them.
  const snap = study([sent("b0", "start", hour(13))]);
  snap.tasks.push(task("t2", "Read", { done: true }), task("t3", "Run"));
  snap.blocks = [...snap.blocks.slice(0, 5),
    block("b6", "t2", hour(19), "2026-10-26T19:30:00Z"),
    block("b7", "t3", "2026-10-26T11:00:00Z", "2026-10-26T11:30:00Z"),
    block("b8", "t3", hour(20), "2026-10-26T20:30:00Z")];
  // Five Study blocks and b8 are the six: b0's repeat has no slot.
  assert.deepEqual(whatToSend(snap, at("2026-10-26T13:10:00Z")), []);
  snap.blocks.pop(); // without b8, only five can be nudged, so one slot is free
  assert.deepEqual(whatToSend(snap, at("2026-10-26T13:10:00Z")).map((m) => m.kind), ["repeat"]);
});

test("budget: a seventh block's nudge goes out only into a slot left free", () => {
  // All six slots spent on b0-b5's nudges: b6 (3:00 pm) gets nothing.
  const log = [0, 1, 2, 3, 4, 5].map((i) => sent(`b${i}`, "start", hour(13 + i)));
  assert.deepEqual(whatToSend(study(log), at(hour(19))), []);
  // b2's task done before its nudge (no slot used): its slot passes to b6.
  const snap = study([0, 1, 3, 4, 5].map((i) => sent(`b${i}`, "start", hour(13 + i))));
  snap.tasks.push(task("t2", "Done early", { done: true }));
  snap.blocks[2] = { ...snap.blocks[2], task_id: "t2" };
  assert.deepEqual(whatToSend(snap, at(hour(19))).map((m) => [m.kind, m.block_id]), [["start", "b6"]]);
});

// --- Check-in ------------------------------------------------------------------------------

const sixTasks = ["a", "b", "c", "d", "e", "f"].map((id, i) => task(id, `Task ${id}`, { done: i < 4 }));

test("check-in: at the shutdown time, it counts what's done and what's left", () => {
  const snap = snapshot({ tasks: sixTasks, log: [briefSent] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T20:59:00Z")), []);
  assert.deepEqual(whatToSend(snap, at("2026-10-26T21:00:00Z")), [{ // 5:00 pm, the default
    kind: "checkin", block_id: null, day, send_at: "2026-10-26T21:00:00.000Z",
    text: "Shutdown time. 4 done, 2 left.", buttons: openPlan,
  }]);
});

test("check-in: follows the shutdown line saved for the day", () => {
  const snap = snapshot({ tasks: sixTasks, day: { day, shutdown: false, shutdown_at: "18:30:00" }, log: [briefSent] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T21:00:00Z")), []);
  const [checkin] = whatToSend(snap, at("2026-10-26T22:30:00Z")); // 6:30 pm
  assert.equal(checkin.kind, "checkin");
  assert.equal(checkin.send_at, "2026-10-26T22:30:00.000Z");
});

test("check-in: a shutdown line at 11 pm or later sends it at 10:55 pm", () => {
  const snap = snapshot({ tasks: sixTasks, day: { day, shutdown: false, shutdown_at: "23:30:00" }, log: [briefSent] });
  assert.deepEqual(whatToSend(snap, at("2026-10-27T02:54:00Z")), []);
  const [checkin] = whatToSend(snap, at("2026-10-27T02:55:00Z")); // 10:55 pm
  assert.equal(checkin.kind, "checkin");
  assert.equal(checkin.send_at, "2026-10-27T02:55:00.000Z");
});

test("check-in: skipped when the day is already shut down", () => {
  const snap = snapshot({ tasks: sixTasks, day: { day, shutdown: true, shutdown_at: null }, log: [briefSent] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T21:00:00Z")), []);
});

test("check-in: an empty day stays quiet after its brief", () => {
  assert.deepEqual(whatToSend(snapshot({ log: [briefSent] }), at("2026-10-26T21:00:00Z")), []);
});

test("budget: the check-in still goes out once the six are spent", () => {
  const log = [0, 1, 2, 3, 4, 5].map((i) => sent(`b${i}`, "start", hour(13 + i)));
  assert.deepEqual(whatToSend(study(log), at(hour(21))).map((m) => m.kind), ["checkin"]);
});

// --- Taps ----------------------------------------------------------------------------------

// The nudge for homework's 2:00-2:45 pm block went out; its Google event is "ev1".
const tapped = (extra = {}) => homework({
  blocks: [block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T18:45:00Z", { gcal_id: "ev1" })],
  log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z")],
  ...extra,
});

test("Done during a block: the task is done, the block ends now and Google is told later", () => {
  assert.deepEqual(handleTap({ action: "done", block_id: "b1" }, tapped(), at("2026-10-26T18:20:30Z")), {
    changes: [
      { table: "blocks", id: "b1", update: { ends_at: "2026-10-26T18:20:30.000Z" } },
      { table: "gcal_pending", insert: { gcal_id: "ev1", ends_at: "2026-10-26T18:20:30.000Z" } },
      { table: "tasks", id: "t1", update: { done: true } },
    ],
    text: "✓ Done",
  });
});

test("Done before a block: the block is deleted, and so is its Google event later", () => {
  assert.deepEqual(handleTap({ action: "done", block_id: "b1" }, tapped(), at("2026-10-26T17:50:00Z")), {
    changes: [
      { table: "blocks", id: "b1", delete: true },
      { table: "gcal_pending", insert: { gcal_id: "ev1", ends_at: null } },
      { table: "tasks", id: "t1", update: { done: true } },
    ],
    text: "✓ Done",
  });
});

test("Done after a block: the task is done and the block stays as it was", () => {
  assert.deepEqual(handleTap({ action: "done", block_id: "b1" }, tapped(), at("2026-10-26T19:00:00Z")), {
    changes: [{ table: "tasks", id: "t1", update: { done: true } }],
    text: "✓ Done",
  });
});

test("Done: the block rules apply to each of the task's blocks, and one without an event leaves Google alone", () => {
  const snap = tapped({ blocks: [
    block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T18:45:00Z"),
    block("b2", "t1", "2026-10-26T20:00:00Z", "2026-10-26T20:30:00Z", { gcal_id: "ev2" }),
  ] });
  assert.deepEqual(handleTap({ action: "done", block_id: "b1" }, snap, at("2026-10-26T18:30:00Z")).changes, [
    { table: "blocks", id: "b1", update: { ends_at: "2026-10-26T18:30:00.000Z" } },
    { table: "blocks", id: "b2", delete: true },
    { table: "gcal_pending", insert: { gcal_id: "ev2", ends_at: null } },
    { table: "tasks", id: "t1", update: { done: true } },
  ]);
});

test("Done twice: once the task is done, a second tap changes nothing", () => {
  const snap = tapped({ tasks: [task("t1", "OS homework", { done: true })] });
  assert.deepEqual(handleTap({ action: "done", block_id: "b1" }, snap, at("2026-10-26T18:25:00Z")), { changes: [], text: "✓ Done" });
});

test("a tap on a block that is gone changes nothing and says so", () => {
  const gone = { changes: [], text: "That block is no longer on the plan." };
  assert.deepEqual(handleTap({ action: "done", block_id: "b9" }, tapped(), at("2026-10-26T18:20:00Z")), gone);
  assert.deepEqual(handleTap({ action: "snooze", block_id: "b9" }, tapped(), at("2026-10-26T18:20:00Z")), gone);
});

test("Snooze: logs the nudge for ten minutes after the tap, and nothing else changes", () => {
  assert.deepEqual(handleTap({ action: "snooze", block_id: "b1" }, tapped(), at("2026-10-26T18:03:20Z")), {
    changes: [{ table: "nudges", insert: snoozed }], // 2:13 pm, unsent
    text: "Snoozed until 2:13 pm · OS homework",
  });
});

test("Snooze: the logged nudge replaces the repeat and comes at 2:13 pm", () => {
  const { changes } = handleTap({ action: "snooze", block_id: "b1" }, tapped(), at("2026-10-26T18:03:20Z"));
  const snap = tapped({ log: [...tapped().log, ...changes.map((c) => c.insert)] });
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:10:00Z")), []);
  assert.deepEqual(whatToSend(snap, at("2026-10-26T18:13:00Z")).map((m) => [m.kind, m.send_at]), [["snooze", "2026-10-26T18:13:00.000Z"]]);
});

test("Snooze: once the day's six nudges are spent, nothing is logged and the message says so", () => {
  const log = [briefSent, ...[0, 1, 2, 3, 4].map((i) => sent(`b${i + 2}`, "start", `2026-10-26T1${3 + i}:00:00.000Z`)),
    sent("b1", "start", "2026-10-26T18:00:00.000Z")];
  assert.deepEqual(handleTap({ action: "snooze", block_id: "b1" }, tapped({ log }), at("2026-10-26T18:03:00Z")), {
    changes: [], text: "No nudges left today · OS homework",
  });
});

test("Snooze on a task that is already done logs nothing", () => {
  const snap = tapped({ tasks: [task("t1", "OS homework", { done: true })] });
  assert.deepEqual(handleTap({ action: "snooze", block_id: "b1" }, snap, at("2026-10-26T18:03:00Z")), { changes: [], text: "✓ Done" });
});

test("Snooze: no slot while later blocks' nudges hold the rest, and nothing is logged", () => {
  // b1 at 2:00 pm, then five more blocks from 3:00 pm: with b1's nudge sent, all six are spoken for.
  const later = [0, 1, 2, 3, 4].map((i) => block(`b${i + 2}`, "t2", `2026-10-26T${19 + i}:00:00Z`, `2026-10-26T${19 + i}:30:00Z`));
  const snap = tapped({ tasks: [task("t1", "OS homework"), task("t2", "Study")], blocks: [...tapped().blocks, ...later] });
  assert.deepEqual(handleTap({ action: "snooze", block_id: "b1" }, snap, at("2026-10-26T18:03:00Z")), {
    changes: [], text: "No nudges left today · OS homework",
  });
});

test("Snooze: a snooze waiting to go out holds its slot", () => {
  // Four blocks: b0 (1:00-3:00 pm) nudged and repeated, b1 (2:00 pm) nudged and snoozed until
  // 2:13, b2 and b3 still to come. Four slots used or waiting and two kept: none for b0.
  const snap = snapshot({
    tasks: [task("t1", "Study")],
    blocks: [block("b0", "t1", hour(17), hour(19)), block("b1", "t1", hour(18), "2026-10-26T18:30:00Z"),
      block("b2", "t1", hour(20), "2026-10-26T20:30:00Z"), block("b3", "t1", hour(21), "2026-10-26T21:30:00Z")],
    log: [briefSent, sent("b0", "start", hour(17)), sent("b0", "repeat", "2026-10-26T17:10:00.000Z"),
      sent("b1", "start", hour(18)), { ...snoozed, block_id: "b1" }],
  });
  assert.deepEqual(handleTap({ action: "snooze", block_id: "b0" }, snap, at("2026-10-26T18:05:00Z")), {
    changes: [], text: "No nudges left today · Study",
  });
  // Once b3 is gone, a slot is free.
  snap.blocks.pop();
  assert.equal(handleTap({ action: "snooze", block_id: "b0" }, snap, at("2026-10-26T18:05:00Z")).changes.length, 1);
});

test("Snooze: refused when the nudge would come back in quiet hours, and nothing is logged", () => {
  const late = tapped({
    blocks: [block("b1", "t1", "2026-10-27T02:40:00Z", "2026-10-27T03:20:00Z")], // 10:40-11:20 pm
    log: [briefSent, sent("b1", "start", "2026-10-27T02:40:00.000Z")],
  });
  // A tap at 10:50 pm would send it at 11:00 pm.
  assert.deepEqual(handleTap({ action: "snooze", block_id: "b1" }, late, at("2026-10-27T02:50:30Z")), {
    changes: [], text: "Too close to quiet hours · OS homework",
  });
  // At 10:49 pm it still comes back at 10:59.
  assert.equal(handleTap({ action: "snooze", block_id: "b1" }, late, at("2026-10-27T02:49:00Z")).text, "Snoozed until 10:59 pm · OS homework");
});

// --- Reading a tap -------------------------------------------------------------------------

const ID = "0b6c1f9e-3d1a-4c55-9a43-2f7d8e6b1c20";
const update = (data, chat = 42) => ({ callback_query: { id: "q1", data, message: { message_id: 7, chat: { id: chat } } } });

test("reading a tap: Done and Snooze from Lisul's chat name the action and block", () => {
  assert.deepEqual(readTap(update(`done:${ID}`), settings), { action: "done", block_id: ID, query_id: "q1", chat_id: 42, message_id: 7 });
  assert.deepEqual(readTap(update(`snooze:${ID.toUpperCase()}`), settings), { action: "snooze", block_id: ID.toUpperCase(), query_id: "q1", chat_id: 42, message_id: 7 });
});

test("reading a tap: another chat, another update or bad data is ignored", () => {
  assert.equal(readTap(update(`done:${ID}`, 99), settings), null);
  assert.equal(readTap({ message: { text: "hi" } }, settings), null);
  assert.equal(readTap({ callback_query: { id: "q1", data: `done:${ID}` } }, settings), null); // no message
  assert.equal(readTap(update(`delete:${ID}`), settings), null);
  assert.equal(readTap(update("done:b1"), settings), null);
  assert.equal(readTap(update(`done:${ID}),id.neq.x`), settings), null);
  assert.equal(readTap(update(undefined), settings), null);
});

test("reading a tap: a block outside today's snapshot has to be looked up", () => {
  const snap = tapped();
  assert.equal(needsTappedBlock(snap, { block_id: "b1" }), false);
  assert.equal(needsTappedBlock(snap, { block_id: ID }), true);
});
