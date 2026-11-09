// Estimate learning in Plan today (docs/sheet-focus.md, "Estimates against actuals"): the sample
// gate, the median over the newest rows, and the line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateLearning, learningLine, LEARN_MIN, LEARN_WINDOW } from "../src/sheet/estimate-learning.mjs";

const rows = (ratios, est = 60) => ratios.map((r, i) => ({ at: new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString(), kind: "other", est_min: est, minutes: Math.round(est * r) }));

test("nothing shows below the sample gate, and rows without an estimate don't count", () => {
  assert.equal(estimateLearning(rows(Array(LEARN_MIN - 1).fill(1.4))), null);
  assert.equal(estimateLearning([...rows(Array(LEARN_MIN - 1).fill(1.4)), { at: "2026-11-01T00:00:00Z", est_min: null, minutes: 30 }]), null);
  assert.equal(estimateLearning(null), null);
  assert.deepEqual(estimateLearning(rows(Array(LEARN_MIN).fill(1.4))), { pace: 1.4, n: LEARN_MIN });
});

test("the pace is the median over the newest rows, held to the pace limits", () => {
  // Old rows at 3x drop out of the window; the newest 30 run 1.2x.
  assert.deepEqual(estimateLearning([...rows(Array(10).fill(3)), ...rows(Array(LEARN_WINDOW).fill(1.2)).map((r, i) => ({ ...r, at: `2026-11-0${1 + (i % 8)}T1${i % 10}:00:00Z` }))]), { pace: 1.2, n: LEARN_WINDOW });
  assert.equal(estimateLearning(rows([1, 1, 1, 2, 2, 2, 2, 5, 5])).pace, 2);
  assert.equal(estimateLearning(rows(Array(9).fill(6))).pace, 3);
});

test("the line says the pace, how many tasks it rests on, and what today's estimates come to", () => {
  assert.equal(learningLine({ pace: 1.4, n: 12 }, 240), "You usually take 1.4× your estimates (median of your last 12 finished tasks). Today's 4h of estimates is about 5h35.");
  assert.equal(learningLine({ pace: 0.8, n: 9 }, 0), "You usually take 0.8× your estimates (median of your last 9 finished tasks).");
  assert.equal(learningLine({ pace: 1, n: 20 }, 120), "Your estimates have been about right (median of your last 20 finished tasks).");
  assert.equal(learningLine(null, 120), null);
});
