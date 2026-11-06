// Swipes on the phone (src/sheet/swipe.mjs, docs/sheet.md, "On the phone"): which way a finger is
// going and what a swipe does. Expected values are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockAxis, swipeActions, rowArmed, dayStep } from "../src/sheet/swipe.mjs";

test("a finger locks to an axis only once it has moved, and sideways must clearly win", () => {
  assert.equal(lockAxis(4, 3), null);
  assert.equal(lockAxis(12, 2), "x");
  assert.equal(lockAxis(-12, 2), "x");
  assert.equal(lockAxis(2, 12), "y");
  assert.equal(lockAxis(10, 10), "y");
});

test("an open task swipes right to done and left to tomorrow", () => {
  const a = swipeActions({ kind: "task", done: false, day: "2026-11-03", today: "2026-11-03" });
  assert.deepEqual(a.right, { label: "Done", act: "done" });
  assert.deepEqual(a.left, { label: "Tomorrow", act: "tomorrow" });
});

test("a Someday task's left swipe is tomorrow; a later day's is the next day", () => {
  assert.equal(swipeActions({ kind: "task", done: false, day: null, today: "2026-11-03" }).left.act, "tomorrow");
  assert.deepEqual(swipeActions({ kind: "task", done: false, day: "2026-11-04", today: "2026-11-03" }).left, { label: "Next day", act: "day-after" });
});

test("an event row only swipes right: an event can't move to tomorrow", () => {
  const a = swipeActions({ kind: "event", done: false, day: "2026-11-03", today: "2026-11-03" });
  assert.equal(a.right.act, "done");
  assert.equal(a.left, null);
});

test("a done row has no swipe, so the day takes the gesture", () => {
  assert.equal(swipeActions({ kind: "task", done: true, day: "2026-11-03", today: "2026-11-03" }), null);
  assert.equal(swipeActions({ kind: "event", done: true, day: "2026-11-03", today: "2026-11-03" }), null);
});

test("a row arms at 35% of its width, at most 96 px", () => {
  assert.equal(rowArmed(95, 358), false);
  assert.equal(rowArmed(-96, 358), true);
  assert.equal(rowArmed(70, 200), true);
  assert.equal(rowArmed(69, 200), false);
});

test("a day steps past 60 px when the swipe is mostly sideways", () => {
  assert.equal(dayStep(-61, 5), "next");
  assert.equal(dayStep(61, 5), "prev");
  assert.equal(dayStep(59, 0), null);
  assert.equal(dayStep(70, 40), null);
});
