// Checking off on /plan (src/sheet/celebrate.mjs, docs/sheet.md "Completion"): when a ✓ gets the
// burst or a big moment, and that the motion stays behind prefers-reduced-motion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldBurst, isAssignment, isDayCleared, momentOf, specks, STREAK_MS, MOMENT_WORDS, capped, LATE, wait, ANIM_MS, SAVE_MS, once } from "../src/sheet/celebrate.mjs";

const never = () => 0.99;
const always = () => 0;
const T = (id, day, extra = {}) => ({ id, day, done: false, source: null, ...extra });

test("the burst comes on the third ✓ within ten minutes", () => {
  const now = 1_000_000_000;
  assert.equal(shouldBurst([], now, never), false);
  assert.equal(shouldBurst([now - 60_000], now, never), false);
  assert.equal(shouldBurst([now - 120_000, now - 60_000], now, never), true);
  // Older ones don't count toward the streak.
  assert.equal(shouldBurst([now - STREAK_MS - 1, now - 60_000], now, never), false);
});

test("otherwise the burst is a roll of the dice, about one in five", () => {
  assert.equal(shouldBurst([], 0, always), true);
  assert.equal(shouldBurst([], 0, () => 0.19), true);
  assert.equal(shouldBurst([], 0, () => 0.2), false);
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
