// The Now/Next line above today (src/sheet/now-next.mjs). Expected values are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nowNext } from "../src/sheet/now-next.mjs";

const task = (title, start, end, done = false) => ({ kind: "task", task: { title, done }, start, end });
const event = (title, start, end, done = false) => ({ kind: "event", title, start, end, done });

test("Now is the row running; Next the first to start after this minute", () => {
  const rows = [task("Old", 500, 560), event("Lecture", 540, 620), task("Gym", 1050, 1110), task("Later", 1200, 1230)];
  const r = nowNext(rows, 600);
  assert.equal(r.now.title, "Lecture");
  assert.equal(r.next.task.title, "Gym");
});

test("Done rows, all-day rows and untimed tasks never show", () => {
  const rows = [task("Finished", 590, 620, true), { kind: "task", task: { title: "Untimed", done: false } }, event("Holiday", null, null), event("Skipped", 700, 720, true)];
  assert.deepEqual(nowNext(rows, 600), { now: null, next: null });
});

test("A row ends the minute its end comes, and the latest start wins an overlap", () => {
  assert.equal(nowNext([task("A", 500, 600)], 600).now, null);
  assert.equal(nowNext([event("Long", 500, 700), task("Inside", 590, 620)], 600).now.task.title, "Inside");
});
