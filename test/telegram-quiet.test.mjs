// Fewer, quieter Telegram messages (src/sheet/nudges.mjs; research/plan-phone.md P2, P7, U16):
// which messages ring and which arrive silently, the links that open a view in /plan, and the
// brief's folded tail. Monday 2026-10-26 in New York (EDT, UTC-4) unless a test says otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { whatToSend, silent } from "../src/sheet/nudges.mjs";

const day = "2026-10-26";
const settings = { time_zone: "America/New_York", telegram_chat_id: 42, nudges_on: true };
const task = (id, title, extra = {}) => ({ id, title, day, done: false, due: null, public: true, ...extra });
const block = (id, task_id, starts_at, ends_at, extra = {}) => ({ id, task_id, starts_at, ends_at, proposed: false, ...extra });
const snapshot = (extra = {}) => ({ settings, day: null, tasks: [], blocks: [], log: [], ...extra });
const at = (iso) => new Date(iso);
const sent = (block_id, kind, send_at) => ({ block_id, kind, day, send_at, sent_at: send_at });
const briefSent = sent(null, "brief", "2026-10-26T12:00:00.000Z");

// ---------------------------------------------------------------- silent

test("silent: the brief and a block's start nudge ring; Finished? and the check-in arrive silently", () => {
  const snap = snapshot({
    tasks: [task("t1", "OS homework")],
    blocks: [block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T18:45:00Z")],
  });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.kind, "brief");
  assert.equal(silent(brief), false);
  const [start] = whatToSend({ ...snap, log: [briefSent] }, at("2026-10-26T18:00:00Z"));
  assert.equal(start.kind, "start");
  assert.equal(silent(start), false);
  const [finished] = whatToSend({ ...snap, log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z"), sent("b1", "repeat", "2026-10-26T18:10:00.000Z")] }, at("2026-10-26T18:45:00Z"));
  assert.equal(finished.kind, "finished");
  assert.equal(silent(finished), true);
  const [checkin] = whatToSend({ ...snap, log: [briefSent] }, at("2026-10-26T21:00:00Z")).filter((m) => m.kind === "checkin");
  assert.equal(silent(checkin), true);
});

test("silent: a repeat, a snooze, wind-down and bedtime still ring; replan and horizon messages don't", () => {
  for (const kind of ["repeat", "snooze", "wind_down", "bedtime", "proposal"]) assert.equal(silent({ kind }), false, kind);
  for (const kind of ["replan", "horizon"]) assert.equal(silent({ kind }), true, kind);
});

// ---------------------------------------------------------------- links that open a view

const plan = (view) => `https://www.lisul-elvi.com/plan/?open=${view}`;

test("links: the check-in's Open /plan opens Shutdown", () => {
  const snap = snapshot({ tasks: [task("t1", "OS homework")], log: [briefSent] });
  const [checkin] = whatToSend(snap, at("2026-10-26T21:00:00Z")).filter((m) => m.kind === "checkin");
  assert.deepEqual(checkin.buttons, [{ text: "Open /plan", url: plan("shutdown") }]);
});

test("links: a plan's Open /plan opens the plan, between Approve all and Skip", () => {
  const proposal = { day, rev: 2, status: "pending", created_at: "2026-10-26T10:07:00Z", run_trigger: "morning", note: null, picks: [], blocks: [] };
  const snap = snapshot({
    tasks: [task("t1", "OS homework")],
    blocks: [block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T18:45:00Z", { proposed: true })],
    proposal,
  });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.deepEqual(brief.buttons, [
    { text: "Approve all", callback_data: `pa:${day}:2` },
    { text: "Open /plan", url: plan("plan") },
    { text: "Skip", callback_data: `ps:${day}:2` },
  ]);
});

test("links: with mail waiting and no plan to approve, the brief says how many and opens Needs you", () => {
  const snap = snapshot({ tasks: [task("t1", "OS homework")], needsOpen: [{ id: "n1", done: false }, { id: "n2", done: false }] });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text, 'Today: 1 task, 0 blocks.\nNothing planned yet: say "plan my day" to Claude.\nNeeds you: 2.');
  assert.deepEqual(brief.buttons, [{ text: "Open /plan", url: plan("needs") }]);
});

// ---------------------------------------------------------------- the folded brief

// An expandable_blockquote entity, "collapsed-by-default block quotation", with offset and length
// "in UTF-16 code units" (core.telegram.org/bots/api#messageentity).
const fold = (offset, length) => [{ type: "expandable_blockquote", offset, length }];

test("folded brief: what to do stays in view; awaiting reply folds under it", () => {
  const snap = snapshot({
    tasks: [task("t1", "OS homework", { due: "2026-10-27" }), task("t2", "Gym")],
    awaiting: [{ who: "Prof. Kim", since: "2026-10-20T15:00:00Z" }],
  });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  const head = 'Today: 2 tasks, 0 blocks.\nAt risk: OS homework (due Tue).\nNothing planned yet: say "plan my day" to Claude.';
  const tail = "Awaiting reply: 1 (Prof. Kim).";
  assert.equal(brief.text, `${head}\n${tail}`);
  assert.deepEqual(brief.entities, fold(head.length + 1, tail.length));
});

test("folded brief: offsets count UTF-16 code units, so an emoji in a title counts as two", () => {
  const snap = snapshot({ tasks: [task("t1", "Run 🏃")], awaiting: [{ who: "Ana", since: "2026-10-20T15:00:00Z" }] });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text.slice(brief.entities[0].offset), "Awaiting reply: 1 (Ana).");
});

test("folded brief: with nothing to fold, there are no entities", () => {
  const [brief] = whatToSend(snapshot({ tasks: [task("t1", "Gym")] }), at("2026-10-26T12:00:00Z"));
  assert.equal(brief.entities, undefined);
});

// ---------------------------------------------------------------- Monday's Last week line

// Last week is Mon 10/19 to Sun 10/25. Each block is 2 h from 1 pm local (17:00Z, EDT).
const lw = (d, task_id) => ({ task_id, starts_at: `2026-10-${d}T17:00:00Z`, ends_at: `2026-10-${d}T19:00:00Z` });
const lastWeek = {
  blocks: [lw(19, "a"), lw(20, "a"), lw(21, "b"), lw(22, "c")],   // 8 h on 4 days
  done: ["a", "b"],                                                  // 6 h of it done
  actuals: [
    { kind: "course", est_min: 60, minutes: 90 }, { kind: "course", est_min: 60, minutes: 84 }, { kind: "course", est_min: 30, minutes: 39 },
    { kind: "other", est_min: 60, minutes: 60 },
  ],
};
const dueSoon = [
  task("p1", "OS project", { day: null, list: "Inbox", due: "2026-10-30" }),
  task("p2", "Essay", { day: null, list: "Inbox", due: "2026-10-29" }),
  task("p3", "Taxes", { day: null, list: "Inbox", due: "2026-11-10" }),    // next week
];
const hzRows = [
  { task_id: "p1", state: "on_track", short_min: 0, slack_min: 300, finish_day: "2026-10-28", notified: null },
  { task_id: "p2", state: "tight", short_min: 0, slack_min: 30, finish_day: "2026-10-29", notified: "tight" },
];
// p1 and p2 have blocks before they're due, so neither is at risk.
const covering = [block("x1", "p1", "2026-10-27T13:00:00Z", "2026-10-27T14:00:00Z"), block("x2", "p2", "2026-10-27T15:00:00Z", "2026-10-27T16:00:00Z")];

test("Monday brief: a Last week line with hours done of planned, the pace furthest off, and what's due this week", () => {
  const snap = snapshot({ tasks: [task("t1", "Gym"), ...dueSoon], blocks: covering, lastWeek, horizon: hzRows });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text.split("\n").find((l) => l.startsWith("Last week")),
    "Last week: 6h done of 8h planned. Course tasks ran 1.4× estimate. Due this week: Essay (tight), OS project (on track).");
});

