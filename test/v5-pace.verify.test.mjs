// Verification tests for v5 P1, Finished? and pace: the Finished? check and its four answers in
// src/sheet/nudges.mjs (whatToSend, readTap, handleTap), and pace in src/sheet/pace.mjs
// (paceKind, paceByKind, pacedMinutes, plannedVsDone). Written before the code from
// docs/sheet-v5.md "Contracts" and spec 47. Every test starts as `todo`; the implementer removes
// `todo` and must not change an expectation. Expected values are written out by hand. Modules are
// imported inside each test, so this file loads before the code exists.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5). OS homework's block runs 9:30-10:15 am
// (14:30-15:15 UTC); its start nudge went out at 9:30 and its repeat at 9:40.
//
// Readings chosen where the contract leaves room (closest to its words):
// - The order of a tap's changes isn't part of the contract; tests sort them.
// - Finished?'s minutes count every approved block of the task that started before the tap, on
//   any day, each up to the earlier of its end and the tap.
import { test } from "node:test";
import assert from "node:assert/strict";

const nudges = () => import("../src/sheet/nudges.mjs");
const pace = () => import("../src/sheet/pace.mjs");
const todo = { todo: true };

const TZ = "America/New_York";
const day = "2026-11-04";
const B = (n) => `0b0b0b0b-0000-4000-8000-00000000000${n}`;
const settings = { time_zone: TZ, telegram_chat_id: 42, nudges_on: true, morning_on: false };
const task = (id, title, extra = {}) => ({ id, title, day, done: false, due: null, public: true, est_min: null, at_time: null, rolls: 0, ...extra });
const block = (id, task_id, starts_at, ends_at, extra = {}) => ({ id, task_id, starts_at, ends_at, proposed: false, gcal_id: null, ...extra });
const sent = (block_id, kind, send_at) => ({ block_id, kind, day, send_at, sent_at: send_at });
const at = (iso) => new Date(iso);

const osHomework = task("t1", "OS homework", { est_min: 45 });
const gym = task("t2", "Gym", { est_min: 60 });
const b1 = block(B(1), "t1", "2026-11-04T14:30:00Z", "2026-11-04T15:15:00Z", { gcal_id: "ev1" }); // 9:30-10:15 am
const briefSent = sent(null, "brief", "2026-11-04T13:00:00.000Z");
const nudged = [briefSent, sent(B(1), "start", "2026-11-04T14:30:00.000Z"), sent(B(1), "repeat", "2026-11-04T14:40:00.000Z")];
const snapshot = (extra = {}) => ({ settings, day: null, tasks: [osHomework, gym], blocks: [b1], log: nudged, busy: [], proposal: null, needsOpen: [], campus: [], ...extra });

const finishedButtons = (id) => [
  { text: "Finished", callback_data: `finished:${id}` },
  { text: "More time", callback_data: `more:${id}` },
  { text: "Didn't start", callback_data: `nostart:${id}` },
  { text: "Tomorrow", callback_data: `tomorrow:${id}` },
];
const finishedAt = (send_at) => ({ kind: "finished", block_id: B(1), day, send_at, text: "Finished? · OS homework", buttons: finishedButtons(B(1)) });

// =============================================================================================
// When Finished? is sent
// =============================================================================================

test("Finished?: sent when a nudged block ends, with its four buttons", todo, async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(snapshot(), at("2026-11-04T15:15:00Z")), [finishedAt("2026-11-04T15:15:00.000Z")]);
});

test("Finished?: not before the block ends", todo, async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(snapshot(), at("2026-11-04T15:14:00Z")), []);
});

test("Finished?: a late run still sends it within 30 minutes of the end, not after", todo, async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(snapshot(), at("2026-11-04T15:44:00Z")), [finishedAt("2026-11-04T15:15:00.000Z")]);
  assert.deepEqual(whatToSend(snapshot(), at("2026-11-04T15:45:00Z")), []);
});

test("Finished?: once per block end", todo, async () => {
  const { whatToSend } = await nudges();
  const log = [...nudged, sent(B(1), "finished", "2026-11-04T15:15:00.000Z")];
  assert.deepEqual(whatToSend(snapshot({ log }), at("2026-11-04T15:20:00Z")), []);
});

