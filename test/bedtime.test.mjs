// Tonight's bedtime (src/sheet/bedtime.mjs): a set target, eased in from his typical bedtime, or
// Oura's optimal window. A night is the evening of its day: a bedtime from noon to noon belongs to
// it, so 00:30 and 02:00 are minutes 1470 and 1560 of the night before. Expected values by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bedtimeFor, bedtimeMarker, bedtimeStatus, shutdownFor, nightAt, nightOf, ouraWindow, ouraWindowLine, typicalBedtime } from "../src/sheet/bedtime.mjs";

const TZ = "America/New_York";
// A long_sleep that starts at `start`, "YYYY-MM-DDTHH:MM" local in New York (EDT, UTC-4, until
// 2 am on Sunday 2026-11-01; EST, UTC-5, from then), 8 hours long.
let n = 0;
const sleepAt = (start, type = "long_sleep") => {
  const s = new Date(`${start}:00${start < "2026-11-01T01" ? "-04:00" : "-05:00"}`);
  return { oura_id: `s${++n}`, day: start.slice(0, 10), type, bedtime_start: s.toISOString(), bedtime_end: new Date(+s + 8 * 3_600_000).toISOString() };
};
// His last week: asleep at 3:00-4:00 am, so a median of 3:30 am (night minutes 1650).
const week = ["2026-10-29T03:00", "2026-10-30T03:30", "2026-10-31T04:00", "2026-11-02T03:30", "2026-11-03T03:15", "2026-11-04T03:45", "2026-11-05T03:30"].map((s) => sleepAt(s));
const settings = (extra) => ({ wind_down_on: true, bedtime_target: "00:30:00", bedtime_ease: true, bedtime_set_on: "2026-11-05", ...extra });

test("nightOf: a time after noon is that day's night; one before noon is the night before", () => {
  assert.deepEqual(nightOf(new Date("2026-11-05T04:30:00Z"), TZ), { night: "2026-11-04", minutes: 1410 }); // 11:30 pm Wed
  assert.deepEqual(nightOf(new Date("2026-11-05T05:30:00Z"), TZ), { night: "2026-11-04", minutes: 1470 }); // 00:30 Thu
  assert.deepEqual(nightOf(new Date("2026-11-05T07:00:00Z"), TZ), { night: "2026-11-04", minutes: 1560 }); // 02:00 Thu
  assert.deepEqual(nightOf(new Date("2026-11-05T17:00:00Z"), TZ), { night: "2026-11-05", minutes: 720 }); // noon Thu
  // DST ends at 2 am on Sun Nov 1: 06:30Z is 1:30 am EST, still Saturday's night.
  assert.deepEqual(nightOf(new Date("2026-11-01T06:30:00Z"), TZ), { night: "2026-10-31", minutes: 1530 });
});

test("nightAt: night minutes back to an instant, across midnight and DST", () => {
  assert.equal(nightAt("2026-11-04", 1470, TZ), "2026-11-05T05:30:00.000Z");
  assert.equal(nightAt("2026-11-04", 1410, TZ), "2026-11-05T04:30:00.000Z");
  // Saturday Oct 31's 3:00 am is on Sunday, after the clocks went back: EST.
  assert.equal(nightAt("2026-10-31", 1620, TZ), "2026-11-01T08:00:00.000Z");
  // Spring forward (Sun Mar 8 2026): 11:00 pm Saturday is still EST.
  assert.equal(nightAt("2026-03-07", 1380, TZ), "2026-03-08T04:00:00.000Z");
});

test("typicalBedtime: the median of the newest 7 long sleeps' starts, before a night if given", () => {
  assert.equal(typicalBedtime(week, TZ), 1650);
  // Naps and rest don't count.
  assert.equal(typicalBedtime([...week, sleepAt("2026-11-05T15:00", "late_nap")], TZ), 1650);
  // Before Nov 2's night: Oct 28-31's nights (Oct 29 3:00, Oct 30 3:30, Oct 31 4:00 starts).
  assert.equal(typicalBedtime(week, TZ, "2026-11-01"), 1650);
  assert.equal(typicalBedtime(week.slice(0, 2), TZ), null); // fewer than 3
});