test("Monday brief: no Last week line when last week had fewer than 3 planned days, or on another day", () => {
  const thin = { ...lastWeek, blocks: lastWeek.blocks.slice(0, 2) };
  const [brief] = whatToSend(snapshot({ tasks: [task("t1", "Gym")], lastWeek: thin }), at("2026-10-26T12:00:00Z"));
  assert.ok(!brief.text.includes("Last week"));
  const tue = { ...settings };
  const [tuesday] = whatToSend(snapshot({ settings: tue, tasks: [task("t1", "Gym", { day: "2026-10-27" })], lastWeek }), at("2026-10-27T12:00:00Z"));
  assert.ok(!tuesday.text.includes("Last week"));
});

test("Monday brief: paces within 20% of the estimate, or with under 3 samples, are left out", () => {
  const even = { ...lastWeek, actuals: [{ kind: "course", est_min: 60, minutes: 66 }, { kind: "course", est_min: 60, minutes: 60 }, { kind: "course", est_min: 60, minutes: 70 }, { kind: "jira", est_min: 30, minutes: 90 }] };
  const [brief] = whatToSend(snapshot({ tasks: [task("t1", "Gym")], lastWeek: even }), at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text.split("\n")[1], "Last week: 6h done of 8h planned.");
});

// ---------------------------------------------------------------- a missed morning plan

test("brief: a missed morning plan is said even when today already has blocks", () => {
  const snap = snapshot({
    settings: { ...settings, morning_on: true },
    tasks: [task("t1", "OS homework")],
    blocks: [block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T18:45:00Z")],
  });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.text, 'Today: 1 task, 1 block.\nNo morning plan came in today: say "plan my day" to Claude.');
});
