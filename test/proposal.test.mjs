// The morning plan (src/sheet/proposal.mjs), past what the verification tests pin: whitespace,
// a lapsed proposal, input that isn't a list, and the brief's lines for a small plan. Wednesday
// 2026-11-04 in New York (EST, UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProposal, couldntFitLine, planSnapshot, proposalLines } from "../src/sheet/proposal.mjs";

const DAY = "2026-11-04";
const SBU = "lisul.elvitigala@stonybrook.edu";
const snap = (extra = {}) => ({
  now: "2026-11-04T11:07:00.000Z", time_zone: "America/New_York", plan_day: DAY, shutdown: "17:00",
  tasks: [{ id: "t1", title: "OS homework", est_min: 45, at_time: null, due: null, tag: null, source: null, day: DAY, list: null, at_risk: false }],
  blocks: [], busy: [], busy_as_of: null, interests: null, campus: [], proposal: null, needs_you_open: [], accounts: [SBU],
  ...extra,
});
const need = (extra = {}) => ({
  account: SBU, message_id: "19a4f2c3b5d6e7f8", link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(SBU)}#all/19a4f2c3b5d6e7f8`,
  sender: "Ana Ruiz", subject: "Demo moved", why: "Reply by Thursday.", kind: "reply", ...extra,
});

test("checkProposal: runs of spaces collapse and the ends are trimmed in the rows", () => {
  const r = checkProposal({ day: DAY, blocks: [], needs_you: [need({ subject: "  Demo   moved  " })], picks: [], note: " Lab 4  didn't fit. " }, snap());
  assert.equal(r.ok, true);
  assert.equal(r.rows.needs[0].subject, "Demo moved");
  assert.equal(r.rows.note, "Lab 4 didn't fit.");
});

test("checkProposal: a tab is a control character, refused like a newline", () => {
  const r = checkProposal({ day: DAY, blocks: [], needs_you: [need({ why: "Reply\tnow." })], picks: [], note: null }, snap());
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^needs_you\[0\]\.why: /);
});

test("checkProposal: a lapsed proposal can't be replaced", () => {
  const r = checkProposal({ day: DAY, blocks: [], needs_you: [], picks: [], note: null }, snap({ proposal: { status: "lapsed", created_at: "2026-11-04T10:30:00Z" } }));
  assert.deepEqual(r.errors, ["day: the proposal for 2026-11-04 is already lapsed"]);
});

test("checkProposal: missing lists count as empty; lists that aren't lists are refused", () => {
  assert.equal(checkProposal({ day: DAY }, snap()).ok, true);
  const r = checkProposal({ day: DAY, blocks: "09:00 OS homework", needs_you: {}, picks: 3 }, snap());
  assert.deepEqual(r.errors, ["blocks: must be a list", "needs_you: must be a list", "picks: must be a list"]);
});

test("checkProposal: a block over an approved block names it, both ends in the morning", () => {
  const r = checkProposal({ day: DAY, blocks: [{ task_id: "t1", start: "10:30", minutes: 45 }] },
    snap({ blocks: [{ task_id: "t1", starts_at: "2026-11-04T15:00:00Z", ends_at: "2026-11-04T16:00:00Z", proposed: false }] }));
  assert.deepEqual(r.errors, ["blocks[0]: overlaps an approved block 10:00–11:00 am"]);
});

test("proposalLines: a morning-only plan names its half of the day once, and one open mail \"needs\" you", () => {
  const p = { day: DAY, status: "pending", created_at: "2026-11-04T11:09:00Z", note: null, picks: [] };
  const blocks = [{ id: "p1", task_id: "t1", starts_at: "2026-11-04T14:30:00Z", ends_at: "2026-11-04T15:15:00Z", proposed: true }];
  const tasks = [{ id: "t1", title: "OS homework" }];
  assert.deepEqual(proposalLines(p, blocks, tasks, [{ done: false }], [], [], "America/New_York"),
    ["Morning plan: 1 block, 9:30–10:15 am.", "9:30 am · OS homework (45 min)", "Mail: 1 needs you."]);
  assert.deepEqual(proposalLines(p, [], tasks, [], [], [], "America/New_York"), ["Morning plan: no blocks."]);
});

