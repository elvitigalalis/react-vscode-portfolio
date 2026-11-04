// The campus Edge Function (docs/sheet-sources.md, "Edge Functions"): pg_cron calls it at :35
// every hour (supabase/schema.sql, "sheet-campus") to keep campus_events at SB Engaged's public
// events from now through 14 days ahead. Reading the feed and choosing the rows happen in
// src/sheet/ical.mjs and src/sheet/feeds.mjs, the modules the tests cover; this file only
// fetches, writes and records the fetch in feed_state (source 'campus'), 304 or not. Then it
// refreshes a few dozen RSVP counts from the events' public pages (refreshCounts, below).
//
// Deploy from the repo root with server-side bundling, which follows the imports out of
// supabase/functions:
//   npx supabase functions deploy campus --use-api --no-verify-jwt
// --no-verify-jwt because the cron job has no Supabase sign-in; it proves itself with the shared
// secret below.
//
// CPU: Edge Functions get 2 s of CPU per request and 256 MB of memory; time spent waiting on the
// network doesn't count (supabase.com/docs/guides/functions/limits). The feed is about 8.4 MB and
// 7,700 events. campusWindowIcs cuts it to the window's ~1,300 events before parseIcs reads them:
// in Node, 18 ms for the cut and parse against 70 ms for parsing it all (2026-11-02 feed). The
// body is read whole rather than streamed: the cut is cheaper than the stream bookkeeping, and
// the text is a small share of the memory limit. The RSVP counts are mostly network wait: a
// regex over each ~70 KB page.
//
// Secrets: SHEET_CRON_SECRET (already set for telegram). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase and read in ../_shared/server.ts.
import { parseIcs } from "../../../src/sheet/ical.mjs";
import { campusChange, campusRows, campusWindowIcs, countsDue, rsvpCount } from "../../../src/sheet/feeds.mjs";
import { calendarText, db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");

// The school-wide public feed (all public events from all groups). It redirects to CampusGroups'
// static host, which sends an ETag and Last-Modified and answers conditional requests.
const FEED = "https://sbengaged.stonybrook.edu/ical/stonybrook/ical_stonybrook.ics";
const SOURCE = "campus";
const WINDOW_MS = 14 * 86_400_000;
const BATCH = 500;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const now = new Date();
  try {
    return Response.json(await sync(now));
  } catch (e) {
    return feedFailed(SOURCE, e, now.toISOString());
  }
});

// --- The sync ---------------------------------------------------------------------------------

// Every run, 304 or not, deletes the rows that have ended and records the fetch in feed_state.
// A changed feed also upserts the window's rows and stores the new ETag and Last-Modified.
async function sync(now: Date) {
  const [state] = await db(`feed_state?select=etag,last_modified&source=eq.${SOURCE}`);

  // A conditional GET (RFC 9110, 13.1.2 and 13.1.3): with nothing new the feed answers 304.
  const headers: Record<string, string> = {};
  if (state?.etag) headers["If-None-Match"] = state.etag;
  if (state?.last_modified) headers["If-Modified-Since"] = state.last_modified;
  const res = await fetch(FEED, { headers });
  // v5 R1: today's events before and after a changed feed's write, for the replan decision.
  const before = res.status === 304 ? null : await todays(now);
  const fresh = res.status === 304 ? null : await write(res, now);

  const at = encodeURIComponent(now.toISOString());
  await db(`campus_events?ends_at=lte.${at}`, { method: "DELETE" });
  if (before) {
    const [settings] = await db("settings?select=time_zone");
    const change = campusChange(before, await todays(now), now, settings?.time_zone ?? "America/New_York");
    if (change) await db("changes", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(change) });
  }
  await saveFeedState(SOURCE, { fetched_at: now.toISOString(), ok: true, error: null, ...fresh });
  // The counts are extra: their failing never marks the feed as failed.
  const counts = await refreshCounts(now).catch((e) => { console.error("campus counts:", e instanceof Error ? e.message : e); return null; });
  return { ok: true, status: res.status, items: fresh?.items, counts };
}

// The events still to come within the next day; campusChange narrows them to today.
const todays = (now: Date) => {
  const from = encodeURIComponent(now.toISOString());
  const to = encodeURIComponent(new Date(now.getTime() + 86_400_000).toISOString());
  return db(`campus_events?select=uid,starts_at,ends_at&ends_at=gt.${from}&starts_at=lt.${to}`);
};

// --- RSVP counts ------------------------------------------------------------------------------

// The feed has no attendee count; each event's public page shows how many have registered
// (robots.txt allows these pages; it disallows only /mobile_ws/ and a few upload paths). Each run
// reads at most COUNTS pages, one at a time with PAUSE_MS between them, and stops once the run is
// BUDGET_MS old, well inside pg_net's 2-minute timeout. countsDue picks the ones whose count is
// missing or stale. A failed page still stamps rsvp_checked_at, keeping the last count, so it
// waits its turn rather than being retried every hour. Returns how many counts were read.
const COUNTS = 40;
const PAUSE_MS = 1_000;
const BUDGET_MS = 60_000;
const AGENT = "lisul-elvi.com planner (one reader; a few dozen pages an hour)";

async function refreshCounts(now: Date) {
  // The window's upcoming rows, soonest first: PostgREST's row cap, if it bites, drops the far end.
  const at = encodeURIComponent(now.toISOString());
  const rows = await db(`campus_events?select=uid,title,event_type,url,starts_at,rsvp_checked_at&starts_at=gt.${at}&order=starts_at`);
  let read = 0;
  for (const [i, row] of countsDue(rows, now, COUNTS).entries()) {
    if (Date.now() - now.getTime() > BUDGET_MS) break;
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    let count: number | null = null;
    try {
      const page = await fetch(row.url, { headers: { "User-Agent": AGENT } });
      if (page.ok) count = rsvpCount(await page.text());
      else await page.body?.cancel();
    } catch { /* a network error: keep the last count */ }
    const checked = { rsvp_checked_at: new Date().toISOString() };
    await db(`campus_events?uid=eq.${encodeURIComponent(row.uid)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(count === null ? checked : { ...checked, rsvp_count: count }),
    });
    if (count !== null) read++;
  }
  return read;
}

// A changed feed: its window's rows upserted, and the rows it no longer lists deleted. Returns
// the feed_state columns that come with it.
async function write(res: Response, now: Date) {
  const etag = res.headers.get("etag");
  const last_modified = res.headers.get("last-modified");
  const text = await calendarText(res);
  const to = new Date(now.getTime() + WINDOW_MS);
  const rows = campusRows(parseIcs(campusWindowIcs(text, now, to), { from: now, to }), now);

  // Upsert in batches, so no request carries the whole window (about 800 KB of rows).
  for (let i = 0; i < rows.length; i += BATCH) {
    await db("campus_events?on_conflict=uid", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + BATCH)),
    });
  }
  // Every row in the window was just written with updated_at = now, so an older one has left the
  // feed (a cancelled event) and goes, unless the window came back empty, which says more about
  // the feed than the events (docs/sheet-sources.md, "Schema").
  if (rows.length > 0) await db(`campus_events?updated_at=lt.${encodeURIComponent(now.toISOString())}`, { method: "DELETE" });
  return { etag, last_modified, items: rows.length };
}
