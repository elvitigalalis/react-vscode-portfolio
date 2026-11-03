// The Campus list in /plan (docs/sheet-sources.md, "campus.mjs"): which SB Engaged events show
// under a day, and the task "Add to my day" makes from one. Pure, so node --test covers it.
import { localNow, cutTitle } from "./logic.mjs";

// Tags as SB Engaged sends them can carry stray spaces; they compare trimmed.
export const tagsOf = (e) => (e.tags ?? []).map((t) => t.trim()).filter(Boolean);
const startOf = (e, timeZone) => localNow(new Date(e.starts_at), timeZone);

// SB Engaged tags free food as " Free Food & Refreshments", leading space and all.
export const freeFood = (e) => tagsOf(e).some((t) => /free food/i.test(t));

// Practices and meetings ("general body meeting" included), by type or title. "Meet & Greet"
// is not a meeting: the word has to be whole.
const ROUTINE = /\b(practice|meeting)s?\b/i;
export const routine = (e) => ROUTINE.test(e.event_type ?? "") || ROUTINE.test(e.title ?? "");

// How many have registered, from the event's page (feeds.mjs, rsvpCount); -1 when unknown, so an
// unread count sorts after a real 0.
const going = (e) => (Number.isInteger(e.rsvp_count) ? e.rsvp_count : -1);

// A day's events, by the local day they start on: most RSVPs first (the well-attended ones are
// usually the funded ones), unknown counts last; ties go free food first, then by start time.
// Routine events show only with `showRoutine`; with `tags`, only events carrying one of them.
export function campusDay(events, day, timeZone, { tags, showRoutine = false } = {}) {
  const want = tags?.length ? new Set(tags) : null;
  return events
    .filter((e) => startOf(e, timeZone).day === day && (showRoutine || !routine(e))
      && (!want || tagsOf(e).some((t) => want.has(t))))
    .sort((a, b) => (going(b) - going(a)) || (freeFood(b) - freeFood(a)) || Date.parse(a.starts_at) - Date.parse(b.starts_at));
}

// The tags in use, with how many events carry each: most used first, then A to Z.
export function campusTags(events) {
  const counts = new Map();
  for (const e of events) for (const t of new Set(tagsOf(e))) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// All day is the row's `all_day`. The feed read (feeds.mjs) sets it, SB Engaged's 12 am to
// 11:55 pm events included, so the rule lives in one place.
const minutesLong = (e) => Math.round((Date.parse(e.ends_at) - Date.parse(e.starts_at)) / 60_000);

const pad = (n) => String(n).padStart(2, "0");

// The task "Add to my day" makes: private, tagged #campus, on the day the event starts, at its
// local start time, with its length as the estimate (at most 4 hours). An all-day event gets
// neither. The title fits the tasks table's 1 to 500 characters (cutTitle).
export function eventToTask(e, timeZone) {
  const { day, minutes } = startOf(e, timeZone);
  return {
    title: cutTitle(e.title) || "Campus event",
    day,
    list: null,
    at_time: e.all_day ? null : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
    est_min: e.all_day ? null : Math.min(240, Math.max(1, minutesLong(e))),
    tag: "campus",
    public: false,
  };
}

// Whether "Add to my day" already made this event's task: a #campus task with its title on its
// day. `tasks` is any iterable of task rows (the planner's state.tasks values).
export const isAdded = (tasks, t) => [...tasks].some((x) => x.tag === "campus" && x.day === t.day && x.title === t.title);

// The tag filters in force on a day: the picked tags that have a chip on screen (`campusTags` of
// that day). A tag picked on another day is remembered but never empties this one.
export const activeTags = (picked, onScreen) => picked.filter((g) => onScreen.some((x) => x.tag === g));