test("bedtimeFor: no target and no Oura window is no bedtime; wind-down off is none either", () => {
  assert.equal(bedtimeFor("2026-11-05", { settings: settings({ bedtime_target: null }), sleep: week, sleepTimes: [], tz: TZ }), null);
  assert.equal(bedtimeFor("2026-11-05", { settings: settings({ wind_down_on: false }), sleep: week, sleepTimes: [], tz: TZ }), null);
});

test("bedtimeFor: the target as it is with Ease in off", () => {
  const b = bedtimeFor("2026-11-05", { settings: settings({ bedtime_ease: false }), sleep: week, sleepTimes: [], tz: TZ });
  assert.deepEqual(b, { minutes: 1470, wind_down: 1410, source: "target", target: 1470 });
});

test("bedtimeFor: Ease in starts 15 minutes before his typical bedtime and steps 15 earlier a night", () => {
  const on = (night) => bedtimeFor(night, { settings: settings(), sleep: week, sleepTimes: [], tz: TZ })?.minutes;
  assert.equal(on("2026-11-05"), 1635); // set tonight: 3:30 - 0:15 = 3:15 am
  assert.equal(on("2026-11-06"), 1620); // 3:00 am
  assert.equal(on("2026-11-12"), 1530); // a week on: 1:30 am
  // 12 nights to 12:30 am, then it stays at the target.
  assert.equal(on("2026-11-16"), 1470);
  assert.equal(on("2026-12-20"), 1470);
  // The start is fixed by the nights before he set it: better nights since don't speed it up.
  const better = [...week, sleepAt("2026-11-06T00:30"), sleepAt("2026-11-07T00:40"), sleepAt("2026-11-08T00:35")];
  assert.equal(bedtimeFor("2026-11-08", { settings: settings(), sleep: better, sleepTimes: [], tz: TZ }).minutes, 1590);
  assert.equal(bedtimeFor("2026-11-08", { settings: settings(), sleep: better, sleepTimes: [], tz: TZ }).source, "easing");
});

test("bedtimeFor: easing with a typical bedtime already at or before the target is the target", () => {
  const early = ["2026-10-30T23:00", "2026-10-31T23:30", "2026-11-02T00:00"].map((s) => sleepAt(s));
  assert.deepEqual(bedtimeFor("2026-11-05", { settings: settings(), sleep: early, sleepTimes: [], tz: TZ }), { minutes: 1470, wind_down: 1410, source: "target", target: 1470 });
  // Without enough nights to know his typical bedtime, the target too.
  assert.equal(bedtimeFor("2026-11-05", { settings: settings(), sleep: [], sleepTimes: [], tz: TZ }).minutes, 1470);
});

test("bedtimeFor: a target before noon or after noon both read as the evening's", () => {
  assert.equal(bedtimeFor("2026-11-05", { settings: settings({ bedtime_ease: false, bedtime_target: "23:15:00" }), sleep: [], sleepTimes: [], tz: TZ }).minutes, 1395);
  assert.equal(bedtimeFor("2026-11-05", { settings: settings({ bedtime_ease: false, bedtime_target: "02:00" }), sleep: [], sleepTimes: [], tz: TZ }).minutes, 1560);
});

