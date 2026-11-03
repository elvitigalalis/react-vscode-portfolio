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
