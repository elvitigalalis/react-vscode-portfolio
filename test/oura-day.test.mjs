// A day's Oura numbers on /plan (src/sheet/oura-day.mjs): bands, formatting, the chips and the
// dialog's rows, and sparklines. Made-up numbers; expected values by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { band, bedWake, chipsLabel, dayChips, dayMetrics, hm, lateNap, sleepStrip, sparkPath, spreadLine, stripLayout } from "../src/sheet/oura-day.mjs";

const TZ = "America/New_York";
const row = (day, extra = {}) => ({ day, readiness: 86, sleep_s: 27600, sleep_score: 82, efficiency: 91, deep_s: 4800, rem_s: 6030, rhr_low: 48, rhr_avg: 54, hrv_avg: 41, temp_dev: -0.23, activity_score: 77, steps: 8412, stress: "restored", ...extra });

test("band: Oura's own, 85+ optimal, 70-84 good, under 70 pay attention", () => {
  assert.deepEqual(band(85), { key: "optimal", word: "optimal" });
  assert.deepEqual(band(84), { key: "good", word: "good" });
  assert.deepEqual(band(70), { key: "good", word: "good" });
  assert.deepEqual(band(69), { key: "attention", word: "pay attention" });
  assert.equal(band(null), null);
});

test("hm: hours and minutes", () => {
  assert.equal(hm(27600), "7h 40m");
  assert.equal(hm(25200), "7h 00m");
  assert.equal(hm(2700), "45m");
  assert.equal(hm(null), null);
});

test("dayChips: sleep score, readiness and total, with accessible names; missing ones left out", () => {
  const chips = dayChips(row("2026-11-04", { readiness: 64 }));
  assert.deepEqual(chips.map((c) => [c.text, c.band, c.label]), [
    ["82", "good", "Sleep score 82, good"],
    ["64", "attention", "Readiness 64, pay attention"],
    ["7h 40m", null, "Total sleep 7h 40m"],
  ]);
  assert.deepEqual(dayChips(row("2026-11-04", { sleep_score: null, readiness: null })).map((c) => c.key), ["total"]);
  assert.deepEqual(dayChips(null), []);
  assert.equal(chipsLabel(chips.slice(0, 1), "Wed Nov 4"), "Oura for Wed Nov 4: Sleep score 82, good. Open details");
});

test("bedWake: the wake day's main sleep, local times", () => {
  const nights = [
    { type: "long_sleep", bedtime_start: "2026-11-04T06:10:00Z", bedtime_end: "2026-11-04T14:40:00Z" }, // 1:10-9:40 am EST
    { type: "late_nap", bedtime_start: "2026-11-04T20:00:00Z", bedtime_end: "2026-11-04T20:30:00Z" },
  ];
  assert.equal(bedWake(nights, "2026-11-04", TZ), "1:10 am → 9:40 am");
  assert.equal(bedWake(nights, "2026-11-03", TZ), null);
});

test("dayMetrics: the full set with one-word labels, formatted, and 7 days of sparkline", () => {
  const rows = [row("2026-10-29", { sleep_score: 70 }), row("2026-11-03", { sleep_score: 90, steps: null }), row("2026-11-04")];
  const m = dayMetrics("2026-11-04", rows, [], TZ);
  assert.deepEqual(m.map((x) => [x.label, x.value]), [
    ["Sleep", "82"], ["Readiness", "86"], ["Total", "7h 40m"], ["Efficiency", "91%"], ["Deep", "1h 20m"], ["REM", "1h 41m"],
    ["Bedtime", "–"], ["Resting HR", "48 bpm"], ["HRV", "41 ms"], ["Temperature", "−0.2 °C"], ["Activity", "77"], ["Steps", "8,412"], ["Stress", "Restored"],
  ]);
  assert.deepEqual(m[0].spark, [70, null, null, null, null, 90, 82]);
  assert.equal(m[0].aria, "Sleep 82, good");
  assert.equal(m[0].band, "good");
  assert.equal(m[12].spark, null);
  assert.equal(dayMetrics("2026-11-02", rows, [], TZ)[11].aria, "Steps: none");
});

test("sparkPath: a line scaled to the box, broken at gaps; nothing with under 2 points", () => {
  assert.equal(sparkPath([1, 3], 10, 6), "M1 5L9 1");
  assert.equal(sparkPath([1, null, 3], 10, 6), "M1 5M9 1");
  assert.equal(sparkPath([2, 2, 2], 10, 6), "M1 3L5 3L9 3");
  assert.equal(sparkPath([null, 4, null]), "");
});

// A main sleep from `bed` (the night before `wake`'s day, or past midnight) to `wake`, EST.
const main = (wakeDay, bed, wake) => {
  const prev = new Date(Date.parse(`${wakeDay}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const start = bed >= "12:00" ? `${prev}T${bed}:00-05:00` : `${wakeDay}T${bed}:00-05:00`;
  return { type: "long_sleep", bedtime_start: new Date(start).toISOString(), bedtime_end: new Date(`${wakeDay}T${wake}:00-05:00`).toISOString() };
};

test("lateNap: a late_nap ending today after 6 pm, in words", () => {
  const nap = { type: "late_nap", bedtime_start: "2026-11-04T22:10:00Z", bedtime_end: "2026-11-04T23:20:00Z" }; // 5:10-6:20 pm
  assert.equal(lateNap([nap], "2026-11-04", TZ), "late nap 5:10–6:20 pm");
  assert.equal(lateNap([{ ...nap, type: "sleep" }], "2026-11-04", TZ), null);
  assert.equal(lateNap([nap], "2026-11-05", TZ), null);
});

test("sleepStrip: 7 nights of bed and wake, and how much each varied", () => {
  const nights = [main("2026-11-02", "02:00", "10:00"), main("2026-11-03", "03:00", "11:00"), main("2026-11-04", "23:30", "08:30")];
  const s = sleepStrip(nights, "2026-11-04", TZ);
  assert.equal(s.rows.length, 7);
  assert.deepEqual(s.rows.slice(4), [
    { day: "2026-11-02", label: "M", bed: 1560, wake: 2040 },
    { day: "2026-11-03", label: "T", bed: 1620, wake: 2100 },
    { day: "2026-11-04", label: "W", bed: 1410, wake: 1950 },
  ]);
  assert.equal(s.rows[0].bed, null);
  // bed 1560, 1620, 1410: mean 1530, sd sqrt((900+8100+14400)/3) = 88; wake 2040, 2100, 1950: sd 62.
  assert.deepEqual(s.spread, { bed: 88, wake: 62 });
  assert.equal(spreadLine(s.spread), "Bedtime ±1h 28m · Wake ±1h 02m");
  assert.equal(spreadLine({ bed: 42, wake: 15 }), "Bedtime ±42 min · Wake ±15 min");
  assert.equal(spreadLine({ bed: null, wake: null }), null);
});

test("stripLayout: bars on an hour-cut axis with the target line", () => {
  const s = sleepStrip([main("2026-11-04", "00:00", "08:00")], "2026-11-04", TZ);
  // Axis 11 pm (1380) to 9 am (1980): 600 minutes over 264 units from x = 16.
  const l = stripLayout(s, 1440, 280);
  assert.deepEqual(l.rows[6], { y: 72, label: "W", x1: 42.4, x2: 253.6 });
  assert.equal(l.target, 42.4);
  assert.deepEqual(l.ticks.map((t) => t.label), ["12 am", "2 am", "4 am", "6 am", "8 am"]);
  assert.equal(stripLayout(sleepStrip([], "2026-11-04", TZ), null), null);
});
