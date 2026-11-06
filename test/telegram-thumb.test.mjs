// The bot at a block boundary, its stale buttons, and the thumb keyboard (research/plan-phone.md
// P3, P5, P6): src/sheet/nudges.mjs (whatToSend, deadButtons, keyStep, readTap, handleTap) and
// src/sheet/capture.mjs (readKey, readText). Wednesday 2026-11-04 in New York, EST (UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { whatToSend, deadButtons, keyStep, readTap, handleTap, needsTappedBlock, silent } from "../src/sheet/nudges.mjs";
import { readKey, readText } from "../src/sheet/capture.mjs";

const TZ = "America/New_York";
const day = "2026-11-04";
const B = (n) => `0b0b0b0b-0000-4000-8000-00000000000${n}`;
const T = (n) => `0c0c0c0c-0000-4000-8000-00000000000${n}`;
const settings = { time_zone: TZ, telegram_chat_id: 42, nudges_on: true, morning_on: false };
const task = (id, title, extra = {}) => ({ id, title, day, done: false, due: null, est_min: null, at_time: null, ...extra });
const block = (id, task_id, starts_at, ends_at, extra = {}) => ({ id, task_id, starts_at, ends_at, proposed: false, gcal_id: null, ...extra });
const sent = (block_id, kind, send_at, extra = {}) => ({ block_id, kind, day, send_at, sent_at: send_at, ...extra });
const at = (iso) => new Date(iso);

const os = task(T(1), "OS homework");
const gym = task(T(2), "Gym");
const b1 = block(B(1), T(1), "2026-11-04T14:30:00Z", "2026-11-04T15:15:00Z"); // 9:30-10:15 am
const b2 = block(B(2), T(2), "2026-11-04T15:15:00Z", "2026-11-04T16:00:00Z"); // 10:15-11:00 am
const briefSent = sent(null, "brief", "2026-11-04T13:00:00.000Z");
const nudged = [briefSent, sent(B(1), "start", "2026-11-04T14:30:00.000Z", { tg_message_id: 501 }), sent(B(1), "repeat", "2026-11-04T14:40:00.000Z", { tg_message_id: 502 })];
const snapshot = (extra = {}) => ({ settings, day: null, tasks: [os, gym], blocks: [b1, b2], log: nudged, busy: [], proposal: null, needsOpen: [], campus: [], ...extra });

const finishedButtons = (id) => [
  { text: "Finished", callback_data: `finished:${id}` },
  { text: "More time", callback_data: `more:${id}` },
  { text: "Didn't start", callback_data: `nostart:${id}` },
  { text: "Tomorrow", callback_data: `tomorrow:${id}` },
];
const tapButtons = (id) => [{ text: "Done", callback_data: `done:${id}` }, { text: "Snooze 10 min", callback_data: `snooze:${id}` }];

// ---------------------------------------------------------------- P3: one message at a boundary

test("boundary: Finished? and the next block's start go as one message with two button rows", () => {
  const out = whatToSend(snapshot(), at("2026-11-04T15:15:00Z"));
  assert.deepEqual(out, [{
    kind: "finished", block_id: B(1), day, send_at: "2026-11-04T15:15:00.000Z",
    text: "Finished? · OS homework\nNext: ▶ 10:15 am · Gym (45 min)",
    buttons: finishedButtons(B(1)),
    keyboard: [finishedButtons(B(1)), tapButtons(B(2))],
    also: [{ kind: "start", block_id: B(2), day, send_at: "2026-11-04T15:15:00.000Z" }],
  }]);
  // It asks him to start something now, so it rings, though a Finished? alone is silent.
  assert.equal(silent(out[0]), false);
});

test("boundary: a start five minutes after the end still joins; ten minutes after goes alone", () => {
  const near = block(B(2), T(2), "2026-11-04T15:20:00Z", "2026-11-04T16:00:00Z");
  const [m] = whatToSend(snapshot({ blocks: [b1, near] }), at("2026-11-04T15:20:00Z"));
  assert.equal(m.kind, "finished");
  assert.equal(m.also[0].block_id, B(2));
  const far = block(B(2), T(2), "2026-11-04T15:25:00Z", "2026-11-04T16:00:00Z");
  const alone = whatToSend(snapshot({ blocks: [b1, far] }), at("2026-11-04T15:15:00Z"));
  assert.deepEqual(alone.map((x) => x.kind), ["finished"]);
  assert.equal(alone[0].also, undefined);
});

test("boundary: a start already sent is not sent again inside a Finished?", () => {
  const log = [...nudged, sent(B(2), "start", "2026-11-04T15:15:00.000Z")];
  const out = whatToSend(snapshot({ log }), at("2026-11-04T15:16:00Z"));
  assert.deepEqual(out.map((x) => [x.kind, x.also]), [["finished", undefined]]);
});

// ---------------------------------------------------------------- P5: dead buttons

test("dead buttons: a block's new message takes the buttons off its earlier ones", () => {
  const [m] = whatToSend(snapshot({ blocks: [b1] }), at("2026-11-04T15:15:00Z"));
  assert.deepEqual(deadButtons(m, nudged), [501, 502]);
});

