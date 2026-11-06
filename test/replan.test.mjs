// changeRow, the row a sync writes (src/sheet/replan.mjs). shouldReplan and the reason words are
// covered by test/v5-replans.verify.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { changeRow } from "../src/sheet/replan.mjs";

test("changeRow: a reason gives its kind and weight", () => {
  assert.deepEqual(changeRow("course_due_soon", "uid-1"), { kind: "course", reason: "course_due_soon", weight: 8, ref: "uid-1" });
  assert.deepEqual(changeRow("campus_change"), { kind: "campus", reason: "campus_change", weight: 3, ref: null });
});

test("changeRow: a ref is cut to 200 characters; an unknown reason throws", () => {
  assert.equal(changeRow("course_change", "x".repeat(250)).ref.length, 200);
  assert.throws(() => changeRow("weather_change"));
});

// --- The feeds' changes (src/sheet/feeds.mjs) -------------------------------------------------

test("courseChanges: one row per insert and update, due within 48 hours or not", async () => {
  const { courseChanges } = await import("../src/sheet/feeds.mjs");
  const out = {
    insert: [{ due: "2026-11-06", source_uid: "a" }, { due: "2026-11-07", source_uid: "b" }, { due: "2026-11-03", source_uid: "c" }],
    update: [{ id: "t1", due: "2026-11-04" }],
    seen: [],
  };
  assert.deepEqual(courseChanges(out, [{ id: "t1", source_uid: "d" }], "2026-11-04").map((c) => [c.reason, c.weight, c.ref]), [
    ["course_due_soon", 8, "a"], // the day after tomorrow
    ["course_change", 3, "b"],
    ["course_change", 3, "c"], // already past
    ["course_due_soon", 8, "d"],
  ]);
  assert.deepEqual(courseChanges({ insert: [], update: [], seen: [] }, [], "2026-11-04"), []);
});

test("campusChange: only today's events still to come count", async () => {
  const { campusChange } = await import("../src/sheet/feeds.mjs");
  const TZ = "America/New_York";
  const now = "2026-11-04T15:00:00Z"; // 10:00 am
  const ev = (uid, s, e) => ({ uid, starts_at: s, ends_at: e });
  const past = ev("p", "2026-11-04T13:00:00Z", "2026-11-04T14:00:00Z");
  const later = ev("l", "2026-11-04T20:00:00Z", "2026-11-04T21:00:00Z");
  const tomorrow = ev("t", "2026-11-05T20:00:00Z", "2026-11-05T21:00:00Z");
  assert.equal(campusChange([past, later], [later, tomorrow], now, TZ), null);
  assert.deepEqual(campusChange([later], [ev("l", "2026-11-04T20:30:00Z", "2026-11-04T21:00:00Z")], now, TZ),
    { kind: "campus", reason: "campus_change", weight: 3, ref: null });
  assert.equal(campusChange([later], [], now, TZ).reason, "campus_change");
});

// --- The tick's state (src/sheet/replan.mjs) --------------------------------------------------

test("replanState: plans today, the last plan and the shutdown line from today's rows", async () => {
  const { replanState } = await import("../src/sheet/replan.mjs");
  const settings = { time_zone: "America/New_York", replans_on: true, morning_on: true, plan_edited_at: "2026-11-04T14:00:00Z", telegram_chat_id: 1 };
  const proposals = [
    { rev: 1, run_trigger: "morning", created_at: "2026-11-04T11:09:00Z" },
    { rev: 2, run_trigger: "replan", created_at: "2026-11-04T15:05:00Z" },
  ];
  const replans = [{ at: "2026-11-04T15:00:00Z" }, { at: "2026-11-04T17:00:00Z" }];
  assert.deepEqual(replanState({ settings, day: { day: "2026-11-04", shutdown: false, shutdown_at: "18:30:00" }, proposals, replans }), {
    settings: { time_zone: "America/New_York", replans_on: true, morning_on: true },
    day: { day: "2026-11-04", shutdown: false, shutdown_at: "18:30:00" },
    shutdown: "18:30",
    plans_today: 3,
    last_plan_at: "2026-11-04T17:00:00.000Z",
    seen_until: "2026-11-04T15:05:00.000Z",
    closed: false,
    last_edit_at: "2026-11-04T14:00:00Z",
  });
  const none = replanState({ settings: { ...settings, plan_edited_at: null }, day: null, proposals: [], replans: [] });
  assert.equal(none.shutdown, "17:00");
  assert.equal(none.plans_today, 0);
  assert.equal(none.last_plan_at, null);
  // A replan with no morning revision today counts only itself.
  assert.equal(replanState({ settings, day: null, proposals: [proposals[1]], replans: [replans[0]] }).plans_today, 1);
});

