// /plan behaviour (work package B): the pure parts in src/sheet/glance.mjs. Expected values are
// written out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedAlert, plannedLeft, overCommit } from "../src/sheet/glance.mjs";

// ---------------------------------------------------------------- feedAlert staleness

const at = (iso) => new Date(iso).getTime();
const row = (source, fetched_at, ok = true) => ({ source, fetched_at, ok, error: null, items: 3 });

test("feedAlert: a connected feed not read for over 3x its interval is flagged", () => {
  const now = at("2026-11-06T15:00:00Z");
  const rows = [
    row("gmail", "2026-11-06T14:44:00Z"),       // 16 min, every 5 min: stale
    row("freebusy", "2026-11-06T14:31:00Z"),    // 29 min, every 10: fine
    row("brightspace", "2026-11-06T11:59:00Z"), // 3h01, hourly: stale
    row("campus", "2026-11-06T12:01:00Z"),      // 2h59, hourly: fine
  ];
  assert.deepEqual(feedAlert(rows, now), ["gmail", "brightspace"]);
});

test("feedAlert: Hevy, read every 15 min, is stale after 45 min", () => {
  const now = at("2026-11-06T15:00:00Z");
  assert.deepEqual(feedAlert([row("hevy", "2026-11-06T14:16:00Z"), row("hevy", "2026-11-06T14:14:00Z")], now), ["hevy"]);
});

test("feedAlert: a not-connected feed (ok null) is never stale; a failed one is still named", () => {
  const now = at("2026-11-06T15:00:00Z");
  assert.deepEqual(feedAlert([row("slack", "2026-11-01T00:00:00Z", null), row("oura", "2026-11-06T14:59:00Z", false)], now), ["oura"]);
});

test("feedAlert: without a now, only failed reads count (the old contract)", () => {
  assert.deepEqual(feedAlert([row("gmail", "2020-01-01T00:00:00Z")]), []);
});

// ---------------------------------------------------------------- dayWindow

test("dayWindow: from the day's open to shutdown + 1 h, on whole hours", async () => {
  const { dayWindow } = await import("../src/sheet/glance.mjs");
  // Opens 12:45 pm, shutdown 11 pm: 12 pm to midnight, so an 11:30 pm block shows.
  assert.deepEqual(dayWindow(12 * 60 + 45, 23 * 60), { from: 12 * 60, to: 24 * 60 });
  // Shutdown 10:20 pm ends the window at 11:20, rounded up to 12 am.
  assert.deepEqual(dayWindow(9 * 60 + 30, 22 * 60 + 20), { from: 9 * 60, to: 24 * 60 });
});

test("dayWindow: grows to hold anything already on the day", async () => {
  const { dayWindow } = await import("../src/sheet/glance.mjs");
  // A 10 am class before a 1 pm open, and an 11:30 pm–12:15 am block after a 5 pm shutdown.
  assert.deepEqual(dayWindow(13 * 60, 17 * 60, [{ start: 10 * 60, end: 11 * 60 }, { start: 23 * 60 + 30, end: 24 * 60 + 15 }]),
    { from: 10 * 60, to: 25 * 60 });
  // All-day spans (0 to 1440) are not passed in; a span starting before midnight is clipped at 0.
  assert.deepEqual(dayWindow(13 * 60, 17 * 60, [{ start: -30, end: 30 }]), { from: 0, to: 18 * 60 });
});

// ---------------------------------------------------------------- openView

test("openView: ?open= names a view, and the rest of the query is kept", async () => {
  const { openView } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(openView("?open=shutdown"), { view: "shutdown", search: "" });
  assert.deepEqual(openView("?mail=ok&open=needs"), { view: "needs", search: "?mail=ok" });
  assert.deepEqual(openView("?open=plan&x=1"), { view: "plan", search: "?x=1" });
});

test("openView: an unknown or missing view opens nothing; an unknown one is still stripped", async () => {
  const { openView } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(openView(""), { view: null, search: "" });
  assert.deepEqual(openView("?calendar=ok"), { view: null, search: "?calendar=ok" });
  assert.deepEqual(openView("?open=settings"), { view: null, search: "" });
});

// ---------------------------------------------------------------- followToday

