// Horizon planning, part 2, in Telegram (docs/sheet-horizon.md, "Part 2", 7): the brief names
// what won't fit, and one message goes out when a task turns tight or won't fit, inside the
// nudge budget. Monday 2026-10-26 in New York (EDT, UTC-4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { horizonMarks, horizonResets, whatToSend, BUDGET } from "../src/sheet/nudges.mjs";

const day = "2026-10-26";
const settings = { time_zone: "America/New_York", telegram_chat_id: 42, nudges_on: true };
const task = (id, title, extra = {}) => ({ id, title, day: null, list: "Inbox", done: false, due: "2026-10-30", public: true, ...extra });
const hz = (task_id, state, extra = {}) => ({ task_id, state, short_min: 0, slack_min: 120, finish_day: "2026-10-28", notified: null, ...extra });
const snapshot = (extra = {}) => ({ settings, day: null, tasks: [], blocks: [], log: [], ...extra });
const briefSent = { block_id: null, kind: "brief", day, send_at: "2026-10-26T12:00:00.000Z", sent_at: "2026-10-26T12:00:02Z" };
const at = (iso) => new Date(iso);

test("brief: won't fit gets its own line with the hours short and the fixes; tight stays at risk", () => {
  const snap = snapshot({
    tasks: [task("os", "OS project"), task("essay", "Essay", { due: "2026-10-29" }), task("hw", "HW", { due: "2026-10-27" })],
    horizon: [hz("os", "wont_fit", { short_min: 120 }), hz("essay", "tight"), hz("hw", "on_track")],
  });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.deepEqual(brief.text.split("\n").slice(0, 3), [
    "Today: 0 tasks, 0 blocks.",
    "At risk: Essay (due Thu).",
    "Won't fit: OS project, 2h short (due Fri). Move the due date, cut the estimate or raise a day's cap in /plan.",
  ]);
  // The brief tells him of both, so neither gets a message of its own later.
  assert.deepEqual(brief.horizon, [{ task_id: "os", state: "wont_fit" }, { task_id: "essay", state: "tight" }]);
});

test("a task that turns tight or won't fit after the brief gets one message, with the fix", () => {
  const tasks = [task("os", "OS project"), task("essay", "Essay", { due: "2026-10-29" })];
  const horizon = [hz("os", "wont_fit", { short_min: 90 }), hz("essay", "tight", { finish_day: "2026-10-29" })];
  const [m] = whatToSend(snapshot({ tasks, horizon, log: [briefSent] }), at("2026-10-26T15:03:20Z"));
  assert.equal(m.kind, "horizon");
  assert.equal(m.block_id, null);
  assert.equal(m.send_at, "2026-10-26T15:03:00.000Z");
  assert.equal(m.text, [
    "OS project won't fit: 1h30 short by Fri. Move the due date, cut the estimate or raise a day's cap in /plan.",
    "Essay is tight: done Thu, no day spare.",
  ].join("\n"));
  assert.deepEqual(m.horizon, [{ task_id: "os", state: "wont_fit" }, { task_id: "essay", state: "tight" }]);
  assert.deepEqual(m.buttons, [{ text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" }]);
});

test("no message for a state already told, before the brief, or with the budget spent", () => {
  const tasks = [task("os", "OS project")];
  const told = snapshot({ tasks, horizon: [hz("os", "tight", { notified: "tight" })], log: [briefSent] });
  assert.deepEqual(whatToSend(told, at("2026-10-26T15:00:00Z")), []);
  // Tight, then won't fit, is news again.
  const worse = snapshot({ tasks, horizon: [hz("os", "wont_fit", { notified: "tight", short_min: 30 })], log: [briefSent] });
  assert.equal(whatToSend(worse, at("2026-10-26T15:00:00Z"))[0].kind, "horizon");
  const spent = Array.from({ length: BUDGET }, (_, i) => ({ block_id: `b${i}`, kind: "start", day, send_at: `2026-10-26T13:0${i}:00.000Z`, sent_at: "x" }));
  const full = snapshot({ tasks, horizon: [hz("os", "tight")], log: [briefSent, ...spent] });
  assert.deepEqual(whatToSend(full, at("2026-10-26T15:00:00Z")), []);
});

test("horizonResets: on track forgets what was told, and won't fit eased to tight remembers tight", () => {
  assert.deepEqual(horizonResets([
    hz("a", "on_track", { notified: "tight" }),
    hz("b", "tight", { notified: "wont_fit" }),
    hz("c", "tight", { notified: "tight" }),
    hz("d", "on_track"),
  ]), [{ task_id: "a", notified: null }, { task_id: "b", notified: "tight" }]);
});

// Before this the states were marked told only after Telegram took the message, and a failed save
// left them untold, so the next minute (a new send_at, past the log's unique key) sent it again.
// The telegram tick now marks them first, as a claim, and puts them back if the send fails.
test("horizonMarks: what a message marks told before it goes, and what to put back if it fails", () => {
  const rows = [hz("os", "wont_fit", { notified: "tight" }), hz("essay", "tight"), hz("lab", "wont_fit")];
  const m = { kind: "horizon", horizon: [{ task_id: "os", state: "wont_fit" }, { task_id: "lab", state: "wont_fit" }, { task_id: "essay", state: "tight" }] };
  assert.deepEqual(horizonMarks(m, rows), {
    mark: [{ ids: ["essay"], notified: "tight" }, { ids: ["os", "lab"], notified: "wont_fit" }],
    restore: [{ ids: ["os"], notified: "tight" }, { ids: ["lab", "essay"], notified: null }],
  });
  assert.deepEqual(horizonMarks({ kind: "start" }, rows), { mark: [], restore: [] });
});