// Telegram links bare domains, @mentions and /commands even without parse_mode, so none may
// reach a message (security review, 2026-11-03).
test("checkProposal: bare domains, mentions, other schemes and /commands are refused in the note", () => {
  for (const note of ["Confirm at sbu-housing.com?id=1", "see evil.com", "evil.com:443", "join t.me", "tg://resolve?domain=evilbot",
    "ask @evilbot", "write x@evil.com", "tap /start now", "/start", "ftp://x"]) {
    const r = checkProposal({ day: DAY, note }, snap());
    assert.equal(r.ok, false, note);
    assert.match(r.errors[0], /^note: /, note);
  }
});

test("checkProposal: ordinary sentences with dots, times and slashes still pass", () => {
  for (const note of ["Lab 4 didn't fit: 3.5 hours left, e.g. after 5 p.m.", "CSE 320 HW3 and AMS 310 overlap", "Ph.D. talk at 4:30 pm", "Reading 2/3 done"]) {
    assert.equal(checkProposal({ day: DAY, note }, snap()).ok, true, note);
  }
});

test("proposalLines: a campus pick whose title could become a link stays off Telegram", () => {
  const campus = [
    { uid: "a", title: "Free pizza at evil.com", starts_at: "2026-11-04T23:00:00Z", rsvp_count: 5 },
    { uid: "b", title: "Robotics GBM", starts_at: "2026-11-05T00:00:00Z", rsvp_count: 9 },
  ];
  const lines = proposalLines({ day: DAY, status: "pending", note: null, picks: [{ uid: "a" }, { uid: "b" }] }, [], [], [], null, campus, "America/New_York");
  assert.ok(!lines.some((l) => l.includes("evil")), lines.join("\n"));
  assert.ok(lines.includes("Campus pick: Robotics GBM (7:00 pm, 9 going)"), lines.join("\n"));
});

// --- v5 D2: a realistic day ---------------------------------------------------------------------

test("planSnapshot: day_rules carry the workload cap from settings, 6 hours without one", () => {
  const rows = (settings) => ({ settings: { time_zone: "America/New_York", ...settings }, tasks: [], blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [] });
  const now = new Date("2026-11-04T11:07:00Z");
  assert.deepEqual(planSnapshot(rows({ workload_cap_min: 270 }), now).day_rules, { workload_cap_min: 270, travel_min: 10, break_after_min: 90, break_min: 10, cap_reason: null, bedtime: null, wind_down_from: null });
  assert.equal(planSnapshot(rows({}), now).day_rules.workload_cap_min, 360);
});

test("couldntFitLine: a title that could become a link reads \"A task\"; a gone task drops", () => {
  const tasks = [{ id: "a", title: "Sign up at evil.com" }, { id: "b", title: "Lab 4" }];
  assert.equal(couldntFitLine(["a", "b", "gone"], tasks), "Couldn't fit: A task, Lab 4.");
  assert.equal(couldntFitLine(["gone"], tasks), null);
  assert.equal(couldntFitLine(undefined, tasks), null);
});

test("checkProposal: without version 5, couldnt_fit is ignored and rows don't carry it", () => {
  const r = checkProposal({ day: DAY, blocks: [], couldnt_fit: ["nope"] }, snap());
  assert.equal(r.ok, true);
  assert.equal("couldnt_fit" in r.rows, false);
});

// --- v5 V1: the plan window, the run and turned-down tasks in read_planner --------------------

const v5Rows = (extra = {}) => ({
  settings: { time_zone: "America/New_York", busy_as_of: null, interests: null },
  tasks: [
    { id: "t1", title: "OS homework", day: DAY, done: false, est_min: 45 },
    { id: "t2", title: "Laundry", day: DAY, done: false, est_min: 30 },
  ],
  blocks: [], busy: [], days: [{ day: DAY, shutdown_at: null, turned_down: ["t2"] }], campus: [],
  proposal: { day: DAY, rev: 2, status: "pending", created_at: "2026-11-04T14:00:00Z", run_trigger: "replan" },
  needsOpen: [], accounts: [],
  ...extra,
});

