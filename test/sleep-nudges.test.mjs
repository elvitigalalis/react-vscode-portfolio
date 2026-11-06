// Telegram and Oura (src/sheet/nudges.mjs): the woke-late replan's words, quiet until he's up,
// the brief held until after he wakes, and the brief's cap line. Expected values are by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { whatToSend } from "../src/sheet/nudges.mjs";

const TZ = "America/New_York";
const D = "2026-11-04"; // Wednesday, EST (UTC-5)
const t = (id, title, extra = {}) => ({ id, title, day: D, done: false, due: null, public: true, est_min: 45, ...extra });
const tasks = [t("t1", "OS homework"), t("t2", "Gym")];
const at = (hhmm) => new Date(`${D}T${hhmm}:00-05:00`);
const long = (wake, hours = 8) => {
  const end = at(wake);
  return { oura_id: wake, day: D, type: "long_sleep", bedtime_start: new Date(+end - hours * 3_600_000).toISOString(), bedtime_end: end.toISOString() };
};
// Typical weekday wake 9:40 (Mon-Wed of the week before and this Mon-Tue).
const past = ["2026-10-28T09:40", "2026-10-29T09:30", "2026-10-30T09:50", "2026-11-02T09:40", "2026-11-03T09:40"].map((w) => {
  const end = new Date(`${w}:00${w < "2026-11-01" ? "-04:00" : "-05:00"}`);
  return { oura_id: w, day: w.slice(0, 10), type: "long_sleep", bedtime_start: new Date(+end - 8 * 3_600_000).toISOString(), bedtime_end: end.toISOString() };
});
const snap = (extra = {}) => ({
  settings: { time_zone: TZ, telegram_chat_id: 42, nudges_on: true, morning_on: false },
  day: null, tasks, blocks: [], log: [], proposal: null, needsOpen: [], campus: [], busy: [], academic: [], awaiting: [],
  ...extra,
});
const kinds = (s, now) => whatToSend(s, now).map((m) => m.kind);
// An approved Gym block at 8:30-9:30 am, nudged at its start.
const gym = { id: "b1", task_id: "t2", starts_at: at("08:30").toISOString(), ends_at: at("09:30").toISOString(), proposed: false, gcal_id: null };

test("no Oura data: the brief goes at 8:00 and nudges from then, as before", () => {
  assert.deepEqual(kinds(snap({ blocks: [gym] }), at("08:00")), ["brief"]);
  assert.deepEqual(kinds(snap({ blocks: [gym], log: [{ block_id: null, kind: "brief", day: D, send_at: at("08:00").toISOString(), sent_at: at("08:00").toISOString() }] }), at("08:30")), ["start"]);
});

test("not up yet: nothing before his typical wake, and the brief waits until typical wake + 90", () => {
  const s = snap({ blocks: [gym], sleep: past });
  assert.deepEqual(kinds(s, at("08:30")), []);
  assert.deepEqual(kinds(s, at("09:39")), []);
  // From 9:40 the running block's nudge may go; the brief waits until 11:10.
  assert.deepEqual(kinds(s, at("09:40")), []); // Gym ended at 9:30: its nudge is no use now
  const late = { ...gym, id: "b2", starts_at: at("09:00").toISOString(), ends_at: at("10:30").toISOString() };
  assert.deepEqual(kinds({ ...s, blocks: [late] }, at("09:45")), ["start"]);
  assert.deepEqual(kinds(s, at("11:09")), []);
  assert.deepEqual(kinds(s, at("11:10")), ["brief"]);
  assert.equal(whatToSend(s, at("11:10"))[0].send_at, at("11:10").toISOString());
});

test("up and synced: quiet ends at his wake, and the brief goes 15 minutes after it", () => {
  const s = snap({ sleep: [...past, long("08:50")] });
  assert.deepEqual(kinds(s, at("09:04")), []);
  assert.deepEqual(kinds(s, at("09:05")), ["brief"]);
  // An early wake doesn't end quiet hours before 8:00, or send the brief before then.
  const early = snap({ sleep: [...past, long("06:30")] });
  assert.deepEqual(kinds(early, at("07:59")), []);
  assert.deepEqual(kinds(early, at("08:00")), ["brief"]);
});

test("the brief goes once, though its time moves when the wake syncs after it went", () => {
  const sent = { block_id: null, kind: "brief", day: D, send_at: at("11:10").toISOString(), sent_at: at("11:10").toISOString() };
  // It went at 11:10 from his typical wake; then the ring synced a 10:20 wake.
  assert.deepEqual(kinds(snap({ sleep: [...past, long("10:20")], log: [sent] }), at("11:30")), []);
});

