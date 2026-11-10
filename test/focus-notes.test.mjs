// Focus notes (docs/sheet-focus.md, "Stop and where I left off"): Stop's row, Done's closing row,
// the credit each task carries and the line its row shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayProgress } from "../src/sheet/progress.mjs";
import { stopRow, doneRow, closingRow, closeFinished, focusedEntries, progressByTask, progressText, sessionMinutes, creditMinutes, NOTE_MAX } from "../src/sheet/focus-notes.mjs";

const TZ = "America/New_York";
// Started 11:50 pm on Nov 4 (EST), so the day is the 4th even when stopped on the 5th.
const s = { block_id: "b1", task_id: "t1", started_at: Date.parse("2026-11-05T04:50:00Z"), ends_at: Date.parse("2026-11-05T05:35:00Z") };
const at = (min) => new Date(s.started_at + min * 60_000);

test("Stop keeps the minutes and a trimmed one-line note, on the day it started", () => {
  assert.deepEqual(stopRow(s, "  drafted intro,\n next: methods  ", at(25.4), TZ, "id1"),
    { id: "id1", at: at(25.4).toISOString(), day: "2026-11-04", task_id: "t1", block_id: "b1", minutes: 25, note: "drafted intro, next: methods", done: false });
});

test("Stop with no note still credits the minutes; under a minute with no note keeps nothing", () => {
  assert.equal(stopRow(s, "   ", at(10), TZ, "id").note, null);
  assert.equal(stopRow(s, "", at(10), TZ, "id").minutes, 10);
  assert.equal(stopRow(s, "", at(0.4), TZ, "id"), null);
  assert.equal(stopRow(s, "next: the proof", at(0.4), TZ, "id").minutes, 0);
});

test("Stop's credit stops at the block's end (with its +15s) unless he types one", () => {
  // The block ends 45 min after Start; a session left running 10 hours suggests 45.
  assert.equal(creditMinutes(s, at(600)), 45);
  assert.equal(creditMinutes({ ...s, ends_at: s.ends_at + 15 * 60_000 }, at(600)), 60);
  assert.equal(creditMinutes(s, at(30)), 30);
  assert.equal(creditMinutes({ ...s, ends_at: s.started_at - 60_000 }, at(30)), 30);
  assert.equal(stopRow(s, "", at(600), TZ, "id").minutes, 45);
  // What he types wins, held to 0–960 and whole; a blank or junk field falls back.
  assert.equal(stopRow(s, "", at(600), TZ, "id", "130").minutes, 130);
  assert.equal(stopRow(s, "", at(600), TZ, "id", "2000").minutes, 960);
  assert.equal(stopRow(s, "", at(600), TZ, "id", "").minutes, 45);
  assert.equal(stopRow(s, "", at(600), TZ, "id", "abc").minutes, 45);
  assert.equal(stopRow(s, "", at(600), TZ, "id", "0"), null);
});

test("a note is cut to its limit and minutes are held to 960", () => {
  assert.equal(stopRow(s, "x".repeat(400), at(5), TZ, "id").note.length, NOTE_MAX);
  // An emoji at the limit is kept whole or left out, never split into a lone surrogate.
  const cut = stopRow(s, "x".repeat(279) + "\u{1F600}\u{1F600}", at(5), TZ, "id").note;
  assert.equal(cut, "x".repeat(279) + "\u{1F600}");
  assert.equal(Array.from(cut).length, NOTE_MAX);
  assert.equal(/[\ud800-\udbff]$/.test(cut), false);
  assert.equal(sessionMinutes(s, at(2000)), 960);
});

test("Done's row has the session's own minutes and closes the rows it counted", () => {
  assert.deepEqual(doneRow(s, at(0.2), TZ, "d1", ["r1"]), { id: "d1", at: at(0.2).toISOString(), day: "2026-11-04", task_id: "t1", block_id: "b1", minutes: 0, note: null, done: true, closes: ["r1"] });
});

let n = 0;
const row = (task_id, iso, minutes, note = null, extra = {}) => ({ id: `r${n++}`, task_id, at: iso, minutes, note, done: false, ...extra });