test("Finished?: skipped for a block that was never nudged", todo, async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(snapshot({ log: [briefSent] }), at("2026-11-04T15:15:00Z")), []);
});

test("Finished?: skipped when the task is already done", todo, async () => {
  const { whatToSend } = await nudges();
  const tasks = [{ ...osHomework, done: true }, gym];
  assert.deepEqual(whatToSend(snapshot({ tasks }), at("2026-11-04T15:15:00Z")), []);
});

test("Finished?: skipped when the day is shut down", todo, async () => {
  const { whatToSend } = await nudges();
  const shut = { day, planned: true, shutdown: true, shutdown_at: null, reflection: null };
  assert.deepEqual(whatToSend(snapshot({ day: shut }), at("2026-11-04T15:15:00Z")), []);
});

test("Finished?: a block ending at 10:45 pm, before quiet hours, still gets one", todo, async () => {
  const { whatToSend } = await nudges();
  // 10:00-10:45 pm, nudged at 10:00 pm; the check-in went out at 5:00 pm.
  const late = block(B(5), "t1", "2026-11-05T03:00:00Z", "2026-11-05T03:45:00Z");
  const log = [briefSent, sent(B(5), "start", "2026-11-05T03:00:00.000Z"), sent(B(5), "repeat", "2026-11-05T03:10:00.000Z"),
    sent(null, "checkin", "2026-11-04T22:00:00.000Z")];
  assert.deepEqual(whatToSend(snapshot({ blocks: [late], log }), at("2026-11-05T03:45:00Z")), [{
    kind: "finished", block_id: B(5), day, send_at: "2026-11-05T03:45:00.000Z", text: "Finished? · OS homework", buttons: finishedButtons(B(5)),
  }]);
});

test("More time asks again at the new end", todo, async () => {
  const { whatToSend } = await nudges();
  // The block now runs to 10:45 am; the first Finished? went out at 10:15.
  const longer = { ...b1, ends_at: "2026-11-04T15:45:00Z" };
  const log = [...nudged, sent(B(1), "finished", "2026-11-04T15:15:00.000Z")];
  assert.deepEqual(whatToSend(snapshot({ blocks: [longer], log }), at("2026-11-04T15:45:00Z")), [finishedAt("2026-11-04T15:45:00.000Z")]);
});

// =============================================================================================
// The nudge budget
// =============================================================================================

const others = (n) => Array.from({ length: n }, (_, i) => sent(`x${i}`, "start", `2026-11-04T1${3 + i}:05:00.000Z`));

test("budget: with all six slots used, Finished? isn't sent", todo, async () => {
  const { whatToSend } = await nudges();
  // OS homework's start and repeat, and four other nudges.
  assert.deepEqual(whatToSend(snapshot({ log: [...nudged, ...others(4)] }), at("2026-11-04T15:15:00Z")), []);
});

test("budget: Finished? takes only the slots left after the kept nudges still to go out", todo, async () => {
  const { whatToSend } = await nudges();
  // Gym's 2:00 pm block is one of the first six, so its nudge holds a slot.
  const gymBlock = block(B(2), "t2", "2026-11-04T19:00:00Z", "2026-11-04T20:00:00Z");
  const blocks = [b1, gymBlock];
  // 5 used + 1 held: none left.
  assert.deepEqual(whatToSend(snapshot({ blocks, log: [...nudged, ...others(3)] }), at("2026-11-04T15:15:00Z")), []);
  // 4 used + 1 held: one left, for Finished?.
  assert.deepEqual(whatToSend(snapshot({ blocks, log: [...nudged, ...others(2)] }), at("2026-11-04T15:15:00Z")), [finishedAt("2026-11-04T15:15:00.000Z")]);
});

test("budget: a Finished? that went out counts toward it", todo, async () => {
  const { handleTap } = await nudges();
  const gymBlock = block(B(2), "t2", "2026-11-04T19:00:00Z", "2026-11-04T20:00:00Z");
  const base = [...nudged, ...others(2), sent(B(2), "start", "2026-11-04T19:00:00.000Z")]; // 5 used
  const snoozeAt = at("2026-11-04T19:05:00Z");
  // With the Finished? logged, all six are used and a Snooze on Gym is refused.
  const full = snapshot({ blocks: [b1, gymBlock], log: [...base, sent(B(1), "finished", "2026-11-04T15:15:00.000Z")] });
  assert.deepEqual(handleTap({ action: "snooze", block_id: B(2) }, full, snoozeAt), { changes: [], text: "No nudges left today · Gym" });
  // Without it, one slot is left.
  const open = snapshot({ blocks: [b1, gymBlock], log: base });
  assert.equal(handleTap({ action: "snooze", block_id: B(2) }, open, snoozeAt).changes.length, 1);
});

