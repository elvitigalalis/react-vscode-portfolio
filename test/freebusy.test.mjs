// busyChange (src/sheet/freebusy.mjs), beyond the verification tests in
// test/v5-busy.verify.test.mjs: the one `changes` row a busy sync writes (docs/sheet-v5.md,
// "freebusy.mjs"). Wednesday 2026-11-04 in New York, EST (UTC-5); the sync runs at 10:02 am.
import { test } from "node:test";
import assert from "node:assert/strict";
import { busyChange, busySaved } from "../src/sheet/freebusy.mjs";

const TZ = "America/New_York";
const now = new Date("2026-11-04T15:02:00Z");
const span = (starts_at, ends_at) => ({ starts_at, ends_at });
const lecture = span("2026-11-04T19:00:00.000Z", "2026-11-04T20:20:00.000Z"); // 2:00-3:20 pm
const block = { starts_at: "2026-11-04T20:00:00.000Z", ends_at: "2026-11-04T21:00:00.000Z" }; // 3-4 pm

test("busyChange: the same spans, in any order, are no change", () => {
  const a = span("2026-11-05T19:00:00.000Z", "2026-11-05T20:00:00.000Z");
  assert.equal(busyChange([lecture, a], [a, lecture], [block], now, TZ), null);
  assert.equal(busyChange([], [], [], now, TZ), null);
});

test("busyChange: a new busy time on a block today is busy_overlap, weight 10", () => {
  assert.deepEqual(busyChange([], [lecture], [block], now, TZ), { kind: "busy", reason: "busy_overlap", weight: 10, ref: "2026-11-04T19:00:00.000Z/2026-11-04T20:20:00.000Z" });
});

test("busyChange: a block already over, or on another day, doesn't count as overlapped", () => {
  const past = { starts_at: "2026-11-04T14:00:00.000Z", ends_at: "2026-11-04T15:00:00.000Z" };
  const early = span("2026-11-04T14:30:00.000Z", "2026-11-04T15:30:00.000Z");
  assert.equal(busyChange([], [early], [past], now, TZ).reason, "busy_change");
  const thursday = { starts_at: "2026-11-05T20:00:00.000Z", ends_at: "2026-11-05T21:00:00.000Z" };
  assert.equal(busyChange([], [span("2026-11-05T19:00:00.000Z", "2026-11-05T20:20:00.000Z")], [thursday], now, TZ), null);
  // A span that was already there isn't new, even over a block.
  const other = span("2026-11-04T16:00:00.000Z", "2026-11-04T17:00:00.000Z");
  assert.equal(busyChange([lecture], [lecture, other], [block], now, TZ).reason, "busy_change");
});

test("busyChange: an hour or more freed before midnight is time_freed, weight 4", () => {
  // 2:00-3:20 pm (80 minutes) goes; 80 >= 60.
  assert.deepEqual(busyChange([lecture], [], [block], now, TZ), { kind: "busy", reason: "time_freed", weight: 4, ref: null });
  // 2:00-3:20 pm shortened to 2:00-2:30 pm frees 50 minutes: not enough.
  assert.equal(busyChange([lecture], [span("2026-11-04T19:00:00.000Z", "2026-11-04T19:30:00.000Z")], [], now, TZ).reason, "busy_change");
  // Only time from now on counts: 9:00-10:30 am going frees 28 minutes from 10:02.
  assert.equal(busyChange([span("2026-11-04T14:00:00.000Z", "2026-11-04T15:30:00.000Z")], [], [], now, TZ).reason, "busy_change");
  // Overlapping spans count once: two copies of 2:00-3:20 pm, one going, changes no busy time.
  const twin = span("2026-11-04T19:00:00.000Z", "2026-11-04T20:10:00.000Z");
  assert.equal(busyChange([lecture, twin], [lecture], [], now, TZ), null);
  // Tomorrow's time doesn't count: freeing Thursday's 2 hours can't change today's plan.
  assert.equal(busyChange([span("2026-11-05T15:00:00.000Z", "2026-11-05T17:00:00.000Z")], [], [], now, TZ), null);
});

