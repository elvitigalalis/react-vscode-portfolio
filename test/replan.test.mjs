// changeRow, the row a sync writes (src/sheet/replan.mjs). shouldReplan and the reason words are
// covered by test/v5-replans.verify.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { changeRow } from "../src/sheet/replan.mjs";

test("changeRow: a reason gives its kind and weight", () => {
  assert.deepEqual(changeRow("course_due_soon", "uid-1"), { kind: "course", reason: "course_due_soon", weight: 8, ref: "uid-1" });
  assert.deepEqual(changeRow("campus_change"), { kind: "campus", reason: "campus_change", weight: 3, ref: null });
});

test("changeRow: a ref is cut to 200 characters; an unknown reason throws", () => {
  assert.equal(changeRow("course_change", "x".repeat(250)).ref.length, 200);
  assert.throws(() => changeRow("weather_change"));
});
