// The wake profile, the plan window's start and the woke-late decision (src/sheet/sleep.mjs),
// from Oura sleep_nights rows. Expected values are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeProfile } from "../src/sheet/sleep.mjs";

const TZ = "America/New_York";
// One night, `hours` long, ending at `wake`, "YYYY-MM-DDTHH:MM" local in New York: EDT (UTC-4)
// until daylight saving ends on Sunday 2026-11-01 at 2 am, EST (UTC-5) from then.
let n = 0;
const night = (wake, type = "long_sleep", hours = 8) => {
  const end = new Date(`${wake}:00${wake < "2026-11-01T02" ? "-04:00" : "-05:00"}`);
  return { oura_id: `n${++n}`, day: wake.slice(0, 10), type, bedtime_start: new Date(+end - hours * 3_600_000).toISOString(), bedtime_end: end.toISOString() };
};
// Wednesday 2026-11-04, 8:00 pm EST.
const NOW = new Date("2026-11-05T01:00:00Z");

test("wakeProfile: weekday and weekend medians apart; a weekend is a Saturday or Sunday wake", () => {
  const nights = [
    night("2026-11-02T09:30"), night("2026-11-03T09:50"), night("2026-11-04T09:40"), // Mon-Wed
    night("2026-10-31T11:00"), night("2026-11-01T10:40"), night("2026-10-25T10:50"), // Sat, Sun, Sun
  ];
  const p = wakeProfile(nights, NOW, TZ);
  assert.equal(p.weekday, 9 * 60 + 40);
  assert.equal(p.weekend, 10 * 60 + 50);
});

test("wakeProfile: fewer than 3 nights of a kind gives null for it", () => {
  const p = wakeProfile([night("2026-11-02T09:30"), night("2026-11-03T09:50"), night("2026-11-01T10:40")], NOW, TZ);
  assert.equal(p.weekday, null);
  assert.equal(p.weekend, null);
  assert.deepEqual(wakeProfile([], NOW, TZ), { weekday: null, weekend: null, woke_at: null, woke_at_iso: null });
});

test("wakeProfile: naps, rest and deleted periods never count; a day's long_sleep beats its nap", () => {
  const nights = [
    night("2026-11-02T09:30"), night("2026-11-03T09:50"), night("2026-11-04T09:40"),
    night("2026-11-04T15:00", "sleep", 1), // an afternoon nap
    night("2026-11-03T16:00", "late_nap", 2),
    night("2026-11-02T06:00", "rest", 8), // falsely detected, rejected
    night("2026-11-02T12:00", "deleted", 9),
  ];
  assert.equal(wakeProfile(nights, NOW, TZ).weekday, 9 * 60 + 40);
});

test("wakeProfile: a day with no long_sleep falls back to its longest sleep over 3 hours", () => {
  const nights = [
    night("2026-11-02T09:30", "sleep", 7), night("2026-11-02T13:00", "sleep", 1),
    night("2026-11-03T08:50", "sleep", 6),
    night("2026-11-04T10:10", "sleep", 3.5),
    night("2026-10-30T08:00", "sleep", 2), // a nap on a day with nothing longer: no wake that day
  ];
  assert.equal(wakeProfile(nights, NOW, TZ).weekday, 9 * 60 + 30); // 8:50, 9:30, 10:10
});

test("wakeProfile: two long sleeps ending the same morning take the later wake", () => {
  const nights = [night("2026-11-04T05:00", "long_sleep", 4), night("2026-11-04T09:40", "long_sleep", 4)];
  assert.equal(wakeProfile(nights, NOW, TZ).woke_at, 9 * 60 + 40);
});

test("wakeProfile: only the newest 14 nights of each kind count", () => {
  // 16 weekday wakes: the 2 oldest at 6:00, the 14 newest at 9:00 and 10:00 alternately.
  const days = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21",
    "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"];
  const nights = days.map((d, i) => night(`${d}T${i < 2 ? "06:00" : i % 2 ? "09:00" : "10:00"}`));
  assert.equal(wakeProfile(nights, NOW, TZ).weekday, 9 * 60 + 30); // 7 at 9:00, 7 at 10:00
});

test("wakeProfile: wake times are local wall-clock times across the daylight-saving change", () => {
  // 9:00 am EDT on Oct 28-30 (13:00Z) and 9:00 am EST on Nov 2-4 (14:00Z) are all 9:00.
  const nights = ["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04"].map((d) => night(`${d}T09:00`));
  assert.equal(new Set(nights.map((r) => r.bedtime_end.slice(11, 13))).size, 2);
  assert.equal(wakeProfile(nights, NOW, TZ).weekday, 9 * 60);
});

test("wakeProfile: today's wake is the main sleep ending today, local; nothing in the future", () => {
  const morning = new Date("2026-11-04T16:00:00Z"); // 11:00 am
  const nights = [night("2026-11-03T09:50"), night("2026-11-04T10:20"), night("2026-11-04T10:50", "sleep", 0.5)];
  const p = wakeProfile(nights, morning, TZ);
  assert.equal(p.woke_at, 10 * 60 + 20);
  assert.equal(p.woke_at_iso, "2026-11-04T15:20:00.000Z");
  // Before it synced, at 7 am, there is no wake yet today.
  assert.equal(wakeProfile(nights.slice(0, 1), new Date("2026-11-04T12:00:00Z"), TZ).woke_at, null);
  // Only a nap today: still no wake.
  assert.equal(wakeProfile([night("2026-11-04T10:20", "sleep", 1)], morning, TZ).woke_at, null);
});

// --- windowStart ---------------------------------------------------------------------------

