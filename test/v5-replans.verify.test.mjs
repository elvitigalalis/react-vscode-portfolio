// Verification tests for v5 R1, replans during the day: src/sheet/replan.mjs (shouldReplan,
// REASON_WORDS, reasonWords) and the replan message in src/sheet/nudges.mjs. Written before the
// code from docs/sheet-v5.md "Contracts" and spec 47. Every test starts as `todo`; the implementer
// removes `todo` and must not change an expectation. Expected values are written out by hand.
// Modules are imported inside each test, so this file loads before the code exists.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5). The tick runs at 10:02 am, 15:02 UTC. Today's
// morning revision was made at 6:09 am (11:09 UTC); shutdown is at 5:00 pm.
//
// Readings chosen where the contract leaves room (closest to its words):
// - shouldReplan takes the rows the tick already narrowed to `replan_id` and `consumed_rev` null;
//   it filters only by time (after `now`, or at or before `last_plan_at`).
// - An age is `now - at`, so "15 minutes old" means at least 15 minutes have passed.
// - `ids` are compared as a set; their order isn't part of the contract.
// - The replan message's "+" lines carry the block's minutes and its "−" lines don't, as in the
//   contract's example.
import { test } from "node:test";
import assert from "node:assert/strict";

const replan = () => import("../src/sheet/replan.mjs");
const nudges = () => import("../src/sheet/nudges.mjs");
const todo = { todo: true };

const TZ = "America/New_York";
const DAY = "2026-11-04";
const now = new Date("2026-11-04T15:02:00Z"); // 10:02 am

const change = (id, at, kind, reason, weight) => ({ id, at, kind, reason, weight, ref: null, replan_id: null, consumed_day: null, consumed_rev: null });
const state = (extra = {}) => ({
  settings: { time_zone: TZ, replans_on: true, morning_on: true },
  day: { day: DAY, shutdown: false, shutdown_at: null },
  shutdown: "17:00",
  plans_today: 1,
  last_plan_at: "2026-11-04T11:09:00Z", // 6:09 am
  last_edit_at: null,
  ...extra,
});
// A change that fires on its own, a minute old.
const urgent = [change("c1", "2026-11-04T15:01:00Z", "busy", "busy_overlap", 10)];
const hold = (h) => ({ fire: false, hold: h });

// =============================================================================================
// shouldReplan: the rules
// =============================================================================================

test("shouldReplan: a change of weight 10 fires at once", async () => {
  const { shouldReplan } = await replan();
  assert.deepEqual(shouldReplan(urgent, state(), now), { fire: true, reasons: ["busy_overlap"], counts: { busy: 1 }, ids: ["c1"] });
});

test("shouldReplan: a change of weight 8 fires at once, even logged this minute", async () => {
  const { shouldReplan } = await replan();
  const changes = [change("c1", "2026-11-04T15:02:00Z", "course", "course_due_soon", 8)];
  assert.deepEqual(shouldReplan(changes, state(), now), { fire: true, reasons: ["course_due_soon"], counts: { course: 1 }, ids: ["c1"] });
});

test("shouldReplan: a lone change under weight 8, a minute old, waits", async () => {
  const { shouldReplan } = await replan();
  assert.deepEqual(shouldReplan([change("c1", "2026-11-04T15:01:00Z", "course", "course_change", 3)], state(), now), hold("waiting"));
});

test("shouldReplan: a real busy change fires once it is 15 minutes old, not at 14", async () => {
  const { shouldReplan } = await replan();
  // 9:47 am is 15 minutes before 10:02.
  const at = (t) => [change("c1", t, "busy", "busy_change", 2)];
  assert.deepEqual(shouldReplan(at("2026-11-04T14:47:00Z"), state(), now), { fire: true, reasons: ["busy_change"], counts: { busy: 1 }, ids: ["c1"] });
  assert.deepEqual(shouldReplan(at("2026-11-04T14:48:00Z"), state(), now), hold("waiting"));
});

