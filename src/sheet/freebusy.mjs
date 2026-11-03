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
