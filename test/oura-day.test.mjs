// A day's Oura numbers on /plan (src/sheet/oura-day.mjs): bands, formatting, the chips and the
// dialog's rows, and sparklines. Made-up numbers; expected values by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { band, bedWake, chipsLabel, dayChips, dayMetrics, hm, sparkPath } from "../src/sheet/oura-day.mjs";

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
