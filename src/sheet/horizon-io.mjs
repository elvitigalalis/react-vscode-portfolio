// Horizon planning, part 2 (docs/sheet-horizon.md, "Part 2: the wiring"; ADR 0006): the rows a
// re-flow reads, the engine's input built from them, the key that lets an unchanged re-flow be
// skipped, and the re-flow itself. Free of the network: the telegram and planner-mcp functions
// pass reflowHorizon their own read and rpc, so node --test covers it.
import { addDays, blockMinutes, freeMinutes, localNow, minutesOn, zonedIso } from "./logic.mjs";
import { paceByKind } from "./pace.mjs";
import { dayCap, sleepDebt, wakeOn, wakeProfile, windowStart } from "./sleep.mjs";
import { bedtimeFor, shutdownFor } from "./bedtime.mjs";
import { HORIZON_RULES, confirmedDoneMin, dayFree, horizonMinutes, paceP80ByKind, planHorizon, workKind } from "./horizon.mjs";

// read_planner's day rules: 10 minutes of travel on each side of a busy time, and the cap's
// default.
const TRAVEL = 10;
const DEFAULT_CAP = 360;
// read_planner's window also ends by his wake + 16 hours (proposal.mjs's AWAKE_MAX).
const AWAKE_MAX = 16 * 60;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const isoWeekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;

// The rows, as { table, select, filters, or?, order } queries (proposal-io.mjs's form). The busy
// times, blocks and feedback depend on the tasks read, so they are functions.
export function horizonQueries(today, timeZone) {
  const midnight = (d) => zonedIso(d, 0, timeZone);
  return {
    tasks: { table: "tasks", select: "id,title,due,est_min,at_time,source,tag,done,project_id,step", filters: [["done", "is", "false"], ["due", "not.is", "null"]] },
    actuals: { table: "actuals", select: "at,kind,est_min,minutes", order: "at" },
    habits: { table: "habits", select: "id,name,days,ideal,minutes,flex_min,defence", order: "position" },
    days: { table: "days", select: "day,shutdown,shutdown_at", filters: [["day", "eq", today]] },
    // Today's and the two nights before it, for the rolling sleep debt (sleepDebt).
    sleepDay: { table: "sleep_days", select: "day,readiness,sleep_s", filters: [["day", "gte", addDays(today, -2)], ["day", "lte", today]] },
    // Oura: the sleep periods (his wake, so the window opens where read_planner's does) and the
    // bedtime windows (wind-down). Only the free minutes that follow from them leave the server.
    sleep: { table: "sleep_nights", select: "oura_id,day,type,bedtime_start,bedtime_end", order: "bedtime_end" },
    sleepTimes: { table: "sleep_times", select: "day,start_offset,end_offset", order: "day" },
    previous: { table: "horizon_alloc", select: "task_id,day,minutes,over_min", filters: [["day", "gte", today]], order: "day" },
    // Today to the latest due date.
    busy: (last) => ({ table: "busy", select: "starts_at,ends_at", filters: [["starts_at", "lt", midnight(addDays(last, 1))], ["ends_at", "gt", midnight(today)]], order: "starts_at" }),
    // Today's blocks (for what is locked) and every block of the tasks (for confirmed work).
    blocks: (ids) => ({
      table: "blocks",
      select: "id,task_id,habit_id,starts_at,ends_at,proposed,auto",
      or: [`and(starts_at.lt.${midnight(addDays(today, 1))},ends_at.gt.${midnight(today)})`, ...(ids.length ? [`task_id.in.(${ids.join(",")})`] : [])].join(","),
      order: "starts_at",
    }),
    // The More time answers on those blocks; block ids are uuids, so they go in as they are.
    feedback: (blockIds) => ({ table: "feedback", select: "at,item,action,ref", filters: [["item", "eq", "finished"], ["action", "eq", "more"], ["ref->>block_id", "in", `(${blockIds.join(",")})`]] }),
  };
}

// A block is locked once approved, unless it is an auto-approved one not yet started, which the
// next revision may move (proposal.mjs's movable).
const locked = (b, now) => !b.proposed && !(b.auto && Date.parse(b.starts_at) > now.getTime());