test("planSnapshot v5: the window starts at now rounded up to the quarter hour, on today only", async () => {
  const { planSnapshot } = await import("../src/sheet/proposal.mjs");
  assert.deepEqual(planSnapshot(v5Rows(), new Date("2026-11-04T14:07:00Z")).window, { from: "09:15", to: "17:00" });
  assert.deepEqual(planSnapshot(v5Rows(), new Date("2026-11-04T14:15:00Z")).window, { from: "09:15", to: "17:00" });
  assert.deepEqual(planSnapshot(v5Rows(), new Date("2026-11-04T11:07:00Z")).window, { from: "07:00", to: "17:00" });
  // From 3 pm the day planned is tomorrow, which starts at 07:00.
  const late = planSnapshot(v5Rows(), new Date("2026-11-04T20:30:00Z"));
  assert.equal(late.plan_day, "2026-11-05");
  assert.deepEqual(late.window, { from: "07:00", to: "17:00" });
});

test("planSnapshot v5: a turned-down task leaves the list; the proposal carries its revision", async () => {
  const { planSnapshot } = await import("../src/sheet/proposal.mjs");
  const s = planSnapshot(v5Rows(), new Date("2026-11-04T14:07:00Z"));
  assert.equal(s.version, 5);
  assert.deepEqual(s.tasks.map((t) => t.id), ["t1"]);
  assert.deepEqual(s.turned_down, ["t2"]);
  assert.deepEqual(s.proposal, { rev: 2, status: "pending", created_at: "2026-11-04T14:00:00Z", run_trigger: "replan" });
});

test("planSnapshot v5: a started replan after the newest revision and under 30 minutes old makes a replan run", async () => {
  const { planSnapshot } = await import("../src/sheet/proposal.mjs");
  const now = new Date("2026-11-04T14:20:00Z");
  const replan = { at: "2026-11-04T14:05:00Z", result: "started", reasons: ["busy_overlap"] };
  const changes = [{ kind: "busy" }, { kind: "mail" }, { kind: "mail" }];
  assert.deepEqual(planSnapshot(v5Rows({ replan, changes }), now).run, { trigger: "replan", reasons: ["busy_overlap"], changes: { busy: 1, mail: 2 } });
  // Too old, failed, or before the newest revision: the morning run.
  const morning = { trigger: "morning", reasons: [], changes: {} };
  assert.deepEqual(planSnapshot(v5Rows({ replan }), new Date("2026-11-04T14:36:00Z")).run, morning);
  assert.deepEqual(planSnapshot(v5Rows({ replan: { ...replan, result: "failed" } }), now).run, morning);
  assert.deepEqual(planSnapshot(v5Rows({ replan: { ...replan, at: "2026-11-04T13:55:00Z" } }), now).run, morning);
});

// --- v5 H1: habits ------------------------------------------------------------------------------

test("proposalLines: a habit block reads \"Habit\"", () => {
  const p = { day: DAY, status: "pending", created_at: "2026-11-04T11:09:00Z", note: null, picks: [] };
  const blocks = [{ id: "p1", task_id: null, habit_id: "h1", starts_at: "2026-11-04T17:30:00Z", ends_at: "2026-11-04T18:00:00Z", proposed: true }];
  assert.deepEqual(proposalLines(p, blocks, [], [], [], [], "America/New_York"),
    ["Morning plan: 1 block, 12:30–1:00 pm.", "12:30 pm · Habit (30 min)"]);
});