test("followToday: back the next morning, the week and the day on screen move to today", async () => {
  const { followToday } = await import("../src/sheet/glance.mjs");
  // Tuesday's tab, shown again on Wednesday: same week, the phone's one day moves.
  assert.deepEqual(followToday({ week: "2026-11-02", focus: "2026-11-03" }, "2026-11-03", "2026-11-04"), { week: "2026-11-02", focus: "2026-11-04" });
  // Sunday night's tab, shown again on Monday: the next week.
  assert.deepEqual(followToday({ week: "2026-11-02", focus: "2026-11-08" }, "2026-11-08", "2026-11-09"), { week: "2026-11-09", focus: "2026-11-09" });
});

test("followToday: a day he stepped to, or the same day, stays", async () => {
  const { followToday } = await import("../src/sheet/glance.mjs");
  assert.equal(followToday({ week: "2026-11-02", focus: "2026-11-06" }, "2026-11-03", "2026-11-04"), null);
  assert.equal(followToday({ week: "2026-11-09", focus: "2026-11-10" }, "2026-11-03", "2026-11-04"), null);
  assert.equal(followToday({ week: "2026-11-02", focus: "2026-11-03" }, "2026-11-03", "2026-11-03"), null);
});

// ---------------------------------------------------------------- settingsOpen (research U12)

const GROUPS = ["accounts", "day", "claude", "status"];

test("settingsOpen: on a wide screen every group is open; on a phone only the one asked for", async () => {
  const { settingsOpen } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(settingsOpen(GROUPS, "status", false), [true, true, true, true]);
  assert.deepEqual(settingsOpen(GROUPS, "status", true), [false, false, false, true]);
  assert.deepEqual(settingsOpen(GROUPS, "accounts", true), [true, false, false, false]);
});

test("settingsOpen: no section (S, the ⋯ menu) opens all on a wide screen and none on a phone", async () => {
  const { settingsOpen } = await import("../src/sheet/glance.mjs");
  assert.deepEqual(settingsOpen(GROUPS, null, false), [true, true, true, true]);
  assert.deepEqual(settingsOpen(GROUPS, null, true), [false, false, false, false]);
  // An unknown name is no section.
  assert.deepEqual(settingsOpen(GROUPS, "feeds", true), [false, false, false, false]);
});

test("plannedLeft: undone estimates plus the rest of blocks no estimate covers", () => {
  const now = Date.parse("2026-11-09T15:00:00Z");
  const tasks = [
    { id: "a", done: false, est_min: 60 },
    { id: "b", done: true, est_min: 90 },
    { id: "c", done: false, est_min: null },
  ];
  const blocks = [
    { task_id: "a", starts_at: "2026-11-09T16:00:00Z", ends_at: "2026-11-09T17:00:00Z" }, // its estimate counts
    { task_id: "b", starts_at: "2026-11-09T18:00:00Z", ends_at: "2026-11-09T19:00:00Z" }, // done
    { task_id: "c", starts_at: "2026-11-09T14:30:00Z", ends_at: "2026-11-09T15:30:00Z" }, // 30 left
    { task_id: null, starts_at: "2026-11-09T20:00:00Z", ends_at: "2026-11-09T20:45:00Z" }, // a habit, 45
    { task_id: null, starts_at: "2026-11-09T12:00:00Z", ends_at: "2026-11-09T13:00:00Z" }, // over
    { task_id: null, proposed: true, starts_at: "2026-11-09T21:00:00Z", ends_at: "2026-11-09T22:00:00Z" },
  ];
  assert.equal(plannedLeft(tasks, blocks, now), 60 + 30 + 45);
  // Clipped to shutdown at 8:30 pm UTC: the habit block counts 30 of its 45 minutes.
  assert.equal(plannedLeft(tasks, blocks, now, Date.parse("2026-11-09T20:30:00Z")), 60 + 30 + 30);
  assert.equal(plannedLeft([], [], now), 0);
});

test("overCommit: only when planned is past the free time, which reads to a quarter hour", () => {
  assert.equal(overCommit(300, 360), null);
  assert.equal(overCommit(360, 360), null);
  assert.deepEqual(overCommit(540, 367), { planned: 540, free: 360 });
  assert.deepEqual(overCommit(30, 0), { planned: 30, free: 0 });
});
