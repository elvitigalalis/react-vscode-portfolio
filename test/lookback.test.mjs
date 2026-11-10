// The look-back (docs/sheet-lookback.md): every insight stays silent below its sample gate, and
// says facts about tasks and estimates in the planner's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callLookback, dueLookback, estimateHint, keepsMoving, paceTrend, shutdownLine, tomorrowLine, weekLine, weekReview,
} from "../src/sheet/lookback.mjs";

const TZ = "America/New_York";
const MONDAY = "2026-11-09"; // last week is Nov 2–8, the week before Oct 26–Nov 1
const at = (day, hh = "15") => `${day}T${hh}:00:00Z`;
const block = (id, task_id, day, min, extra = {}) => ({ id, task_id, starts_at: at(day), ends_at: new Date(Date.parse(at(day)) + min * 60000).toISOString(), proposed: false, ...extra });
const review = (o) => weekReview({ blocks: [], tasks: [], feedback: [], days: [], cap: 360, today: MONDAY, timeZone: TZ, ...o });

test("a week with under 3 planned days says nothing", () => {
  const blocks = [block("a", "t1", "2026-11-03", 60), block("b", "t1", "2026-11-04", 60)];
  assert.equal(review({ blocks, tasks: [{ id: "t1", done: true }] }), null);
});

test("proposed and habit blocks don't count as planned days", () => {
  const blocks = [block("a", "t1", "2026-11-03", 60), block("b", "t1", "2026-11-04", 60), block("c", "t1", "2026-11-05", 60, { proposed: true }), block("d", null, "2026-11-06", 60, { habit_id: "h" })];
  assert.equal(review({ blocks, tasks: [{ id: "t1", done: true }] }), null);
});

test("last week: planned and done by day, in minutes, with the cap", () => {
  const blocks = [block("a", "t1", "2026-11-02", 120), block("b", "t2", "2026-11-03", 60), block("c", "t1", "2026-11-04", 60)];
  const w = review({ blocks, tasks: [{ id: "t1", done: true }, { id: "t2", done: false }] });
  assert.equal(w.from, "2026-11-02");
  assert.equal(w.to, "2026-11-08");
  assert.equal(w.planned_min, 240);
  assert.equal(w.done_min, 180);
  assert.equal(w.days.length, 7);
  assert.deepEqual(w.days[1], { day: "2026-11-03", planned_min: 60, done_min: 0, cap_min: 360 });
  assert.equal(w.prior, null);
});

test("a block answered Didn't start doesn't count as done, even when its task finished later", () => {
  const blocks = [block("a", "t1", "2026-11-02", 60), block("b", "t1", "2026-11-03", 60), block("c", "t1", "2026-11-04", 60)];
  const feedback = [{ at: at("2026-11-02", "16"), action: "nostart", ref: { block_id: "a", task_id: "t1" } }];
  const w = review({ blocks, feedback, tasks: [{ id: "t1", done: true }] });
  assert.equal(w.done_min, 120);
  assert.equal(w.nostart, 1);
});

test("moved counts tasks answered Tomorrow that week, once each, and ignores other weeks", () => {
  const blocks = [block("a", "t1", "2026-11-02", 60), block("b", "t1", "2026-11-03", 60), block("c", "t1", "2026-11-04", 60)];
  const feedback = [
    { at: at("2026-11-02"), action: "tomorrow", ref: { task_id: "t1" } },
    { at: at("2026-11-03"), action: "tomorrow", ref: { task_id: "t1" } },
    { at: at("2026-11-04"), action: "tomorrow", ref: { task_id: "t2" } },
    { at: at("2026-10-28"), action: "tomorrow", ref: { task_id: "t3" } },
  ];
  assert.equal(review({ blocks, feedback, tasks: [] }).moved, 2);
});

