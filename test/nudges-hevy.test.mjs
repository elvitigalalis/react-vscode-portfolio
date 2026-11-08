// Hevy in the Telegram messages (src/sheet/nudges.mjs; docs/sheet-nudges.md, "Hevy"): the Nice
// lift after a synced workout, the brief's next routine and the optional Gym start nudge.
// Monday 2026-10-26 in New York (EDT, UTC-4). The workouts are made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { whatToSend, silent } from "../src/sheet/nudges.mjs";

const day = "2026-10-26";
const settings = { time_zone: "America/New_York", telegram_chat_id: 42, nudges_on: true };
const at = (iso) => new Date(iso);
const briefSent = { block_id: null, kind: "brief", day, send_at: "2026-10-26T12:00:00.000Z", sent_at: "2026-10-26T12:00:01Z" };
const openPlan = [{ text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" }];

// Push #1 last Thursday, Pull #1 on Saturday, Push #2 tonight 6:30 to 7:35 pm.
const push1 = { id: "w-push-1", title: "Push #1", routine_id: "r-push", day: "2026-10-22", starts_at: "2026-10-22T22:30:00+00:00", ends_at: "2026-10-22T23:30:00+00:00" };
const pull1 = { id: "w-pull-1", title: "Pull #1", routine_id: "r-pull", day: "2026-10-24", starts_at: "2026-10-24T14:00:00+00:00", ends_at: "2026-10-24T15:00:00+00:00" };
const push2 = { id: "w-push-2", title: "Push #2", routine_id: "r-push", day, starts_at: "2026-10-26T22:30:00+00:00", ends_at: "2026-10-26T23:35:00+00:00" };
const set = (workout_id, i, weight_kg, reps, set_type = "normal") => ({ workout_id, exercise_index: 0, set_index: i, template_id: "T-BENCH", exercise: "Bench Press", set_type, weight_kg, reps });
const sets = [
  set("w-push-1", 0, 40, 8, "warmup"), set("w-push-1", 1, 80, 6), set("w-push-1", 2, 80, 6),
  set("w-push-2", 0, 40, 8, "warmup"), set("w-push-2", 1, 84, 6), set("w-push-2", 2, 84, 5),
];
const hevy = (extra = {}) => ({
  account: { connected_at: "2026-10-20T12:00:00+00:00", synced_at: "2026-10-26T23:39:00+00:00", last_error: null, weight_unit: "lbs" },
  recent: [push2], history: [push1, pull1, push2], sets, sent: [], ...extra,
});
const snapshot = (extra = {}) => ({ settings, day: null, tasks: [], blocks: [], log: [briefSent], hevy: hevy(), ...extra });
const kinds = (msgs) => msgs.map((m) => m.kind);

// ---------------------------------------------------------------- Nice lift

test("nice lift: once the workout syncs, one silent message with its PRs, keyed by its end", () => {
  const [m, ...rest] = whatToSend(snapshot(), at("2026-10-26T23:40:00Z"));
  assert.deepEqual(rest, []);
  assert.deepEqual(m, {
    kind: "workout", block_id: null, day, send_at: "2026-10-26T23:35:00.000Z",
    text: "Nice lift · Push #2 · 1h 05m · 2 sets\nPRs: Bench Press 185 × 6 (e1RM 222)", buttons: openPlan,
  });
  assert.equal(silent(m), true);
});

test("nice lift: in kg when Hevy is set to kg", () => {
  const snap = snapshot({ hevy: hevy({ account: { ...hevy().account, weight_unit: "kg" } }) });
  const [m] = whatToSend(snap, at("2026-10-26T23:40:00Z"));
  assert.equal(m.text, "Nice lift · Push #2 · 1h 05m · 2 sets\nPRs: Bench Press 84 × 6 (e1RM 101)");
});

test("nice lift: never twice, by today's log or the workout rows since yesterday", () => {
  const row = { block_id: null, kind: "workout", day, send_at: "2026-10-26T23:35:00.000Z", sent_at: "2026-10-26T23:40:01Z" };
  assert.deepEqual(whatToSend(snapshot({ log: [briefSent, row] }), at("2026-10-26T23:45:00Z")), []);
  assert.deepEqual(whatToSend(snapshot({ hevy: hevy({ sent: [{ day, send_at: "2026-10-26T23:35:00+00:00" }] }) }), at("2026-10-26T23:45:00Z")), []);
});

test("nice lift: a workout that ended over 12 hours ago, or before Hevy was connected, is not news", () => {
  // The first full sync reads his whole history: connected at 7:40 pm, after tonight's workout.
  const connected = hevy({ account: { ...hevy().account, connected_at: "2026-10-26T23:40:00+00:00" } });
  assert.deepEqual(whatToSend(snapshot({ hevy: connected }), at("2026-10-26T23:55:00Z")), []);
  const morning = { ...push2, id: "w-am", starts_at: "2026-10-26T10:00:00+00:00", ends_at: "2026-10-26T11:00:00+00:00" };
  assert.deepEqual(whatToSend(snapshot({ hevy: hevy({ recent: [morning] }) }), at("2026-10-26T23:30:00Z")), []);
});

test("nice lift: waits for the brief and quiet hours; a late-night workout goes after the next brief", () => {
  const late = { ...push2, id: "w-late", starts_at: "2026-10-27T02:00:00+00:00", ends_at: "2026-10-27T03:10:00+00:00" }; // 10 to 11:10 pm
  const snap = snapshot({ log: [], hevy: hevy({ recent: [late], history: [push1, pull1, late] }) });
  assert.deepEqual(whatToSend(snap, at("2026-10-27T03:20:00Z")), []);
  // Next morning: the brief first, then the Nice lift for last night once the brief is out.
  assert.deepEqual(kinds(whatToSend(snap, at("2026-10-27T12:00:00Z"))), ["brief"]);
  const after = { ...snap, log: [{ ...briefSent, day: "2026-10-27", send_at: "2026-10-27T12:00:00.000Z" }] };
  const [m] = whatToSend(after, at("2026-10-27T12:01:00Z"));
  assert.equal(m.kind, "workout");
  assert.equal(m.day, day);
  assert.equal(m.send_at, "2026-10-27T03:10:00.000Z");
});

test("nice lift: with Hevy not connected there is nothing", () => {
  assert.deepEqual(whatToSend(snapshot({ hevy: undefined }), at("2026-10-26T23:40:00Z")), []);
  assert.deepEqual(whatToSend(snapshot({ hevy: hevy({ account: null }) }), at("2026-10-26T23:40:00Z")), []);
});
