// Shutdown that closes loops (src/sheet/shutdown-close.mjs, docs/sheet.md "Shutdown"): the wins
// it fills in, the places an unfinished task can go, and what Finish saves for each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rollsOnServer, choicesFor, closedLine, decisionChange, doneToday, firstUp, targetOf, undecided, winLines, winsOf } from "../src/sheet/shutdown-close.mjs";

const tz = "America/New_York";
const today = "2026-11-03"; // a Tuesday
const T = (id, title, extra = {}) => ({ id, title, day: today, list: null, position: 1, done: false, done_at: null, at_time: null, rolls: 0, source: null, ...extra });

test("done today goes by done_at on his clock, wherever the task sits", () => {
  assert.equal(doneToday(T("a", "A", { done: true, done_at: "2026-11-03T15:00:00Z" }), today, tz), true);
  // 11:30 pm Monday in New York: yesterday.
  assert.equal(doneToday(T("b", "B", { done: true, done_at: "2026-11-03T04:30:00Z" }), today, tz), false);
  assert.equal(doneToday(T("c", "C", { day: null, list: "GitHub", done: true, done_at: "2026-11-03T20:00:00Z" }), today, tz), true);
  assert.equal(doneToday(T("d", "D", { done: true }), today, tz), true, "no done_at: a done task on today");
  assert.equal(doneToday(T("e", "E"), today, tz), false);
});

test("wins: tasks, focus, GitHub and Jira apart, the workout and the habits", () => {
  const at = "2026-11-03T18:00:00Z";
  const tasks = [
    T("a", "Laundry", { done: true, done_at: at }),
    T("b", "OS homework 4", { done: true, done_at: at }),
    T("c", "Review: Fix login redirect", { day: null, list: "GitHub", source: "github", done: true, done_at: at }),
    T("d", "KAN-12 Add form validation", { day: null, list: "Jira", source: "jira", done: true, done_at: at }),
    T("e", "Still open"),
  ];
  const w = winsOf({ tasks, today, tz, focused: 100, workouts: [{ id: "w1", title: "Push day", starts_at: "2026-11-03T22:00:00Z", ends_at: "2026-11-03T22:55:00Z" }], habits: ["Read", "Gym"] });
  assert.deepEqual(w.tasks.map((t) => t.id), ["a", "b"]);
  assert.deepEqual(winLines(w), [
    { key: "tasks", text: "2 tasks done", detail: "Laundry, OS homework 4" },
    { key: "focus", text: "1h40 focused", detail: null },
    { key: "github", text: "1 closed on GitHub", detail: "Review: Fix login redirect" },
    { key: "jira", text: "1 Jira ticket done", detail: "KAN-12 Add form validation" },
    { key: "lift-w1", text: "Lifted: Push day", detail: "55m" },
    { key: "habits", text: "2 habits ticked", detail: "Read, Gym" },
  ]);
});

test("wins: an empty day has no lines, and long lists name three", () => {
  assert.deepEqual(winLines(winsOf({ tasks: [], today, tz })), []);
  const five = ["A", "B", "C", "D", "E"].map((x) => T(x, x, { done: true }));
  assert.equal(winLines(winsOf({ tasks: five, today, tz }))[0].detail, "A, B, C and 2 more");
});

test("choices: This week only while the week's last day is past tomorrow", () => {
  assert.deepEqual(choicesFor(today).map((c) => c.label), ["Done", "Tomorrow", "This week", "Someday"]);
  assert.deepEqual(choicesFor("2026-11-07").map((c) => c.kind), ["done", "tomorrow", "someday"], "Saturday: Sunday is tomorrow");
  assert.deepEqual(targetOf("week", today), { day: "2026-11-08" });
  assert.deepEqual(targetOf("tomorrow", today), { day: "2026-11-04" });
  assert.deepEqual(targetOf("someday", today), { list: "Inbox" });
  assert.equal(targetOf("done", today), null);
});

test("what each decision saves", () => {
  const t = T("a", "A", { rolls: 1, at_time: "15:00:00", position: 4 });
  assert.deepEqual(decisionChange(t, "done", today, 9), { done: true });
  // Tomorrow counts as a roll and keeps a fixed time, as the nightly rollover does.
  assert.deepEqual(decisionChange(t, "tomorrow", today, 9), { day: "2026-11-04", list: null, position: 9, rolls: 2 });
  assert.deepEqual(decisionChange(t, "week", today, 9), { day: "2026-11-08", list: null, position: 9 });
  // Someday starts over: no time, no rolls (logic.mjs, moveChange).
  assert.deepEqual(decisionChange(t, "someday", today, 9), { day: null, list: "Inbox", position: 9, at_time: null, rolls: 0 });
});

test("every open task needs a place; the closed line says where they went", () => {
  const open = [T("a", "A"), T("b", "B"), T("c", "C")];
  const d = new Map([["a", "tomorrow"], ["b", "someday"]]);
  assert.deepEqual(undecided(open, d).map((t) => t.id), ["c"]);
  d.set("c", "tomorrow");
  assert.deepEqual(undecided(open, d), []);
  assert.equal(closedLine(d), "2 on tomorrow · 1 in Someday.");
  assert.equal(closedLine(new Map([["x", "done"], ["y", "week"]])), "1 more done · 1 later this week.");
  assert.equal(closedLine(new Map()), null);
  assert.equal(firstUp([T("a", "Done one", { done: true }), T("b", "Lab 5")]), "Lab 5");
  assert.equal(firstUp([]), null);
  // By time, then position, whatever order they come in.
  const later = [T("p", "Second", { position: 2 }), T("q", "Gym", { position: 5, at_time: "18:00:00" }), T("r", "Standup", { position: 9, at_time: "09:30:00" }), T("s", "First", { position: 1 })];
  assert.equal(firstUp(later), "Standup");
  assert.equal(firstUp(later.filter((t) => !t.at_time)), "First");
});

test("a plain Tomorrow rides on shut_down's roll; a timed one or a third roll is written", () => {
  assert.equal(rollsOnServer(T("a", "A"), "tomorrow"), true);
  assert.equal(rollsOnServer(T("a", "A", { rolls: 2 }), "tomorrow"), true);
  assert.equal(rollsOnServer(T("a", "A", { rolls: 3 }), "tomorrow"), false, "the roll would park it in Inbox");
  assert.equal(rollsOnServer(T("a", "A", { at_time: "15:00:00" }), "tomorrow"), false);
  assert.equal(rollsOnServer(T("a", "A"), "week"), false);
});
