// Verification tests for v4 "/plan at a glance": the pure functions in src/sheet/glance.mjs.
// Written before the code from docs/sheet-glance.md ("Contracts → Pure functions"). Every test
// starts as `todo`; the implementer removes `todo` and must not change an expectation. The
// module is imported inside each test so this file loads while glance.mjs doesn't exist yet.
//
// Expected values are written out by hand. Most times fall in the week of Mon 2026-11-09, after
// daylight saving ended on Nov 1, so New York is UTC-5 (EST) all week. Calendar events have the
// shape api.mjs calendarEvents returns ({ title, allDay, busy, starts_at, ends_at, link }), with
// Google's offset times; blocks have Supabase's UTC times.
//
// Readings picked where the contract is not explicit (closest to its words):
// - loadShare: `pct` rounds the share and `level` uses load's rule on the raw minutes, so they
//   can disagree at the boundary (203 of 240 min is pct 85 but level 'ok').
// - stripSegments: overlapping parts are kept as separate segments (nothing says to merge them),
//   and an event that only touches a window edge (6–7 am) is "entirely outside" and dropped.
// - feedAlert keeps the order of the rows it is given.
import { test } from "node:test";
import assert from "node:assert/strict";

const TZ = "America/New_York";
const todo = { todo: true };

// A timed calendar event, as calendarEvents returns it.
const ev = (starts_at, ends_at, extra = {}) =>
  ({ title: "Busy", allDay: false, busy: true, starts_at, ends_at, link: null, ...extra });
const block = (starts_at, ends_at, proposed = false, task_id = "t1") =>
  ({ id: `b-${starts_at}`, task_id, starts_at, ends_at, proposed });

// ---------------------------------------------------------------- sourceOf

test("sourceOf: a Brightspace task is a course task", async () => {
  const { sourceOf } = await import("../src/sheet/glance.mjs");
  assert.equal(sourceOf({ id: "t1", title: "CSE 320 HW4", source: "brightspace", tag: null }), "course");
});

test("sourceOf: a #campus task is a campus task", async () => {
  const { sourceOf } = await import("../src/sheet/glance.mjs");
  assert.equal(sourceOf({ id: "t2", title: "Hack night", source: null, tag: "campus" }), "campus");
});

test("sourceOf: any other task has no source, and Brightspace comes before the tag", async () => {
  const { sourceOf } = await import("../src/sheet/glance.mjs");
  assert.equal(sourceOf({ id: "t3", title: "Ship auth", source: null, tag: "workit" }), null);
  assert.equal(sourceOf({ id: "t4", title: "Laundry", source: null, tag: null }), null);
  assert.equal(sourceOf({ id: "t5", title: "CSE 416 demo", source: "brightspace", tag: "campus" }), "course");
});

// ---------------------------------------------------------------- campusSummary

test("campusSummary: no events is zero of each", async () => {
  const { campusSummary } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(campusSummary([]), { n: 0, food: 0 });
});

test("campusSummary: counts events and those with free food, as SB Engaged tags it", async () => {
  const { campusSummary } = await import("../src/sheet/glance.mjs");
  const events = [
    { title: "Diwali Night", starts_at: "2026-11-10T23:00:00Z", tags: [" Free Food & Refreshments", "Cultural"] },
    { title: "Resume Workshop", starts_at: "2026-11-10T18:00:00Z", tags: ["Career"] },
    { title: "Pizza & Code", starts_at: "2026-11-10T22:00:00Z", tags: ["free food "] },
  ];
  assert.deepEqual(campusSummary(events), { n: 3, food: 2 });
});

test("campusSummary: an event without tags still counts, with no food", async () => {
  const { campusSummary } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(campusSummary([{ title: "Open Mic", starts_at: "2026-11-11T00:00:00Z" }, { title: "Chess Club", tags: [] }]), { n: 2, food: 0 });
});

// ---------------------------------------------------------------- dueLevel
// Today is Tue 2026-11-10 in New York. A due day ends at midnight EST, 05:00Z the next day.

const task = (due, done = false) => ({ id: "t1", title: "OS homework", due, done });
const TODAY = "2026-11-10";