// =============================================================================================
// Reading the taps
// =============================================================================================

const update = (data, chat = 42) => ({ callback_query: { id: "q1", data, message: { message_id: 7, chat: { id: chat } } } });

test("readTap: the four Finished? buttons name the action and the block", todo, async () => {
  const { readTap } = await nudges();
  for (const action of ["finished", "more", "nostart", "tomorrow"]) {
    assert.deepEqual(readTap(update(`${action}:${B(1)}`), settings), { action, block_id: B(1), query_id: "q1", chat_id: 42, message_id: 7 });
  }
});

test("readTap: a Finished? button without a block UUID, or from another chat, is ignored", todo, async () => {
  const { readTap } = await nudges();
  assert.equal(readTap(update("finished:abc"), settings), null);
  assert.equal(readTap(update("finish:" + B(1)), settings), null);
  assert.equal(readTap(update("more:"), settings), null);
  assert.equal(readTap(update(`tomorrow:${B(1)}`, 99), settings), null);
});

// =============================================================================================
// The four answers
// =============================================================================================

const key = (c) => `${c.table ?? ""}:${c.id ?? ""}:${c.rpc ?? ""}:${JSON.stringify(c.insert ?? c.args ?? c.update ?? null)}`;
const sorted = (r) => ({ ...r, changes: [...r.changes].sort((a, b) => key(a).localeCompare(key(b))) });
const tapAt = at("2026-11-04T15:17:00Z"); // 10:17 am

// OS homework also has 30 minutes on Tuesday, an approved block at 2:00 pm with its event, and a
// proposed one at 4:00 pm.
const b3 = block(B(3), "t1", "2026-11-04T19:00:00Z", "2026-11-04T19:45:00Z", { gcal_id: "ev3" });
const b4 = block(B(4), "t1", "2026-11-03T20:00:00Z", "2026-11-03T20:30:00Z");
const p1 = block(B(6), "t1", "2026-11-04T21:00:00Z", "2026-11-04T21:45:00Z", { proposed: true });
const busyDay = () => snapshot({ blocks: [b1, b3, b4, p1] });

test("Finished: marks the task done, applies the block rules, and records the minutes it took", todo, async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(sorted(handleTap({ action: "finished", block_id: B(1) }, busyDay(), tapAt)), sorted({
    changes: [
      { table: "blocks", id: B(3), delete: true },
      { table: "gcal_pending", insert: { gcal_id: "ev3", ends_at: null } },
      { table: "blocks", id: B(6), delete: true },
      { table: "tasks", id: "t1", update: { done: true } },
      // 45 minutes today and 30 on Tuesday.
      { table: "actuals", insert: { day, task_id: "t1", block_id: B(1), kind: "other", est_min: 45, minutes: 75 } },
    ],
    text: "✓ Done in 75 min · OS homework",
  }));
});

test("Finished: a course task records kind course; a task with no estimate records est_min null", todo, async () => {
  const { handleTap } = await nudges();
  const hw = task("t4", "HW3", { day: null, list: "Brightspace", source: "brightspace", est_min: 30, due: "2026-11-09" });
  const chores = task("t5", "Laundry");
  const hwBlock = block(B(7), "t4", "2026-11-04T18:00:00Z", "2026-11-04T18:45:00Z"); // 1:00-1:45 pm
  const choreBlock = block(B(8), "t5", "2026-11-04T19:00:00Z", "2026-11-04T19:20:00Z"); // 2:00-2:20 pm
  const snap = snapshot({ tasks: [hw, chores], blocks: [hwBlock, choreBlock] });
  const hwOut = handleTap({ action: "finished", block_id: B(7) }, snap, at("2026-11-04T18:46:00Z"));
  assert.deepEqual(hwOut.changes.find((c) => c.table === "actuals"), { table: "actuals", insert: { day, task_id: "t4", block_id: B(7), kind: "course", est_min: 30, minutes: 45 } });
  const choreOut = handleTap({ action: "finished", block_id: B(8) }, snap, at("2026-11-04T19:21:00Z"));
  assert.deepEqual(choreOut.changes.find((c) => c.table === "actuals"), { table: "actuals", insert: { day, task_id: "t5", block_id: B(8), kind: "other", est_min: null, minutes: 20 } });
});