test("planSnapshot: approved habit blocks keep their habit_id, and stay out of planned versus done", () => {
  const rows = {
    settings: { time_zone: "America/New_York" }, tasks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [],
    blocks: [{ task_id: null, habit_id: "h1", starts_at: "2026-11-04T17:30:00Z", ends_at: "2026-11-04T18:00:00Z", proposed: false }],
    past: [{ task_id: null, habit_id: "h1", starts_at: "2026-11-03T17:30:00Z", ends_at: "2026-11-03T18:00:00Z", proposed: false, task: null }],
  };
  const s = planSnapshot(rows, new Date("2026-11-04T11:07:00Z"));
  assert.deepEqual(s.blocks, [{ task_id: null, habit_id: "h1", starts_at: "2026-11-04T17:30:00Z", ends_at: "2026-11-04T18:00:00Z", proposed: false }]);
  assert.deepEqual(s.planned_vs_done, []);
});

// --- Fix: a replan from 3 pm plans the rest of today ---------------------------------------------

test("planDayOf: a fresh started replan from 3 pm plans today; otherwise the 3 pm rule", async () => {
  const { planDayOf } = await import("../src/sheet/proposal.mjs");
  const four = new Date("2026-11-04T21:00:00Z"); // 4:00 pm
  const replan = { day: DAY, at: "2026-11-04T20:55:00Z", result: "started", reasons: ["busy_overlap"] };
  const morning = { created_at: "2026-11-04T11:09:00Z" };
  assert.equal(planDayOf(four, "America/New_York", replan, morning), DAY);
  assert.equal(planDayOf(four, "America/New_York", replan, null), DAY);
  assert.equal(planDayOf(four, "America/New_York", null, morning), "2026-11-05");
  assert.equal(planDayOf(four, "America/New_York", { ...replan, result: "failed" }, morning), "2026-11-05");
  // Its revision is in already, or it is over 30 minutes old: the 3 pm rule again.
  assert.equal(planDayOf(four, "America/New_York", replan, { created_at: "2026-11-04T20:58:00Z" }), "2026-11-05");
  assert.equal(planDayOf(new Date("2026-11-04T21:30:00Z"), "America/New_York", replan, morning), "2026-11-05");
});

test("planSnapshot v5: a replan run at 4 pm plans today from now, not tomorrow", async () => {
  const { planSnapshot } = await import("../src/sheet/proposal.mjs");
  const four = new Date("2026-11-04T21:02:00Z"); // 4:02 pm
  const replan = { day: DAY, at: "2026-11-04T20:55:00Z", result: "started", reasons: ["busy_overlap"] };
  const days = [{ day: DAY, shutdown_at: "18:30:00", turned_down: [] }];
  const s = planSnapshot(v5Rows({ replan, days, plan_day: DAY }), four);
  assert.equal(s.plan_day, DAY);
  assert.deepEqual(s.window, { from: "16:15", to: "18:30" });
  assert.equal(s.run.trigger, "replan");
  // A replans row of another day never makes a replan run.
  assert.equal(planSnapshot(v5Rows({ replan: { ...replan, day: "2026-11-03" } }), new Date("2026-11-04T14:20:00Z")).run.trigger, "morning");
});

// --- Fix: changes logged during a run stay for the next replan ------------------------------------

test("planSnapshot v5: read_at is when the snapshot was read; checkProposal passes it on to apply_proposal", async () => {
  const { planSnapshot, checkProposal } = await import("../src/sheet/proposal.mjs");
  const read = new Date("2026-11-04T14:07:00Z");
  const s = planSnapshot(v5Rows(), read);
  assert.equal(s.read_at, "2026-11-04T14:07:00.000Z");
  // Submitted four minutes later, against a fresh snapshot.
  const fresh = planSnapshot(v5Rows(), new Date("2026-11-04T14:11:00Z"));
  const input = { day: DAY, replaces: 2, blocks: [], read_at: s.read_at };
  const r = checkProposal(input, fresh);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows.read_at, "2026-11-04T14:07:00.000Z");
  // Without it, apply_proposal keeps its own clock (rows have no read_at).
  assert.equal("read_at" in checkProposal({ ...input, read_at: undefined }, fresh).rows, false);
  // Not a time, or after the fresh read: refused.
  assert.match(checkProposal({ ...input, read_at: "soon" }, fresh).errors.join(" "), /^read_at/);
  assert.match(checkProposal({ ...input, read_at: "2026-11-04T14:12:00.000Z" }, fresh).errors.join(" "), /^read_at/);
});