test("shouldReplan: one change of weight 4 is enough at 15 minutes old, not at 14", async () => {
  const { shouldReplan } = await replan();
  const at = (t) => [change("c1", t, "busy", "time_freed", 4)];
  assert.deepEqual(shouldReplan(at("2026-11-04T14:47:00Z"), state(), now), { fire: true, reasons: ["time_freed"], counts: { busy: 1 }, ids: ["c1"] });
  assert.deepEqual(shouldReplan(at("2026-11-04T14:48:00Z"), state(), now), hold("waiting"));
});

// The quiet reasons, written with the weights the syncs give them.
const quiet = [
  ["mail", "mail_new", 2], ["slack", "slack_new", 3], ["campus", "campus_change", 3], ["course", "course_change", 3],
  ["github", "github_change", 3], ["jira", "jira_change", 3], ["handshake", "handshake_change", 3],
];

test("shouldReplan: a quiet change alone waits, however old, while the last plan is under 5 hours old", async () => {
  const { shouldReplan } = await replan();
  // The plan was 4 h 59 min ago; the change came just after it.
  const s = state({ last_plan_at: "2026-11-04T10:03:00Z" });
  for (const [kind, reason, weight] of quiet) {
    assert.deepEqual(shouldReplan([change("c1", "2026-11-04T10:04:00Z", kind, reason, weight)], s, now), hold("waiting"), reason);
  }
  // Many of them, and all kinds at once, add up to nothing.
  const all = quiet.map(([k, r, w], i) => change(`c${i}`, "2026-11-04T11:00:00Z", k, r, w));
  assert.deepEqual(shouldReplan(all, s, now), hold("waiting"));
});

test("shouldReplan: a quiet change catches up 5 hours after the last plan, once settled 15 minutes", async () => {
  const { shouldReplan } = await replan();
  const s = state({ last_plan_at: "2026-11-04T10:02:00Z" });
  const at = (t) => [change("c1", t, "mail", "mail_new", 2)];
  assert.deepEqual(shouldReplan(at("2026-11-04T14:47:00Z"), s, now), { fire: true, reasons: ["mail_new"], counts: { mail: 1 }, ids: ["c1"] });
  assert.deepEqual(shouldReplan(at("2026-11-04T14:48:00Z"), s, now), hold("waiting"));
});

test("shouldReplan: quiet changes ride along on a fire that's happening anyway", async () => {
  const { shouldReplan } = await replan();
  const changes = [change("c1", "2026-11-04T15:01:00Z", "mail", "mail_owed", 8), change("c2", "2026-11-04T15:00:00Z", "slack", "slack_new", 3)];
  const r = shouldReplan(changes, state(), now);
  assert.deepEqual(r.reasons, ["mail_owed", "slack_new"]);
  assert.deepEqual([...r.ids].sort(), ["c1", "c2"]);
  // A fresh busy change waits for itself, and a quiet change older than it doesn't hurry it.
  const older = [change("c1", "2026-11-04T14:00:00Z", "campus", "campus_change", 3), change("c2", "2026-11-04T15:00:00Z", "busy", "busy_change", 2)];
  assert.deepEqual(shouldReplan(older, state(), now), hold("waiting"));
});

test("shouldReplan: with no changes it holds with nothing", async () => {
  const { shouldReplan } = await replan();
  assert.deepEqual(shouldReplan([], state(), now), hold("nothing"));
});

test("shouldReplan: changes after now, or at or before the last plan, don't count", async () => {
  const { shouldReplan } = await replan();
  const ignored = [
    change("c1", "2026-11-04T15:03:00Z", "busy", "busy_overlap", 10), // a minute in the future
    change("c2", "2026-11-04T11:09:00Z", "busy", "busy_overlap", 10), // as the run's own proposal went in
    change("c3", "2026-11-04T11:08:00Z", "course", "course_due_soon", 8), // before it
  ];
  assert.deepEqual(shouldReplan(ignored, state(), now), hold("nothing"));
  // One that counts, alone too light to fire.
  const r = shouldReplan([...ignored, change("c4", "2026-11-04T15:00:00Z", "mail", "mail_new", 2)], state(), now);
  assert.deepEqual(r, hold("waiting"));
});

