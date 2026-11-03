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
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { parseIcs } from "../../../src/sheet/ical.mjs";
import { courseTaskChanges } from "../../../src/sheet/feeds.mjs";

const env = (name: string) => Deno.env.get(name) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
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
    await saveState({ fetched_at, ok: true, error: null, items: out.items });
    return Response.json({ ok: true, ...out });
  } catch (e) {
    const error = scrub(e instanceof Error ? e.message : String(e));
    console.error("brightspace:", error);
    // Recording the failure can fail too (the database being the problem); say so either way.
    await saveState({ fetched_at, ok: false, error }).catch(() => {});
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

// An error's text with the feed URL taken out (fetch errors can quote it), and any other link
// too, cut to a line's length.
const scrub = (msg: string) => msg.split(FEED).join("<feed>").split(FEED_URL).join("<feed>").replace(/(https?|webcals?):\/\/\S+/g, "<link>").slice(0, 300);

// --- The database, through PostgREST with the service key (it bypasses row-level security) ---

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 201 ? null : res.json();
}

// Upserts follow PostgREST: on_conflict names the unique columns, and
// Prefer: resolution=ignore-duplicates or merge-duplicates says what a clash does
// (docs.postgrest.org/en/stable/references/api/tables_views.html#upsert).
const saveState = (row: Record<string, unknown>) =>
  db("feed_state?on_conflict=source", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ source: SOURCE, ...row }),
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

  const res = await fetch(FEED_URL, { headers: { Accept: "text/calendar" } });
  if (!res.ok) throw new Error(`feed: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("feed: not an iCal calendar");

  // From yesterday on: items already past when the sync first runs don't become tasks, and a
  // past item keeps the due date it last had. Brightspace lists the term ahead, so half a year
  // covers it.
  const events = parseIcs(text, { from: new Date(+now - DAY), to: new Date(+now + 183 * DAY) });
  const changes = courseTaskChanges(events, { tasks, seen, timeZone: settings?.time_zone ?? "America/New_York" }) as Changes;

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
  return { items: events.length, inserted: changes.insert.length, updated: changes.update.length };
}