test("dueLevel: due in two days with no block is at risk; in three days, or with no due date, it isn't", async () => {
  const { dueLevel } = await import("../src/sheet/glance.mjs");
  assert.equal(dueLevel(task("2026-11-12"), [], TODAY, TZ), "risk");
  assert.equal(dueLevel(task("2026-11-13"), [], TODAY, TZ), null);
  assert.equal(dueLevel(task(null), [], TODAY, TZ), null);
});

test("dueLevel: due today is at risk, not overdue", async () => {
  const { dueLevel } = await import("../src/sheet/glance.mjs");
  assert.equal(dueLevel(task("2026-11-10"), [], TODAY, TZ), "risk");
});

test("dueLevel: an approved block starting at 11:30 pm on the due day clears the risk", async () => {
  const { dueLevel } = await import("../src/sheet/glance.mjs");
  // 11:30 pm EST on Thu Nov 12.
  assert.equal(dueLevel(task("2026-11-12"), [block("2026-11-13T04:30:00Z", "2026-11-13T05:00:00Z")], TODAY, TZ), null);
});

test("dueLevel: a block starting just after the due day ends doesn't clear it", async () => {
  const { dueLevel } = await import("../src/sheet/glance.mjs");
  // 12:15 am EST on Fri Nov 13.
  assert.equal(dueLevel(task("2026-11-12"), [block("2026-11-13T05:15:00Z", "2026-11-13T06:00:00Z")], TODAY, TZ), "risk");
});

test("dueLevel: a proposed block, or another task's block, leaves it at risk", async () => {
  const { dueLevel } = await import("../src/sheet/glance.mjs");
  // 2–3 pm EST on Wed Nov 11.
  assert.equal(dueLevel(task("2026-11-12"), [block("2026-11-11T19:00:00Z", "2026-11-11T20:00:00Z", true)], TODAY, TZ), "risk");
  assert.equal(dueLevel(task("2026-11-12"), [block("2026-11-11T19:00:00Z", "2026-11-11T20:00:00Z", false, "t9")], TODAY, TZ), "risk");
});

test("dueLevel: past due with no block is overdue, not risk", async () => {
  const { dueLevel } = await import("../src/sheet/glance.mjs");
  assert.equal(dueLevel(task("2026-11-09"), [], TODAY, TZ), "overdue");
  assert.equal(dueLevel(task("2026-10-28"), [], TODAY, TZ), "overdue");
});

test("dueLevel: past due is overdue even when a block ran on its due day", async () => {
  const { dueLevel } = await import("../src/sheet/glance.mjs");
  // 4–5 pm EST on Mon Nov 9, the due day.
  assert.equal(dueLevel(task("2026-11-09"), [block("2026-11-09T21:00:00Z", "2026-11-09T22:00:00Z")], TODAY, TZ), "overdue");
});

test("dueLevel: a done task is always null, overdue or at risk", async () => {
  const { dueLevel } = await import("../src/sheet/glance.mjs");
  assert.equal(dueLevel(task("2026-11-09", true), [], TODAY, TZ), null);
  assert.equal(dueLevel(task("2026-11-11", true), [], TODAY, TZ), null);
});

// ---------------------------------------------------------------- loadShare

test("loadShare: pct rounds to a whole percent", todo, async () => {
  const { loadShare } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(loadShare(0, 240), { pct: 0, level: "ok" });
  assert.deepEqual(loadShare(100, 240), { pct: 42, level: "ok" }); // 41.67 %
  assert.deepEqual(loadShare(130, 480), { pct: 27, level: "ok" }); // 27.08 %
});

test("loadShare: exactly 85 % is near", todo, async () => {
  const { loadShare } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(loadShare(204, 240), { pct: 85, level: "near" });
  assert.deepEqual(loadShare(408, 480), { pct: 85, level: "near" });
});

test("loadShare: just under 85 % is ok even when pct rounds to 85", todo, async () => {
  const { loadShare } = await import("../src/sheet/glance.mjs");
  // 84.58 %: the level follows load's rule on the minutes, not the rounded pct.
  assert.deepEqual(loadShare(203, 240), { pct: 85, level: "ok" });
});

test("loadShare: exactly full is near, not over", todo, async () => {
  const { loadShare } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(loadShare(240, 240), { pct: 100, level: "near" });
});

