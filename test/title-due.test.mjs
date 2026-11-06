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
  assert.equal(titleDue("Essay due Sept 3", TODAY), "2026-09-03");
  assert.equal(titleDue("Apply by Jan 10", TODAY), "2027-01-10");
});

test("titleDue: a date counts only when it is a deadline: after due, by or deadline, or a feed's timestamp", () => {
  assert.equal(titleDue("Essay due Thu, Nov 12", TODAY), "2026-11-12");
  assert.equal(titleDue("Deadline: December 1st", TODAY), "2026-12-01");
  assert.equal(titleDue("Quiz 4 Fri, Nov 13, 2026, 11:59 PM EST", TODAY), "2026-11-13");
  for (const t of ["Watch 4 lectures for AMS 261 (start with September 22 skip 25th (exam 1))",
    "Essay Sept 3", "Form 11/20/2026", "Review notes from Oct 28", "Trip Dec 20, 2026", "Read chapter after Nov 9"]) {
    assert.equal(titleDue(t, TODAY), null, t);
  }
});

test("titleDue: a numeric date after \"due\", or with its year", () => {
  assert.equal(titleDue("Problem set due 11/14", TODAY), "2026-11-14");
  assert.equal(titleDue("Problem set (due: 1/9)", TODAY), "2027-01-09");
  assert.equal(titleDue("Form due 11/20/2026", TODAY), "2026-11-20");
});

test("titleDue: no explicit date, an impossible one, or two different ones give null", () => {
  for (const t of ["Finish MicroMouse slideshows", "Read 14.1 - 14.2", "Halve 3/4 cup", "May I ask Prof. Lee", "Call at 11:59 PM",
    "Feb 30 thing", "Nov 5 or Nov 6", "Meet in Room 2/14", "Section 3.5 2026"]) assert.equal(titleDue(t, TODAY), null, t);
  assert.equal(titleDue("Quiz due Nov 5 — reminder: due Nov 5, 2026", TODAY), "2026-11-05");
  assert.equal(titleDue("Quiz due Nov 5, starts Nov 2", TODAY), "2026-11-05");
});

test("jiraTaskChanges: a ticket with no due date takes the one its summary spells out, on insert and update", async () => {
  const { jiraTaskChanges } = await import("../src/sheet/sources.mjs");
  const issues = [{ key: "KAN-30", fields: { summary: "Demo slides due 11/14", duedate: null } }];
  const site = "example-team.atlassian.net";
  assert.equal(jiraTaskChanges(issues, { tasks: [], seen: [], site, today: TODAY }).insert[0].due, "2026-11-14");
  const tasks = [{ id: "t1", title: "KAN-30 Demo slides due 11/14", due: "2026-11-14", done: false, source: "jira", source_uid: "KAN-30" }];
  assert.deepEqual(jiraTaskChanges(issues, { tasks, seen: ["KAN-30"], site, today: TODAY }).update, []);
});
