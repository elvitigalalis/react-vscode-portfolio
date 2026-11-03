// The campus Edge Function (docs/sheet-sources.md, "Edge Functions"): pg_cron calls it at :35
// every hour (supabase/schema.sql, "sheet-campus") to keep campus_events at SB Engaged's public
// events from now through 14 days ahead. Reading the feed and choosing the rows happen in
// src/sheet/ical.mjs and src/sheet/feeds.mjs, the modules the tests cover; this file only
// fetches, writes and records the fetch in feed_state (source 'campus'), 304 or not.
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
// the text is a small share of the memory limit.
//
// Secrets: SHEET_CRON_SECRET (already set for telegram). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase and read in ../_shared/server.ts.
import { parseIcs } from "../../../src/sheet/ical.mjs";
import { campusRows, campusWindowIcs } from "../../../src/sheet/feeds.mjs";
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
  const fresh = res.status === 304 ? null : await write(res, now);

  const at = encodeURIComponent(now.toISOString());
  await db(`campus_events?ends_at=lte.${at}`, { method: "DELETE" });
  await saveFeedState(SOURCE, { fetched_at: now.toISOString(), ok: true, error: null, ...fresh });
  return { ok: true, status: res.status, items: fresh?.items };
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