test("More time: extends the block 30 minutes when that time is free, and its event with it", todo, async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(sorted(handleTap({ action: "more", block_id: B(1) }, snapshot(), at("2026-11-04T15:16:00Z"))), sorted({
    changes: [
      { table: "blocks", id: B(1), update: { ends_at: "2026-11-04T15:45:00.000Z" } },
      { table: "gcal_pending", insert: { gcal_id: "ev1", ends_at: "2026-11-04T15:45:00.000Z" } },
    ],
    text: "More time: until 10:45 am · OS homework",
  }));
});

test("More time: a proposed block in the way doesn't count, and a busy time starting at the new end is fine", todo, async () => {
  const { handleTap } = await nudges();
  const inTheWay = block(B(6), "t2", "2026-11-04T15:15:00Z", "2026-11-04T16:15:00Z", { proposed: true });
  const busy = [{ starts_at: "2026-11-04T15:45:00Z", ends_at: "2026-11-04T16:45:00Z" }]; // from 10:45 am
  const r = handleTap({ action: "more", block_id: B(1) }, snapshot({ blocks: [b1, inTheWay], busy }), at("2026-11-04T15:16:00Z"));
  assert.equal(r.text, "More time: until 10:45 am · OS homework");
});

test("More time: when a busy time or another approved block takes the next 30 minutes, it says so and changes nothing", todo, async () => {
  const { handleTap } = await nudges();
  const notFree = { changes: [], text: "The next 30 min aren't free · OS homework" };
  const busy = [{ starts_at: "2026-11-04T15:30:00Z", ends_at: "2026-11-04T16:30:00Z" }]; // 10:30-11:30 am
  assert.deepEqual(handleTap({ action: "more", block_id: B(1) }, snapshot({ busy }), at("2026-11-04T15:16:00Z")), notFree);
  const gymNext = block(B(2), "t2", "2026-11-04T15:30:00Z", "2026-11-04T16:30:00Z");
  assert.deepEqual(handleTap({ action: "more", block_id: B(1) }, snapshot({ blocks: [b1, gymNext] }), at("2026-11-04T15:16:00Z")), notFree);
});

test("More time: not past 11 pm", todo, async () => {
  const { handleTap } = await nudges();
  // 10:00-10:45 pm: 30 more would end at 11:15 pm.
  const late = block(B(5), "t1", "2026-11-05T03:00:00Z", "2026-11-05T03:45:00Z");
  assert.deepEqual(handleTap({ action: "more", block_id: B(5) }, snapshot({ blocks: [late] }), at("2026-11-05T03:46:00Z")), {
    changes: [], text: "Too close to quiet hours · OS homework",
  });
});

test("Didn't start: leaves the task open and records nothing", todo, async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(handleTap({ action: "nostart", block_id: B(1) }, busyDay(), tapAt), { changes: [], text: "Left open · OS homework" });
});

test("Tomorrow: rolls the task at once and clears its blocks still to come today", todo, async () => {
  const { handleTap } = await nudges();
  assert.deepEqual(sorted(handleTap({ action: "tomorrow", block_id: B(1) }, busyDay(), tapAt)), sorted({
    changes: [
      { table: "blocks", id: B(3), delete: true },
      { table: "gcal_pending", insert: { gcal_id: "ev3", ends_at: null } },
      { table: "blocks", id: B(6), delete: true },
      { rpc: "roll_tasks", args: { ids: ["t1"], target: "2026-11-05" } },
    ],
    text: "Moved to tomorrow · OS homework",
  }));
});

