// v5 H1, /plan's Settings habits (docs/sheet-v5.md, "/plan"): the line each habit shows and the
// check on a new habit before it is saved, which keeps to the habits table's own checks
// (supabase/schema.sql, "v5 H1").
import { test } from "node:test";
import assert from "node:assert/strict";
import { habitLine, readHabit } from "../src/sheet/habits.mjs";

const gym = { name: "Gym", days: [1, 3, 5], ideal: "07:30:00", minutes: 60, flex_min: 30, defence: "flexible" };

test("habitLine: name, days, ideal ± flex, length and defence", () => {
  assert.equal(habitLine(gym), "Gym · Mon, Wed, Fri · 7:30 am ± 30 min · 1h · flexible");
  assert.equal(habitLine({ ...gym, name: "Lunch", days: [1, 2, 3, 4, 5], ideal: "12:30", minutes: 30, flex_min: 0, defence: "firm" }),
    "Lunch · weekdays · 12:30 pm sharp · 30m · firm");
  assert.equal(habitLine({ ...gym, days: [7, 6, 5, 4, 3, 2, 1] }), "Gym · every day · 7:30 am ± 30 min · 1h · flexible");
});

test("readHabit: the form's values as a habits row", () => {
  assert.deepEqual(readHabit({ name: "  Weekly   review ", days: ["7"], ideal: "16:00", minutes: "45", flex_min: "60", defence: "firm" }),
    { habit: { name: "Weekly review", days: [7], ideal: "16:00", minutes: 45, flex_min: 60, defence: "firm" } });
});

test("readHabit: refuses a bad name or no days (the form's constraints hold the rest)", () => {
  const ok = { name: "Gym", days: ["1"], ideal: "07:30", minutes: "60", flex_min: "30", defence: "flexible" };
  for (const bad of [
    { name: " " }, { name: "x".repeat(41) }, { days: [] }, { days: ["0"] }, { days: ["8"] },
  ]) assert.ok(readHabit({ ...ok, ...bad }).error, JSON.stringify(bad));
});
