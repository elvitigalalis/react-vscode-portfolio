// Focus mode on /plan (docs/sheet-focus.md): which block gets Start, the session's clock, the
// minutes it records into actuals, +15 min, the retried writes and Stuck's message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { focusTarget, startSession, focusClock, countdown, readSession, focusActual, extendFocus, drainOutbox, readOutbox, stuckMessage } from "../src/sheet/focus.mjs";

const TZ = "America/New_York";
const at = (iso) => new Date(iso);
const task = (id, extra = {}) => ({ id, title: `Task ${id}`, done: false, est_min: 45, ...extra });
const block = (id, task_id, starts_at, ends_at, extra = {}) => ({ id, task_id, starts_at, ends_at, proposed: false, ...extra });

// 2:00–2:45 pm and 4:00–5:00 pm EST on Nov 4.
const tasks = new Map([["t1", task("t1")], ["t2", task("t2")]]);
const blocks = [block("b2", "t2", "2026-11-04T21:00:00Z", "2026-11-04T22:00:00Z"), block("b1", "t1", "2026-11-04T19:00:00Z", "2026-11-04T19:45:00Z")];

test("the block on now gets Start", () => {
  assert.equal(focusTarget(blocks, tasks, at("2026-11-04T19:10:00Z"), TZ)?.id, "b1");
});

test("between blocks, the next one today gets Start", () => {
  assert.equal(focusTarget(blocks, tasks, at("2026-11-04T20:00:00Z"), TZ)?.id, "b2");
  assert.equal(focusTarget(blocks, tasks, at("2026-11-04T13:00:00Z"), TZ)?.id, "b1");
});

test("proposed blocks, done tasks, habit blocks and tomorrow's blocks get none", () => {
  const done = new Map([["t1", task("t1", { done: true })], ["t2", task("t2")]]);
  assert.equal(focusTarget(blocks, done, at("2026-11-04T19:10:00Z"), TZ)?.id, "b2");
  assert.equal(focusTarget([block("b3", "t1", "2026-11-04T19:00:00Z", "2026-11-04T19:45:00Z", { proposed: true })], tasks, at("2026-11-04T19:10:00Z"), TZ), null);
  assert.equal(focusTarget([block("b4", null, "2026-11-04T19:00:00Z", "2026-11-04T19:45:00Z", { habit_id: "h" })], tasks, at("2026-11-04T19:10:00Z"), TZ), null);
  // After 5 pm nothing is left today; tomorrow's 2 pm block waits for tomorrow.
  assert.equal(focusTarget([...blocks, block("b5", "t1", "2026-11-05T19:00:00Z", "2026-11-05T19:45:00Z")], tasks, at("2026-11-04T22:30:00Z"), TZ), null);
});

test("a session counts down to the block's end and up from Start", () => {
  const s = startSession(blocks[1], at("2026-11-04T19:05:00Z"));
  assert.deepEqual(s, { block_id: "b1", task_id: "t1", started_at: Date.parse("2026-11-04T19:05:00Z"), ends_at: Date.parse("2026-11-04T19:45:00Z") });
  assert.deepEqual(focusClock(s, at("2026-11-04T19:20:30Z")), { left: "24:30", elapsed: "15:30", over: false, share: 15.5 / 40 });
  // Past the end it says by how much, calmly, and the share stays full.
  assert.deepEqual(focusClock(s, at("2026-11-04T19:47:05Z")), { left: "+2:05", elapsed: "42:05", over: true, share: 1 });
});

test("Start on the next block counts its whole wait as time to its end", () => {
  const s = startSession(blocks[0], at("2026-11-04T20:00:00Z"));
  assert.equal(focusClock(s, at("2026-11-04T20:00:00Z")).left, "2:00:00");
});

test("countdown reads m:ss under an hour and h:mm:ss over", () => {
  assert.equal(countdown(0), "0:00");
  assert.equal(countdown(59_999), "0:59");
  assert.equal(countdown(3_600_000 + 61_000), "1:01:01");
});

test("a stored session reads back only when whole", () => {
  const s = { block_id: "b1", task_id: "t1", started_at: 1, ends_at: 2 };
  assert.deepEqual(readSession(JSON.stringify(s)), s);
  for (const bad of [null, "", "{", "[]", JSON.stringify({ ...s, ends_at: "x" }), JSON.stringify({ ...s, block_id: 3 })]) assert.equal(readSession(bad), null);
});

