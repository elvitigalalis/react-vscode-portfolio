// The pure side of the server's busy sync (docs/sheet-v5.md, "freebusy.mjs"): the body busy-sync
// posts to Google's freebusy.query, and the busy rows it saves from the answer. Google's shapes
// are as in https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query.
// No network, so node --test covers it; supabase/functions/busy-sync does the calls.

import { localNow, plural, zonedIso } from "./logic.mjs";

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
// overlap now through 7 days ahead, as Google gives them (cut to that range), once each and
// earliest first (as busyRows in morning.mjs, unmerged). "Time blocks" (`blocksCalendar`) adds nothing even if Google answers
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

// The one `changes` row a sync's new busy rows make, or null when nothing changed that could
// change the rest of today's plan. Spans can't be compared as they come: Google cuts them to the
// query's range, so an event in progress starts "now" and one crossing the far end of the 7 days
// ends there, both different at every sync, and each sync's range takes in events a week out.
// So the sync compares the time covered from now to the shutdown line ("HH:MM", today; midnight
// without one). A span with time on a block today (approved or proposed) that hasn't ended, time
// that wasn't busy before, is busy_overlap; else an hour or more freed in that window is
// time_freed; else any difference there is busy_change. Weights as REASON_WORDS
// (docs/sheet-v5.md, "replan.mjs").
export function busyChange(before, after, blocks, now, timeZone, shutdown = null) {
  const change = (reason, weight, ref = null) => ({ kind: "busy", reason, weight, ref });

  const today = localNow(now, timeZone).day;
  const t = now.getTime();
  const live = blocks.filter((b) => Date.parse(b.ends_at) > t && localNow(new Date(b.starts_at), timeZone).day === today);
  // Its ref is the new busy time's span, "<starts_at>/<ends_at>" in UTC (times, never a title),
  // so the replan message can say which block it landed on.
  const hit = after.find((s) => live.some((b) => landsOn(s, b, before, t)));
  if (hit) return change("busy_overlap", 10, `${new Date(hit.starts_at).toISOString()}/${new Date(hit.ends_at).toISOString()}`);

  const [h, m] = shutdown ? shutdown.split(":").map(Number) : [24, 0];
  const end = Date.parse(zonedIso(today, h * 60 + m, timeZone));
  if (minutes(covered(before, t, end)) - minutes(covered(after, t, end)) >= 60) return change("time_freed", 4);
  return JSON.stringify(covered(before, t, end)) === JSON.stringify(covered(after, t, end)) ? null : change("busy_change", 2);
}

// Whether span s has time from `t` on, on block b, that `before` didn't already cover.
function landsOn(s, b, before, t) {
  const from = Math.max(Date.parse(s.starts_at), Date.parse(b.starts_at), t);
  const to = Math.min(Date.parse(s.ends_at), Date.parse(b.ends_at));
  return to > from && minutes(covered(before, from, to)) < (to - from) / 60_000;
}

// The time from `from` to `to` that at least one span covers, as sorted [start, end] pairs,
// overlapping and touching spans joined.
function covered(spans, from, to) {
  const cut = spans
    .map((s) => [Math.max(Date.parse(s.starts_at), from), Math.min(Date.parse(s.ends_at), to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of cut) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const minutes = (pairs) => pairs.reduce((n, [a, b]) => n + b - a, 0) / 60_000;

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