test("loadShare: over capacity is over, with pct capped at 100", todo, async () => {
  const { loadShare } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(loadShare(241, 240), { pct: 100, level: "over" });
  assert.deepEqual(loadShare(300, 240), { pct: 100, level: "over" }); // 125 %
  assert.deepEqual(loadShare(720, 240), { pct: 100, level: "over" }); // 300 %
});

test("loadShare: a capacity of 0 is over with any minutes, ok with none", todo, async () => {
  const { loadShare } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(loadShare(30, 0), { pct: 100, level: "over" });
  assert.deepEqual(loadShare(0, 0), { pct: 0, level: "ok" });
});

// ---------------------------------------------------------------- stripSegments
// Day Tue 2026-11-10 (EST). The default window is 7 am–11 pm, 960 minutes; 9.6 minutes is 1 %.

const DAY = "2026-11-10";

test("stripSegments: nothing on the day gives no segments", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(stripSegments([], [], DAY, TZ), []);
});

test("stripSegments: a busy event becomes window percentages rounded to 0.1", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  // 9:00 am is 12.5 %; 10:15 am is 20.3125 %.
  assert.deepEqual(stripSegments([ev("2026-11-10T09:00:00-05:00", "2026-11-10T10:15:00-05:00")], [], DAY, TZ),
    [{ from: 12.5, to: 20.3, kind: "busy" }]);
});

test("stripSegments: approved blocks are 'block' and proposed ones 'proposed'", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  const blocks = [
    block("2026-11-10T19:30:00Z", "2026-11-10T20:00:00Z"), // 2:30–3 pm: 46.875–50 %
    block("2026-11-10T22:30:00Z", "2026-11-10T23:45:00Z", true), // 5:30–6:45 pm: 65.625–73.4375 %
  ];
  assert.deepEqual(stripSegments([], blocks, DAY, TZ), [
    { from: 46.9, to: 50, kind: "block" },
    { from: 65.6, to: 73.4, kind: "proposed" },
  ]);
});

test("stripSegments: events and blocks are sorted together by from", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  const events = [
    ev("2026-11-10T17:30:00-05:00", "2026-11-10T18:45:00-05:00"), // 65.6–73.4
    ev("2026-11-10T08:20:00-05:00", "2026-11-10T09:00:00-05:00"), // 8.3–12.5
  ];
  const blocks = [
    block("2026-11-10T18:00:00Z", "2026-11-10T19:30:00Z", true), // 1–2:30 pm: 37.5–46.9
    block("2026-11-10T16:50:00Z", "2026-11-10T17:30:00Z"), // 11:50 am–12:30 pm: 30.2–34.4
  ];
  assert.deepEqual(stripSegments(events, blocks, DAY, TZ), [
    { from: 8.3, to: 12.5, kind: "busy" },
    { from: 30.2, to: 34.4, kind: "block" },
    { from: 37.5, to: 46.9, kind: "proposed" },
    { from: 65.6, to: 73.4, kind: "busy" },
  ]);
});

test("stripSegments: a part before 7 am is clipped to the window's start", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(stripSegments([ev("2026-11-10T06:00:00-05:00", "2026-11-10T08:20:00-05:00")], [], DAY, TZ),
    [{ from: 0, to: 8.3, kind: "busy" }]);
});

test("stripSegments: a part after 11 pm is clipped to the window's end", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  // A block 10:10–11:45 pm EST: 94.79 % to past the end.
  assert.deepEqual(stripSegments([], [block("2026-11-11T03:10:00Z", "2026-11-11T04:45:00Z")], DAY, TZ),
    [{ from: 94.8, to: 100, kind: "block" }]);
});

test("stripSegments: an event from the night before is clipped to this morning", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  // 10 pm Mon to 8:20 am Tue.
  assert.deepEqual(stripSegments([ev("2026-11-09T22:00:00-05:00", "2026-11-10T08:20:00-05:00")], [], DAY, TZ),
    [{ from: 0, to: 8.3, kind: "busy" }]);
});

