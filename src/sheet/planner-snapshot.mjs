// read_planner's snapshot (docs/sheet-morning.md), shared by planner-mcp, which reads as the owner
// through supabase-js, and the telegram function's chat (docs/sheet-chat.md), which reads with the
// service key through PostgREST (proposal-io.mjs, queryPath). Each passes its own `read` for a query of proposal-io.mjs's shape.
// Only what planSnapshot keeps goes out, so Oura data stays code-derived
// (docs/adr/0005-oura-data-never-reaches-claude.md) and Hevy rows are never read.
import { messageRunOf, planDayOf, planSnapshot } from "./proposal.mjs";
import { habitsQuery, horizonSnapshotQueries, paceQueries, replanQueries, snapshotQueries, todayReplanQueries } from "./proposal-io.mjs";
import { withMessages } from "./messages.mjs";
import { addDays } from "./logic.mjs";

// A query is { table, select, filters?: [[column, op, value]], or?, order? } (proposal-io.mjs), and
// read(query) resolves to its rows.

// The raw rows planSnapshot takes: settings first for the time zone, then the day's rows, then
// the blocks of the tasks read.
export async function plannerSnapshot(read, pending, now) {
  const [settings] = await read({ table: "settings", select: "*" });
  if (!settings) throw new Error("settings: no row");
  // v5 R1: a replan run plans the rest of today, even from 3 pm (planDayOf), and so does a
  // message run, which may go on as a replan of today while replans are on (step 2b).
  const t = todayReplanQueries(now, settings.time_zone);
  const [[replan = null], [todayRev = null], [message = null]] = await Promise.all([
    read(t.replan), read(t.proposal), settings.replans_on ? read(t.message) : Promise.resolve([]),
  ]);
  const planDay = planDayOf(now, settings.time_zone, replan, todayRev, message);
  const messageRun = Boolean(settings.replans_on) && messageRunOf(now, message, todayRev);
  // Horizon planning: plan_day's minutes and every state; none until its schema has run.
  const h = horizonSnapshotQueries(planDay);
  const [alloc, states] = await Promise.all([optional(read, h.alloc), optional(read, h.states)]);
  const horizonIds = alloc.filter((a) => a.minutes - a.over_min > 0).map((a) => a.task_id);
  const q = snapshotQueries(now, settings.time_zone, planDay, horizonIds);
  const { tasks, busy, days, campus, proposal, needsOpen, accounts } = q.queries;
  const rows = await Promise.all([tasks, busy, days, campus, proposal, needsOpen, accounts].map((x) => read(x)));
  const blocks = await read(q.blocks(rows[0].map((t) => t.id)));
  // v5 W1: the cached forecast; planSnapshot keeps plan_day's hours.
  const [weather = null] = await read({ table: "weather_cache", select: "periods" });
  // v5 SRC3: plan_day's academic calendar entries (the day planSnapshot plans).
  const [academicDay = null] = await read({ table: "academic_days", select: "entries", filters: [["day", "eq", planDay]] });
  // v5 P1: what pace and planned versus done are worked out from.
  const p = paceQueries(now, settings.time_zone, planDay);
  const [actuals, past] = await Promise.all([read(p.actuals), read(p.past)]);
  // v5 H1: the habits; planSnapshot keeps plan_day's.
  const habits = await read(habitsQuery());
  // v5 R1: the replan that started this run, if any, and the changes since the newest revision.
  const changes = await read(replanQueries(now, settings.time_zone, rows[4][0] ?? null, planDay).changes);
  // v5 L1: the triage rules.
  const triage = await read({ table: "triage_rules", select: "match,pattern,action", order: "created_at" });
  // v5 M1: Reply owed and Awaiting reply, which the mail sync keeps.
  const replyState = await read({ table: "reply_state", select: "account,thread_id,state,since,who,message_id,basis,draft", order: "since" });
  // Oura: the sleep periods (nightly_roll keeps 60 days), the day's readiness and sleep, and
  // Oura's bedtime windows. A missing table (the Oura schema not run yet) reads as none. Only what
  // code derives from them goes out: window.from, window.to, the cap and break rule, and bedtime
  // and wind_down_from as plain times (docs/adr/0005-oura-data-never-reaches-claude.md).
  const [sleep, sleepDays, sleepTimes, restPeriods] = await Promise.all([
    optional(read, { table: "sleep_nights", select: "oura_id,day,type,bedtime_start,bedtime_end", order: "bedtime_end" }),
    // plan_day's and the two days before it, for the rolling sleep debt (sleep.mjs, sleepDebt).
    optional(read, { table: "sleep_days", select: "day,readiness,sleep_s", filters: [["day", "gte", addDays(planDay, -2)], ["day", "lte", planDay]] }),
    optional(read, { table: "sleep_times", select: "day,start_offset,end_offset", order: "day" }),
    optional(read, { table: "rest_periods", select: "start_day,end_day", order: "start_day" }),
  ]);
  const snap = planSnapshot({
    sleep, sleepDays, sleepTimes, restPeriods,
    plan_day: planDay, actuals, past, habits, replan, changes, triage, replyState,
    settings, tasks: rows[0], blocks, busy: rows[1], days: rows[2], campus: rows[3],
    proposal: rows[4][0] ?? null, needsOpen: rows[5], accounts: rows[6], weather,
    academic: academicDay?.entries ?? [], horizon: { alloc, states },
  }, now);
  // Messages to Claude: the pending ones, today and replans_on.
  // Whether this may be a message run going on as a replan of today (submit_proposal reads it).
  snap.message_run = messageRun;
  return withMessages(snap, await pending(), settings, now);
}

// A read of a table that may not exist yet: none until its schema section has run. supabase-js
// says "schema cache" or "does not exist"; PostgREST through db() gives the code (PGRST205, 42P01).
async function optional(read, q) {
  try {
    return await read(q);
  } catch (e) {
    if (/schema cache|does not exist|PGRST205|42P01/.test(e?.message ?? "")) return [];
    throw e;
  }
}