test("the week before shows only when it passes the same gate", () => {
  const week = ["2026-11-02", "2026-11-03", "2026-11-04"].map((d, i) => block(`w${i}`, "t1", d, 60));
  const thin = [block("p0", "t1", "2026-10-27", 60)];
  const full = ["2026-10-27", "2026-10-28", "2026-10-29"].map((d, i) => block(`p${i}`, "t1", d, 120));
  const tasks = [{ id: "t1", done: true }];
  assert.equal(review({ blocks: [...week, ...thin], tasks }).prior, null);
  const w = review({ blocks: [...week, ...full], tasks });
  assert.deepEqual(w.prior, { planned_min: 360, done_min: 360 });
  assert.equal(weekLine(w), "Done 3h of 3h planned · the week before 6h of 6h");
});

test("reflections come back with their weekday; blank ones and other weeks stay out", () => {
  const blocks = ["2026-11-02", "2026-11-03", "2026-11-04"].map((d, i) => block(`w${i}`, "t1", d, 60));
  const days = [{ day: "2026-11-03", reflection: "Lab ran long" }, { day: "2026-11-04", reflection: "  " }, { day: "2026-10-30", reflection: "old" }];
  assert.deepEqual(review({ blocks, days, tasks: [] }).reflections, [{ day: "2026-11-03", weekday: "Tue", text: "Lab ran long" }]);
});

const actuals = (kind, ratios) => ratios.map((r, i) => ({ at: `2026-10-${String(10 + i).padStart(2, "0")}T15:00:00Z`, kind, est_min: 60, minutes: Math.round(60 * r) }));

test("the hint needs the kind's sample gate and an estimate", () => {
  const task = { est_min: 60, source: "brightspace" };
  assert.equal(estimateHint(task, { course: { pace: null, n: 3 } }), null);
  assert.equal(estimateHint({ ...task, est_min: null }, { course: { pace: 1.4, n: 12 } }), null);
});

test("the hint says what similar tasks took and the block it means", () => {
  const hint = estimateHint({ est_min: 60, source: "brightspace" }, { course: { pace: 1.4, n: 12 } });
  assert.equal(hint, "Course tasks like this took about 1h25 for a 1h estimate (median of 12) · blocks will be 1h30");
  assert.equal(estimateHint({ est_min: 30 }, { other: { pace: 1, n: 5 } }), "Tasks like this took about 30m for a 30m estimate (median of 5) · blocks will be 30m");
});

test("a task keeps moving at two rolls, a recent park, or two Tomorrow answers in 14 days", () => {
  const today = "2026-11-06";
  const tomorrow = (day, task_id = "t") => ({ at: at(day), action: "tomorrow", ref: { task_id } });
  assert.equal(keepsMoving({ id: "t", rolls: 1 }, [], today, TZ), false);
  assert.equal(keepsMoving({ id: "t", rolls: 2 }, [], today, TZ), true);
  assert.equal(keepsMoving({ id: "t", rolls: 2, done: true }, [], today, TZ), false);
  assert.equal(keepsMoving({ id: "t", rolls: 0, parked_on: "2026-10-30" }, [], today, TZ), true);
  assert.equal(keepsMoving({ id: "t", rolls: 0, parked_on: "2026-10-01" }, [], today, TZ), false);
  assert.equal(keepsMoving({ id: "t", rolls: 0 }, [tomorrow("2026-11-05"), tomorrow("2026-11-04")], today, TZ), true);
  assert.equal(keepsMoving({ id: "t", rolls: 0 }, [tomorrow("2026-11-05"), tomorrow("2026-10-04")], today, TZ), false);
  assert.equal(keepsMoving({ id: "t", rolls: 0 }, [tomorrow("2026-11-05"), tomorrow("2026-11-04", "x")], today, TZ), false);
});

const TODAY = "2026-11-30";
const due = (i, extra) => ({ id: `d${i}`, title: `Task ${i}`, due: "2026-11-20", done: true, done_at: at("2026-11-19"), ...extra });

test("the due look-back needs 5 tasks with a known finish; a finish with no stamp is left out", () => {
  const tasks = [due(1), due(2), due(3), due(4), due(5, { done_at: null }), due(6, { done_at: undefined })];
  assert.equal(dueLookback({ tasks, today: TODAY, timeZone: TZ }), null);
});