// --- False positives: free/busy answers only for now to 7 days ahead, cut to that range ---------

test("busyChange: an event in progress, its start cut to now by Google, is no change", () => {
  const whole = span("2026-11-04T14:30:00.000Z", "2026-11-04T16:00:00.000Z"); // 9:30-11:00 am
  const cut = span(now.toISOString(), "2026-11-04T16:00:00.000Z");
  const on = { starts_at: "2026-11-04T15:30:00.000Z", ends_at: "2026-11-04T16:30:00.000Z" };
  assert.equal(busyChange([whole], [cut], [on], now, TZ), null);
  const earlier = span("2026-11-04T14:52:00.000Z", "2026-11-04T16:00:00.000Z"); // cut by the last sync
  assert.equal(busyChange([earlier], [cut], [on], now, TZ), null);
});

test("busyChange: an event entering the 7-day range, its end cut to the range, is no change", () => {
  // A class at 10:00 am next Wednesday, first seen at the 10:01 sync and again at 10:02.
  const thisSync = span("2026-11-11T15:00:00.000Z", "2026-11-11T15:02:00.000Z");
  assert.equal(busyChange([], [thisSync], [block], now, TZ), null);
  assert.equal(busyChange([span(thisSync.starts_at, "2026-11-11T15:01:00.000Z")], [thisSync], [block], now, TZ), null);
});

test("busyChange: a busy time that grows onto a block is busy_overlap; one that doesn't reach it isn't", () => {
  const short = span("2026-11-04T19:00:00.000Z", "2026-11-04T19:30:00.000Z");
  assert.equal(busyChange([short], [lecture], [block], now, TZ).reason, "busy_overlap");
  assert.equal(busyChange([short], [span(short.starts_at, "2026-11-04T19:40:00.000Z")], [block], now, TZ).reason, "busy_change");
});

// --- The rest of today's plan window: now to the shutdown line ----------------------------------

test("busyChange: only now to the shutdown line counts as a change", () => {
  const evening = span("2026-11-04T23:00:00.000Z", "2026-11-05T00:30:00.000Z"); // 6:00-7:30 pm
  // Shutdown at 5:00 pm: the evening is outside the plan's window, added or freed.
  assert.equal(busyChange([], [evening], [], now, TZ, "17:00"), null);
  assert.equal(busyChange([evening], [], [], now, TZ, "17:00"), null);
  // Shutdown at 8:00 pm: inside it.
  assert.equal(busyChange([], [evening], [], now, TZ, "20:00").reason, "busy_change");
  assert.equal(busyChange([evening], [], [], now, TZ, "20:00").reason, "time_freed");
  // Past the line nothing is left of the window.
  assert.equal(busyChange([lecture], [], [], now, TZ, "09:00"), null);
});

// --- busySaved, Settings' "Busy times saved 4 min ago" ----------------------------------------

test("busySaved: how long ago busy times were saved, from busy_as_of", () => {
  assert.equal(busySaved(null, now), "Busy times not saved yet");
  assert.equal(busySaved("2026-11-04T15:01:40.000Z", now), "Busy times saved just now");
  assert.equal(busySaved("2026-11-04T14:58:00.000Z", now), "Busy times saved 4 min ago");
  assert.equal(busySaved("2026-11-04T14:02:30.000Z", now), "Busy times saved 59 min ago");
  assert.equal(busySaved("2026-11-04T14:02:00.000Z", now), "Busy times saved 1 hour ago");
  assert.equal(busySaved("2026-11-04T05:00:00.000Z", now), "Busy times saved 10 hours ago");
  assert.equal(busySaved("2026-11-01T15:00:00.000Z", now), "Busy times saved 3 days ago");
});

test("busyChange: busy_overlap's ref is the new busy time's span, for the replan message", () => {
  const out = busyChange([], [lecture], [block], now, TZ);
  assert.equal(out.ref, `${new Date(lecture.starts_at).toISOString()}/${new Date(lecture.ends_at).toISOString()}`);
});
