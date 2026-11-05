// Horizon planning, part 1: the pure engine (docs/sheet-horizon.md, "The engine").
import { test } from "node:test";
import assert from "node:assert/strict";
import { planHorizon, horizonMinutes, confirmedDoneMin, dayFree, CHUNK_MIN, CHUNK_MAX } from "../src/sheet/horizon.mjs";

const TODAY = "2026-11-05"; // a Thursday
const days = (n, minutes = 240, from = TODAY) => Object.fromEntries(Array.from({ length: n }, (_, i) => {
  const d = new Date(`${from}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
  return [d.toISOString().slice(0, 10), minutes];
}));
const task = (id, due, minutes, extra = {}) => ({ id, due, minutes, done_min: 0, ...extra });
const plan = (input) => planHorizon({ today: TODAY, free: days(30), locked: [], frozen_days: [], previous: [], ...input });
// Later days fill to 85% of their free time: 106 free holds 90, 75 holds 60.
const free90 = { ...days(30, 106), [TODAY]: 90 };
const on = (r, id) => r.allocations.filter((a) => a.task_id === id).map(({ day, minutes }) => [day, minutes]);

test("a task that fits goes on today, whole, and is on track", () => {
  const r = plan({ tasks: [task("a", "2026-11-10", 60)] });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 60]]);
  assert.equal(r.tasks.a.state, "on_track");
  assert.equal(r.tasks.a.finish_day, "2026-11-05");
  assert.equal(r.tasks.a.short_min, 0);
});

test("a long task goes in chunks of at most 90, leaving no piece under 30", () => {
  const r = plan({ tasks: [task("a", "2026-11-12", 200)] }); // 3h20 → 3h30 in 15-minute steps
  assert.deepEqual(on(r, "a"), [["2026-11-05", 90], ["2026-11-06", 90], ["2026-11-07", 30]]);
  const r2 = plan({ tasks: [task("a", "2026-11-12", 195)] }); // 90 + 90 would leave 15
  assert.deepEqual(on(r2, "a"), [["2026-11-05", 90], ["2026-11-06", 75], ["2026-11-07", 30]]);
});

test("a task of an hour or less is never split", () => {
  const r = plan({ tasks: [task("a", "2026-11-12", 60)], free: { ...days(30), "2026-11-05": 45 } });
  assert.deepEqual(on(r, "a"), [["2026-11-06", 60]]);
});

test("the plan aims to finish a working day before the due day", () => {
  const free = { ...days(30), "2026-11-05": 0, "2026-11-06": 0, "2026-11-07": 75 };
  const r = plan({ tasks: [task("a", "2026-11-08", 90)], free });
  assert.equal(r.tasks.a.target_day, "2026-11-07");
  assert.deepEqual(on(r, "a"), [["2026-11-07", 60], ["2026-11-08", 30]]);
  assert.equal(r.tasks.a.state, "tight"); // it eats the buffer
  // Due tomorrow: no buffer day, the due day is the target.
  assert.equal(plan({ tasks: [task("b", "2026-11-06", 30)] }).tasks.b.target_day, "2026-11-06");
  // A day with no free time is not a working day.
  assert.equal(plan({ tasks: [task("c", "2026-11-09", 30)], free: { ...days(30), "2026-11-08": 0 } }).tasks.c.target_day, "2026-11-07");
});

test("earliest due goes first", () => {
  const r = plan({ tasks: [task("a", "2026-11-20", 120), task("b", "2026-11-07", 90)], free: free90 });
  assert.deepEqual(on(r, "b"), [["2026-11-05", 90]]);
  assert.deepEqual(on(r, "a"), [["2026-11-06", 90], ["2026-11-07", 30]]);
  assert.equal(r.tasks.a.state, "on_track");
});

test("what won't fit stays on the due day past the cap, with the minutes short", () => {
  const r = plan({ tasks: [task("a", "2026-11-05", 180)], free: { "2026-11-05": 120 } });
  assert.deepEqual(r.allocations, [{ task_id: "a", day: "2026-11-05", minutes: 180, over_min: 60 }]);
  assert.equal(r.tasks.a.state, "wont_fit");
  assert.equal(r.tasks.a.short_min, 60);
  assert.equal(r.tasks.a.slack_min, -60);
});

test("only confirmed done time comes off", () => {
  const r = plan({ tasks: [task("a", "2026-11-12", 120, { done_min: 60 })] });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 60]]);
  assert.equal(r.tasks.a.remaining_min, 60);
  const done = plan({ tasks: [task("b", "2026-11-12", 60, { done_min: 75 })] });
  assert.deepEqual(on(done, "b"), []);
  assert.equal(done.tasks.b.state, "on_track");
});

test("today's locked blocks are kept and count toward the task", () => {
  const r = plan({ tasks: [task("a", "2026-11-12", 120)], locked: [{ task_id: "a", day: TODAY, minutes: 60 }] });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 90], ["2026-11-06", 30]]);
  // Locked minutes stay even past what the task has left.
  const r2 = plan({ tasks: [task("b", "2026-11-12", 30)], locked: [{ task_id: "b", day: TODAY, minutes: 60 }] });
  assert.deepEqual(on(r2, "b"), [["2026-11-05", 60]]);
});

test("a re-flow with nothing changed moves nothing", () => {
  const previous = [{ task_id: "a", day: "2026-11-06", minutes: 60, over_min: 0 }, { task_id: "a", day: "2026-11-07", minutes: 60, over_min: 0 }];
  const r = plan({ tasks: [task("a", "2026-11-20", 120)], previous });
  assert.deepEqual(on(r, "a"), [["2026-11-06", 60], ["2026-11-07", 60]]); // a fresh plan would put 90 today
  assert.equal(r.moved_min, 0);
});

test("a new task takes free time first and moves only the minutes it must", () => {
  const free = free90;
  const previous = [{ task_id: "a", day: "2026-11-05", minutes: 90, over_min: 0 }, { task_id: "a", day: "2026-11-06", minutes: 30, over_min: 0 }];
  const r = plan({ tasks: [task("a", "2026-11-20", 120), task("b", "2026-11-07", 90)], free, previous });
  assert.deepEqual(on(r, "b"), [["2026-11-06", 90]]);
  assert.deepEqual(on(r, "a"), [["2026-11-05", 90], ["2026-11-07", 30]]);
  assert.equal(r.moved_min, 30);
  assert.equal(r.tasks.b.state, "on_track");
});

test("a busy time landing on a kept day gives back only what no longer fits", () => {
  const previous = [{ task_id: "a", day: "2026-11-05", minutes: 90, over_min: 0 }, { task_id: "a", day: "2026-11-06", minutes: 90, over_min: 0 }];
  const r = plan({ tasks: [task("a", "2026-11-20", 180)], free: { ...days(30), "2026-11-05": 60 }, previous });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 60], ["2026-11-06", 90], ["2026-11-07", 30]]);
  assert.equal(r.moved_min, 30);
});

test("a frozen day keeps its minutes and takes nothing new", () => {
  const previous = [{ task_id: "a", day: "2026-11-06", minutes: 60, over_min: 0 }];
  const r = plan({ tasks: [task("a", "2026-11-20", 60), task("b", "2026-11-09", 60)], free: { ...days(30), "2026-11-05": 0 }, frozen_days: ["2026-11-06"], previous });
  assert.deepEqual(on(r, "a"), [["2026-11-06", 60]]);
  assert.deepEqual(on(r, "b"), [["2026-11-07", 60]]);
  // A done task's frozen minutes go.
  const r2 = plan({ tasks: [], frozen_days: ["2026-11-06"], previous });
  assert.deepEqual(r2.allocations, []);
});

test("an overdue task is planned from today and is tight at best", () => {
  const r = plan({ tasks: [task("a", "2026-11-03", 60)] });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 60]]);
  assert.equal(r.tasks.a.state, "tight");
});

test("an earlier deadline takes kept time from a task due later", () => {
  // b (due Fri) was planned on today; a new a, due tomorrow, needs today's only free time.
  const free = { ...days(30, 0), "2026-11-05": 90, "2026-11-08": 106 };
  const previous = [{ task_id: "b", day: "2026-11-05", minutes: 90, over_min: 0 }];
  const r = plan({ tasks: [task("a", "2026-11-06", 90), task("b", "2026-11-09", 90)], free, previous });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 90]]);
  assert.deepEqual(on(r, "b"), [["2026-11-08", 90]]);
  // Both have no slack to spare (0, under one day's chunk), so both are tight.
  assert.deepEqual([r.tasks.a.state, r.tasks.a.slack_min, r.tasks.b.state], ["tight", 0, "tight"]);
  assert.equal(r.moved_min, 90);
});

test("kept minutes past the target come forward when there is room", () => {
  const previous = [{ task_id: "a", day: "2026-11-09", minutes: 60, over_min: 0 }];
  const r = plan({ tasks: [task("a", "2026-11-09", 60)], previous });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 60]]);
  assert.equal(r.tasks.a.state, "on_track");
});

test("last time's overflow is planned again, not kept", () => {
  const previous = [{ task_id: "a", day: "2026-11-05", minutes: 150, over_min: 60 }];
  const r = plan({ tasks: [task("a", "2026-11-12", 150)], previous });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 90], ["2026-11-06", 60]]);
  assert.equal(r.tasks.a.short_min, 0);
});

test("horizonMinutes scales the estimate by pace with no 4-hour limit", () => {
  const paces = { course: { pace: 1.5, n: 6 }, other: { pace: null, n: 2 } };
  assert.equal(horizonMinutes({ est_min: 600, source: "brightspace" }, paces), 900);
  assert.equal(horizonMinutes({ est_min: 50 }, paces), 45); // rounded to 15
  assert.equal(horizonMinutes({}, paces), 30);
  assert.equal(horizonMinutes({ est_min: 5 }, paces), 15);
});

test("confirmedDoneMin counts a More time block up to the answer, and nothing else", () => {
  const blocks = [
    { id: "k1", task_id: "a", starts_at: "2026-11-04T15:00:00Z", ends_at: "2026-11-04T16:30:00Z" },
    { id: "k2", task_id: "a", starts_at: "2026-11-04T18:00:00Z", ends_at: "2026-11-04T19:00:00Z" },
    { id: "k3", task_id: "b", starts_at: "2026-11-04T18:00:00Z", ends_at: "2026-11-04T19:00:00Z" },
  ];
  const feedback = [
    { at: "2026-11-04T16:00:00Z", item: "finished", action: "more", ref: { block_id: "k1" } },
    { at: "2026-11-04T16:35:00Z", item: "finished", action: "more", ref: { block_id: "k1" } }, // after the end: capped
    { at: "2026-11-04T19:00:00Z", item: "finished", action: "nostart", ref: { block_id: "k2" } },
    { at: "2026-11-04T19:00:00Z", item: "block", action: "done", ref: { block_id: "k3" } },
  ];
  assert.deepEqual(confirmedDoneMin(blocks, feedback), { a: 90 });
});

test("dayFree is the cap less locked work, held to the free window", () => {
  assert.equal(dayFree({ cap: 360, window_free_min: 600, locked_min: 60 }), 300);
  assert.equal(dayFree({ cap: 360, window_free_min: 200 }), 195);
  assert.equal(dayFree({ cap: 360, window_free_min: 600, locked_min: 400 }), 0);
});

// A seeded sweep: whatever the input, the rules hold.
test("every plan keeps the rules", () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const day = (i) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
  for (let run = 0; run < 300; run++) {
    const free = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [day(i), rand(5) * 60]));
    const tasks = Array.from({ length: 1 + rand(6) }, (_, i) => task(`t${i}`, day(rand(20) - 2), 15 * (1 + rand(40)), { done_min: rand(3) ? 0 : 15 * rand(4) }));
    const frozen_days = rand(2) ? [day(1)] : [];
    const previous = rand(2) ? planHorizon({ today: TODAY, tasks, free }).allocations : [];
    const r = planHorizon({ today: TODAY, tasks, free, frozen_days, previous });
    const again = planHorizon({ today: TODAY, tasks, free, frozen_days, previous: r.allocations });
    assert.equal(again.moved_min, 0, `run ${run}: a re-flow of its own plan moved minutes`);
    for (const t of tasks) {
      const mine = r.allocations.filter((a) => a.task_id === t.id);
      const left = Math.ceil(Math.max(0, t.minutes - t.done_min) / 15) * 15;
      const fromFrozen = previous.filter((p) => p.task_id === t.id && frozen_days.includes(p.day)).reduce((s, p) => s + p.minutes, 0);
      if (!fromFrozen) assert.equal(mine.reduce((s, a) => s + a.minutes, 0), left, `run ${run}: ${t.id} total`);
      const due = t.due < TODAY ? TODAY : t.due;
      for (const a of mine) {
        assert.ok(a.day >= TODAY && a.day <= due, `run ${run}: ${t.id} on ${a.day}, due ${t.due}`);
        if (frozen_days.includes(a.day)) continue;
        if (a.day !== due) assert.ok(a.minutes <= CHUNK_MAX, `run ${run}: ${t.id} ${a.minutes} on ${a.day}`);
        if (left >= CHUNK_MIN) assert.ok(a.minutes >= CHUNK_MIN, `run ${run}: ${t.id} piece ${a.minutes}`);
      }
      if (left <= 60 && !fromFrozen) assert.ok(mine.length <= 1, `run ${run}: ${t.id} split`);
      assert.equal(r.tasks[t.id].state === "wont_fit", r.tasks[t.id].short_min > 0);
    }
    for (const d of Object.keys(free)) {
      if (frozen_days.includes(d)) continue;
      const used = r.allocations.filter((a) => a.day === d).reduce((s, a) => s + a.minutes - a.over_min, 0);
      assert.ok(used <= free[d], `run ${run}: ${d} holds ${used} of ${free[d]}`);
    }
  }
});

test("after a change, a re-flow moves no more minutes than planning afresh would", () => {
  let seed = 11;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const day = (i) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
  const moved = (prev, next) => prev.reduce((s, p) => s + Math.max(0, p.minutes - (next.find((a) => a.task_id === p.task_id && a.day === p.day)?.minutes ?? 0)), 0);
  let total = 0, fresh = 0;
  for (let run = 0; run < 300; run++) {
    const free = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [day(i), 60 + rand(4) * 60]));
    const tasks = Array.from({ length: 2 + rand(5) }, (_, i) => task(`t${i}`, day(1 + rand(20)), 15 * (2 + rand(30))));
    const previous = planHorizon({ today: TODAY, tasks, free }).allocations;
    // One change: a busy time lands, a task is added, or one is done.
    const kind = rand(3);
    const free2 = kind === 0 ? { ...free, [day(rand(5))]: 0 } : free;
    const tasks2 = kind === 1 ? [...tasks, task("new", day(1 + rand(10)), 15 * (2 + rand(8)))] : kind === 2 ? tasks.slice(1) : tasks;
    const r = planHorizon({ today: TODAY, tasks: tasks2, free: free2, previous });
    const f = planHorizon({ today: TODAY, tasks: tasks2, free: free2 });
    assert.equal(r.moved_min, moved(previous, r.allocations));
    total += r.moved_min; fresh += moved(previous, f.allocations);
    assert.ok(r.moved_min <= moved(previous, f.allocations), `run ${run}: moved ${r.moved_min}, fresh ${moved(previous, f.allocations)}`);
  }
  assert.ok(total < fresh, `re-flows moved ${total}, fresh plans ${fresh}`);
});

test("later days fill to 85% of their free time, today to all of it", () => {
  const r = plan({ tasks: [task("a", "2026-11-20", 240)], free: days(30, 90) });
  assert.deepEqual(on(r, "a"), [["2026-11-05", 90], ["2026-11-06", 75], ["2026-11-07", 75]]);
});
