// Wind-down on Telegram (src/sheet/nudges.mjs): one "Wind down" message an hour before tonight's
// bedtime and one "Bedtime" at it, once each a night, through quiet hours, never once Oura has him
// asleep, and off with nudges or wind-down off. Wednesday 2026-11-04, New York (EST, UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { whatToSend } from "../src/sheet/nudges.mjs";

const TZ = "America/New_York";
const D = "2026-11-04";
// Local "HH:MM" on Wednesday, or on Thursday morning for times before noon.
const at = (hhmm) => new Date(`${hhmm < "12:00" ? "2026-11-05" : D}T${hhmm}:00-05:00`);
const snap = (extra = {}, settings = {}) => ({
  settings: { time_zone: TZ, telegram_chat_id: 42, nudges_on: true, morning_on: false, wind_down_on: true, bedtime_target: "00:30:00", bedtime_ease: false, ...settings },
  day: null, tasks: [], blocks: [], log: [], proposal: null, needsOpen: [], campus: [], busy: [], academic: [], awaiting: [], sleep: [], nightLog: [],
  ...extra,
});
const night = (s, now) => whatToSend(s, now).filter((m) => m.kind === "wind_down" || m.kind === "bedtime");
const sent = (kind, hhmm) => ({ block_id: null, kind, day: D, send_at: at(hhmm).toISOString(), sent_at: at(hhmm).toISOString() });

test("wind down at bedtime - 60, in quiet hours, plain text with no buttons", () => {
  assert.deepEqual(night(snap(), at("23:29")), []);
  const [m] = night(snap(), at("23:30"));
  assert.deepEqual(m, { kind: "wind_down", block_id: null, day: D, send_at: at("23:30").toISOString(), text: "Wind down: lights out at 12:30 am. Wrap up and put the screens away.", buttons: [] });
  // A late run still sends it before bedtime.
  assert.equal(night(snap(), at("00:10"))[0].kind, "wind_down");
});

test("bedtime at bedtime, after midnight on the night before's log day; each once a night", () => {
  const [m] = night(snap({ nightLog: [sent("wind_down", "23:30")] }), at("00:30"));
  assert.equal(m.kind, "bedtime");
  assert.equal(m.day, D);
  assert.equal(m.text, "Bedtime: lights out now. Sleep well.");
  // At bedtime with wind-down never sent, only Bedtime goes: wind-down's hour is over.
  assert.deepEqual(night(snap(), at("00:30")).map((x) => x.kind), ["bedtime"]);
  assert.deepEqual(night(snap({ nightLog: [sent("wind_down", "23:30"), sent("bedtime", "00:30")] }), at("00:35")), []);
  // Sent once even if the bedtime moved after it went (a new target, a synced night).
  assert.deepEqual(night(snap({ nightLog: [sent("wind_down", "23:00")] }), at("23:45")), []);
  // Over half an hour late, Bedtime no longer goes.
  assert.deepEqual(night(snap({ nightLog: [sent("wind_down", "23:30")] }), at("01:01")), []);
});

test("off with nudges off, wind-down off or no bedtime", () => {
  assert.deepEqual(night(snap({}, { nudges_on: false }), at("23:30")), []);
  assert.deepEqual(night(snap({}, { wind_down_on: false }), at("23:30")), []);
  assert.deepEqual(night(snap({}, { bedtime_target: null }), at("23:30")), []);
});

test("never once Oura has him asleep", () => {
  // A sleep that started at 11:40 pm and has synced (he woke briefly and the app synced).
  const asleep = { oura_id: "s1", day: "2026-11-05", type: "sleep", bedtime_start: at("23:40").toISOString(), bedtime_end: at("00:20").toISOString() };
  assert.deepEqual(night(snap({ sleep: [asleep], nightLog: [sent("wind_down", "23:30")] }), at("00:30")), []);
  // Last night's sleep doesn't count.
  const lastNight = { oura_id: "s0", day: D, type: "long_sleep", bedtime_start: "2026-11-04T08:00:00Z", bedtime_end: "2026-11-04T17:00:00Z" };
  assert.equal(night(snap({ sleep: [lastNight] }), at("23:30")).length, 1);
});

test("the wind-down messages don't use the start-nudge budget", () => {
  const log = Array.from({ length: 6 }, (_, i) => ({ block_id: `b${i}`, kind: "start", day: D, send_at: at("14:00").toISOString(), sent_at: at("14:00").toISOString() }));
  assert.equal(night(snap({ log }), at("23:30")).length, 1);
  // A 9:30 pm bedtime's wind-down at 8:30 pm goes alongside the day's other messages.
  assert.equal(night(snap({ log }, { bedtime_target: "21:30:00" }), at("20:30"))[0].text, "Wind down: lights out at 9:30 pm. Wrap up and put the screens away.");
});

test("wind down adds a late nap's warning, a low ring and an evening tip, all from server rows", () => {
  const nap = { oura_id: "n1", day: "2026-11-05", type: "late_nap", bedtime_start: at("17:10").toISOString(), bedtime_end: at("18:20").toISOString() };
  const ringLow = { ring_low: true, ring_checked_at: at("23:20").toISOString() };
  const tipDays = [{ day: D, contributors: { latency: 50, efficiency: 60 } }];
  const [m] = night(snap({ sleep: [nap], ringLow, tipDays }), at("23:30"));
  assert.equal(m.text, "Wind down: lights out at 12:30 am. Wrap up and put the screens away. After a late nap, keep to your bedtime. Charge your ring.\nTip: Screens off and lights dim for the last hour: your wind-down starts at 11:30 pm.");
  // A stale battery reading, and a day tip that isn't about the evening, add nothing.
  const [plain] = night(snap({ ringLow: { ring_low: true, ring_checked_at: at("21:00").toISOString() }, tipDays: [{ day: D, contributors: { efficiency: 60 } }] }), at("23:30"));
  assert.equal(plain.text, "Wind down: lights out at 12:30 am. Wrap up and put the screens away.");
});
