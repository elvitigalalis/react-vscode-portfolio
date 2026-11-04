// The ical-sync Edge Function (docs/sheet-v5.md, "Edge Functions"): reads Lisul's Handshake
// calendar and the SBU academic calendar, and keeps his enrollment task. pg_cron calls it at :25
// every hour (supabase/schema.sql, "sheet-ical"). src/sheet/ical.mjs and src/sheet/sources.mjs,
// the modules the tests cover, decide what each feed means; this file only fetches and writes.
//
// - Handshake: interviews and appointments (handshakeBusy) become busy rows with source
//   'handshake', replaced in one call (handshake_sync_save) that leaves the calendar's alone and
//   writes a handshake change when they moved. Recorded in feed_state as "handshake".
// - The academic calendar: each day's entries (academicEntries) from today on, in academic_days,
//   for the brief and read_planner. Recorded as "academic".
// - Enrollment: settings.enrollment_at as one task (enrollmentTask), upserted on (source,
//   source_uid) and left alone once done; cleared when the setting is.
//
// A feed whose secret isn't set records { ok: null, error: 'not connected' }; one failing doesn't
// stop the other.
//
// Deploy from the repo root, as brightspace:
//   npx supabase functions deploy ical-sync --use-api --no-verify-jwt
//
// Secrets (function secrets, set by Lisul, never in the repo): SHEET_HANDSHAKE_ICS (Handshake's
// private calendar link, which carries a token, so it is never logged or written to feed_state),
// SHEET_ACADEMIC_ICS and SHEET_CRON_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read
// in ../_shared/server.ts.
import { parseIcs } from "../../../src/sheet/ical.mjs";
import { academicEntries, enrollmentTask, handshakeBusy } from "../../../src/sheet/sources.mjs";
import { addDays, localNow } from "../../../src/sheet/logic.mjs";
import { calendarText, db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
// Either link may be handed out as webcal://, which fetch can't open; it is https underneath.
const https = (url: string) => url.replace(/^webcals?:\/\//i, "https://");
const HANDSHAKE = env("SHEET_HANDSHAKE_ICS");
const ACADEMIC = env("SHEET_ACADEMIC_ICS");
const DAY = 86_400_000;
// Handshake busy times are kept for the next 30 days; academic entries for the next 120.
const BUSY_DAYS = 30;
const ACADEMIC_DAYS = 120;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const now = new Date();
  const [settings] = await db("settings?select=time_zone,enrollment_at");
  const tz = settings.time_zone;
  const out = {
    handshake: await feed("handshake", HANDSHAKE, now, (events) => saveHandshake(events, now)),
    academic: await feed("academic", ACADEMIC, now, (events) => saveAcademic(events, now, tz)),
    enrollment: await saveEnrollment(settings?.enrollment_at ?? null, tz).catch((e) => {
      console.error("enrollment:", e instanceof Error ? e.message : String(e));
      return "failed";
    }),
  };
  const ok = out.handshake.ok !== false && out.academic.ok !== false;
  return Response.json({ ok, ...out }, { status: ok ? 200 : 502 });
});

// One feed's run: fetch, parse from yesterday to 120 days ahead, save, and record it.
async function feed(source: string, link: string, now: Date, save: (events: any[]) => Promise<void>) {
  const fetched_at = now.toISOString();
  if (!link) {
    await saveFeedState(source, { fetched_at, ok: null, error: "not connected" });
    return { ok: null, skipped: "not connected" };
  }
  try {
    const text = await calendarText(await fetch(https(link), { headers: { Accept: "text/calendar" } }));
    const events = parseIcs(text, { from: new Date(+now - DAY), to: new Date(+now + ACADEMIC_DAYS * DAY) });
    await save(events);
    await saveFeedState(source, { fetched_at, ok: true, error: null, items: events.length });
    return { ok: true, items: events.length };
  } catch (e) {
    // The link may carry a private token, so it is taken out of the error (_shared/server.ts).
    await feedFailed(source, e, fetched_at, [link, https(link)]);
    return { ok: false };
  }
}

// From now to 30 days ahead, in one call (supabase/schema.sql, handshake_sync_save).
async function saveHandshake(events: any[], now: Date) {
  await db("rpc/handshake_sync_save", {
    method: "POST",
    body: JSON.stringify({
      from_at: now.toISOString(),
      to_at: new Date(+now + BUSY_DAYS * DAY).toISOString(),
      rows: handshakeBusy(events).map((b: any) => ({ starts_at: b.starts_at, ends_at: b.ends_at })),
    }),
  });
}

// Every day from today with entries, written over what was there; days with none have no row.
async function saveAcademic(events: any[], now: Date, tz: string) {
  const today = localNow(now, tz).day;
  const rows = [];
  for (let i = 0; i < ACADEMIC_DAYS; i++) {
    const day = addDays(today, i);
    const entries = academicEntries(events, day, tz);
    if (entries.length) rows.push({ day, entries, fetched_at: now.toISOString() });
  }
  await db("academic_days?day=gte.1900-01-01", { method: "DELETE" });
  if (rows.length) await db("academic_days", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) });
}

// The enrollment task follows the setting until it's done. Upserts follow PostgREST
// (docs.postgrest.org/en/stable/references/api/tables_views.html#upsert).
async function saveEnrollment(enrollmentAt: string | null, tz: string) {
  const [task = null] = await db("tasks?select=id,done&source=eq.enrollment&source_uid=eq.enrollment");
  if (task?.done) return "done";
  const row = enrollmentTask(enrollmentAt, tz);
  if (!row) {
    if (task) await db(`tasks?id=eq.${task.id}&done=is.false`, { method: "DELETE" });
    return task ? "removed" : "none";
  }
  await db("tasks?on_conflict=source,source_uid", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
  return "saved";
}