test("replanState: with no line of its own, today shuts down when wind-down starts", async () => {
  const { replanState, shouldReplan } = await import("../src/sheet/replan.mjs");
  const settings = { time_zone: "America/New_York", replans_on: true, morning_on: true, plan_edited_at: null, wind_down_on: true, bedtime_target: "03:00:00", bedtime_ease: false };
  // Bed 3:00 am: wind-down after midnight, so the line is 11 pm, and a 6 pm change still replans.
  const s = replanState({ settings, today: "2026-11-04", day: null, proposals: [], replans: [], sleep: [], sleepTimes: [] });
  assert.equal(s.shutdown, "23:00");
  const change = { id: "c1", at: "2026-11-04T21:50:00Z", kind: "task", reason: "new task", weight: 8 };
  assert.equal(shouldReplan([change], s, new Date("2026-11-04T22:00:00Z")).fire, true); // 6 pm
  // A line he moved wins; wind-down off is the old 5 pm.
  assert.equal(replanState({ settings, today: "2026-11-04", day: { day: "2026-11-04", shutdown: false, shutdown_at: "18:30:00" }, proposals: [], replans: [] }).shutdown, "18:30");
  assert.equal(replanState({ settings: { ...settings, wind_down_on: false }, today: "2026-11-04", day: null, proposals: [], replans: [] }).shutdown, "17:00");
});

test("rateLimited: holds until retry_after", async () => {
  const { rateLimited } = await import("../src/sheet/replan.mjs");
  const rows = [{ retry_after: null }, { retry_after: "2026-11-04T16:00:00Z" }];
  assert.equal(rateLimited(rows, new Date("2026-11-04T15:59:00Z")), true);
  assert.equal(rateLimited(rows, new Date("2026-11-04T16:00:00Z")), false);
});

// --- /plan's edit stamp (src/sheet/api.mjs) ---------------------------------------------------

test("stampsEdit: writes to tasks, blocks and turn_down count; reads and other tables don't", async () => {
  const { stampsEdit } = await import("../src/sheet/api.mjs");
  assert.equal(stampsEdit("PATCH", "tasks?id=eq.1"), true);
  assert.equal(stampsEdit("POST", "blocks"), true);
  assert.equal(stampsEdit("DELETE", "blocks?id=eq.1"), true);
  assert.equal(stampsEdit("POST", "rpc/turn_down"), true);
  assert.equal(stampsEdit("GET", "tasks?select=*"), false);
  assert.equal(stampsEdit("PATCH", "settings?id=eq.true"), false);
  assert.equal(stampsEdit("POST", "busy"), false);
  assert.equal(stampsEdit("POST", "tasks_extra"), false);
});

// --- Fix: a replan that never started ---------------------------------------------------------

