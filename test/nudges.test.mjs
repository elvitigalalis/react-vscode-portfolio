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
  assert.equal(whatToSend(snap, at("2026-10-27T02:59:00Z")).length, 1); // 10:59 pm
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