test("Done records the minutes since Start, on the session's day, as Finished does", () => {
  const s = startSession(blocks[1], at("2026-11-04T19:05:00Z"));
  assert.deepEqual(focusActual(s, task("t1", { source: "brightspace" }), at("2026-11-04T19:52:40Z"), TZ),
    { task: "t1", block: "b1", d: "2026-11-04", kind: "course", est: 45, minutes: 48 });
  // No estimate travels as null; under half a minute records nothing; a forgotten timer stops at 960.
  assert.equal(focusActual(s, task("t1", { est_min: null }), at("2026-11-04T19:35:00Z"), TZ).est, null);
  assert.equal(focusActual(s, task("t1"), at("2026-11-04T19:05:20Z"), TZ), null);
  assert.equal(focusActual(s, task("t1"), at("2026-11-06T19:05:00Z"), TZ).minutes, 960);
});

test("+15 min moves the block's end and the session's when the next 15 min are free", () => {
  const s = startSession(blocks[1], at("2026-11-04T19:05:00Z"));
  assert.deepEqual(extendFocus(s, blocks[1], [], TZ), { ends_at: "2026-11-04T20:00:00.000Z", session: { ...s, ends_at: Date.parse("2026-11-04T20:00:00Z") } });
  // An approved block or a busy event in those 15 minutes, or a past-11-pm end, refuses it.
  const next = block("b9", "t2", "2026-11-04T19:55:00Z", "2026-11-04T20:30:00Z");
  assert.deepEqual(extendFocus(s, blocks[1], [next], TZ), { why: "The next 15 min aren't free" });
  assert.deepEqual(extendFocus(s, blocks[1], [{ starts_at: "2026-11-04T19:30:00Z", ends_at: "2026-11-04T19:50:00Z" }], TZ), { why: "The next 15 min aren't free" });
  const late = block("b8", "t1", "2026-11-05T03:00:00Z", "2026-11-05T03:50:00Z"); // 10:00–10:50 pm
  assert.deepEqual(extendFocus(startSession(late, at("2026-11-05T03:00:00Z")), late, [], TZ), { why: "Too close to quiet hours" });
  // A proposed block doesn't count as taken; nor does the block itself.
  assert.ok(extendFocus(s, blocks[1], [{ ...next, proposed: true }, blocks[1]], TZ).ends_at);
});

test("+15 min with the block gone from the plan moves only the timer", () => {
  const s = startSession(blocks[1], at("2026-11-04T19:05:00Z"));
  assert.deepEqual(extendFocus(s, null, [], TZ), { ends_at: null, session: { ...s, ends_at: s.ends_at + 15 * 60_000 } });
});

test("writes run in order and stop at the first that fails, which stays for the next try", async () => {
  const ran = [];
  const ops = [{ op: "actual", n: 1 }, { op: "done", n: 2 }, { op: "extend", n: 3 }];
  const left = await drainOutbox(ops, async (o) => { if (o.n === 2 && ran.length < 2) { ran.push("fail"); throw new Error("offline"); } ran.push(o.n); });
  assert.deepEqual(left, ops.slice(1));
  assert.deepEqual(await drainOutbox(left, async (o) => { ran.push(o.n); }), []);
  assert.deepEqual(ran, [1, "fail", 2, 3]);
});

test("a stored outbox reads back as its whole ops only", () => {
  assert.deepEqual(readOutbox(JSON.stringify([{ op: "done", task: "t1" }, { op: "bogus" }, 3])), [{ op: "done", task: "t1" }]);
  assert.deepEqual(readOutbox("nope"), []);
  assert.deepEqual(readOutbox(null), []);
});

test("Stuck asks Claude for 2-4 smaller to-dos today, naming the task and its first step", () => {
  assert.equal(stuckMessage({ title: "OS homework" }, { first_step: "open HW4, do Q1" }, "2026-11-04"),
    "I'm stuck on \"OS homework\". Break it into 2-4 smaller to-dos for today (2026-11-04), about 10-25 min each, in the order to do them, each a concrete action. Its first step was: open HW4, do Q1.");
  assert.equal(stuckMessage({ title: "OS homework" }, null, "2026-11-04"),
    "I'm stuck on \"OS homework\". Break it into 2-4 smaller to-dos for today (2026-11-04), about 10-25 min each, in the order to do them, each a concrete action.");
});