test("replanState: a failed or rate-limited replan counts toward neither plans_today nor too_soon", async () => {
  const { replanState } = await import("../src/sheet/replan.mjs");
  const settings = { time_zone: "America/New_York", replans_on: true, morning_on: true, plan_edited_at: null };
  const proposals = [{ rev: 1, run_trigger: "morning", created_at: "2026-11-04T11:09:00Z" }];
  const replans = [
    { at: "2026-11-04T15:00:00Z", result: "started" },
    { at: "2026-11-04T16:00:00Z", result: "failed" },
    { at: "2026-11-04T16:30:00Z", result: "rate_limited", retry_after: "2026-11-04T17:30:00Z" },
    { at: "2026-11-04T16:40:00Z", result: null }, // still sending
  ];
  const s = replanState({ settings, day: null, proposals, replans });
  assert.equal(s.plans_today, 3);
  assert.equal(s.last_plan_at, "2026-11-04T16:40:00.000Z");
  const failedOnly = replanState({ settings, day: null, proposals, replans: replans.slice(1, 3) });
  assert.equal(failedOnly.plans_today, 1);
  assert.equal(failedOnly.last_plan_at, "2026-11-04T11:09:00.000Z");
});

test("fireOutcome: started keeps the changes tied; a 429, a failure or a throw unties them and records why", async () => {
  const { fireOutcome } = await import("../src/sheet/replan.mjs");
  assert.deepEqual(fireOutcome({ ok: true, session_id: "s1", session_url: "https://x" }),
    { patch: { result: "started", session_id: "s1" }, untie: false });
  assert.deepEqual(fireOutcome({ ok: false, status: 429, error: "rate_limit_error", retry_at: "2026-11-04T17:00:00.000Z" }),
    { patch: { result: "rate_limited", error: "rate_limit_error", retry_after: "2026-11-04T17:00:00.000Z" }, untie: true });
  assert.deepEqual(fireOutcome({ ok: false, status: 500, error: "api_error" }), { patch: { result: "failed", error: "api_error" }, untie: true });
  // A throw (fireRoutine refusing its input, say) is a failure too, its message cut to 300.
  assert.deepEqual(fireOutcome(null, new Error("fire: bad routine id")), { patch: { result: "failed", error: "fire: bad routine id" }, untie: true });
  assert.equal(fireOutcome(null, new Error("x".repeat(400))).patch.error.length, 300);
});

test("shouldReplan: a change logged after the run read the day, but before its revision went in, still counts", async () => {
  const { shouldReplan, replanState } = await import("../src/sheet/replan.mjs");
  const settings = { time_zone: "America/New_York", replans_on: true, morning_on: true, plan_edited_at: null };
  // The replan run read the day at 9:00 and submitted at 9:04; the mail came in at 9:02.
  const proposals = [{ rev: 2, status: "pending", run_trigger: "replan", created_at: "2026-11-04T14:04:00Z", read_at: "2026-11-04T14:00:00Z" }];
  const state = replanState({ settings, day: null, proposals, replans: [] });
  assert.equal(state.seen_until, "2026-11-04T14:00:00.000Z");
  const mail = [{ id: "c1", at: "2026-11-04T14:02:00Z", kind: "mail", reason: "mail_owed", weight: 8 }];
  assert.equal(shouldReplan(mail, state, new Date("2026-11-04T15:05:00Z")).fire, true);
  // A revision without read_at (an older one) sees up to its created_at, as before.
  const old = replanState({ settings, day: null, proposals: [{ ...proposals[0], read_at: null }], replans: [] });
  assert.equal(old.seen_until, "2026-11-04T14:04:00.000Z");
  assert.deepEqual(shouldReplan(mail, old, new Date("2026-11-04T15:05:00Z")), { fire: false, hold: "nothing" });
});

test("shouldReplan: a day whose newest revision is skipped or lapsed holds as closed", async () => {
  const { shouldReplan, replanState } = await import("../src/sheet/replan.mjs");
  const settings = { time_zone: "America/New_York", replans_on: true, morning_on: true, plan_edited_at: null };
  const urgent = [{ id: "c1", at: "2026-11-04T15:01:00Z", kind: "busy", reason: "busy_overlap", weight: 10 }];
  const now = new Date("2026-11-04T15:02:00Z");
  const rows = (status) => [
    { rev: 1, status: "superseded", run_trigger: "morning", created_at: "2026-11-04T11:09:00Z" },
    { rev: 2, status, run_trigger: "replan", created_at: "2026-11-04T13:00:00Z" },
  ];
  for (const status of ["skipped", "lapsed"]) {
    const state = replanState({ settings, day: null, proposals: rows(status), replans: [] });
    assert.equal(state.closed, true);
    assert.deepEqual(shouldReplan(urgent, state, now), { fire: false, hold: "closed" });
  }
  for (const status of ["pending", "approved"]) {
    assert.equal(shouldReplan(urgent, replanState({ settings, day: null, proposals: rows(status), replans: [] }), now).fire, true);
  }
});

