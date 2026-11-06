// The brightspace Edge Function (docs/sheet-sources.md, "Edge Functions"): turns Lisul's
// Brightspace calendar into course tasks: due dates as tasks with due dates, and exams, quizzes
// and other events as tasks on their day at their time. pg_cron calls it at :20 every hour
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
import { courseChanges, courseEventChanges, courseRemovals, courseTaskChanges } from "../../../src/sheet/feeds.mjs";
import { addDays, localNow } from "../../../src/sheet/logic.mjs";
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
  update: ({ id: string } & Record<string, unknown>)[];
  seen: { source: string; uid: string }[];
};

async function sync(now: Date) {
  const [settings] = await db("settings?select=time_zone");
  const tasks = await db(`tasks?select=id,title,day,list,due,at_time,est_min,done,source,source_uid,link&source=eq.${SOURCE}`);
  const seen = (await db(`feed_seen?select=uid&source=eq.${SOURCE}`)).map((r: { uid: string }) => r.uid);

  const text = await calendarText(await fetch(FEED_URL, { headers: { Accept: "text/calendar" } }));

  // From yesterday on: items already past when the sync first runs don't become tasks, and a
  // past item keeps the due date it last had. Brightspace lists the term ahead, so half a year
  // covers it.
  const to = new Date(+now + 183 * DAY);
  const events = parseIcs(text, { from: new Date(+now - DAY), to });
  const timeZone = settings.time_zone;
  const today = localNow(now, timeZone).day;
  // Due dates, then the events (exams, quizzes, holidays) beside them; both are course tasks.
  const due = courseTaskChanges(events, { tasks, seen, timeZone }) as Changes;
  const timed = courseEventChanges(events, { tasks, seen, timeZone, today }) as Changes;
  const changes: Changes = { insert: [...due.insert, ...timed.insert], update: [...due.update, ...timed.update], seen: [...due.seen, ...timed.seen] };
  // Cancelled or gone from the feed, up to the day before the window's far edge.
  const removed = courseRemovals(events, { tasks, today, until: addDays(localNow(to, timeZone).day, -1) }) as { id: string; uid: string }[];

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
  for (const { id, ...fields } of changes.update) {
    await db(`tasks?id=eq.${id}&done=is.false`, { method: "PATCH", body: JSON.stringify(fields) });
  }
  // A removed item's task goes, and so does its UID, so the item comes back as new if reinstated.
  // PostgREST filters: docs.postgrest.org/en/stable/references/api/tables_views.html#operators.
  if (removed.length) {
    await db(`tasks?id=in.(${removed.map((r) => r.id).join(",")})&done=is.false`, { method: "DELETE" });
    const uids = removed.map((r) => `"${r.uid.replace(/["\\]/g, "\\$&")}"`).join(",");
    await db(`feed_seen?source=eq.${SOURCE}&uid=in.(${encodeURIComponent(uids)})`, { method: "DELETE" });
  }
  // v5 R1: what the replan decision weighs (docs/sheet-v5.md, "replan.mjs"), once the tasks are in.
  const logged = courseChanges({ ...changes, removed }, tasks, today);
  if (logged.length) await db("changes", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(logged) });
  return { items: events.length, inserted: changes.insert.length, updated: changes.update.length, removed: removed.length };
}