test("Tomorrow: a task from a Someday list moves onto tomorrow", todo, async () => {
  const { handleTap } = await nudges();
  const hw = task("t4", "HW3", { day: null, list: "Brightspace", source: "brightspace", est_min: 30 });
  const hwBlock = block(B(7), "t4", "2026-11-04T14:30:00Z", "2026-11-04T15:15:00Z");
  assert.deepEqual(handleTap({ action: "tomorrow", block_id: B(7) }, snapshot({ tasks: [hw], blocks: [hwBlock] }), tapAt), {
    changes: [{ table: "tasks", id: "t4", update: { day: "2026-11-05", list: null } }],
    text: "Moved to tomorrow · HW3",
  });
});

test("the answers on a done task, or a block no longer there, change nothing", todo, async () => {
  const { handleTap } = await nudges();
  const done = snapshot({ tasks: [{ ...osHomework, done: true }, gym] });
  for (const action of ["finished", "more", "nostart", "tomorrow"]) {
    assert.deepEqual(handleTap({ action, block_id: B(1) }, done, tapAt), { changes: [], text: "✓ Done" }, action);
    assert.deepEqual(handleTap({ action, block_id: B(9) }, snapshot(), tapAt), { changes: [], text: "That block is no longer on the plan." }, action);
  }
});

// =============================================================================================
// Pace
// =============================================================================================

test("paceKind: course, campus, GitHub, Jira, or other", todo, async () => {
  const { paceKind } = await pace();
  assert.equal(paceKind({ source: "brightspace", tag: null }), "course");
  assert.equal(paceKind({ source: "brightspace", tag: "campus" }), "course");
  assert.equal(paceKind({ source: null, tag: "campus" }), "campus");
  assert.equal(paceKind({ source: "github", tag: null }), "github");
  assert.equal(paceKind({ source: "jira", tag: null }), "jira");
  assert.equal(paceKind({ source: "mail", tag: null }), "other");
  assert.equal(paceKind({ source: null, tag: "workit" }), "other");
});

let n = 0;
// One finished task: its estimate and what it took, a day apart in order.
const row = (kind, est_min, minutes) => {
  n += 1;
  return { id: `a${n}`, at: new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString(), day: "2026-10-01", task_id: `t${n}`, block_id: null, kind, est_min, minutes };
};
const none = { pace: null, n: 0 };

test("paceByKind: fewer than 5 finished tasks of a kind give no pace", todo, async () => {
  const { paceByKind } = await pace();
  const rows = [row("course", 30, 60), row("course", 30, 60), row("course", 30, 60), row("course", 30, 60)];
  assert.deepEqual(paceByKind(rows), { course: { pace: null, n: 4 }, campus: none, github: none, jira: none, other: none });
});

test("paceByKind: 5 samples give the median of actual over estimate", todo, async () => {
  const { paceByKind } = await pace();
  // 1, 1.5, 2, 1.2 and 0.8: the median is 1.2.
  const rows = [row("course", 30, 30), row("course", 40, 60), row("course", 30, 60), row("course", 50, 60), row("course", 50, 40)];
  assert.deepEqual(paceByKind(rows).course, { pace: 1.2, n: 5 });
});

test("paceByKind: an even count takes the mean of the middle two", todo, async () => {
  const { paceByKind } = await pace();
  // 1, 2, 1.5, 0.5, 1 and 3, sorted 0.5 1 1 1.5 2 3: (1 + 1.5) / 2.
  const rows = [row("other", 60, 60), row("other", 30, 60), row("other", 40, 60), row("other", 60, 30), row("other", 45, 45), row("other", 20, 60)];
  assert.deepEqual(paceByKind(rows).other, { pace: 1.25, n: 6 });
});

test("paceByKind: pace is held between 0.5 and 3", todo, async () => {
  const { paceByKind } = await pace();
  const slow = Array.from({ length: 5 }, () => row("jira", 15, 60));   // 4 each
  const fast = Array.from({ length: 5 }, () => row("github", 60, 15)); // 0.25 each
  const out = paceByKind([...slow, ...fast]);
  assert.deepEqual(out.jira, { pace: 3, n: 5 });
  assert.deepEqual(out.github, { pace: 0.5, n: 5 });
});