// --- The woke-late change (src/sheet/replan.mjs, routine-fire.mjs, nudges.mjs) ---------------

test("woke_late: a sleep change heavy enough to start a replan, whose kind the fire text carries", async () => {
  const { changeRow, shouldReplan } = await import("../src/sheet/replan.mjs");
  const { fireText } = await import("../src/sheet/routine-fire.mjs");
  const row = changeRow("woke_late", "2026-11-04T15:20:00.000Z");
  assert.deepEqual(row, { kind: "sleep", reason: "woke_late", weight: 9, ref: "2026-11-04T15:20:00.000Z" });
  const now = new Date("2026-11-04T15:30:00Z"); // 10:30 am
  const state = { settings: { time_zone: "America/New_York", replans_on: true, morning_on: true }, day: null, shutdown: "17:00", plans_today: 1, last_plan_at: "2026-11-03T22:00:00Z", last_edit_at: null };
  const r = shouldReplan([{ id: "c1", at: "2026-11-04T15:29:00Z", ...row }], state, now);
  assert.equal(r.fire, true);
  assert.deepEqual(r.counts, { sleep: 1 });
  assert.equal(fireText("replan", r.counts), "trigger: replan\nreasons: sleep 1");
  // Replans off: held, as any change.
  assert.equal(shouldReplan([{ id: "c1", at: "2026-11-04T15:29:00Z", ...row }], { ...state, settings: { ...state.settings, replans_on: false } }, now).hold, "replans_off");
});

// --- No-op replans and the paused cap (research/plan-reliability.md R7) ----------------------

test("replanState: a replan revision whose blocks match the one before it doesn't count toward the cap", async () => {
  const { replanState } = await import("../src/sheet/replan.mjs");
  const settings = { time_zone: "America/New_York", replans_on: true, morning_on: true, plan_edited_at: null };
  const b = (task_id, s, e) => ({ task_id, habit_id: null, starts_at: s, ends_at: e });
  const gym = b("t1", "2026-11-04T20:00:00Z", "2026-11-04T21:00:00Z");
  const hw = b("t2", "2026-11-04T18:00:00Z", "2026-11-04T19:00:00Z");
  const proposals = [
    { rev: 1, run_trigger: "morning", created_at: "2026-11-04T11:09:00Z", blocks: [gym, hw] },
    { rev: 2, run_trigger: "replan", created_at: "2026-11-04T15:05:00Z", blocks: [hw, gym] },             // the same blocks
    { rev: 3, run_trigger: "replan", created_at: "2026-11-04T17:05:00Z", blocks: [hw] },                  // changed
  ];
  const replans = [{ at: "2026-11-04T15:00:00Z", result: "started" }, { at: "2026-11-04T17:00:00Z", result: "started" }];
  assert.equal(replanState({ settings, day: null, proposals, replans }).plans_today, 2);
});

test("capHold: at the daily cap, says how many plans ran and whether a weighty change is waiting", async () => {
  const { capHold } = await import("../src/sheet/replan.mjs");
  const now = new Date("2026-11-04T22:00:00Z");
  const state = { plans_today: 8, seen_until: "2026-11-04T21:00:00Z" };
  const c = (weight, at) => ({ id: "c", at, weight, reason: "x", kind: "busy" });
  assert.deepEqual(capHold([c(10, "2026-11-04T21:30:00Z")], state, now), { hold: "daily_cap", used: 8, weighty: true });
  assert.deepEqual(capHold([c(2, "2026-11-04T21:30:00Z"), c(10, "2026-11-04T20:30:00Z")], state, now), { hold: "daily_cap", used: 8, weighty: false });
});
