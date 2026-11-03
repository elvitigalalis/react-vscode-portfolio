// The campus Edge Function (docs/sheet-sources.md, "Edge Functions"): pg_cron calls it at :35
// every hour (supabase/schema.sql, "sheet-campus") to keep campus_events at SB Engaged's public
// events from now through 14 days ahead. Reading the feed and choosing the rows happen in
// src/sheet/ical.mjs and src/sheet/feeds.mjs, the modules the tests cover; this file only
// fetches, writes and records the fetch in feed_state (source 'campus').
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
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { parseIcs } from "../../../src/sheet/ical.mjs";
import { campusRows, campusWindowIcs } from "../../../src/sheet/feeds.mjs";

const env = (name: string) => Deno.env.get(name) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
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
    const error = String((e as Error)?.message ?? e).slice(0, 500);
    await saveState({ fetched_at: now.toISOString(), ok: false, error }).catch(() => {});
    return Response.json({ ok: false, error }, { status: 502 });
  }
});

// Whether a header holds the secret, compared without stopping at the first difference.
function secretMatches(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// --- The database, through PostgREST with the service key (it bypasses row-level security) ---

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 201 ? null : res.json();
}

// Upserts the feed's one feed_state row. Only the columns given change, so a failed run keeps
// the last good ETag and Last-Modified and the next run still fetches the newer feed.
const saveState = (state: Record<string, unknown>) =>
  db("feed_state?on_conflict=source", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ source: SOURCE, ...state }),
  });

// --- The sync ---------------------------------------------------------------------------------

async function sync(now: Date) {
  const [state] = await db(`feed_state?select=etag,last_modified&source=eq.${SOURCE}`);

  // A conditional GET (RFC 9110, 13.1.2 and 13.1.3): with nothing new the feed answers 304.
  const headers: Record<string, string> = {};
  if (state?.etag) headers["If-None-Match"] = state.etag;
  if (state?.last_modified) headers["If-Modified-Since"] = state.last_modified;
  const res = await fetch(FEED, { headers });
  if (res.status === 304) return { ok: true, status: 304 };
  if (!res.ok) throw new Error(`feed: ${res.status} ${res.statusText}`);
  const etag = res.headers.get("etag");
  const last_modified = res.headers.get("last-modified");

  const to = new Date(now.getTime() + WINDOW_MS);
  const text = await res.text();
  const rows = campusRows(parseIcs(campusWindowIcs(text, now, to), { from: now, to }), now);
  if (rows.length === 0 && !text.includes("BEGIN:VCALENDAR")) throw new Error("feed: not a calendar");

  // Upsert in batches, so no request carries the whole window (about 800 KB of rows).
  for (let i = 0; i < rows.length; i += BATCH) {
    await db("campus_events?on_conflict=uid", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + BATCH)),
    });
  }

  // Rows that have ended go, each sync. Every row in the window was just written with
  // updated_at = now, so an older one has left the feed (a cancelled event) and goes too, unless
  // the feed came back empty, which says more about the feed than the events.
  const at = encodeURIComponent(now.toISOString());
  await db(`campus_events?ends_at=lte.${at}`, { method: "DELETE" });
  if (rows.length > 0) await db(`campus_events?updated_at=lt.${at}`, { method: "DELETE" });

  await saveState({ etag, last_modified, fetched_at: now.toISOString(), ok: true, error: null, items: rows.length });
  return { ok: true, status: res.status, items: rows.length };
}