test("planDayOf: a message run that goes on as a replan of today plans today from 3 pm too", async () => {
  const { planDayOf, messageRunOf } = await import("../src/sheet/proposal.mjs");
  const four = new Date("2026-11-04T21:00:00Z"); // 4:00 pm
  const morning = { created_at: "2026-11-04T11:09:00Z" };
  // The newest fired message, answered by now (submit_proposal's fresh read comes after it).
  const message = { fired_at: "2026-11-04T20:55:00Z" };
  assert.equal(messageRunOf(four, message, morning), true);
  assert.equal(planDayOf(four, "America/New_York", null, morning, message), DAY);
  // Fired over 30 minutes ago, before today's newest revision, or none: the 3 pm rule.
  assert.equal(planDayOf(new Date("2026-11-04T21:30:00Z"), "America/New_York", null, morning, message), "2026-11-05");
  assert.equal(planDayOf(four, "America/New_York", null, { created_at: "2026-11-04T20:58:00Z" }, message), "2026-11-05");
  assert.equal(planDayOf(four, "America/New_York", null, morning, null), "2026-11-05");
  assert.equal(messageRunOf(four, { fired_at: null }, morning), false);
});

// --- Wind-down: no block or habit in the hour before tonight's bedtime ----------------------

test("planSnapshot: a bedtime cuts window.to to an hour before it when that falls on the day", () => {
  const at = (hhmm, extra = {}) => planSnapshot(v5Rows({
    settings: { time_zone: "America/New_York", wind_down_on: true, bedtime_target: hhmm, bedtime_ease: false, ...extra },
    days: [{ day: DAY, shutdown_at: "23:30:00", turned_down: [] }],
  }), new Date("2026-11-04T14:07:00Z"));
  // Bed 12:30 am: wind-down from 11:30 pm, the shutdown line itself here.
  assert.deepEqual(at("00:30:00").window, { from: "09:15", to: "23:30" });
  // Bed 11:00 pm: the window ends at 10:00 pm, before the 11:30 pm shutdown.
  assert.deepEqual(at("23:00:00").window, { from: "09:15", to: "22:00" });
  assert.equal(at("23:00:00").day_rules.bedtime, "23:00");
  assert.equal(at("23:00:00").day_rules.wind_down_from, "22:00");
  // Bed 2:00 am: wind-down from 1:00 am is tomorrow; the window keeps the shutdown line.
  assert.deepEqual(at("02:00:00").window, { from: "09:15", to: "23:30" });
  assert.equal(at("02:00:00").day_rules.wind_down_from, "01:00");
  // Wind-down off: no bedtime.
  assert.deepEqual(at("23:00:00", { wind_down_on: false }).window, { from: "09:15", to: "23:30" });
  assert.equal(at("23:00:00", { wind_down_on: false }).day_rules.bedtime, null);
  // Oura's window when no target is set: start 10:30 pm, from the next day's row.
  const oura = planSnapshot(v5Rows({
    settings: { time_zone: "America/New_York", wind_down_on: true, bedtime_target: null },
    days: [{ day: DAY, shutdown_at: "23:30:00", turned_down: [] }],
    sleepTimes: [{ day: "2026-11-05", start_offset: -5400, end_offset: -1800 }],
  }), new Date("2026-11-04T14:07:00Z"));
  assert.deepEqual(oura.window, { from: "09:15", to: "21:30" });
});

