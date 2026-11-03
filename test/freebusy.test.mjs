// busyChange (src/sheet/freebusy.mjs), beyond the verification tests in
// test/v5-busy.verify.test.mjs: the one `changes` row a busy sync writes (docs/sheet-v5.md,
// "freebusy.mjs"). Wednesday 2026-11-04 in New York, EST (UTC-5); the sync runs at 10:02 am.
import { test } from "node:test";
import assert from "node:assert/strict";
import { busyChange } from "../src/sheet/freebusy.mjs";

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
  assert.deepEqual(busyChange([], [lecture], [block], now, TZ), { kind: "busy", reason: "busy_overlap", weight: 10, ref: null });
});

test("busyChange: a block already over, or on another day, doesn't count as overlapped", () => {
  const past = { starts_at: "2026-11-04T14:00:00.000Z", ends_at: "2026-11-04T15:00:00.000Z" };
  const early = span("2026-11-04T14:30:00.000Z", "2026-11-04T15:30:00.000Z");
  assert.equal(busyChange([], [early], [past], now, TZ).reason, "busy_change");
  const thursday = { starts_at: "2026-11-05T20:00:00.000Z", ends_at: "2026-11-05T21:00:00.000Z" };
  assert.equal(busyChange([], [span("2026-11-05T19:00:00.000Z", "2026-11-05T20:20:00.000Z")], [thursday], now, TZ).reason, "busy_change");
  // A span that was already there isn't new, even over a block.
  const other = span("2026-11-06T15:00:00.000Z", "2026-11-06T16:00:00.000Z");
  assert.equal(busyChange([lecture], [lecture, other], [block], now, TZ).reason, "busy_change");
});

test("busyChange: an hour or more freed before midnight is time_freed, weight 4", () => {
  // 2:00-3:20 pm (80 minutes) goes; 80 >= 60.
  assert.deepEqual(busyChange([lecture], [], [block], now, TZ), { kind: "busy", reason: "time_freed", weight: 4, ref: null });
  // 2:00-3:20 pm shortened to 2:00-2:30 pm frees 50 minutes: not enough.
  assert.equal(busyChange([lecture], [span("2026-11-04T19:00:00.000Z", "2026-11-04T19:30:00.000Z")], [], now, TZ).reason, "busy_change");
  // Only time from now on counts: 9:00-10:30 am going frees 28 minutes from 10:02.
  assert.equal(busyChange([span("2026-11-04T14:00:00.000Z", "2026-11-04T15:30:00.000Z")], [], [], now, TZ).reason, "busy_change");
  // Overlapping spans count once: two copies of 2:00-3:20 pm, one going, frees nothing.
  const twin = span("2026-11-04T19:00:00.000Z", "2026-11-04T20:10:00.000Z");
  assert.equal(busyChange([lecture, twin], [lecture], [], now, TZ).reason, "busy_change");
  // Tomorrow's time doesn't count: freeing Thursday's 2 hours is a plain change.
  assert.equal(busyChange([span("2026-11-05T15:00:00.000Z", "2026-11-05T17:00:00.000Z")], [], [], now, TZ).reason, "busy_change");
});