test("a task's credit is its open rows' minutes, with the newest note and their ids", () => {
  const old = row("t1", "2026-11-03T15:00:00Z", 30, "old");
  const a = row("t1", "2026-11-04T16:00:00Z", 25, "next: methods"), b = row("t1", "2026-11-04T15:00:00Z", 15, "first"), c = row("t1", "2026-11-04T17:00:00Z", 10);
  const t2 = row("t2", "2026-11-04T15:00:00Z", 40, "next: tests");
  const p = progressByTask([old, row("t1", "2026-11-03T16:00:00Z", 20, null, { done: true, closes: [old.id] }), a, b, c, t2,
    row("t2", "2026-11-04T18:00:00Z", 5, null, { done: true, closes: [t2.id] })]);
  assert.deepEqual(p.get("t1"), { minutes: 50, note: "next: methods", ids: [b.id, a.id, c.id] });
  assert.equal(p.has("t2"), false);
});

test("a closing row closes only the rows it lists, so credit this page never read survives", () => {
  // The repro: a Stop from yesterday this page never loaded, then Done today with nothing known.
  const stop = stopRow(s, "next: tests", at(40), TZ, "r-stop");
  const done = doneRow({ ...s, started_at: s.started_at + 86_400_000 }, new Date(s.started_at + 86_400_000 + 20 * 60_000), TZ, "d1", []);
  assert.deepEqual(progressByTask([stop, done]).get("t1"), { minutes: 40, note: "next: tests", ids: ["r-stop"] });
  // A closing row with no session (the task done elsewhere) has no minutes of its own.
  assert.deepEqual(closingRow({ task_id: "t1", day: "2026-11-05", closes: ["r-stop"] }, at(60), "c1"), { id: "c1", at: at(60).toISOString(), day: "2026-11-05", task_id: "t1", block_id: null, minutes: 0, note: null, done: true, closes: ["r-stop"] });
  assert.equal(progressByTask([stop, closingRow({ task_id: "t1", day: "2026-11-05", closes: ["r-stop"] }, at(60), "c1")]).has("t1"), false);
});

test("a task finished outside focus gets a closing row for its open rows; open tasks don't", () => {
  const progress = new Map([["t1", { minutes: 40, note: "x", ids: ["a", "b"] }], ["t2", { minutes: 10, note: null, ids: ["c"] }], ["gone", { minutes: 5, note: null, ids: ["d"] }]]);
  const tasks = new Map([["t1", { id: "t1", done: true }], ["t2", { id: "t2", done: false }]]);
  let i = 0;
  assert.deepEqual(closeFinished(progress, tasks, "2026-11-05", at(0), () => `c${i++}`),
    [{ id: "c0", at: at(0).toISOString(), day: "2026-11-05", task_id: "t1", block_id: null, minutes: 0, note: null, done: true, closes: ["a", "b"] }]);
});

test("focused today counts each session's own minutes today, never earlier credit", () => {
  // Yesterday a 40m Stop; today a 20m Stop, then Done after 10 more (its actuals row says 70, the
  // closing row 10); a task done elsewhere (0); and a 15m Done while focus_log was unread.
  const rows = [
    { id: "a", day: "2026-11-04", task_id: "t1", minutes: 40, done: false },
    { id: "b", day: "2026-11-05", task_id: "t1", minutes: 20, done: false },
    { id: "c", day: "2026-11-05", task_id: "t1", minutes: 10, done: true, closes: ["a", "b"] },
    { id: "d", day: "2026-11-05", task_id: "t3", minutes: 0, done: true, closes: [] },
  ];
  const entries = focusedEntries(rows, [{ day: "2026-11-05", minutes: 15 }]);
  assert.equal(dayProgress([], "2026-11-05", entries).focused, 45);
  assert.equal(dayProgress([], "2026-11-04", entries).focused, 40);
  assert.equal(dayProgress([], "2026-11-05", focusedEntries([])).focused, 0);
});

test("the row's line says the minutes focused, against the estimate when there is one", () => {
  assert.equal(progressText({ minutes: 40 }, 90), "40m focused of 1h30");
  assert.equal(progressText({ minutes: 75 }, null), "1h15 focused");
  assert.equal(progressText({ minutes: 0, note: "x" }, 30), null);
  assert.equal(progressText(undefined, 30), null);
});
