// Focus notes (docs/sheet-focus.md, "Stop and where I left off"): Stop's row, Done's closing row,
// the credit each task carries and the line its row shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stopRow, doneRow, progressByTask, progressText, sessionMinutes, NOTE_MAX } from "../src/sheet/focus-notes.mjs";

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

test("a note is cut to its limit and minutes are held to 960", () => {
  assert.equal(stopRow(s, "x".repeat(400), at(5), TZ, "id").note.length, NOTE_MAX);
  assert.equal(sessionMinutes(s, at(2000)), 960);
});

test("Done's row closes the run with the session's own minutes", () => {
  assert.deepEqual(doneRow(s, at(0.2), TZ, "d1"), { id: "d1", at: at(0.2).toISOString(), day: "2026-11-04", task_id: "t1", block_id: "b1", minutes: 0, note: null, done: true });
});

const row = (task_id, iso, minutes, note = null, done = false) => ({ task_id, at: iso, minutes, note, done });

test("a task's credit is its minutes since its last done row, with the newest note", () => {
  const p = progressByTask([
    row("t1", "2026-11-03T15:00:00Z", 30, "old"),
    row("t1", "2026-11-03T16:00:00Z", 20, null, true),
    row("t1", "2026-11-04T16:00:00Z", 25, "next: methods"),
    row("t1", "2026-11-04T15:00:00Z", 15, "first"),
    row("t1", "2026-11-04T17:00:00Z", 10),
    row("t2", "2026-11-04T15:00:00Z", 40, "next: tests"),
    row("t2", "2026-11-04T18:00:00Z", 5, null, true),
  ]);
  assert.deepEqual(p.get("t1"), { minutes: 50, note: "next: methods" });
  assert.equal(p.has("t2"), false);
});

test("the row's line says the minutes focused, against the estimate when there is one", () => {
  assert.equal(progressText({ minutes: 40 }, 90), "40m focused of 1h30");
  assert.equal(progressText({ minutes: 75 }, null), "1h15 focused");
  assert.equal(progressText({ minutes: 0, note: "x" }, 30), null);
  assert.equal(progressText(undefined, 30), null);
});
