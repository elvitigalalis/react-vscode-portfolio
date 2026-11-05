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

test("windowStart: never later than 17:00, and on today never before now rounded up", async () => {
  const { windowStart } = await import("../src/sheet/sleep.mjs");
  const at6 = new Date("2026-11-04T11:00:00Z");
  assert.equal(windowStart("2026-11-04", at6, TZ, { weekday: 13 * 60, weekend: null, woke_at: null }), 13 * 60 + 30);
  assert.equal(windowStart("2026-11-04", at6, TZ, { weekday: 17 * 60, weekend: null, woke_at: null }), 17 * 60);
  assert.equal(windowStart("2026-11-04", at6, TZ, { weekday: null, weekend: null, woke_at: 16 * 60 + 50 }), 17 * 60);
  const at1007 = new Date("2026-11-04T15:07:00Z"); // 10:07 am, woke at 8:00
  assert.equal(windowStart("2026-11-04", at1007, TZ, { weekday: null, weekend: null, woke_at: 8 * 60 }), 10 * 60 + 15);
  const at1pm = new Date("2026-11-04T18:00:00Z");
  assert.equal(windowStart("2026-11-04", at1pm, TZ, { weekday: 13 * 60, weekend: null, woke_at: null }), 13 * 60 + 30);
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

// --- dayCap ----------------------------------------------------------------------------------

test("dayCap: readiness under 70 takes 0.8 of the cap, 85+ adds a tenth, rounded to 15 minutes", async () => {
  const { dayCap } = await import("../src/sheet/sleep.mjs");
  assert.deepEqual(dayCap(360, { readiness: 64, sleep_s: null }), { workload_cap_min: 285, break_after_min: 90, cap_reason: "readiness 64: lighter day" }); // 288
  assert.deepEqual(dayCap(360, { readiness: 88, sleep_s: 7 * 3600 }), { workload_cap_min: 390, break_after_min: 90, cap_reason: "readiness 88: fuller day" }); // 396
  assert.deepEqual(dayCap(360, { readiness: 70, sleep_s: 7 * 3600 }), { workload_cap_min: 360, break_after_min: 90, cap_reason: null });
  assert.equal(dayCap(360, { readiness: 84 }).workload_cap_min, 360);
  assert.equal(dayCap(360, { readiness: 85 }).workload_cap_min, 390);
  assert.equal(dayCap(360, { readiness: 69 }).workload_cap_min, 285);
});

test("dayCap: no Oura row, or one without numbers, keeps the cap", async () => {
  const { dayCap } = await import("../src/sheet/sleep.mjs");
  assert.deepEqual(dayCap(360, null), { workload_cap_min: 360, break_after_min: 90, cap_reason: null });
  assert.deepEqual(dayCap(270, { readiness: null, sleep_s: null }), { workload_cap_min: 270, break_after_min: 90, cap_reason: null });
});

test("dayCap: under 6 hours of sleep takes 0.85 and breaks after 60; the lower multiplier wins", async () => {
  const { dayCap } = await import("../src/sheet/sleep.mjs");
  const short = 5 * 3600 + 40 * 60;
  assert.deepEqual(dayCap(360, { readiness: null, sleep_s: short }), { workload_cap_min: 300, break_after_min: 60, cap_reason: "slept 5h40: lighter day" }); // 306
  assert.deepEqual(dayCap(360, { readiness: 90, sleep_s: short }), { workload_cap_min: 300, break_after_min: 60, cap_reason: "readiness 90, slept 5h40: lighter day" });
  assert.deepEqual(dayCap(360, { readiness: 64, sleep_s: short }), { workload_cap_min: 285, break_after_min: 60, cap_reason: "readiness 64, slept 5h40: lighter day" });
  assert.equal(dayCap(360, { sleep_s: 6 * 3600 }).break_after_min, 90); // 6 hours is enough
});

test("dayCap: a lower cap never drops below the work already approved", async () => {
  const { dayCap } = await import("../src/sheet/sleep.mjs");
  assert.equal(dayCap(360, { readiness: 50 }, 330).workload_cap_min, 330);
  assert.equal(dayCap(360, { readiness: 50 }, 400).workload_cap_min, 360); // never above the base cap for it
  assert.equal(dayCap(360, { readiness: 50 }, 100).workload_cap_min, 285);
});

// --- read_planner and submit_proposal (src/sheet/proposal.mjs) -------------------------------

const rows = (sleep, extra = {}) => ({
  settings: { time_zone: TZ }, tasks: [{ id: "t1", title: "OS homework", est_min: 45, day: "2026-11-04", done: false }],
  blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [], sleep, ...extra,
});
const week = [night("2026-11-02T09:30"), night("2026-11-03T09:50"), night("2026-10-30T09:40"),
  night("2026-10-31T11:00"), night("2026-11-01T10:40"), night("2026-10-25T10:50")];

test("planSnapshot: the window follows his wake", async () => {
  const { planSnapshot } = await import("../src/sheet/proposal.mjs");
  const at6 = new Date("2026-11-04T11:00:00Z"); // Wed 6:00 am, not up yet
  const snap = planSnapshot(rows(week, { sleepSynced: "2026-11-04T10:55:00Z" }), at6);
  assert.deepEqual(snap.window, { from: "10:15", to: "17:00" });
  // Up at 8:05 and synced: today's wake wins.
  const at815 = new Date("2026-11-04T13:15:00Z");
  const up = planSnapshot(rows([...week, night("2026-11-04T08:05")]), at815);
  assert.equal(up.window.from, "08:45");
  // No Oura: 07:00, as before.
  const none = planSnapshot(rows(undefined), at6);
  assert.equal(none.window.from, "07:00");
});

test("checkProposal: a block may start at the wake-based window start, not before", async () => {
  const { planSnapshot, checkProposal } = await import("../src/sheet/proposal.mjs");
  const snap = planSnapshot(rows(week), new Date("2026-11-04T11:00:00Z"));
  const paced = snap.tasks[0].paced_min;
  const submit = (start) => checkProposal({ day: "2026-11-04", replaces: null, blocks: [{ task_id: "t1", start, minutes: paced }] }, snap);
  assert.equal(submit("10:15").ok, true);
  const early = submit("09:00");
  assert.equal(early.ok, false);
  assert.match(early.errors.join("\n"), /blocks\[0\]: starts before 10:15/);
});

test("planSnapshot: today's readiness and sleep set day_rules; checkProposal holds a plan to them", async () => {
  const { planSnapshot, checkProposal } = await import("../src/sheet/proposal.mjs");
  const at6 = new Date("2026-11-04T11:00:00Z");
  const sleepDays = [{ day: "2026-11-04", readiness: 64, sleep_s: 5 * 3600 + 40 * 60 }, { day: "2026-11-03", readiness: 90, sleep_s: 8 * 3600 }];
  const snap = planSnapshot(rows([], { sleepDays }), at6);
  assert.deepEqual(snap.day_rules, { workload_cap_min: 285, travel_min: 10, break_after_min: 60, break_min: 10, cap_reason: "lighter day", bedtime: null, wind_down_from: null });
  const tasks = [{ id: "t1", title: "A", est_min: 45, day: "2026-11-04", done: false }, { id: "t2", title: "B", est_min: 45, day: "2026-11-04", done: false }];
  // Two 45-minute blocks back to back run 90 minutes: fine on a normal day, too long after a short night.
  const two = (s) => checkProposal({ day: "2026-11-04", replaces: null, blocks: [{ task_id: "t1", start: "08:00", minutes: 45 }, { task_id: "t2", start: "08:45", minutes: 45 }] }, s);
  assert.match(two(planSnapshot(rows([], { sleepDays, tasks }), at6)).errors.join("\n"), /break after every 60/);
  assert.equal(two(planSnapshot(rows([], { tasks }), at6)).ok, true);
});

// --- Settings → Oura's status line -----------------------------------------------------------

test("ouraStatus: when it last synced and his usual wake times", async () => {
  const { ouraStatus } = await import("../src/sheet/sleep.mjs");
  const now = new Date("2026-11-04T15:00:00Z");
  const profile = { weekday: 9 * 60 + 40, weekend: 10 * 60 + 50, woke_at: null };
  assert.equal(ouraStatus({ synced_at: "2026-11-04T14:55:00Z" }, profile, now), "Synced 5 min ago · usually up 9:40 am weekdays, 10:50 am weekends");
  assert.equal(ouraStatus({ synced_at: "2026-11-04T14:59:40Z" }, { ...profile, weekend: null }, now), "Synced just now · usually up 9:40 am weekdays");
  assert.equal(ouraStatus({ synced_at: "2026-11-04T12:00:00Z" }, { weekday: null, weekend: null }, now), "Synced 3 hours ago · a few more nights to learn when you wake");
  assert.equal(ouraStatus({ synced_at: null }, profile, now), "Not synced yet");
  assert.equal(ouraStatus(null, profile, now), "Not connected");
});

// Oura's API agreement §4(d) (docs/adr/0005-oura-data-never-reaches-claude.md): read_planner goes
// to Claude, so it carries only what code derives, never an Oura figure or field.
test("planSnapshot: no Oura-sourced field or figure reaches read_planner", async () => {
  const { planSnapshot } = await import("../src/sheet/proposal.mjs");
  const sleepDays = [{ day: "2026-11-04", readiness: 64, sleep_s: 5 * 3600 + 40 * 60, sleep_score: 71, hrv_avg: 38, rhr_low: 51 }];
  const sleepTimes = [{ day: "2026-11-05", start_offset: -3600, end_offset: 0 }];
  const snap = planSnapshot(rows([...week, night("2026-11-04T08:05")], {
    sleepDays, sleepTimes, sleepSynced: "2026-11-04T13:10:00Z",
    settings: { time_zone: TZ, wind_down_on: true, bedtime_target: "23:30:00", bedtime_ease: false },
  }), new Date("2026-11-04T13:15:00Z"));
  const keys = [];
  const walk = (v) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
  walk(snap);
  for (const k of ["sleep", "readiness", "sleep_s", "sleep_score", "hrv", "hrv_avg", "rhr_low", "bedtime_start", "bedtime_end", "woke_at",
    "typical_wake_weekday", "typical_wake_weekend", "last_synced", "start_offset", "end_offset"]) assert.ok(!keys.includes(k), k);
  const text = JSON.stringify(snap);
  assert.doesNotMatch(text, /readiness|slept|\b64\b|5h40|08:05|oura/i);
  // What it does carry: the derived window, cap and wind-down times.
  assert.equal(snap.window.from, "08:45");
  assert.equal(snap.day_rules.cap_reason, "lighter day");
  assert.equal(snap.day_rules.bedtime, "23:30");
});