test("dead buttons: none for a message without a block, or a block never messaged before", () => {
  assert.deepEqual(deadButtons({ kind: "brief", block_id: null, send_at: "2026-11-04T13:00:00.000Z" }, nudged), []);
  assert.deepEqual(deadButtons({ kind: "start", block_id: B(2), send_at: "2026-11-04T15:15:00.000Z" }, nudged), []);
});

test("dead buttons: a tap on one message clears the block's others, not the tapped one", () => {
  assert.deepEqual(deadButtons({ block_id: B(1) }, nudged, 502), [501]);
});

// ---------------------------------------------------------------- P6: the thumb keyboard

const msg = (text, chat = 42) => ({ message: { message_id: 9, chat: { id: chat }, text } });

test("keys: the four labels and their commands are keys, never messages to Claude", () => {
  for (const [text, key] of [["Now", "now"], ["Done", "done"], ["+15 min", "more15"], ["Today", "today"], ["/now", "now"], ["/today", "today"], ["/start", "keys"], ["/keys", "keys"], [" Done ", "done"]]) {
    assert.deepEqual(readKey(msg(text), settings), { key, chat_id: 42, message_id: 9 }, text);
    assert.equal(readText(msg(text), settings), null, text);
  }
});

test("keys: any other text is still captured, and another chat's key is nothing", () => {
  assert.equal(readKey(msg("Done with the lab report, add a review"), settings), null);
  assert.deepEqual(readText(msg("Done with the lab report, add a review"), settings), { text: "Done with the lab report, add a review", chat_id: 42, message_id: 9 });
  assert.equal(readKey(msg("Now"), { ...settings, telegram_chat_id: 7 }), null);
});

test("key Now: the pinned line and the running block's Done and Snooze", () => {
  const r = keyStep("now", snapshot(), at("2026-11-04T14:50:00Z"));
  assert.deepEqual(r, { changes: [], block_id: B(1), text: "Now: OS homework until 10:15 am · Next: Gym at 10:15 am", keyboard: [tapButtons(B(1))] });
});

test("key Done: marks the running block's task done, as the Done tap does", () => {
  const r = keyStep("done", snapshot(), at("2026-11-04T14:50:00Z"));
  assert.equal(r.text, "✓ Done · OS homework");
  assert.equal(r.block_id, B(1));
  assert.deepEqual(r.changes, handleTap({ action: "done", block_id: B(1) }, snapshot(), at("2026-11-04T14:50:00Z")).changes);
});

test("key Done between blocks: nothing changes", () => {
  const r = keyStep("done", snapshot({ blocks: [b1] }), at("2026-11-04T15:30:00Z"));
  assert.deepEqual(r, { changes: [], text: "Nothing is on right now." });
});

test("key +15 min: the running block runs 15 minutes longer when they're free", () => {
  const r = keyStep("more15", snapshot({ blocks: [b1] }), at("2026-11-04T15:00:00Z"));
  assert.deepEqual(r.changes, [{ table: "blocks", id: B(1), update: { ends_at: "2026-11-04T15:30:00.000Z" } }]);
  assert.equal(r.text, "More time: until 10:30 am · OS homework");
});

test("key +15 min: a block that just ended gets the 15 minutes too; a taken slot is refused", () => {
  const r = keyStep("more15", snapshot({ blocks: [b1] }), at("2026-11-04T15:20:00Z"));
  assert.equal(r.text, "More time: until 10:30 am · OS homework");
  const busy = keyStep("more15", snapshot(), at("2026-11-04T15:00:00Z"));
  assert.deepEqual(busy.changes, []);
  assert.equal(busy.text, "The next 15 min aren't free · OS homework");
});

test("key Today: today's open tasks, a Done button each", () => {
  const read = task(T(3), "Read ch. 4");
  const r = keyStep("today", snapshot({ tasks: [os, gym, read, task(T(4), "Laundry", { done: true })] }), at("2026-11-04T14:50:00Z"));
  assert.equal(r.text, "Today: 3 left.\n9:30 am · OS homework\n10:15 am · Gym\nRead ch. 4");
  assert.deepEqual(r.keyboard, [
    [{ text: "Done: OS homework", callback_data: `td:${T(1)}` }],
    [{ text: "Done: Gym", callback_data: `td:${T(2)}` }],
    [{ text: "Done: Read ch. 4", callback_data: `td:${T(3)}` }],
  ]);
});

test("Today's Done tap marks that task done", () => {
  const update = { callback_query: { id: "q", data: `td:${T(3)}`, message: { message_id: 7, chat: { id: 42 } } } };
  const t = readTap(update, settings);
  assert.deepEqual(t, { action: "taskdone", task_id: T(3), query_id: "q", chat_id: 42, message_id: 7 });
  const snap = snapshot({ tasks: [os, gym, task(T(3), "Read ch. 4")] });
  assert.equal(needsTappedBlock(snap, t), false);
  assert.deepEqual(handleTap(t, snap, at("2026-11-04T14:50:00Z")), { changes: [{ table: "tasks", id: T(3), update: { done: true } }], text: "✓ Done · Read ch. 4" });
});
