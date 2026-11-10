// Progress on /plan (src/sheet/progress.mjs, docs/sheet.md "Progress"): today's count and focus
// minutes, and the week's finished tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayProgress, progressText, weekDone, weekTitle } from "../src/sheet/progress.mjs";

const tz = "America/New_York";
const today = "2026-11-03";
const T = (id, day, extra = {}) => ({ id, day, done: false, done_at: null, ...extra });

test("today counts its own tasks and today's focus minutes", () => {
  const tasks = [T("a", today, { done: true }), T("b", today), T("c", today, { done: true }), T("d", "2026-11-04", { done: true }), T("e", null)];
  const actuals = [{ day: today, minutes: 70 }, { day: today, minutes: 30 }, { day: "2026-11-02", minutes: 90 }];
  assert.deepEqual(dayProgress(tasks, today, actuals), { done: 2, total: 3, focused: 100 });
  assert.deepEqual(dayProgress(new Map(tasks.map((t) => [t.id, t])).values(), today), { done: 2, total: 3, focused: 0 });
});

test("the line drops the focused half at 0 and says nothing for an empty day", () => {
  assert.equal(progressText({ done: 3, total: 7, focused: 100 }), "3 of 7 done · 1h40 focused");
  assert.equal(progressText({ done: 0, total: 4, focused: 0 }), "0 of 4 done");
  assert.equal(progressText({ done: 0, total: 0, focused: 25 }), "25m focused");
  assert.equal(progressText({ done: 0, total: 0, focused: 0 }), "");
});

test("the week counts finishes by done_at on his clock, Someday ones too", () => {
  const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
  const tasks = [
    T("a", today, { done: true, done_at: "2026-11-03T15:00:00Z" }),
    T("b", null, { done: true, done_at: "2026-11-05T12:00:00Z" }),
    // 11:30 pm Sunday Nov 1 in New York: last week.
    T("c", "2026-11-02", { done: true, done_at: "2026-11-02T04:30:00Z" }),
    // 11:30 pm Sunday Nov 8: this week.
    T("d", "2026-11-08", { done: true, done_at: "2026-11-09T04:30:00Z" }),
    T("e", today, { done: true }),
    T("f", today),
  ];
  assert.equal(weekDone(tasks, days, tz), 3);
  assert.equal(weekTitle("Nov 2", 3), "Week of Nov 2 · 3 done");
  assert.equal(weekTitle("Nov 2", 0), "Week of Nov 2");
});
