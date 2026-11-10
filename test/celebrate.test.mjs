// Checking off on /plan (src/sheet/celebrate.mjs, docs/sheet.md "Completion"): when a ✓ gets the
// burst or a big moment, and that the motion stays behind prefers-reduced-motion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldBurst, firstToday, firstOfDay, inside, STUBBORN_ROLLS, isAssignment, isDayCleared, momentOf, specks, STREAK_MS, MOMENT_WORDS, capped, LATE, wait, ANIM_MS, SAVE_MS, once } from "../src/sheet/celebrate.mjs";

const T = (id, day, extra = {}) => ({ id, day, done: false, source: null, ...extra });

test("the burst comes on the third ✓ within ten minutes", () => {
  const now = 1_000_000_000;
  assert.equal(shouldBurst([], now), false);
  assert.equal(shouldBurst([now - 60_000], now), false);
  assert.equal(shouldBurst([now - 120_000, now - 60_000], now), true);
  // Older ones don't count toward the streak.
  assert.equal(shouldBurst([now - STREAK_MS - 1, now - 60_000], now), false);
});

test("otherwise only a ✓ that means something bursts, never by chance", () => {
  for (let i = 0; i < 50; i++) assert.equal(shouldBurst([], i), false);
  assert.equal(shouldBurst([], 0, { first: true }), true);
  assert.equal(shouldBurst([], 0, { rolls: STUBBORN_ROLLS - 1 }), false);
  assert.equal(shouldBurst([], 0, { rolls: STUBBORN_ROLLS }), true);
  assert.equal(shouldBurst([], 0, { early: true }), true);
});

test("the day's first ✓ is the first with a done_at today on his clock", () => {
  const tz = "America/New_York";
  const today = "2026-11-03";
  assert.equal(firstToday([], today, tz), true);
  // Finished at 11:30 pm the night before (04:30 UTC on the 3rd) is yesterday.
  assert.equal(firstToday([T("a", null, { done: true, done_at: "2026-11-03T04:30:00Z" })], today, tz), true);
  assert.equal(firstToday([T("a", today, { done: true, done_at: "2026-11-03T15:00:00Z" })], today, tz), false);
  // Done before done_at existed (null) tells nothing.
  assert.equal(firstToday([T("a", today, { done: true, done_at: null })], today, tz), true);
});

test("the day's first ✓ fires once a day, however often nothing looks done", () => {
  const tz = "America/New_York";
  // Quick taps, an uncheck and recheck, another week on screen: no done_at today each time.
  assert.equal(firstOfDay([], "2026-11-10", tz), true);
  assert.equal(firstOfDay([], "2026-11-10", tz), false);
  assert.equal(firstOfDay([T("a", "2026-11-10")], "2026-11-10", tz), false);
  // The next day it can fire again, but not when something is already done that day.
  assert.equal(firstOfDay([T("a", "2026-11-11", { done: true, done_at: "2026-11-11T15:00:00Z" })], "2026-11-11", tz), false);
  assert.equal(firstOfDay([], "2026-11-11", tz), true);
});

test("a focus session finished it inside its estimate", () => {
  assert.equal(inside({ est_min: 45 }, 30), true);
  assert.equal(inside({ est_min: 45 }, 45), false);
  assert.equal(inside({ est_min: null }, 10), false);
  assert.equal(inside({ est_min: 45 }, null), false);
});

test("a Brightspace task is an assignment; others are not", () => {
  assert.equal(isAssignment(T("a", "2026-11-03", { source: "brightspace" })), true);
  assert.equal(isAssignment(T("b", "2026-11-03", { source: "github" })), false);
  assert.equal(isAssignment(T("c", "2026-11-03")), false);
  assert.equal(isAssignment(null), false);
});

test("the day clears only when this ✓ closes the last open task of today", () => {
  const today = "2026-11-03";
  const tasks = [T("a", today, { done: true }), T("b", today), T("c", "2026-11-04"), T("d", null)];
  assert.equal(isDayCleared(tasks, today, "b"), true);
  assert.equal(isDayCleared([...tasks, T("e", today)], today, "b"), false);
  // A task on another day, or one already done, clears nothing.
  assert.equal(isDayCleared(tasks, today, "c"), false);
  assert.equal(isDayCleared(tasks, today, "a"), false);
  assert.equal(isDayCleared(new Map(tasks.map((t) => [t.id, t])).values(), today, "b"), true);
});

test("clearing the day outranks an assignment", () => {
  const today = "2026-11-03";
  const hw = T("hw", today, { source: "brightspace" });
  assert.equal(momentOf(hw, [hw], today), "day");
  assert.equal(momentOf(hw, [hw, T("x", today)], today), "assignment");
  assert.equal(momentOf(T("x", today), [hw, T("x", today)], today), null);
  assert.equal(MOMENT_WORDS.day, "Day cleared.");
  assert.equal(MOMENT_WORDS.assignment, "Assignment done.");
});

test("the specks spread round the check, 18 to 36 px out", () => {
  const s = specks(8, () => 0.5);
  assert.equal(s.length, 8);
  for (const p of s) {
    const d = Math.hypot(p.dx, p.dy);
    assert.ok(d >= 18 && d <= 36, `distance ${d}`);
    assert.ok(p.ms < 1500);
  }
  // Evenly spread: the first goes right, the fifth left.
  assert.ok(s[0].dx > 0 && s[4].dx < 0);
});

test("check-off motion stays behind prefers-reduced-motion", () => {
  const css = readFileSync(new URL("../src/styles/plan-phone.css", import.meta.url), "utf8");
  const js = readFileSync(new URL("../src/sheet/celebrate.mjs", import.meta.url), "utf8");
  // The only CSS transition for it sits inside a no-preference block.
  const transition = css.indexOf("transition: color 0.25s ease-out");
  assert.ok(transition > 0);
  assert.ok(css.lastIndexOf("@media (prefers-reduced-motion: no-preference)", transition) > css.indexOf("Checking off"));
  // Every effect checks calm() first; no ease-in anywhere.
  for (const fn of ["burst", "confetti", "pop", "slide"]) assert.match(js, new RegExp(`export function ${fn}\\(.*\\) \\{\\n  if \\(.*!calm\\(\\)`));
  assert.doesNotMatch(js, /ease-in[^-]/);
});

test("a hung save holds the redraw only until the cap", async () => {
  assert.equal(await capped(Promise.resolve(7), 50), 7);
  assert.equal(await capped(new Promise(() => {}), 20), LATE);
  assert.equal(await capped(wait(40, "slow"), 10), LATE);
  // The caps are short: the animation's about a second, the whole ✓ a few.
  assert.ok(ANIM_MS <= 1500 && SAVE_MS <= 5000 && ANIM_MS < SAVE_MS);
});

test("a second ✓ while the first still saves runs nothing", async () => {
  const busy = new Set();
  let saves = 0;
  const save = async () => { saves++; await wait(20); };
  const [a, b] = await Promise.all([once(busy, "task:t2", save), once(busy, "task:t2", save)]);
  assert.deepEqual([a, b, saves], [true, false, 1]);
  // Another task isn't blocked, and the same one can run again once it has landed.
  assert.equal(await once(busy, "task:t3", save), true);
  assert.equal(await once(busy, "task:t2", save), true);
  assert.equal(saves, 3);
  // A save that throws still frees its key.
  await assert.rejects(once(busy, "task:t4", async () => { throw new Error("boom"); }));
  assert.equal(busy.size, 0);
});
