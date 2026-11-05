// The tip picker (src/sheet/tips.mjs): the lowest contributors under 70, at most 2, none picked on
// the 2 days before, nothing when all are 70 or more. Made-up contributors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTips, tipContext, TIPS } from "../src/sheet/tips.mjs";

const D = "2026-11-04";
const row = (day, contributors) => ({ day, contributors });
const keys = (rows, day = D, ctx) => pickTips(rows, day, ctx).map((t) => t.key);

test("pickTips: the two lowest under 70, lowest first", () => {
  assert.deepEqual(keys([row(D, { timing: 41, latency: 60, restfulness: 55, efficiency: 90 })]), ["timing", "restfulness"]);
  assert.deepEqual(keys([row(D, { timing: 69, efficiency: 70 })]), ["timing"]);
});

test("pickTips: nothing when all are 70 or more, or without contributors", () => {
  assert.deepEqual(keys([row(D, { timing: 70, latency: 99, hrv_balance: 85 })]), []);
  assert.deepEqual(keys([]), []);
  assert.deepEqual(keys([row(D, null)]), []);
});

test("pickTips: a tip picked either of the 2 days before is skipped for the next lowest", () => {
  const rows = [
    row("2026-11-02", { timing: 40 }),
    row("2026-11-03", { latency: 50 }),
    row(D, { timing: 30, latency: 45, restfulness: 60, sleep_balance: 65 }),
  ];
  assert.deepEqual(keys(rows), ["restfulness", "sleep_balance"]);
  // Three days on, it may come back.
  assert.deepEqual(keys([row("2026-11-01", { timing: 40 }), row(D, { timing: 30 })]), ["timing"]);
  // Picked Nov 2, held Nov 3 and 4, back Nov 5.
  const low3 = ["2026-11-02", "2026-11-03", D, "2026-11-05"].map((d) => row(d, { timing: 40 }));
  assert.deepEqual(keys(low3), []);
  assert.deepEqual(keys(low3, "2026-11-05"), ["timing"]);
});

test("pickTips: personal times in the words, and the source beside each", () => {
  const bed = { minutes: 1575, wind_down: 1515, source: "easing", target: 1470 };
  const ctx = tipContext(bed, "17:00:00");
  assert.deepEqual(ctx, { bed: "2:15 am", windDown: "1:15 am", target: "12:30 am", gym: "5:00 pm" });
  const [timing, latency] = pickTips([row(D, { timing: 41, latency: 50 })], D, ctx);
  assert.equal(timing.text, "Go to bed within 30 minutes of the same time each night; your bedtime is easing toward 12:30 am.");
  assert.equal(latency.text, "Screens off and lights dim for the last hour: your wind-down starts at 1:15 am.");
  assert.match(timing.source, /^https:\/\/support\.ouraring\.com\//);
  assert.equal(pickTips([row(D, { recovery_index: 20 })], D, ctx)[0].text, "Finish your last meal and workout 3+ hours before bed (gym at 5:00 pm, bed at 2:15 am).");
  // Without his times, the plain tip.
  assert.equal(pickTips([row(D, { timing: 41 })], D, tipContext(null))[0].text, "Go to bed within 30 minutes of the same time each night.");
  for (const t of Object.values(TIPS)) assert.ok(t.source.startsWith("https://support.ouraring.com/hc/en-us/articles/"));
});