test("stripSegments: anything entirely outside the window is dropped", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  const events = [
    ev("2026-11-10T05:00:00-05:00", "2026-11-10T06:30:00-05:00"), // before 7 am
    ev("2026-11-10T06:00:00-05:00", "2026-11-10T07:00:00-05:00"), // ends exactly at 7 am
    ev("2026-11-10T23:15:00-05:00", "2026-11-10T23:55:00-05:00"), // after 11 pm
    ev("2026-11-09T09:00:00-05:00", "2026-11-09T10:00:00-05:00"), // the day before
    ev("2026-11-11T09:00:00-05:00", "2026-11-11T10:00:00-05:00"), // the day after
  ];
  const blocks = [block("2026-11-10T11:00:00Z", "2026-11-10T11:45:00Z")]; // 6–6:45 am EST
  assert.deepEqual(stripSegments(events, blocks, DAY, TZ), []);
});

test("stripSegments: all-day events and free events are left out", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  const events = [
    { title: "No classes", allDay: true, busy: true, starts_at: "2026-11-10", ends_at: "2026-11-11", link: null },
    ev("2026-11-10T09:00:00-05:00", "2026-11-10T10:15:00-05:00", { title: "Office hours (optional)", busy: false }),
    ev("2026-11-10T13:00:00-05:00", "2026-11-10T15:00:00-05:00", { title: "CSE 416" }),
  ];
  assert.deepEqual(stripSegments(events, [], DAY, TZ), [{ from: 37.5, to: 50, kind: "busy" }]);
});

test("stripSegments: overlapping parts stay separate segments", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  // A 1–3 pm class and an approved block 2:30–3 pm inside it.
  const events = [ev("2026-11-10T13:00:00-05:00", "2026-11-10T15:00:00-05:00")];
  const blocks = [block("2026-11-10T19:30:00Z", "2026-11-10T20:00:00Z")];
  assert.deepEqual(stripSegments(events, blocks, DAY, TZ), [
    { from: 37.5, to: 50, kind: "busy" },
    { from: 46.9, to: 50, kind: "block" },
  ]);
});

test("stripSegments: a custom window changes the percentages", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  // 8 am–8 pm is 720 minutes: 9 am is 8.33 %, 10:30 am 20.83 %; 7:30–8:30 am clips to 0–4.2.
  const events = [
    ev("2026-11-10T09:00:00-05:00", "2026-11-10T10:30:00-05:00"),
    ev("2026-11-10T07:30:00-05:00", "2026-11-10T08:30:00-05:00"),
  ];
  assert.deepEqual(stripSegments(events, [], DAY, TZ, 8 * 60, 20 * 60), [
    { from: 0, to: 4.2, kind: "busy" },
    { from: 8.3, to: 20.8, kind: "busy" },
  ]);
});

test("stripSegments: times are read in the given zone (EDT in October)", todo, async () => {
  const { stripSegments } = await import("../src/sheet/glance.mjs");
  // Tue 2026-10-20 is EDT (UTC-4): 13:00Z is 9 am, 14:15Z is 10:15 am.
  assert.deepEqual(stripSegments([], [block("2026-10-20T13:00:00Z", "2026-10-20T14:15:00Z")], "2026-10-20", TZ),
    [{ from: 12.5, to: 20.3, kind: "block" }]);
});

// ---------------------------------------------------------------- feedAlert

const feed = (source, ok) => ({ source, fetched_at: "2026-11-10T11:07:00Z", ok, error: ok === false ? "HTTP 503" : null, items: 12 });

test("feedAlert: no feed rows, or every feed ok, gives []", todo, async () => {
  const { feedAlert } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(feedAlert([]), []);
  assert.deepEqual(feedAlert([feed("brightspace", true), feed("campus", true)]), []);
});

test("feedAlert: failed feeds are named", todo, async () => {
  const { feedAlert } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(feedAlert([feed("brightspace", true), feed("campus", false)]), ["campus"]);
  // Both failed: both, in row order.
  assert.deepEqual(feedAlert([feed("brightspace", false), feed("campus", false)]), ["brightspace", "campus"]);
});

test("feedAlert: ok null (not fetched yet) is not a failure; only false is", todo, async () => {
  const { feedAlert } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(feedAlert([feed("brightspace", null), feed("campus", true)]), []);
  assert.deepEqual(feedAlert([feed("brightspace", false), feed("campus", null)]), ["brightspace"]);
});