test("planSnapshot: with no line of its own, the day shuts down when wind-down starts, by 11 pm", () => {
  const at = (hhmm, line = null) => planSnapshot(v5Rows({
    settings: { time_zone: "America/New_York", wind_down_on: true, bedtime_target: hhmm, bedtime_ease: false },
    days: [{ day: DAY, shutdown_at: line, turned_down: [] }],
  }), new Date("2026-11-04T14:07:00Z"));
  // Bed 10:30 pm: shutdown and the window's end at 9:30 pm, not 5 pm.
  assert.equal(at("22:30:00").shutdown, "21:30");
  assert.deepEqual(at("22:30:00").window, { from: "09:15", to: "21:30" });
  // Bed 3:00 am: wind-down is after midnight, so 11 pm.
  assert.equal(at("03:00:00").shutdown, "23:00");
  assert.deepEqual(at("03:00:00").window, { from: "09:15", to: "23:00" });
  // A line moved by hand still wins.
  assert.equal(at("03:00:00", "18:00:00").shutdown, "18:00");
  assert.deepEqual(at("03:00:00", "18:00:00").window, { from: "09:15", to: "18:00" });
});

test("checkProposal: a block or habit running into wind-down is refused, naming it", () => {
  const s = planSnapshot(v5Rows({
    settings: { time_zone: "America/New_York", wind_down_on: true, bedtime_target: "23:00:00", bedtime_ease: false },
    tasks: [{ id: "t1", title: "OS homework", day: DAY, done: false, est_min: 45 }],
    days: [{ day: DAY, shutdown_at: "23:30:00", turned_down: [] }],
    proposal: null,
    habits: [{ id: "h1", name: "Read", days: [3], ideal: "21:30:00", minutes: 30, flex_min: 15, defence: "flexible", position: 0 }],
  }), new Date("2026-11-04T14:07:00Z"));
  const ok = checkProposal({ version: 5, day: DAY, replaces: null, blocks: [{ task_id: "t1", start: "21:00", minutes: 45 }], needs_you: [], picks: [] }, s);
  assert.equal(ok.ok, true, ok.errors?.join("; "));
  const late = checkProposal({ version: 5, day: DAY, replaces: null, blocks: [{ task_id: "t1", start: "21:30", minutes: 45 }], needs_you: [], picks: [] }, s);
  assert.equal(late.ok, false);
  assert.match(late.errors.join("\n"), /blocks\[0\]: ends after 22:00, when wind-down starts \(bed 11:00 pm\)/);
  const habit = checkProposal({ version: 5, day: DAY, replaces: null, blocks: [], habits: [{ habit_id: "h1", start: "21:45" }], needs_you: [], picks: [] }, s);
  assert.match(habit.errors.join("\n"), /habits\[0\]: ends after 22:00, when wind-down starts/);
});

test("planSnapshot: Rest Mode cuts the cap to essentials and keeps firm habits only, in words with no figures", () => {
  const habits = [
    { id: "h1", name: "Gym", days: [3], ideal: "17:00:00", minutes: 60, flex_min: 30, defence: "flexible", position: 0 },
    { id: "h2", name: "Meds", days: [3], ideal: "09:00:00", minutes: 15, flex_min: 0, defence: "firm", position: 1 },
  ];
  const s = (restPeriods) => planSnapshot(v5Rows({ habits, restPeriods }), new Date("2026-11-04T14:07:00Z"));
  const on = s([{ start_day: "2026-11-03", end_day: null }]);
  assert.equal(on.day_rules.workload_cap_min, 150); // 0.4 × 6h, to the quarter hour
  assert.equal(on.day_rules.cap_reason, "rest mode");
  assert.deepEqual(on.habits.map((h) => h.id), ["h2"]);
  const back = s([{ start_day: "2026-11-01", end_day: "2026-11-03" }]);
  assert.equal(back.day_rules.workload_cap_min, 195); // 0.55 × 6h
  assert.equal(back.day_rules.cap_reason, "easing back from rest mode");
  assert.deepEqual(back.habits.map((h) => h.id), ["h2", "h1"]);
  assert.equal(s([]).day_rules.workload_cap_min, 360);
});

// --- Auto-approval: a run's blocks count at once, and a later run may move them -------------