test("the due look-back counts by the local day and names what came after", () => {
  const tasks = [due(1), due(2), due(3),
    // 11:30 pm in New York on the due day is the next day in UTC: still on time.
    due(4, { done_at: "2026-11-21T04:30:00Z" }),
    due(5, { title: "Lab 4", done_at: at("2026-11-22") }),
    due(6, { title: "Essay", done: false, done_at: null }),
    due(7, { due: "2026-10-01" }), due(8, { due: "2026-12-01", done: false })];
  const d = dueLookback({ tasks, today: TODAY, timeZone: TZ });
  assert.deepEqual(d, { n: 6, on_time: 4, after: ["Lab 4"], open: ["Essay"] });
});

test("On track look-back needs 10 settled calls and judges against the date of the call", () => {
  const call = (id, state = "on_track", d = "2026-11-20") => ({ task_id: id, due: d, state });
  const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, due: "2026-11-20", done: true, done_at: at("2026-11-18") }));
  // Finished late, even though its due date was then moved to match.
  tasks[0] = { id: "t0", due: "2026-11-25", done: true, done_at: at("2026-11-24") };
  const calls = tasks.map((t) => call(t.id));
  assert.deepEqual(callLookback({ calls, tasks, today: TODAY, timeZone: TZ }), { n: 10, held: 9 });
  assert.equal(callLookback({ calls: calls.slice(1), tasks, today: TODAY, timeZone: TZ }), null);
  // Tight calls and calls not yet due don't count.
  assert.equal(callLookback({ calls: [...calls.slice(1), call("x", "tight")], tasks, today: TODAY, timeZone: TZ }), null);
  assert.equal(callLookback({ calls: [...calls.slice(1), call("t0", "on_track", "2026-12-20")], tasks, today: TODAY, timeZone: TZ }), null);
});

test("the pace trend needs 10 estimated rows of a kind and compares the newest 5 with the 5 before", () => {
  assert.equal(paceTrend(actuals("course", [1, 1, 1, 1, 1, 1, 1, 1, 1])), null);
  assert.equal(paceTrend(actuals("course", [1.5, 1.5, 1.5, 1.5, 1.5, 1.2, 1.2, 1.2, 1.2, 1.2])), "Course tasks lately took 1.2× the estimate, down from 1.5×");
  assert.equal(paceTrend(actuals("course", [1.2, 1.2, 1.2, 1.2, 1.2, 1.5, 1.5, 1.5, 1.5, 1.5])), "Course tasks lately took 1.5× the estimate, up from 1.2×");
  assert.equal(paceTrend(actuals("course", Array(10).fill(1.3))), null);
});

test("shutdown's line leaves out zeros, so a slow day reads as what happened", () => {
  assert.equal(shutdownLine({ done: 3, moving: 2, turned_down: 1 }), "Today: 3 done · 2 moving to tomorrow · 1 suggestion turned down.");
  assert.equal(shutdownLine({ done: 0, moving: 2, turned_down: 0 }), "Today: 2 moving to tomorrow.");
  assert.equal(shutdownLine({ done: 0, moving: 0, turned_down: 0 }), null);
  assert.equal(shutdownLine({ done: 1, moving: 0, turned_down: 0, trend: "Course tasks lately took 1.2× the estimate, down from 1.5×" }), "Today: 1 done. Course tasks lately took 1.2× the estimate, down from 1.5×.");
});

test("tomorrow's load against its room, with a next move when it runs over", () => {
  assert.equal(tomorrowLine(180, 300), "3h planned, room for 5h.");
  assert.equal(tomorrowLine(360, 300), "6h planned, room for 5h. Move something to another day, or raise the cap in Settings.");
});

test("nothing says missed, failed, streak, score or productive", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["lookback.mjs", "lookback-view.mjs", "lookback-shutdown.mjs", "shutdown.mjs", "shutdown-view.mjs", "shutdown-close.mjs"]) {
    const code = readFileSync(new URL(`../src/sheet/${f}`, import.meta.url), "utf8");
    const strings = code.match(/"[^"\n]*"|`[^`\n]*`/g) ?? [];
    for (const s of strings) assert.doesNotMatch(s, /\b(missed|failed to|fail(ure)?s?|streak|score|productiv|overdue|behind)\b/i, `${f}: ${s}`);
  }
});
