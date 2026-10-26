// The Telegram messages (src/sheet/nudges.mjs): what is due at a given minute, worked out from a
// snapshot of the day. Monday 2026-10-26 in New York (EDT, UTC-4) unless a test says otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { whatToSend } from "../src/sheet/nudges.mjs";

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

test("budget: the first six by time are the ones sent", () => {
  // Five gone out; a late run finds b4's repeat (5:10 pm) and b5's nudge (6:00 pm) both due.
  const log = [0, 1, 2, 3, 4].map((i) => sent(`b${i}`, "start", hour(13 + i)));
  const snap = study(log);
  snap.blocks[4] = block("b4", "t1", hour(17), hour(19)); // 1:00-3:00 pm, still on
  assert.deepEqual(whatToSend(snap, at(hour(18))).map((m) => [m.kind, m.block_id]), [["repeat", "b4"]]);
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