test("bedtimeFor: without a target, Oura's optimal window start, from its newest row up to the next day", () => {
  const sleepTimes = [
    { day: "2026-11-04", start_offset: -3600, end_offset: 0 }, // 11 pm
    { day: "2026-11-06", start_offset: 1800, end_offset: 5400 }, // 00:30
    { day: "2026-11-08", start_offset: -1800, end_offset: 1800 }, // later: not for Nov 5's night
  ];
  const b = bedtimeFor("2026-11-05", { settings: settings({ bedtime_target: null }), sleep: week, sleepTimes, tz: TZ });
  assert.deepEqual(b, { minutes: 1470, wind_down: 1410, source: "oura", target: null });
  assert.equal(bedtimeFor("2026-11-04", { settings: settings({ bedtime_target: null }), sleep: [], sleepTimes, tz: TZ }).minutes, 1380);
});

test("bedtimeStatus: Settings' line for tonight", () => {
  const s = settings();
  assert.equal(bedtimeStatus({ minutes: 1575, wind_down: 1515, source: "easing", target: 1470 }), "Tonight: bed 2:15 am, easing 15 min earlier a night toward 12:30 am");
  assert.equal(bedtimeStatus({ minutes: 1470, wind_down: 1410, source: "target", target: 1470 }), "Tonight: bed 12:30 am, wind down from 11:30 pm");
  assert.equal(bedtimeStatus({ minutes: 1380, wind_down: 1320, source: "oura", target: null }), "Tonight: bed 11:00 pm, Oura's suggested bedtime");
  assert.equal(bedtimeStatus(null, s), "No bedtime tonight");
  assert.equal(bedtimeStatus(null, { ...s, wind_down_on: false }), "Wind-down is off");
  assert.equal(bedtimeStatus(null, { ...s, bedtime_target: null }), "No bedtime set, and Oura hasn't suggested one yet");
});

test("ouraWindow: Oura's window and hint for a night, in words", () => {
  const rows = [{ day: "2026-11-05", start_offset: 900, end_offset: 2700, hint: "earlier_bedtime" }];
  const w = ouraWindow("2026-11-04", rows);
  assert.deepEqual(w, { start: 1455, end: 1485, hint: "earlier_bedtime" });
  assert.equal(ouraWindowLine(w), "Oura: 12:15–12:45 am, earlier bedtime");
  assert.equal(ouraWindowLine({ start: 1410, end: 1470, hint: null }), "Oura: 11:30 pm–12:30 am");
  assert.equal(ouraWindowLine(null), null);
  const b = { minutes: 1575, wind_down: 1515, source: "easing", target: 1470 };
  assert.equal(bedtimeMarker(b, w), "Wind down 1:15 am · Bed 2:15 am · Oura: 12:15–12:45 am, earlier bedtime");
  assert.equal(bedtimeMarker(b), "Wind down 1:15 am · Bed 2:15 am");
});

test("shutdownFor: the line he set for the day wins; else wind-down's start, from 5 pm to 11 pm; else 5 pm", () => {
  const at = (s, line = null, sleepTimes = []) => shutdownFor("2026-11-05", { line, settings: s, sleep: week, sleepTimes, tz: TZ });
  // Bed 12:30 am: wind-down from 11:30 pm, capped at 11 pm.
  assert.equal(at(settings({ bedtime_ease: false })), "23:00");
  // Bed 10:00 pm: wind-down from 9:00 pm.
  assert.equal(at(settings({ bedtime_ease: false, bedtime_target: "22:00:00" })), "21:00");
  // Bed 5:30 pm: never earlier than 5 pm.
  assert.equal(at(settings({ bedtime_ease: false, bedtime_target: "17:30:00" })), "17:00");
  // Oura's window when no target is set: bed 11 pm, so 10 pm.
  assert.equal(at(settings({ bedtime_target: null }), null, [{ day: "2026-11-05", start_offset: -3600, end_offset: 0 }]), "22:00");
  // No bedtime, or wind-down off: the old 5 pm.
  assert.equal(at(settings({ bedtime_target: null })), "17:00");
  assert.equal(at(settings({ wind_down_on: false })), "17:00");
  assert.equal(at(null), "17:00");
  // A line moved by hand.
  assert.equal(at(settings({ bedtime_ease: false }), "18:30:00"), "18:30");
});
