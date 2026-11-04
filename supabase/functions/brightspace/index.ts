// The brightspace Edge Function (docs/sheet-sources.md, "Edge Functions"): turns Lisul's
// Brightspace due dates into course tasks. pg_cron calls it at :20 every hour
// (supabase/schema.sql, "sheet-brightspace"). It fetches the calendar feed, and
// src/sheet/ical.mjs and src/sheet/feeds.mjs, the modules the tests cover, decide what changes;
// this file only reads the planner, fetches the feed and writes what they say, then records the
// run in feed_state for the Feeds status in /plan Settings.
//
// Deploy from the repo root with server-side bundling, which follows the imports out of
// supabase/functions:
//   npx supabase functions deploy brightspace --use-api --no-verify-jwt
// --no-verify-jwt because the cron job has no Supabase sign-in; it proves itself with the shared
// secret below.
//
// Secrets (function secrets, set by Lisul, never in the repo): SHEET_BRIGHTSPACE_ICS, the feed's
// subscription URL (Brightspace Calendar, "Subscribe"; it carries a private token, so it is
// never logged or written to feed_state), and SHEET_CRON_SECRET. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase and read in ../_shared/server.ts, with the
// shared-secret check and the database calls.
import { parseIcs } from "../../../src/sheet/ical.mjs";
import { courseChanges, courseTaskChanges } from "../../../src/sheet/feeds.mjs";
import { localNow } from "../../../src/sheet/logic.mjs";
import { calendarText, db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
const FEED = env("SHEET_BRIGHTSPACE_ICS");
// Brightspace may hand out the link as webcal://, which fetch can't open; it is https underneath.
const FEED_URL = FEED.replace(/^webcals?:\/\//i, "https://");
const SOURCE = "brightspace";
const DAY = 86_400_000;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  // No feed set up yet: nothing to do, and nothing has failed.
  if (!FEED) return Response.json({ ok: true, skipped: "no feed" });
  const fetched_at = new Date().toISOString();
  try {
    const out = await sync(new Date());
    await saveFeedState(SOURCE, { fetched_at, ok: true, error: null, items: out.items });
    return Response.json({ ok: true, ...out });
  } catch (e) {
    // The feed URL carries a private token, so it is taken out of the error (_shared/server.ts).
    return feedFailed(SOURCE, e, fetched_at, [FEED, FEED_URL]);
  }
});

// --- Sync ---------------------------------------------------------------------------------

type Changes = {
  insert: Record<string, unknown>[];
  update: { id: string; title: string; due: string }[];
  seen: { source: string; uid: string }[];
};

async function sync(now: Date) {
  const [settings] = await db("settings?select=time_zone");
  const tasks = await db(`tasks?select=id,title,due,done,source,source_uid&source=eq.${SOURCE}`);
  const seen = (await db(`feed_seen?select=uid&source=eq.${SOURCE}`)).map((r: { uid: string }) => r.uid);

  const text = await calendarText(await fetch(FEED_URL, { headers: { Accept: "text/calendar" } }));

  // From yesterday on: items already past when the sync first runs don't become tasks, and a
  // past item keeps the due date it last had. Brightspace lists the term ahead, so half a year
  // covers it.
  const events = parseIcs(text, { from: new Date(+now - DAY), to: new Date(+now + 183 * DAY) });
  const timeZone = settings?.time_zone ?? "America/New_York";
  const changes = courseTaskChanges(events, { tasks, seen, timeZone }) as Changes;

  // Tasks first, then their UIDs: if the run dies between the two, the task holding the UID
  // still counts as seen next time. The unique (source, source_uid) index turns away a repeat.
  if (changes.insert.length) {
    await db("tasks?on_conflict=source,source_uid", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(changes.insert),
    });
  }
  if (changes.seen.length) {
    await db("feed_seen?on_conflict=source,uid", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(changes.seen),
    });
  }
  for (const u of changes.update) {
    await db(`tasks?id=eq.${u.id}&done=is.false`, { method: "PATCH", body: JSON.stringify({ title: u.title, due: u.due }) });
  }
  // v5 R1: what the replan decision weighs (docs/sheet-v5.md, "replan.mjs"), once the tasks are in.
  const logged = courseChanges(changes, tasks, localNow(now, timeZone).day);
  if (logged.length) await db("changes", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(logged) });
  return { items: events.length, inserted: changes.insert.length, updated: changes.update.length };
}
