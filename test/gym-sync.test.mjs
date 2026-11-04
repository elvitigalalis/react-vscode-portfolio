// The Gym tracker's offline outbox (src/sheet/gym-sync.mjs, docs/sheet-gym.md, "Offline"): every
// write goes to the phone first, then to Supabase as an idempotent upsert by id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { outbox } from "../src/sheet/gym-sync.mjs";

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
// A send that records each call, failing while `down` is set.
const server = () => {
  const calls = [];
  const send = async (call) => { if (send.down) throw new Error("offline"); calls.push(structuredClone(call)); };
  send.calls = calls;
  return send;
};
const aSet = (id, reps, session_id = "s1") => ({ id, session_id, exercise_id: "wp", set_index: 1, warmup: false, weight_lb: 100, reps, done_at: "2026-01-05T15:00:00Z" });

test("outbox: the same set saved twice goes up once, with its latest values", async () => {
  const box = outbox(memory());
  box.put("gym_sets", aSet("a", 5));
  box.put("gym_sets", aSet("a", 6));
  assert.equal(box.pending(), 1);
  const send = server();
  assert.equal(await box.flush(send), true);
  assert.deepEqual(send.calls, [{ op: "upsert", table: "gym_sets", rows: [aSet("a", 6)] }]);
  assert.equal(box.pending(), 0);
});

test("outbox: a session goes up before its sets, whatever order they were saved in", async () => {
  const box = outbox(memory());
  box.put("gym_sets", aSet("a", 5));
  box.put("gym_sessions", { id: "s1", program_day_id: "d1", started_at: "2026-01-05T14:50:00Z", finished_at: null });
  box.put("gym_sets", aSet("b", 4));
  const send = server();
  await box.flush(send);
  assert.deepEqual(send.calls.map((c) => [c.table, c.rows.map((r) => r.id)]), [["gym_sessions", ["s1"]], ["gym_sets", ["a", "b"]]]);
});

test("outbox: offline keeps every set on the phone, and the next flush sends them", async () => {
  const storage = memory();
  const send = server();
  send.down = true;
  const box = outbox(storage);
  box.put("gym_sets", aSet("a", 5));
  assert.equal(await box.flush(send), false);
  assert.equal(box.pending(), 1);
  // A reload: a new outbox on the same storage still has it.
  const again = outbox(storage);
  assert.equal(again.pending(), 1);
  send.down = false;
  assert.equal(await again.flush(send), true);
  assert.equal(send.calls[0].rows[0].id, "a");
  assert.equal(outbox(storage).pending(), 0);
});

test("outbox: a set saved or changed while a flush runs goes up in that flush, with its new values", async () => {
  const box = outbox(memory());
  box.put("gym_sets", aSet("a", 5));
  const calls = [];
  const slow = async (call) => {
    calls.push(structuredClone(call));
    if (calls.length === 1) { box.put("gym_sets", aSet("a", 7)); box.put("gym_sets", aSet("b", 4)); }
  };
  assert.equal(await box.flush(slow), true);
  assert.deepEqual(calls.map((c) => c.rows.map((r) => `${r.id}${r.reps}`)), [["a5"], ["a7", "b4"]]);
  assert.equal(box.pending(), 0);
});

test("outbox: Undo turns a queued set into a delete, sent after the upserts", async () => {
  const box = outbox(memory());
  box.put("gym_sessions", { id: "s1", program_day_id: "d1", started_at: "2026-01-05T14:50:00Z", finished_at: null });
  box.put("gym_sets", aSet("a", 5));
  box.drop("gym_sets", "a");
  const send = server();
  await box.flush(send);
  assert.deepEqual(send.calls, [{ op: "upsert", table: "gym_sessions", rows: [{ id: "s1", program_day_id: "d1", started_at: "2026-01-05T14:50:00Z", finished_at: null }] },
    { op: "delete", table: "gym_sets", ids: ["a"] }]);
  // Saving it again after the Undo brings it back as an upsert.
  box.drop("gym_sets", "b");
  box.put("gym_sets", aSet("b", 5));
  await box.flush(send);
  assert.deepEqual(send.calls.at(-1), { op: "upsert", table: "gym_sets", rows: [aSet("b", 5)] });
});

test("outbox: a baseline is keyed by its exercise, and two flushes at once send once", async () => {
  const box = outbox(memory());
  box.put("gym_baselines", { exercise_id: "wp", weight_lb: 100, confirmed: true });
  box.put("gym_baselines", { exercise_id: "wp", weight_lb: 105, confirmed: true });
  const send = server();
  await Promise.all([box.flush(send), box.flush(send)]);
  assert.deepEqual(send.calls, [{ op: "upsert", table: "gym_baselines", rows: [{ exercise_id: "wp", weight_lb: 105, confirmed: true }] }]);
});

test("outbox: a flush asked for while a failing one runs tries again after it", async () => {
  const box = outbox(memory());
  box.put("gym_sets", aSet("a", 5));
  const calls = [];
  let fail = true;
  const send = async (call) => { await null; if (fail) { fail = false; throw new Error("offline"); } calls.push(call); };
  const first = box.flush(send);
  const second = box.flush(send);
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(calls.length, 1);
  assert.equal(box.pending(), 0);
});

test("outbox: storage that throws (a private window) still queues in memory", async () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  const box = outbox(broken);
  box.put("gym_sets", aSet("a", 5));
  assert.equal(box.pending(), 1);
  const send = server();
  await box.flush(send);
  assert.equal(send.calls.length, 1);
});
