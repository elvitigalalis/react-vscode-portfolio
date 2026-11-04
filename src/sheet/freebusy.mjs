// The pure side of the server's busy sync (docs/sheet-v5.md, "freebusy.mjs"): the body busy-sync
// posts to Google's freebusy.query, and the busy rows it saves from the answer. Google's shapes
// are as in https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query.
// No network, so node --test covers it; supabase/functions/busy-sync does the calls.

import { addDays, localNow, plural, zonedIso } from "./logic.mjs";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// The freebusy.query body: now through 7 days ahead, his main calendar (its id is his address)
// and the calendars he shows, once each, never "Time blocks" (his own blocks).
export function freeBusyRequest(settings, now) {
  const blocks = settings.gcal_calendar_id ?? null;
  const ids = [...new Set([settings.owner_email, ...(settings.calendars ?? [])])].filter((id) => id && id !== blocks);
  return {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + WEEK_MS).toISOString(),
    items: ids.map((id) => ({ id })),
  };
}

// The busy rows from a freebusy.query answer: start and end only, in UTC, for the spans that
// overlap now through 7 days ahead, kept whole, once each and earliest first (as busyRows in
// morning.mjs, unmerged). "Time blocks" (`blocksCalendar`) adds nothing even if Google answers
// for it. A calendar whose entry has `errors` adds nothing and is listed in `failed`. All-day
// events count, since free/busy can't tell them apart; events marked free never appear.
export function freeBusyRows(response, now, blocksCalendar) {
  const from = now.getTime();
  const to = from + WEEK_MS;
  const failed = [];
  const spans = new Map();
  for (const [id, cal] of Object.entries(response?.calendars ?? {})) {
    if (cal?.errors?.length) { failed.push(id); continue; }
    if (blocksCalendar && id === blocksCalendar) continue;
    for (const b of cal?.busy ?? []) {
      const start = Date.parse(b.start);
      const end = Date.parse(b.end);
      if (!(end > from && start < to)) continue;
      const row = { starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() };
      spans.set(`${row.starts_at}|${row.ends_at}`, row);
    }
  }
  const rows = [...spans.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.ends_at.localeCompare(b.ends_at));
  return { rows, failed };
}

// The one `changes` row a sync's new busy rows make, or null when `after` holds the same spans
// as `before`. A span that is new and lands on a block today (approved or proposed) that hasn't
// ended is busy_overlap; else an hour or more of busy time freed between now and midnight is
// time_freed; else busy_change. Weights as REASON_WORDS (docs/sheet-v5.md, "replan.mjs").
const key = (r) => `${r.starts_at}|${r.ends_at}`;
export function busyChange(before, after, blocks, now, timeZone) {
  const had = new Set(before.map(key));
  const has = new Set(after.map(key));
  if (had.size === has.size && [...has].every((k) => had.has(k))) return null;
  const change = (reason, weight) => ({ kind: "busy", reason, weight, ref: null });

  const today = localNow(now, timeZone).day;
  const t = now.getTime();
  const live = blocks.filter((b) => Date.parse(b.ends_at) > t && localNow(new Date(b.starts_at), timeZone).day === today);
  const overlaps = (s, b) => Date.parse(s.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(s.ends_at);
  if (after.some((s) => !had.has(key(s)) && live.some((b) => overlaps(s, b)))) return change("busy_overlap", 10);

  const midnight = Date.parse(zonedIso(addDays(today, 1), 0, timeZone));
  if (busyMinutes(before, t, midnight) - busyMinutes(after, t, midnight) >= 60) return change("time_freed", 4);
  return change("busy_change", 2);
}

// Minutes from `from` to `to` covered by at least one span, overlaps counted once.
function busyMinutes(spans, from, to) {
  const cut = spans
    .map((s) => [Math.max(Date.parse(s.starts_at), from), Math.min(Date.parse(s.ends_at), to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let reach = from;
  for (const [a, b] of cut) {
    if (b > reach) total += b - Math.max(a, reach);
    reach = Math.max(reach, b);
  }
  return total / 60_000;
}

// Settings' line on when busy times were last saved (settings.busy_as_of), by the server or
// /plan: "Busy times saved 4 min ago".
export function busySaved(busyAsOf, now) {
  if (!busyAsOf) return "Busy times not saved yet";
  const min = Math.floor((now.getTime() - Date.parse(busyAsOf)) / 60_000);
  if (min < 1) return "Busy times saved just now";
  if (min < 60) return `Busy times saved ${min} min ago`;
  const ago = min < 1440 ? plural(Math.floor(min / 60), "hour") : plural(Math.floor(min / 1440), "day");
  return `Busy times saved ${ago} ago`;
}
