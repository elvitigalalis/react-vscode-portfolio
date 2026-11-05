// Horizon planning, part 2: the rows the re-flow reads, the engine's input built from them, its
// key, and the re-flow itself (docs/sheet-horizon.md, "Part 2: the wiring").
import { test } from "node:test";
import assert from "node:assert/strict";
import { horizonInput, horizonKey, horizonQueries, reflowHorizon } from "../src/sheet/horizon-io.mjs";
import { queryPath } from "../src/sheet/proposal-io.mjs";

const TZ = "America/New_York";
const TODAY = "2026-11-05"; // a Thursday
const eight = new Date("2026-11-05T13:00:00Z"); // 8:00 am EST
const A = "6f1c2a3b-0000-4000-8000-00000000000a";
const B = "6f1c2a3b-0000-4000-8000-00000000000b";
const settings = { time_zone: TZ, workload_cap_min: 600, wind_down_on: false, horizon_key: null };
const task = (id, due, extra = {}) => ({ id, title: id, day: null, list: "Inbox", due, est_min: 60, at_time: null, done: false, source: null, tag: null, ...extra });
const rows = (extra = {}) => ({ settings, tasks: [], blocks: [], busy: [], habits: [], actuals: [], feedback: [], day: null, sleepDay: null, previous: [], ...extra });
// Local clock on a day as an ISO instant (EST is UTC-5 in November).
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00-05:00`).toISOString();

test("horizonInput: undone due tasks without a fixed time, in minutes with their pace", () => {
  const tasks = [task(A, "2026-11-09", { est_min: 120 }), task(B, "2026-11-07", { at_time: "15:00:00" })];
  const input = horizonInput(rows({ tasks }), eight);
  assert.equal(input.today, TODAY);
  assert.deepEqual(input.tasks, [{ id: A, due: "2026-11-09", minutes: 120, done_min: 0, minutes_p80: 120, kind: null }]);
  assert.deepEqual(Object.keys(input.free), ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
});

test("horizonInput: each task carries its minutes at the 80th-percentile pace and its kind of work", () => {
  // Ten "other" actuals: eight at 1x, two at 2x. The median pace is 1, the P80 pace 1.
  // With four at 2x, the P80 is 2 while the median stays 1.
  const row = (i, r) => ({ at: `2026-10-${String(10 + i).padStart(2, "0")}T12:00:00Z`, kind: "other", est_min: 60, minutes: 60 * r });
  const actuals = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2].map((r, i) => row(i, r));
  const tasks = [task(A, "2026-11-09", { title: "CSE 320 midterm", est_min: 60 }), task(B, "2026-11-08", { title: "Implement the parser", est_min: 60 })];
  const input = horizonInput(rows({ tasks, actuals }), eight);
  assert.deepEqual(input.tasks.map((t) => [t.id, t.minutes, t.minutes_p80, t.kind]), [[B, 60, 120, "programming"], [A, 60, 120, "exam"]]);
});

test("horizonKey: a change to the engine's rules changes the key, so a deploy re-flows", async () => {
  const { HORIZON_RULES } = await import("../src/sheet/horizon.mjs");
  assert.ok(Number.isInteger(HORIZON_RULES));
  const input = horizonInput(rows({ tasks: [task(A, "2026-11-08")] }), eight);
  assert.notEqual(await horizonKey(input, HORIZON_RULES + 1), await horizonKey(input));
  assert.equal(await horizonKey(input, HORIZON_RULES), await horizonKey(input));
});

test("horizonInput: each day's free time is the window less busy times with travel and habits, under the cap", () => {
  const tasks = [task(A, "2026-11-06")];
  const busy = [{ starts_at: at(TODAY, "09:00"), ends_at: at(TODAY, "10:00") }];
  const habits = [{ id: "h", name: "Gym", days: [5], ideal: "12:00:00", minutes: 30, flex_min: 30, defence: "flexible" }];
  const { free } = horizonInput(rows({ tasks, busy, habits }), eight);
  // Today 8:00 (now) to 5:00 pm, less 8:50–10:10; Friday 7:00 to 5:00 pm less the 30-minute habit.
  assert.deepEqual(free, { "2026-11-05": 450, "2026-11-06": 570 });
  const capped = horizonInput(rows({ tasks, busy, habits, settings: { ...settings, workload_cap_min: 360 } }), eight).free;
  assert.deepEqual(capped, { "2026-11-05": 360, "2026-11-06": 360 });
});

test("horizonInput: today's locked task blocks count against today, and a More time answer counts as done", () => {
  const tasks = [task(A, "2026-11-06", { est_min: 180 })];
  const blocks = [
    // Approved this morning, answered More time half an hour in.
    { id: "b1", task_id: A, habit_id: null, starts_at: at(TODAY, "07:00"), ends_at: at(TODAY, "08:00"), proposed: false, auto: false },
    // Approved for later today and not auto: locked.
    { id: "b2", task_id: A, habit_id: null, starts_at: at(TODAY, "13:00"), ends_at: at(TODAY, "14:00"), proposed: false, auto: false },
    // Auto-approved and not started: the next revision may move it, so not locked.
    { id: "b3", task_id: A, habit_id: null, starts_at: at(TODAY, "15:00"), ends_at: at(TODAY, "16:00"), proposed: false, auto: true },
    // Proposed: not planned time.
    { id: "b4", task_id: A, habit_id: null, starts_at: at(TODAY, "16:00"), ends_at: at(TODAY, "16:30"), proposed: true, auto: false },
  ];
  const feedback = [{ at: at(TODAY, "07:30"), item: "finished", action: "more", ref: { block_id: "b1" } }];
  const input = horizonInput(rows({ tasks, blocks, feedback }), eight);
  assert.deepEqual(input.tasks, [{ id: A, due: "2026-11-06", minutes: 180, done_min: 30, minutes_p80: 180, kind: null }]);
  assert.deepEqual(input.locked, [{ task_id: A, day: TODAY, minutes: 120 }]);
  // Cap 600 less 120 locked; the window 8:00–17:00 less the 13:00–14:00 block is 480.
  assert.equal(input.free[TODAY], 480);
});

test("horizonInput: tomorrow is frozen once today is shut down, and the stored plan comes back as previous", () => {
  const tasks = [task(A, "2026-11-08")];
  const previous = [{ task_id: A, day: "2026-11-06", minutes: 60, over_min: 0 }];
  const input = horizonInput(rows({ tasks, previous, day: { day: TODAY, shutdown: true } }), eight);
  assert.deepEqual(input.frozen_days, ["2026-11-06"]);
  assert.deepEqual(input.previous, previous);
  assert.deepEqual(horizonInput(rows({ tasks }), eight).frozen_days, []);
});

test("horizonInput: a short night lowers today's cap, as read_planner's does", () => {
  const tasks = [task(A, "2026-11-06")];
  const s = { ...settings, workload_cap_min: 360 };
  const input = horizonInput(rows({ tasks, settings: s, sleepDay: { day: TODAY, readiness: 60, sleep_s: 8 * 3600 } }), eight);
  assert.equal(input.free[TODAY], 285); // 360 × 0.8 = 288 → 285
});

test("horizonInput: three short nights lower today's cap, as read_planner's does", () => {
  const tasks = [task(A, "2026-11-06")];
  const s = { ...settings, workload_cap_min: 360 };
  const h = (x) => x * 3600;
  const sleepDays = [{ day: TODAY, readiness: 75, sleep_s: h(7) }, { day: "2026-11-04", sleep_s: h(6) }, { day: "2026-11-03", sleep_s: h(6) }];
  assert.equal(horizonInput(rows({ tasks, settings: s, sleepDays }), eight).free[TODAY], 300); // 360 × 0.85 = 306 → 300
});

test("horizonKey: the same inputs give the same key; previous and field order don't count", async () => {
  const input = horizonInput(rows({ tasks: [task(A, "2026-11-08")] }), eight);
  const k = await horizonKey(input);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(await horizonKey({ ...input, previous: [{ task_id: A, day: TODAY, minutes: 60, over_min: 0 }] }), k);
  assert.equal(await horizonKey(Object.fromEntries(Object.entries(input).reverse())), k);
  assert.notEqual(await horizonKey({ ...input, today: "2026-11-06" }), k);
});

test("horizonQueries: what the re-flow reads", () => {
  const q = horizonQueries(TODAY, TZ);
  assert.equal(queryPath(q.tasks), "tasks?select=id,title,due,est_min,at_time,source,tag,done&done=is.false&due=not.is.null");
  assert.equal(queryPath(q.previous), `horizon_alloc?select=task_id,day,minutes,over_min&day=gte.${TODAY}&order=day`);
  assert.equal(queryPath(q.days), `days?select=day,shutdown,shutdown_at&day=eq.${TODAY}`);
  assert.equal(queryPath(q.busy("2026-11-09")), "busy?select=starts_at,ends_at&starts_at=lt.2026-11-10T05:00:00.000Z&ends_at=gt.2026-11-05T05:00:00.000Z&order=starts_at");
  assert.equal(queryPath(q.blocks([A])), `blocks?select=id,task_id,habit_id,starts_at,ends_at,proposed,auto&or=(and(starts_at.lt.2026-11-06T05:00:00.000Z,ends_at.gt.2026-11-05T05:00:00.000Z),task_id.in.(${A}))&order=starts_at`);
  assert.equal(queryPath(q.feedback(["b1", "b2"])), "feedback?select=at,item,action,ref&item=eq.finished&action=eq.more&ref->>block_id=in.(b1,b2)");
});

// A fake database: each table's rows, filtered by nothing (the queries' filters are checked above).
function fakeIo(tables) {
  const calls = [];
  return {
    calls,
    read: async (q) => tables[q.table] ?? [],
    rpc: async (name, args) => { calls.push([name, args]); return args.allocs.length; },
  };
}

test("reflowHorizon: plans and saves through replace_horizon, then skips while the key holds", async () => {
  const tables = { settings: [settings], tasks: [task(A, "2026-11-06", { est_min: 60 })] };
  const io = fakeIo(tables);
  const r = await reflowHorizon(io, eight);
  assert.equal(r.skipped, false);
  assert.equal(io.calls.length, 1);
  const [name, args] = io.calls[0];
  assert.equal(name, "replace_horizon");
  assert.equal(args.from_day, TODAY);
  assert.deepEqual(args.allocs, [{ task_id: A, day: TODAY, minutes: 60, over_min: 0 }]);
  assert.deepEqual(args.states.map((s) => [s.task_id, s.state]), [[A, "on_track"]]);
  tables.settings = [{ ...settings, horizon_key: args.key }];
  const again = await reflowHorizon(io, eight);
  assert.equal(again.skipped, true);
  assert.equal(io.calls.length, 1);
});

test("reflowHorizon: with no due tasks it still clears the old plan once", async () => {
  const io = fakeIo({ settings: [settings], horizon_alloc: [{ task_id: A, day: TODAY, minutes: 60, over_min: 0 }] });
  const r = await reflowHorizon(io, eight);
  assert.equal(r.skipped, false);
  assert.deepEqual(io.calls[0][1].allocs, []);
  assert.deepEqual(io.calls[0][1].states, []);
});