test("paceByKind: rounded to 2 decimals", todo, async () => {
  const { paceByKind } = await pace();
  // 1, 1, 40/30, 1.4 and 1.5: the median is 1.333…
  const rows = [row("campus", 30, 30), row("campus", 60, 60), row("campus", 30, 40), row("campus", 50, 70), row("campus", 40, 60)];
  assert.deepEqual(paceByKind(rows).campus, { pace: 1.33, n: 5 });
});

test("paceByKind: rows with no estimate don't count", todo, async () => {
  const { paceByKind } = await pace();
  const rows = [row("course", null, 90), row("course", 0, 90), ...Array.from({ length: 4 }, () => row("course", 30, 45))];
  assert.deepEqual(paceByKind(rows).course, { pace: null, n: 4 });
});

test("paceByKind: only the newest 20 of a kind count", todo, async () => {
  const { paceByKind } = await pace();
  const older = Array.from({ length: 20 }, () => row("course", 30, 60)); // 2 each
  const newer = Array.from({ length: 20 }, () => row("course", 30, 30)); // 1 each
  // Given newest first, to show it goes by `at`, not by order.
  assert.deepEqual(paceByKind([...newer, ...older].reverse()).course, { pace: 1, n: 20 });
});

const paces = (course = null, other = null) => ({
  course: { pace: course, n: course == null ? 0 : 8 }, campus: none, github: none, jira: none, other: { pace: other, n: other == null ? 0 : 8 },
});

test("pacedMinutes: the estimate rounded to 15 when the kind has no pace yet, or 30 with no estimate", todo, async () => {
  const { pacedMinutes } = await pace();
  assert.equal(pacedMinutes({ est_min: 45, source: null }, paces()), 45);
  assert.equal(pacedMinutes({ est_min: 20, source: null }, paces()), 15);
  assert.equal(pacedMinutes({ est_min: 50, source: null }, paces()), 45);
  assert.equal(pacedMinutes({ est_min: null, source: null }, paces()), 30);
});

test("pacedMinutes: estimate times the kind's pace, rounded to the nearest 15, held to 15-240", todo, async () => {
  const { pacedMinutes } = await pace();
  assert.equal(pacedMinutes({ est_min: 45, source: null }, paces(null, 1.3)), 60);   // 58.5
  assert.equal(pacedMinutes({ est_min: 30, source: null }, paces(null, 1.25)), 45);  // 37.5, half up
  assert.equal(pacedMinutes({ est_min: 60, source: null }, paces(null, 1.2)), 75);   // 72
  assert.equal(pacedMinutes({ est_min: 200, source: null }, paces(null, 3)), 240);   // 600
  assert.equal(pacedMinutes({ est_min: 10, source: null }, paces(null, 0.5)), 15);   // 5
  // A course task uses the course pace, not the other one.
  assert.equal(pacedMinutes({ est_min: 30, source: "brightspace" }, paces(2, 1)), 60);
});

test("plannedVsDone: approved block minutes and the done share, for the 14 days before", todo, async () => {
  const { plannedVsDone } = await pace();
  const tasks = [{ id: "d1", done: true }, { id: "u1", done: false }];
  const blocks = [
    block("k1", "d1", "2026-11-02T14:00:00Z", "2026-11-02T15:00:00Z"),                   // Mon, 60, done
    block("k2", "u1", "2026-11-02T16:00:00Z", "2026-11-02T16:30:00Z"),                   // Mon, 30, not done
    block("k3", "d1", "2026-11-03T14:00:00Z", "2026-11-03T14:45:00Z"),                   // Tue, 45, done
    block("k4", "u1", "2026-11-03T18:00:00Z", "2026-11-03T19:00:00Z", { proposed: true }), // proposed: not planned
    block("k5", "d1", "2026-10-20T14:00:00Z", "2026-10-20T15:00:00Z"),                   // 15 days before
    block("k6", "d1", "2026-11-04T14:00:00Z", "2026-11-04T15:00:00Z"),                   // the day itself
    block("k7", "d1", "2026-10-21T14:00:00Z", "2026-10-21T14:15:00Z"),                   // 14 days before
  ];
  assert.deepEqual(plannedVsDone(blocks, tasks, day, TZ), [
    { day: "2026-10-21", planned_min: 15, done_min: 15 },
    { day: "2026-11-02", planned_min: 90, done_min: 60 },
    { day: "2026-11-03", planned_min: 45, done_min: 45 },
  ]);
});
