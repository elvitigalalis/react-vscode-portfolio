// The task details dialog (src/sheet/task-details.mjs): what a save changes, blank clearing a
// detail. Expected values are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detailsChange } from "../src/sheet/task-details.mjs";

const t = { est_min: 45, at_time: "17:30:00", due: "2026-11-10", tag: "gym", day: "2026-11-03" };
const same = { est: "45", time: "17:30", due: "2026-11-10", tag: "gym" };

test("details that didn't change save nothing", () => {
  assert.deepEqual(detailsChange(t, same), { change: {} });
});

test("blank clears an estimate, a fixed time, a due date and a tag", () => {
  assert.deepEqual(detailsChange(t, { est: "", time: "", due: "", tag: "" }), { change: { est_min: null, at_time: null, due: null, tag: null } });
});

test("new values save as the columns hold them", () => {
  assert.deepEqual(detailsChange(t, { est: " 90 ", time: "09:05", due: "2026-11-12", tag: "#Lab" }), { change: { est_min: 90, at_time: "09:05", due: "2026-11-12", tag: "Lab" } });
});

test("an estimate must be whole minutes above zero", () => {
  for (const est of ["0", "-5", "1.5", "abc"]) assert.match(detailsChange(t, { ...same, est }).error, /minutes/);
});

test("a Someday task has no fixed time to change", () => {
  const s = { ...t, day: null, at_time: null };
  assert.deepEqual(detailsChange(s, { ...same, time: "09:00" }), { change: {} });
});
