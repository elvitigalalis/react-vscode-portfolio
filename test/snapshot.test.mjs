// The stored week (src/sheet/snapshot.mjs): it comes back as the planner's state, for its week
// only, and keeps nothing the week doesn't draw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pack, unpack, SNAPSHOT_KEY } from "../src/sheet/snapshot.mjs";

const state = () => ({
  week: "2026-11-02",
  tasks: new Map([["t1", { id: "t1", title: "Laundry", day: "2026-11-03", done: false }]]),
  blocks: [{ id: "b1", task_id: "t1", starts_at: "2026-11-03T15:00:00Z", ends_at: "2026-11-03T15:30:00Z" }],
  days: { "2026-11-03": { day: "2026-11-03", planned: true } },
  parked: 2,
  todos: [{ cal_event_key: "e1", done: true }],
  horizon: [{ task_id: "t1", day: "2026-11-05", minutes: 30 }],
  states: new Map([["t1", { task_id: "t1", state: "tight" }]]),
  settings: { workload_cap_min: 360, bedtime_target: "23:30:00", telegram_chat_id: 42, horizon_key: "secret", owner_email: "a@b" },
  sleep: [{ day: "2026-11-03", hr: [60, 61] }],
  sleepTimes: [{ day: "2026-11-03" }],
  sleepDays: [{ day: "2026-11-03", sleep_score: 82, readiness: 86, sleep_s: 27000, contributors: { a: 1 }, raw: { big: true } }],
});

test("a stored week comes back as the state it was drawn from", () => {
  const back = unpack(pack(state()), "2026-11-02");
  assert.deepEqual([...back.tasks.keys()], ["t1"]);
  assert.equal(back.tasks.get("t1").title, "Laundry");
  assert.equal(back.days["2026-11-03"].planned, true);
  assert.equal(back.parked, 2);
  assert.equal(back.states.get("t1").state, "tight");
  assert.deepEqual(back.todos, [{ cal_event_key: "e1", done: true }]);
  assert.equal(back.settings.workload_cap_min, 360);
  assert.equal(back.sleepDays[0].sleep_score, 82);
});

test("it keeps no keys, chat IDs or raw sleep data", () => {
  const text = pack(state());
  for (const word of ["secret", "telegram_chat_id", "owner_email", "hr", "raw", "sleepTimes"]) assert.equal(text.includes(word), false, word);
});

test("another week, another version or junk gives nothing", () => {
  assert.equal(unpack(pack(state()), "2026-11-09"), null);
  assert.equal(unpack(pack(state()).replace('"v":1', '"v":0'), "2026-11-02"), null);
  assert.equal(unpack("{not json", "2026-11-02"), null);
  assert.equal(unpack(null, "2026-11-02"), null);
});

test("the key is versioned", () => assert.match(SNAPSHOT_KEY, /\.v\d+$/));