// The engine's input (docs/sheet-horizon.md, "Input") from the rows:
//   settings  the settings row      tasks    horizonQueries' tasks     blocks  its blocks
//   busy      its busy rows         habits   every habit               actuals for pace
//   feedback  its More time rows    day      today's days row or null  sleepDay today's sleep_days row or null
//   sleepDays the sleep_days rows of today and the two days before (the rolling sleep debt)
//   previous  horizon_alloc from today
//   sleep     sleep_nights rows        sleepTimes sleep_times rows (both optional, for the window)
export function horizonInput(rows, now) {
  const { settings } = rows;
  const tz = settings.time_zone;
  const today = localNow(now, tz).day;
  const paces = paceByKind(rows.actuals ?? []);
  // The states are judged at the 80th-percentile pace, and the kind of work sets the per-day rules.
  const p80 = paceP80ByKind(rows.actuals ?? []);
  const done = confirmedDoneMin((rows.blocks ?? []).filter((b) => b.task_id), rows.feedback ?? []);
  const tasks = rows.tasks.filter((t) => !t.done && t.due && !t.at_time)
    .map((t) => ({ id: t.id, due: t.due, minutes: horizonMinutes(t, paces), done_min: done[t.id] ?? 0, minutes_p80: horizonMinutes(t, p80), kind: workKind(t),
      // A project's step (docs/sheet-projects.md) is planned after the steps before it.
      ...(t.project_id ? { project: t.project_id, step: t.step } : {}) }))
    .sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));

  const onToday = (rows.blocks ?? []).filter((b) => localNow(new Date(b.starts_at), tz).day === today && locked(b, now));
  const lockedBy = new Map();
  for (const b of onToday) if (b.task_id && !b.habit_id) lockedBy.set(b.task_id, (lockedBy.get(b.task_id) ?? 0) + blockMinutes(b));
  const lockedRows = [...lockedBy].map(([task_id, minutes]) => ({ task_id, day: today, minutes })).sort((a, b) => a.task_id.localeCompare(b.task_id));
  const lockedMin = lockedRows.reduce((n, b) => n + b.minutes, 0);

  const base = settings.workload_cap_min ?? DEFAULT_CAP;
  const last = tasks.reduce((d, t) => (t.due > d ? t.due : d), today);
  const free = {};
  const sleep = rows.sleep ?? [];
  const sleepTimes = rows.sleepTimes ?? [];
  const profile = wakeProfile(sleep, now, tz);
  for (let d = today; d <= last; d = addDays(d, 1)) {
    // The plan window, exactly as planSnapshot's: from windowStart (30 minutes after his wake,
    // today's or his usual one, else 07:00; on today not before now) to the shutdown line, or
    // wind-down when that comes first, and by his wake + 16 hours. Counting from 07:00 instead
    // took the hours he sleeps through as free (2026-11-05: on track with no time left).
    const from = windowStart(d, now, tz, profile);
    const shutdown = toMin(shutdownFor(d, { line: d === today ? rows.day?.shutdown_at ?? null : null, settings, sleep, sleepTimes, tz }));
    const bed = bedtimeFor(d, { settings, sleep, sleepTimes, tz });
    const wake = wakeOn(d, now, tz, profile);
    const end = bed && bed.wind_down < 1440 ? Math.min(shutdown, bed.wind_down) : shutdown;
    const to = wake != null ? Math.min(end, wake + AWAKE_MAX) : end;
    const spans = (rows.busy ?? []).map((b) => ({ start: minutesOn(b.starts_at, d, tz) - TRAVEL, end: minutesOn(b.ends_at, d, tz) + TRAVEL }));
    const blocked = new Set(d === today ? onToday.map((b) => b.habit_id).filter(Boolean) : []);
    for (const h of rows.habits ?? []) {
      if (!(h.days ?? []).includes(isoWeekday(d)) || blocked.has(h.id)) continue;
      spans.push({ start: toMin(h.ideal), end: toMin(h.ideal) + h.minutes });
    }
    if (d === today) for (const b of onToday) spans.push({ start: minutesOn(b.starts_at, d, tz), end: minutesOn(b.ends_at, d, tz) });
    const window_free_min = to > from ? freeMinutes(spans.map((s) => ({ ...s, busy: true })), from, to) : 0;
    const cap = d === today ? dayCap(base, rows.sleepDay?.day === today ? rows.sleepDay : null, lockedMin, sleepDebt(rows.sleepDays ?? [], today)).workload_cap_min : base;
    free[d] = dayFree({ cap, window_free_min, locked_min: d === today ? lockedMin : 0 });
  }
  return {
    today,
    tasks,
    free,
    locked: lockedRows,
    frozen_days: rows.day?.day === today && rows.day.shutdown ? [addDays(today, 1)] : [],
    previous: (rows.previous ?? []).map((p) => ({ task_id: p.task_id, day: p.day, minutes: p.minutes, over_min: p.over_min ?? 0 })),
  };
}

// JSON with every object's keys sorted, so the same input always reads the same.
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v));

// SHA-256 hex of the input without previous, and of the engine's rules version: what
// settings.horizon_key holds after a re-flow. A new version re-flows unchanged inputs.
export async function horizonKey(input, rules = HORIZON_RULES) {
  const { previous: _, ...rest } = input;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical({ ...rest, rules })));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One re-flow (docs/sheet-horizon.md, "Where it runs"). io is { read(query) → rows, rpc(name,
// args) }, the caller's database. Skipped when the inputs' key equals settings.horizon_key;
// otherwise planned and saved with replace_horizon, all or nothing.
export async function reflowHorizon(io, now) {
  const [settings] = await io.read({ table: "settings", select: "*" });
  if (!settings) throw new Error("settings: no row");
  const today = localNow(now, settings.time_zone).day;
  const q = horizonQueries(today, settings.time_zone);
  const none = () => [];
  const [tasks, actuals, habits, [day = null], sleepDays, previous, sleep, sleepTimes] = await Promise.all([
    io.read(q.tasks), io.read(q.actuals), io.read(q.habits), io.read(q.days), io.read(q.sleepDay).catch(none), io.read(q.previous),
    io.read(q.sleep).catch(none), io.read(q.sleepTimes).catch(none),
  ]);
  const last = tasks.reduce((d, t) => (t.due > d ? t.due : d), today);
  const [busy, blocks] = await Promise.all([io.read(q.busy(last)), io.read(q.blocks(tasks.map((t) => t.id)))]);
  const ids = blocks.filter((b) => b.task_id).map((b) => b.id);
  const feedback = ids.length ? await io.read(q.feedback(ids)) : [];
  const input = horizonInput({ settings, tasks, blocks, busy, habits, actuals, feedback, day, sleepDay: sleepDays.find((d) => d.day === today) ?? null, sleepDays, previous, sleep, sleepTimes }, now);
  const key = await horizonKey(input);
  if (key === settings.horizon_key) return { skipped: true, key };
  const out = planHorizon(input);
  const states = Object.entries(out.tasks).map(([task_id, s]) => ({ task_id, ...s }));
  const allocs = out.allocations.map(({ task_id, day: d, minutes, over_min }) => ({ task_id, day: d, minutes, over_min }));
  await io.rpc("replace_horizon", { from_day: today, key, allocs, states });
  return { skipped: false, key, moved_min: out.moved_min, states };
}
