// Fewer, quieter Telegram messages (src/sheet/nudges.mjs; research/plan-phone.md P2, P7, U16):
// which messages ring and which arrive silently, the links that open a view in /plan, and the
// brief's folded tail. Monday 2026-10-26 in New York (EDT, UTC-4) unless a test says otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { whatToSend, silent } from "../src/sheet/nudges.mjs";

const day = "2026-10-26";
const settings = { time_zone: "America/New_York", telegram_chat_id: 42, nudges_on: true };
const task = (id, title, extra = {}) => ({ id, title, day, done: false, due: null, public: true, ...extra });
const block = (id, task_id, starts_at, ends_at, extra = {}) => ({ id, task_id, starts_at, ends_at, proposed: false, ...extra });
const snapshot = (extra = {}) => ({ settings, day: null, tasks: [], blocks: [], log: [], ...extra });
const at = (iso) => new Date(iso);
const sent = (block_id, kind, send_at) => ({ block_id, kind, day, send_at, sent_at: send_at });
const briefSent = sent(null, "brief", "2026-10-26T12:00:00.000Z");

// ---------------------------------------------------------------- silent

test("silent: the brief and a block's start nudge ring; Finished? and the check-in arrive silently", () => {
  const snap = snapshot({
    tasks: [task("t1", "OS homework")],
    blocks: [block("b1", "t1", "2026-10-26T18:00:00Z", "2026-10-26T18:45:00Z")],
  });
  const [brief] = whatToSend(snap, at("2026-10-26T12:00:00Z"));
  assert.equal(brief.kind, "brief");
  assert.equal(silent(brief), false);
  const [start] = whatToSend({ ...snap, log: [briefSent] }, at("2026-10-26T18:00:00Z"));
  assert.equal(start.kind, "start");
  assert.equal(silent(start), false);
  const [finished] = whatToSend({ ...snap, log: [briefSent, sent("b1", "start", "2026-10-26T18:00:00.000Z"), sent("b1", "repeat", "2026-10-26T18:10:00.000Z")] }, at("2026-10-26T18:45:00Z"));
  assert.equal(finished.kind, "finished");
  assert.equal(silent(finished), true);
  const [checkin] = whatToSend({ ...snap, log: [briefSent] }, at("2026-10-26T21:00:00Z")).filter((m) => m.kind === "checkin");
  assert.equal(silent(checkin), true);
});

test("silent: a repeat, a snooze, wind-down and bedtime still ring; replan and horizon messages don't", () => {
  for (const kind of ["repeat", "snooze", "wind_down", "bedtime", "proposal"]) assert.equal(silent({ kind }), false, kind);
  for (const kind of ["replan", "horizon"]) assert.equal(silent({ kind }), true, kind);
});