test("windowStart: today's actual wake + 30, rounded up to the quarter hour", async () => {
  const { windowStart } = await import("../src/sheet/sleep.mjs");
  const at7 = new Date("2026-11-04T12:00:00Z"); // Wed 7:00 am
  const profile = { weekday: 9 * 60 + 40, weekend: 10 * 60 + 50, woke_at: 7 * 60 + 2 };
  assert.equal(windowStart("2026-11-04", at7, TZ, profile), 7 * 60 + 45); // 7:32 → 7:45
  assert.equal(windowStart("2026-11-04", at7, TZ, { ...profile, woke_at: 7 * 60 + 15 }), 7 * 60 + 45); // 7:45 stays
});

test("windowStart: no wake yet uses the day's kind's typical wake + 30, else 07:00", async () => {
  const { windowStart } = await import("../src/sheet/sleep.mjs");
  const at6 = new Date("2026-11-04T11:00:00Z"); // Wed 6:00 am
  const profile = { weekday: 9 * 60 + 40, weekend: 10 * 60 + 50, woke_at: null };
  assert.equal(windowStart("2026-11-04", at6, TZ, profile), 10 * 60 + 15); // 10:10 → 10:15
  assert.equal(windowStart("2026-11-07", at6, TZ, profile), 11 * 60 + 30); // Saturday: 11:20 → 11:30
  assert.equal(windowStart("2026-11-07", at6, TZ, { ...profile, weekend: null }), 7 * 60);
  assert.equal(windowStart("2026-11-05", at6, TZ, null), 7 * 60);
  // Today's wake is today's only: tomorrow still takes the typical wake.
  assert.equal(windowStart("2026-11-05", at6, TZ, { ...profile, woke_at: 6 * 60 }), 10 * 60 + 15);
});

test("windowStart: never later than 12:00, and on today never before now rounded up", async () => {
  const { windowStart } = await import("../src/sheet/sleep.mjs");
  const at6 = new Date("2026-11-04T11:00:00Z");
  assert.equal(windowStart("2026-11-04", at6, TZ, { weekday: 13 * 60, weekend: null, woke_at: null }), 12 * 60);
  assert.equal(windowStart("2026-11-04", at6, TZ, { weekday: null, weekend: null, woke_at: 11 * 60 + 50 }), 12 * 60);
  const at1007 = new Date("2026-11-04T15:07:00Z"); // 10:07 am, woke at 8:00
  assert.equal(windowStart("2026-11-04", at1007, TZ, { weekday: null, weekend: null, woke_at: 8 * 60 }), 10 * 60 + 15);
  const at1pm = new Date("2026-11-04T18:00:00Z");
  assert.equal(windowStart("2026-11-04", at1pm, TZ, { weekday: 13 * 60, weekend: null, woke_at: null }), 13 * 60);
  // An early riser's window can open before 07:00.
  assert.equal(windowStart("2026-11-05", at6, TZ, { weekday: 5 * 60 + 40, weekend: null, woke_at: null }), 6 * 60 + 15);
});

// --- wokeLate --------------------------------------------------------------------------------

test("wokeLate: a wake 45+ minutes after the window the newest pending or approved revision used", async () => {
  const { wokeLate } = await import("../src/sheet/sleep.mjs");
  const at11 = new Date("2026-11-04T16:00:00Z");
  const rev = (extra) => ({ day: "2026-11-04", status: "pending", window_from: "09:15", created_at: "2026-11-03T22:00:00Z", ...extra });
  const woke = (m) => ({ weekday: null, weekend: null, woke_at: m });
  assert.equal(wokeLate(woke(10 * 60), rev(), at11, TZ), true); // 45 minutes
  assert.equal(wokeLate(woke(9 * 60 + 59), rev(), at11, TZ), false);
  assert.equal(wokeLate(woke(10 * 60 + 20), rev({ status: "approved", window_from: "07:00" }), at11, TZ), true);
  assert.equal(wokeLate(woke(6 * 60), rev({ window_from: "07:00" }), at11, TZ), false); // early
});

test("wokeLate: nothing to replan without today's wake or a live revision for today", async () => {
  const { wokeLate } = await import("../src/sheet/sleep.mjs");
  const at11 = new Date("2026-11-04T16:00:00Z");
  const rev = { day: "2026-11-04", status: "pending", window_from: "07:00", created_at: "2026-11-03T22:00:00Z" };
  const woke = { weekday: null, weekend: null, woke_at: 10 * 60 + 20 };
  assert.equal(wokeLate({ ...woke, woke_at: null }, rev, at11, TZ), false);
  assert.equal(wokeLate(woke, null, at11, TZ), false); // the morning plan hasn't run: it will use the wake
  for (const status of ["skipped", "lapsed", "superseded"]) assert.equal(wokeLate(woke, { ...rev, status }, at11, TZ), false);
  assert.equal(wokeLate(woke, { ...rev, day: "2026-11-03" }, at11, TZ), false);
});

test("wokeLate: a revision from before window_from was stored planned from 07:00, or from when it was read today", async () => {
  const { wokeLate } = await import("../src/sheet/sleep.mjs");
  const at11 = new Date("2026-11-04T16:00:00Z");
  const woke = { weekday: null, weekend: null, woke_at: 9 * 60 + 50 };
  // Made last evening: it planned from 07:00.
  assert.equal(wokeLate(woke, { day: "2026-11-04", status: "pending", created_at: "2026-11-03T22:00:00Z" }, at11, TZ), true);
  // Read at 9:20 am today: it planned from 9:30.
  assert.equal(wokeLate(woke, { day: "2026-11-04", status: "pending", read_at: "2026-11-04T14:20:00Z", created_at: "2026-11-04T14:22:00Z" }, at11, TZ), false);
});