test("the brief says when readiness or a short night set the cap", () => {
  const s = snap({ sleep: [...past, long("08:50")], sleepDay: { day: D, readiness: 64, sleep_s: 5 * 3600 + 40 * 60 }, settings: { ...snap().settings, workload_cap_min: 360 } });
  const text = whatToSend(s, at("09:05"))[0].text;
  assert.match(text, /^Readiness 64, slept 5h40: cap 4h45\.$/m);
  // A normal day says nothing about it.
  assert.doesNotMatch(whatToSend(snap({ sleepDay: { day: D, readiness: 75, sleep_s: 7 * 3600 } }), at("08:00"))[0].text, /cap/);
});

test("replan message: a woke-late change says when he woke", () => {
  const HW = { task_id: "t1", starts_at: at("11:00").toISOString(), ends_at: at("11:45").toISOString() };
  const rev = (n, extra) => ({ day: D, rev: n, status: "pending", note: null, picks: [], couldnt_fit: [], suggested: [], run_trigger: "replan", reasons: [], blocks: [], ...extra });
  const s = snap({
    blocks: [{ id: "b3", ...HW, proposed: true, gcal_id: null }],
    log: [{ block_id: null, kind: "brief", day: D, send_at: at("08:00").toISOString(), sent_at: at("08:00").toISOString() }],
    proposal: rev(2, { created_at: at("10:40").toISOString(), reasons: ["woke_late"], blocks: [HW] }),
    previous: rev(1, { status: "superseded", run_trigger: "morning", created_at: "2026-11-03T22:00:00Z", blocks: [{ task_id: "t1", starts_at: at("07:00").toISOString(), ends_at: at("07:45").toISOString() }] }),
    replanSent: 0,
    replanChanges: [{ reason: "woke_late", ref: at("10:20").toISOString() }],
  });
  assert.equal(whatToSend(s, at("10:41"))[0].text.split("\n")[0], "Replan: you woke up at 10:20 am.");
  assert.equal(whatToSend({ ...s, replanChanges: [] }, at("10:41"))[0].text.split("\n")[0], "Replan: you woke up later than planned.");
});

test("the brief says today's sleep score and its band, from the server's own row", () => {
  const s = (score) => snap({ sleep: [...past, long("08:50")], sleepDay: { day: D, readiness: 75, sleep_s: 7 * 3600, sleep_score: score } });
  assert.match(whatToSend(s(82), at("09:05"))[0].text, /^Sleep score 82, good\.$/m);
  assert.match(whatToSend(s(88), at("09:05"))[0].text, /^Sleep score 88, optimal\.$/m);
  assert.match(whatToSend(s(61), at("09:05"))[0].text, /^Sleep score 61, pay attention\.$/m);
  assert.doesNotMatch(whatToSend(s(null), at("09:05"))[0].text, /Sleep score/);
});

test("the brief carries one tip from today's lowest contributor", () => {
  const s = snap({ sleep: [...past, long("08:50")], tipDays: [{ day: D, contributors: { restfulness: 52, timing: 66 } }] });
  assert.match(whatToSend(s, at("09:05"))[0].text, /^Tip: Cooler, darker room, and no caffeine after 2 pm\.$/m);
  assert.doesNotMatch(whatToSend(snap({ sleep: [...past, long("08:50")] }), at("09:05"))[0].text, /Tip:/);
});

test("once the ring sees him up, the brief opens with good morning, his wake and what's first", () => {
  const hw = { id: "b3", task_id: "t1", starts_at: at("19:15").toISOString(), ends_at: at("19:45").toISOString(), proposed: false, gcal_id: null };
  const lines = whatToSend(snap({ blocks: [hw], sleep: [...past, long("08:50")] }), at("09:05"))[0].text.split("\n");
  assert.equal(lines[0], "Good morning! Up at 8:50 am. First up: OS homework at 7:15 pm.");
  // Nothing left on today: just the greeting and the wake.
  assert.equal(whatToSend(snap({ sleep: [...past, long("08:50")] }), at("09:05"))[0].text.split("\n")[0], "Good morning! Up at 8:50 am.");
  // No wake seen (typical wake, or no ring): no greeting, the brief as before.
  assert.doesNotMatch(whatToSend(snap({ sleep: past }), at("11:10"))[0].text, /Good morning/);
  assert.doesNotMatch(whatToSend(snap(), at("08:00"))[0].text, /Good morning/);
});