test("shouldReplan: the run's own proposal doesn't count; a change a minute after it does", async () => {
  const { shouldReplan } = await replan();
  // The replan's revision went in at 9:30 am; the change it caused is stamped with it.
  const s = state({ last_plan_at: "2026-11-04T14:00:00Z", plans_today: 2 });
  assert.deepEqual(shouldReplan([change("c1", "2026-11-04T14:00:00Z", "busy", "busy_overlap", 10)], s, new Date("2026-11-04T15:00:00Z")), hold("nothing"));
  assert.equal(shouldReplan([change("c1", "2026-11-04T14:01:00Z", "busy", "busy_overlap", 10)], s, new Date("2026-11-04T15:00:00Z")).fire, true);
});

test("shouldReplan: with no plan today nothing is ignored for being old", async () => {
  const { shouldReplan } = await replan();
  const r = shouldReplan([change("c1", "2026-11-04T10:00:00Z", "mail", "mail_new", 2)], state({ last_plan_at: null, plans_today: 0 }), now);
  assert.deepEqual(r, { fire: true, reasons: ["mail_new"], counts: { mail: 1 }, ids: ["c1"] });
});

test("shouldReplan: reasons are distinct, highest weight first, then by name; counts by kind", async () => {
  const { shouldReplan } = await replan();
  const changes = [
    change("c1", "2026-11-04T14:50:00Z", "mail", "mail_new", 2),
    change("c2", "2026-11-04T14:55:00Z", "busy", "busy_overlap", 10),
    change("c3", "2026-11-04T14:56:00Z", "mail", "mail_owed", 8),
    change("c4", "2026-11-04T14:57:00Z", "mail", "mail_new", 2),
    change("c5", "2026-11-04T14:58:00Z", "course", "course_due_soon", 8),
    change("c6", "2026-11-04T14:59:00Z", "slack", "slack_new", 3),
    change("c7", "2026-11-04T15:00:00Z", "github", "github_change", 3),
    change("c8", "2026-11-04T15:10:00Z", "jira", "jira_due_soon", 8), // in the future: left out
  ];
  const r = shouldReplan(changes, state(), now);
  assert.equal(r.fire, true);
  assert.deepEqual(r.reasons, ["busy_overlap", "course_due_soon", "mail_owed", "github_change", "slack_new", "mail_new"]);
  assert.deepEqual(r.counts, { mail: 3, busy: 1, course: 1, slack: 1, github: 1 });
  assert.deepEqual([...r.ids].sort(), ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
});

test("shouldReplan: the counts make the fire text", async () => {
  const { shouldReplan } = await replan();
  const { fireText } = await import("../src/sheet/routine-fire.mjs");
  const changes = [
    change("c1", "2026-11-04T14:50:00Z", "mail", "mail_new", 2),
    change("c2", "2026-11-04T14:55:00Z", "busy", "busy_overlap", 10),
    change("c3", "2026-11-04T14:56:00Z", "mail", "mail_owed", 8),
    change("c4", "2026-11-04T14:57:00Z", "mail", "mail_new", 2),
  ];
  assert.equal(fireText("replan", shouldReplan(changes, state(), now).counts), "trigger: replan\nreasons: mail 3, busy 1");
});

// =============================================================================================
// shouldReplan: the holds
// =============================================================================================

test("hold: replans off", async () => {
  const { shouldReplan } = await replan();
  const s = state({ settings: { time_zone: TZ, replans_on: false, morning_on: true } });
  assert.deepEqual(shouldReplan(urgent, s, now), hold("replans_off"));
  assert.deepEqual(shouldReplan([], s, now), hold("replans_off"));
});

test("hold: the morning task off", async () => {
  const { shouldReplan } = await replan();
  assert.deepEqual(shouldReplan(urgent, state({ settings: { time_zone: TZ, replans_on: true, morning_on: false } }), now), hold("morning_off"));
});

test("hold: quiet hours before 8:00 am; 8:00 am itself is open", async () => {
  const { shouldReplan } = await replan();
  const early = [change("c1", "2026-11-04T12:58:00Z", "busy", "busy_overlap", 10)]; // 7:58 am
  assert.deepEqual(shouldReplan(early, state(), new Date("2026-11-04T12:59:00Z")), hold("quiet")); // 7:59 am
  assert.equal(shouldReplan(early, state(), new Date("2026-11-04T13:00:00Z")).fire, true); // 8:00 am
});

test("hold: quiet hours from 11:00 pm; 10:59 pm is open", async () => {
  const { shouldReplan } = await replan();
  const s = state({ shutdown: "23:30" });
  const late = [change("c1", "2026-11-05T03:58:00Z", "busy", "busy_overlap", 10)]; // 10:58 pm
  assert.equal(shouldReplan(late, s, new Date("2026-11-05T03:59:00Z")).fire, true); // 10:59 pm
  assert.deepEqual(shouldReplan(late, s, new Date("2026-11-05T04:00:00Z")), hold("quiet")); // 11:00 pm
});

test("hold: the day is shut down", async () => {
  const { shouldReplan } = await replan();
  assert.deepEqual(shouldReplan(urgent, state({ day: { day: DAY, shutdown: true, shutdown_at: null } }), now), hold("shut_down"));
  // No days row yet is not shut down.
  assert.equal(shouldReplan(urgent, state({ day: null }), now).fire, true);
});

test("hold: at or after the shutdown line", async () => {
  const { shouldReplan } = await replan();
  assert.deepEqual(shouldReplan(urgent, state({ shutdown: "10:00" }), now), hold("after_shutdown"));
  assert.deepEqual(shouldReplan(urgent, state({ shutdown: "10:02" }), now), hold("after_shutdown"));
  assert.equal(shouldReplan(urgent, state({ shutdown: "10:03" }), now).fire, true);
});

test("hold: the daily cap of 8 plans", async () => {
  const { shouldReplan } = await replan();
  assert.deepEqual(shouldReplan(urgent, state({ plans_today: 8 }), now), hold("daily_cap"));
  assert.deepEqual(shouldReplan(urgent, state({ plans_today: 9 }), now), hold("daily_cap"));
  assert.equal(shouldReplan(urgent, state({ plans_today: 7 }), now).fire, true);
});

test("hold: under 60 minutes since the last plan", async () => {
  const { shouldReplan } = await replan();
  const changes = [change("c1", "2026-11-04T14:30:00Z", "busy", "busy_overlap", 10)];
  assert.deepEqual(shouldReplan(changes, state({ last_plan_at: "2026-11-04T14:03:00Z" }), now), hold("too_soon")); // 59 min
  assert.equal(shouldReplan(changes, state({ last_plan_at: "2026-11-04T14:02:00Z" }), now).fire, true); // 60 min
});

test("hold: under 10 minutes since a /plan edit", async () => {
  const { shouldReplan } = await replan();
  assert.deepEqual(shouldReplan(urgent, state({ last_edit_at: "2026-11-04T14:53:00Z" }), now), hold("editing")); // 9 min
  assert.equal(shouldReplan(urgent, state({ last_edit_at: "2026-11-04T14:52:00Z" }), now).fire, true); // 10 min
});

test("a /plan edit is not a change: an edit with no changes is nothing", async () => {
  const { shouldReplan } = await replan();
  assert.deepEqual(shouldReplan([], state({ last_edit_at: "2026-11-04T14:30:00Z" }), now), hold("nothing"));
  assert.deepEqual(shouldReplan([], state({ last_edit_at: "2026-11-04T15:00:00Z" }), now), hold("editing"));
});

test("hold: the holds are checked in the contract's order", async () => {
  const { shouldReplan } = await replan();
  const off = { time_zone: TZ, replans_on: false, morning_on: false };
  const at759 = new Date("2026-11-04T12:59:00Z");
  const early = [change("c1", "2026-11-04T12:58:00Z", "busy", "busy_overlap", 10)];
  assert.deepEqual(shouldReplan(early, state({ settings: off }), at759), hold("replans_off"));
  assert.deepEqual(shouldReplan(early, state({ settings: { ...off, replans_on: true } }), at759), hold("morning_off"));
  // At 11:00 pm the shutdown line has passed too.
  assert.deepEqual(shouldReplan(urgent, state(), new Date("2026-11-05T04:00:00Z")), hold("quiet"));
  const shut = { day: DAY, shutdown: true, shutdown_at: null };
  assert.deepEqual(shouldReplan(urgent, state({ day: shut, shutdown: "10:00", plans_today: 8 }), now), hold("shut_down"));
  assert.deepEqual(shouldReplan(urgent, state({ shutdown: "10:00", plans_today: 8 }), now), hold("after_shutdown"));
  const soon = "2026-11-04T14:30:00Z";
  const edited = "2026-11-04T15:00:00Z";
  const fresh = [change("c1", "2026-11-04T14:45:00Z", "busy", "busy_overlap", 10)];
  assert.deepEqual(shouldReplan(fresh, state({ plans_today: 8, last_plan_at: soon, last_edit_at: edited }), now), hold("daily_cap"));
  assert.deepEqual(shouldReplan(fresh, state({ last_plan_at: soon, last_edit_at: edited }), now), hold("too_soon"));
});

// =============================================================================================
// The reasons in words
// =============================================================================================

const WORDS = {
  busy_overlap: "a busy time landed on a block",
  time_freed: "time freed up",
  busy_change: "busy times changed",
  course_due_soon: "a course task is due within 48 hours",
  course_change: "course tasks changed",
  campus_change: "campus events changed",
  mail_owed: "a known sender is waiting on a reply",
  mail_new: "new mail",
  github_due_soon: "a GitHub item is due within 48 hours",
  github_change: "GitHub items changed",
  jira_due_soon: "a Jira ticket is due within 48 hours",
  jira_change: "Jira tickets changed",
  slack_new: "new Slack mentions",
  handshake_change: "Handshake events changed",
};

// Oura (docs/sheet-v5.md, "Oura") added a fifteenth, woke_late; the fourteen are unchanged.
test("REASON_WORDS: exactly the fourteen reason names, and Oura's woke_late", async () => {
  const { REASON_WORDS } = await replan();
  assert.deepEqual(Object.keys(REASON_WORDS).sort(), [...Object.keys(WORDS), "woke_late"].sort());
});

test("reasonWords: each reason's words", async () => {
  const { reasonWords } = await replan();
  for (const [reason, words] of Object.entries(WORDS)) assert.equal(reasonWords([reason]), words, reason);
});

test("reasonWords: several reasons joined with a comma, in the order given", async () => {
  const { reasonWords } = await replan();
  assert.equal(reasonWords(["busy_overlap", "mail_new"]), "a busy time landed on a block, new mail");
  assert.equal(reasonWords(["mail_owed", "time_freed", "slack_new"]), "a known sender is waiting on a reply, time freed up, new Slack mentions");
});

// =============================================================================================
// The replan message
// =============================================================================================

const settings = { time_zone: TZ, telegram_chat_id: 42, nudges_on: true, morning_on: true };
const B = (n) => `0b0b0b0b-0000-4000-8000-00000000000${n}`;
const ttask = (id, title, extra = {}) => ({ id, title, day: DAY, done: false, due: null, public: true, est_min: 45, ...extra });
const tasks = [ttask("t1", "OS homework"), ttask("t2", "Gym", { est_min: 60 }), ttask("t3", "HW3"), ttask("t5", "Lab 4", { day: null })];
const span = (task_id, starts_at, ends_at) => ({ task_id, starts_at, ends_at });
const row = (id, s, extra = {}) => ({ id, ...s, proposed: true, gcal_id: null, ...extra });
const revision = (rev, extra = {}) => ({
  day: DAY, rev, status: "pending", created_at: "2026-11-04T11:09:00Z", note: null, picks: [], couldnt_fit: [], suggested: [],
  run_trigger: "morning", reasons: [], blocks: [], ...extra,
});

// Revision 2, the replan at 10:05 am: OS homework at 10:15 am, as before, and HW3 at 4:00 pm.
// Revision 1, the morning plan, pending until then (now superseded): OS homework at 10:15 am and
// Gym at 2:00 pm.
const OS = span("t1", "2026-11-04T15:15:00Z", "2026-11-04T16:00:00Z"); // 10:15-11:00 am
const HW3 = span("t3", "2026-11-04T21:00:00Z", "2026-11-04T21:45:00Z"); // 4:00-4:45 pm
const GYM = span("t2", "2026-11-04T19:00:00Z", "2026-11-04T20:00:00Z"); // 2:00-3:00 pm
const rev2 = (extra = {}) => revision(2, {
  created_at: "2026-11-04T15:05:00Z", run_trigger: "replan", reasons: ["busy_overlap", "mail_new"], couldnt_fit: ["t5"], blocks: [OS, HW3], ...extra,
});
const rev1 = (extra = {}) => revision(1, { status: "superseded", blocks: [OS, GYM], ...extra });
const briefSent = { block_id: null, kind: "brief", day: DAY, send_at: "2026-11-04T13:00:00.000Z", sent_at: "2026-11-04T13:00:01Z" };
const snapshot = (extra = {}) => ({
  settings, day: null, tasks, blocks: [row(B(1), OS), row(B(3), HW3)], log: [briefSent],
  proposal: rev2(), previous: rev1(), replanSent: 0, needsOpen: [], campus: [], busy: [], academic: [], awaiting: [],
  ...extra,
});
const planButtons = [
  { text: "Approve all", callback_data: "pa:2026-11-04:2" },
  { text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" },
  { text: "Skip", callback_data: "ps:2026-11-04:2" },
];
const at1006 = new Date("2026-11-04T15:06:00Z");

test("replan message: the reasons in words, the blocks added and gone, and what couldn't fit", async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(snapshot(), at1006), [{
    kind: "replan",
    block_id: null,
    day: DAY,
    send_at: "2026-11-04T15:05:00.000Z",
    text: [
      "Replan: a busy time landed on a block, new mail.",
      "+ 4:00 pm · HW3 (45 min)",
      "− 2:00 pm · Gym",
      "Couldn't fit: Lab 4.",
    ].join("\n"),
    buttons: planButtons,
  }]);
});

