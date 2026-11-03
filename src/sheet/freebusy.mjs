// The pure side of the server's busy sync (docs/sheet-v5.md, "freebusy.mjs"): the body busy-sync
// posts to Google's freebusy.query, and the busy rows it saves from the answer. Google's shapes
// are as in https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query.
// No network, so node --test covers it; supabase/functions/busy-sync does the calls.

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
