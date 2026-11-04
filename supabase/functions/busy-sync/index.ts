// The busy-sync Edge Function (docs/sheet-v5.md, "Edge Functions"): saves Lisul's busy times
// from Google's free/busy data every 10 minutes (supabase/schema.sql, "sheet-busy"), whether or
// not /plan is open. It refreshes the calendar grant's token, posts freeBusyRequest to
// freebusy.query, and in one call (busy_sync_save) replaces the calendar busy rows from now to
// 7 days ahead with freeBusyRows, stamps busy_as_of and writes busyChange's row. Start and end
// only: free/busy carries no titles. src/sheet/freebusy.mjs, which the tests cover, decides all
// of it; this file does the calls and records the run in feed_state as 'freebusy'.
//
// Google's side: the token refresh (developers.google.com/identity/protocols/oauth2/web-server,
// "Refreshing an access token") and POST https://www.googleapis.com/calendar/v3/freeBusy
// (developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).
//
// Deploy from the repo root:
//   npx supabase functions deploy busy-sync --use-api --no-verify-jwt
// --no-verify-jwt because the cron job has no Supabase sign-in; it proves itself with the shared
// secret below.
//
// Secrets: SHEET_CRON_SECRET, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. The refresh token comes
// from Vault (calendar_refresh_token) and is never logged or written anywhere.
import { busyChange, freeBusyRequest, freeBusyRows } from "../../../src/sheet/freebusy.mjs";
import { db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";
import { googleToken, refusedWhy } from "../_shared/google.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
const SOURCE = "freebusy";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const now = new Date();
  const fetched_at = now.toISOString();
  let refresh: string | null = null;
  try {
    refresh = await db("rpc/calendar_refresh_token", { method: "POST", body: "{}" });
    // Nothing connected yet: nothing to do, and nothing has failed.
    if (!refresh) {
      await saveFeedState(SOURCE, { fetched_at, ok: null, error: "not connected", items: null });
      return Response.json({ ok: true, skipped: "not connected" });
    }
    const out = await sync(refresh, now);
    // A calendar Google wouldn't read raises the feed alert, though the rest were saved.
    const error = out.failed ? `${out.failed} calendar${out.failed === 1 ? "" : "s"} couldn't be read` : null;
    await saveFeedState(SOURCE, { fetched_at, ok: !error, error, items: out.items });
    // The grant works again, so an old refusal no longer applies.
    await db("calendar_account?last_error=not.is.null", { method: "PATCH", body: JSON.stringify({ last_error: null }) });
    return Response.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof Refused) {
      await db("calendar_account?id=eq.true", { method: "PATCH", body: JSON.stringify({ last_error: e.message }) }).catch(() => {});
    }
    return feedFailed(SOURCE, e, fetched_at, refresh ? [refresh] : []);
  }
});

// A refused token refresh: the grant is broken, and Reconnect in Settings fixes it.
class Refused extends Error {}

async function sync(refresh: string, now: Date) {
  const { ok, status, grant } = await googleToken({ refresh_token: refresh, grant_type: "refresh_token" });
  if (!ok) throw new Refused(refusedWhy(status, grant));

  const [settings] = await db("settings?select=owner_email,time_zone,gcal_calendar_id,calendars");
  const body = freeBusyRequest(settings, now);
  const res = await fetch(FREEBUSY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${grant.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`freebusy: HTTP ${res.status}`);
  const { rows, failed } = freeBusyRows(await res.json(), now, settings.gcal_calendar_id ?? null);

  // What was saved before, and today's blocks, for the change row.
  const range = `starts_at=lt.${encodeURIComponent(body.timeMax)}&ends_at=gt.${encodeURIComponent(body.timeMin)}`;
  const before = await db(`busy?select=starts_at,ends_at&source=eq.calendar&${range}`);
  const blocks = await db(`blocks?select=starts_at,ends_at&ends_at=gt.${encodeURIComponent(body.timeMin)}` +
    `&starts_at=lt.${encodeURIComponent(new Date(+now + 2 * 86_400_000).toISOString())}`);
  // PostgREST hands timestamps back in its own format; freeBusyRows' are toISOString().
  const iso = (r: { starts_at: string; ends_at: string }) => ({ starts_at: new Date(r.starts_at).toISOString(), ends_at: new Date(r.ends_at).toISOString() });
  const change = busyChange(before.map(iso), rows, blocks, now, settings.time_zone);

  await db("rpc/busy_sync_save", {
    method: "POST",
    body: JSON.stringify({ from_at: body.timeMin, to_at: body.timeMax, rows, change }),
  });
  return { items: rows.length, failed: failed.length, change: change?.reason ?? null };
}
