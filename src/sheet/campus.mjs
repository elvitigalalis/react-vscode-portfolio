// The Campus list in /plan (docs/sheet-sources.md, "campus.mjs"): which SB Engaged events show
// under a day, and the task "Add to my day" makes from one. Pure, so node --test covers it.
import { localNow } from "./logic.mjs";

// Tags as SB Engaged sends them can carry stray spaces; they compare trimmed.
const tagsOf = (e) => (e.tags ?? []).map((t) => t.trim()).filter(Boolean);
const startOf = (e, timeZone) => localNow(new Date(e.starts_at), timeZone);

// SB Engaged tags free food as " Free Food & Refreshments", leading space and all.
export const freeFood = (e) => tagsOf(e).some((t) => /free food/i.test(t));

// Practices and meetings ("general body meeting" included), by type or title. "Meet & Greet"
// is not a meeting: the word has to be whole.
const ROUTINE = /\b(practice|meeting)s?\b/i;
export const routine = (e) => ROUTINE.test(e.event_type ?? "") || ROUTINE.test(e.title ?? "");

// A day's events, by the local day they start on: free food first, then by start time. Routine
// events show only with `showRoutine`; with `tags`, only events carrying one of them.
export function campusDay(events, day, timeZone, { tags, showRoutine = false } = {}) {
  const want = tags?.length ? new Set(tags) : null;
  return events
    .filter((e) => startOf(e, timeZone).day === day && (showRoutine || !routine(e))
      && (!want || tagsOf(e).some((t) => want.has(t))))
    .sort((a, b) => (freeFood(b) - freeFood(a)) || Date.parse(a.starts_at) - Date.parse(b.starts_at));
}

// The tags in use, with how many events carry each: most used first, then A to Z.
export function campusTags(events) {
  const counts = new Map();
  for (const e of events) for (const t of new Set(tagsOf(e))) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// SB Engaged sends all-day events as 12 am to 11:55 pm with all_day false; those read as all day
// in the list, and Add to my day treats them so (no time, no estimate).
const minutesLong = (e) => Math.round((Date.parse(e.ends_at) - Date.parse(e.starts_at)) / 60_000);
export const allDay = (e, timeZone) => Boolean(e.all_day) || (startOf(e, timeZone).minutes === 0 && minutesLong(e) >= 1435);

const pad = (n) => String(n).padStart(2, "0");

// The task "Add to my day" makes: private, tagged #campus, on the day the event starts, at its
// local start time, with its length as the estimate (at most 4 hours). An all-day event gets
// neither. The title fits the tasks table's 1 to 500 characters.
export function eventToTask(e, timeZone) {
  const { day, minutes } = startOf(e, timeZone);
  const title = e.title?.trim() || "Campus event";
  return {
    title: title.length > 500 ? `${title.slice(0, 499)}…` : title,
    day,
    list: null,
    at_time: e.all_day ? null : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
    est_min: e.all_day ? null : Math.min(240, Math.max(1, minutesLong(e))),
    tag: "campus",
    public: false,
  };
}