test("planSnapshot: an auto-approved block not yet started is the plan's to move; started or hand-approved, it's locked", () => {
  const blocks = [
    { task_id: "t1", starts_at: "2026-11-04T19:00:00Z", ends_at: "2026-11-04T19:45:00Z", proposed: false, auto: true }, // 2 pm, ahead
    { task_id: "t2", starts_at: "2026-11-04T13:30:00Z", ends_at: "2026-11-04T14:30:00Z", proposed: false, auto: true }, // 8:30 am, started
    { task_id: "t3", starts_at: "2026-11-04T20:00:00Z", ends_at: "2026-11-04T21:00:00Z", proposed: false, auto: false }, // 3 pm, approved by hand
  ];
  const s = planSnapshot(v5Rows({ blocks, days: [{ day: DAY, shutdown_at: "22:00:00", turned_down: [] }] }), new Date("2026-11-04T14:07:00Z"));
  assert.deepEqual(s.blocks.map((b) => [b.task_id, b.proposed, b.auto ?? false]), [["t1", true, true], ["t2", false, false], ["t3", false, false]]);
  // A new revision may put a block where the movable one was, not on the locked ones.
  const input = (start) => ({ version: 5, day: DAY, replaces: 2, blocks: [{ task_id: "t1", start, minutes: 45 }], needs_you: [], picks: [] });
  assert.equal(checkProposal(input("14:00"), s).ok, true, checkProposal(input("14:00"), s).errors?.join("; "));
  assert.match(checkProposal(input("15:00"), s).errors.join("\n"), /overlaps an approved block/);
});

test("planSnapshot: auto_approve says whether a submitted revision is approved at once (on unless turned off)", () => {
  const at = (settings) => planSnapshot(v5Rows({ settings: { time_zone: "America/New_York", ...settings } }), new Date("2026-11-04T14:07:00Z")).auto_approve;
  assert.equal(at({}), true);
  assert.equal(at({ auto_approve: true }), true);
  assert.equal(at({ auto_approve: false }), false);
});

// --- Every untimed to-do gets a time, or moves to the next day ------------------------------

test("checkProposal: next_day moves plan_day's untimed tasks that couldn't fit, and nothing else", () => {
  const s = planSnapshot(v5Rows({
    tasks: [
      { id: "t1", title: "OS homework", day: DAY, done: false, est_min: 45 },
      { id: "t2", title: "Laundry", day: DAY, done: false, est_min: 30 },
      { id: "t3", title: "Call", day: DAY, done: false, est_min: 15, at_time: "16:00:00" },
      { id: "t4", title: "Essay", day: "2026-11-06", done: false, est_min: 60, source: "brightspace", due: "2026-11-06" },
      { id: "t5", title: "Slides", day: DAY, done: false, est_min: 60 },
    ],
    blocks: [{ task_id: "t5", starts_at: "2026-11-04T20:00:00Z", ends_at: "2026-11-04T21:00:00Z", proposed: false }],
    days: [{ day: DAY, shutdown_at: null, turned_down: [] }],
  }), new Date("2026-11-04T14:07:00Z"));
  const submit = (next_day) => checkProposal({ version: 5, day: DAY, replaces: 2, blocks: [{ task_id: "t1", start: "10:00", minutes: 45 }], next_day, needs_you: [], picks: [] }, s);
  const ok = submit(["t2"]);
  assert.equal(ok.ok, true, ok.errors?.join("; "));
  assert.deepEqual(ok.next_day, ["t2"]);
  assert.equal("next_day" in ok.rows, false); // not one of apply_proposal's arguments
  assert.deepEqual(submit(undefined).next_day, []);
  assert.deepEqual(submit(["t1", "t3", "t4", "t5", "nope"]).errors, [
    "next_day[0]: t1 has a block in this revision, so it stays",
    "next_day[1]: t3 is fixed at 16:00, so it stays",
    "next_day[2]: t4 is not on 2026-11-04, so it can't move to the next day",
    "next_day[3]: t5 already has an approved block, so it stays",
    "next_day[4]: not one of the tasks read_planner gave",
  ]);
});