test("replan message: after an approved revision every proposed block is new", async () => {
  const { whatToSend } = await nudges();
  const snap = snapshot({
    previous: revision(1, { status: "approved", blocks: [GYM] }),
    blocks: [row(B(2), GYM, { proposed: false }), row(B(1), OS), row(B(3), HW3)],
    proposal: rev2({ couldnt_fit: [] }),
  });
  const [m] = whatToSend(snap, at1006);
  assert.equal(m.kind, "replan");
  assert.equal(m.text, [
    "Replan: a busy time landed on a block, new mail.",
    "+ 10:15 am · OS homework (45 min)",
    "+ 4:00 pm · HW3 (45 min)",
  ].join("\n"));
});

test("replan message: not sent when the blocks are the same set as the previous pending revision's", async () => {
  const { whatToSend } = await nudges();
  // The same two blocks, listed the other way round.
  assert.deepEqual(whatToSend(snapshot({ previous: rev1({ blocks: [HW3, OS] }) }), at1006), []);
});

test("replan message: a block moved by 15 minutes is one gone and one added", async () => {
  const { whatToSend } = await nudges();
  const moved = span("t3", "2026-11-04T21:15:00Z", "2026-11-04T22:00:00Z"); // 4:15-5:00 pm
  const snap = snapshot({ previous: rev1({ blocks: [OS, HW3] }), proposal: rev2({ blocks: [OS, moved], couldnt_fit: [] }), blocks: [row(B(1), OS), row(B(3), moved)] });
  const [m] = whatToSend(snap, at1006);
  assert.equal(m.text, "Replan: a busy time landed on a block, new mail.\n+ 4:15 pm · HW3 (45 min)\n− 4:00 pm · HW3");
});

