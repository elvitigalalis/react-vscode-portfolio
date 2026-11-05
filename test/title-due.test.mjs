// A deadline written only in a task's title (logic.mjs, titleDue): the explicit date it names
// becomes the task's due date when it has none. Only explicit dates; nothing is guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { titleDue } from "../src/sheet/logic.mjs";

const TODAY = "2026-11-05";

test("titleDue: a WebAssign title's full date", () => {
  assert.equal(titleDue("Web Assign: Section 14.1 - 14.2 Thu, Nov 5, 2026, 11:59 PM EST (MAT 203)", TODAY), "2026-11-05");
  assert.equal(titleDue("Lab report due December 1, 2026", TODAY), "2026-12-01");
});

test("titleDue: a month and day without a year is the nearest one", () => {
  assert.equal(titleDue("HW 7 Nov 14 11:59pm", TODAY), "2026-11-14");
  assert.equal(titleDue("Essay Sept 3", TODAY), "2026-09-03");
  assert.equal(titleDue("Apply by Jan 10", TODAY), "2027-01-10");
});

test("titleDue: a numeric date after \"due\", or with its year", () => {
  assert.equal(titleDue("Problem set due 11/14", TODAY), "2026-11-14");
  assert.equal(titleDue("Problem set (due: 1/9)", TODAY), "2027-01-09");
  assert.equal(titleDue("Form 11/20/2026", TODAY), "2026-11-20");
});

test("titleDue: no explicit date, an impossible one, or two different ones give null", () => {
  for (const t of ["Finish MicroMouse slideshows", "Read 14.1 - 14.2", "Halve 3/4 cup", "May I ask Prof. Lee", "Call at 11:59 PM",
    "Feb 30 thing", "Nov 5 or Nov 6", "Meet in Room 2/14", "Section 3.5 2026"]) assert.equal(titleDue(t, TODAY), null, t);
  assert.equal(titleDue("Quiz Nov 5 — reminder: Nov 5, 2026", TODAY), "2026-11-05");
});
