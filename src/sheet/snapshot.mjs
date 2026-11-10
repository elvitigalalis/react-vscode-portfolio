// The week as last loaded, kept in this browser so /plan draws at once on opening (docs/sheet.md,
// "Opening"): the planner stores it after each load and draws it before the first read returns,
// marked "Updating…", then loads as usual. It is a short-lived placeholder, so it keeps less than
// the week draws: no Oura data at all (nights, bedtime windows, sleep and readiness scores), no
// calendar IDs, and only the settings the week reads, never keys or IDs. Calendar events have
// their own copy (planner.mjs, sheet.events.<week>). Pure.

export { SNAPSHOT_KEY } from "./snapshot-key.mjs";
const VERSION = 1;

// The settings the week reads (capacity, wind-down, Telegram's switch), less the calendar IDs.
const SETTINGS = ["workload_cap_min", "wind_down_on", "bedtime_target", "bedtime_ease", "bedtime_set_on", "nudges_on", "time_zone"];

const pick = (row, keys) => Object.fromEntries(keys.filter((k) => row?.[k] !== undefined).map((k) => [k, row[k]]));

// The JSON to store for `state` (planner.mjs) as drawn for week `state.week`, for `user` (the
// signed-in user's id, api.mjs userId; null when it can't be read).
export function pack(state, user = null, savedAt = Date.now()) {
  return JSON.stringify({
    v: VERSION,
    savedAt,
    user,
    week: state.week,
    tasks: [...state.tasks.values()],
    blocks: state.blocks,
    days: Object.values(state.days),
    parked: state.parked,
    todos: state.todos,
    horizon: state.horizon,
    states: [...state.states.values()],
    actuals: state.actuals ?? [],
    settings: state.settings ? pick(state.settings, SETTINGS) : null,
  });
}

// The state to draw from stored `text` for `week` and `user`, or null when there is none, it is
// for another week or another user, or it was written by another version.
export function unpack(text, week, user = null) {
  let s;
  try { s = JSON.parse(text); } catch { return null; }
  if (!s || s.v !== VERSION || s.week !== week || (s.user ?? null) !== user || !Array.isArray(s.tasks)) return null;
  return {
    tasks: new Map(s.tasks.map((t) => [t.id, t])),
    blocks: s.blocks ?? [],
    days: Object.fromEntries((s.days ?? []).map((d) => [d.day, d])),
    parked: s.parked ?? 0,
    todos: s.todos ?? [],
    horizon: s.horizon ?? [],
    states: new Map((s.states ?? []).map((h) => [h.task_id, h])),
    actuals: s.actuals ?? [], // today's focus minutes (day, minutes); the progress line keeps today's
    settings: s.settings ?? null,
  };
}