test("replan message: at most 4 a day", async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(snapshot({ replanSent: 4 }), at1006), []);
  assert.deepEqual(whatToSend(snapshot({ replanSent: 3 }), at1006).map((m) => m.kind), ["replan"]);
});

test("replan message: once per revision", async () => {
  const { whatToSend } = await nudges();
  const sent = { block_id: null, kind: "replan", day: DAY, send_at: "2026-11-04T15:05:00.000Z", sent_at: "2026-11-04T15:05:30Z" };
  assert.deepEqual(whatToSend(snapshot({ log: [briefSent, sent], replanSent: 1 }), at1006), []);
});

test("replan message: not in quiet hours", async () => {
  const { whatToSend } = await nudges();
  // Made at 11:10 pm, looked at a minute later.
  const late = snapshot({ proposal: rev2({ created_at: "2026-11-05T04:10:00Z" }) });
  assert.deepEqual(whatToSend(late, new Date("2026-11-05T04:11:00Z")), []);
  // Made at 7:40 am, before the brief.
  const early = snapshot({ proposal: rev2({ created_at: "2026-11-04T12:40:00Z" }), log: [] });
  assert.deepEqual(whatToSend(early, new Date("2026-11-04T12:45:00Z")), []);
});

test("replan message: outside the nudge budget", async () => {
  const { whatToSend } = await nudges();
  // Six nudges already went out today: the budget is spent.
  const used = [1, 2, 3, 4, 5, 6].map((n) => ({ block_id: `0c0c0c0c-0000-4000-8000-00000000000${n}`, kind: "start", day: DAY, send_at: `2026-11-04T13:0${n}:00.000Z`, sent_at: `2026-11-04T13:0${n}:01Z` }));
  assert.deepEqual(whatToSend(snapshot({ log: [briefSent, ...used] }), at1006).map((m) => m.kind), ["replan"]);
});

test("replan message: only for a pending revision", async () => {
  const { whatToSend } = await nudges();
  assert.deepEqual(whatToSend(snapshot({ proposal: rev2({ status: "approved" }), blocks: [row(B(1), OS, { proposed: false }), row(B(3), HW3, { proposed: false })] }), at1006), []);
});

test("replan message: at most 6 added lines, earliest first", async () => {
  const { whatToSend } = await nudges();
  // Seven 15-minute blocks from 10:15 am, given latest first.
  const seven = ["15:15", "15:30", "15:45", "16:00", "16:15", "16:30", "16:45"].map((t) => {
    const [h, m] = t.split(":").map(Number);
    const end = `${String(m === 45 ? h + 1 : h).padStart(2, "0")}:${String((m + 15) % 60).padStart(2, "0")}`;
    return span("t1", `2026-11-04T${t}:00Z`, `2026-11-04T${end}:00Z`);
  }).reverse();
  const snap = snapshot({
    previous: revision(1, { status: "approved", blocks: [] }),
    proposal: rev2({ blocks: seven, couldnt_fit: [] }),
    blocks: seven.map((s, i) => row(`0d0d0d0d-0000-4000-8000-00000000000${i}`, s)),
  });
  const [m] = whatToSend(snap, at1006);
  assert.equal(m.text, [
    "Replan: a busy time landed on a block, new mail.",
    "+ 10:15 am · OS homework (15 min)",
    "+ 10:30 am · OS homework (15 min)",
    "+ 10:45 am · OS homework (15 min)",
    "+ 11:00 am · OS homework (15 min)",
    "+ 11:15 am · OS homework (15 min)",
    "+ 11:30 am · OS homework (15 min)",
  ].join("\n"));
});
