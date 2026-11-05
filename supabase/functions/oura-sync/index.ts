// The oura-sync Edge Function (docs/sheet-v5.md, "Oura"): every 10 minutes (supabase/schema.sql,
// "sheet-oura") it reads Lisul's sleep periods and daily readiness from Oura and saves only what
// the plan needs: each period's id, day, type and bedtimes (sleep_nights), and each day's
// readiness and main sleep's total (sleep_days). When today's wake has synced and came 45+
// minutes after the window today's newest revision was planned from, it logs a woke_late change,
// so the replan tick replans the rest of today. src/sheet/oura.mjs and sleep.mjs, which the tests
// cover, decide all of it; this file does the calls and records the run in feed_state as 'oura'.
//
// Oura's side: the token refresh (cloud.ouraring.com/docs/authentication: "The refresh token is
// single-use"), GET /v2/usercollection/sleep and /daily_readiness (cloud.ouraring.com/v2/docs).
// /plan's day numbers: GET /daily_sleep, /daily_activity and /daily_stress, scores and steps only.
// Ring: GET /workout (scope workout; a 401/403 marks the grant without it, and Settings asks to
// reconnect), /rest_mode_period and /ring_battery_level?latest=true (only a low flag is kept).
// A ring workout over a Gym habit block ends it as a finished block ends (ring.mjs).
// Wind-down: GET /v2/usercollection/sleep_time, Oura's optimal bedtime window, keeping only its
// day and offsets (sleep_times). The spec maps no endpoint to a scope; if the daily grant doesn't
// cover it, the run carries on without it.
// Sleep data reaches Oura only once he opens the Oura app, so a run can find nothing new.
//
// Deploy from the repo root:
//   npx supabase functions deploy oura-sync --use-api --no-verify-jwt
// --no-verify-jwt because the cron job has no Supabase sign-in; it proves itself with the shared
// secret below.
//
// Secrets: SHEET_CRON_SECRET, OURA_CLIENT_ID and OURA_CLIENT_SECRET. The tokens come from Vault
// (oura_tokens) and are never logged or written anywhere else.
import { dayRows, freshAccess, ouraDocs, ouraLatest, Refused, restRows, ringLow, sleepRows, sleepTimeRows, syncRange, workoutRows } from "../../../src/sheet/oura.mjs";
import { gymMatches } from "../../../src/sheet/ring.mjs";
import { wakeProfile, wokeLate } from "../../../src/sheet/sleep.mjs";
import { changeRow } from "../../../src/sheet/replan.mjs";
import { addDays, localNow } from "../../../src/sheet/logic.mjs";
import { db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
const CLIENT_ID = env("OURA_CLIENT_ID");
const CLIENT_SECRET = env("OURA_CLIENT_SECRET");
const SOURCE = "oura";

type Tokens = { refresh: string; access: string | null; expires_at: string | null; synced_at: string | null };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const now = new Date();
  const fetched_at = now.toISOString();
  let tokens: Tokens | null = null;
  try {
    tokens = await db("rpc/oura_tokens", { method: "POST", body: "{}" });
    // Nothing connected yet: nothing to do, and nothing has failed.
    if (!tokens?.refresh) {
      await saveFeedState(SOURCE, { fetched_at, ok: null, error: "not connected", items: null });
      return Response.json({ ok: true, skipped: "not connected" });
    }
    const out = await sync(tokens, now);
    await saveFeedState(SOURCE, { fetched_at, ok: true, error: null, items: out.items });
    return Response.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof Refused && tokens) {
      // Refused because another run rotated the token in the meantime: not broken.
      const latest: Tokens | null = await db("rpc/oura_tokens", { method: "POST", body: "{}" }).catch(() => null);
      if (latest?.refresh === tokens.refresh) await db("rpc/oura_broken", { method: "POST", body: JSON.stringify({ why: e.message }) }).catch(() => {});
    }
    return feedFailed(SOURCE, e, fetched_at, tokens ? [tokens.refresh, tokens.access ?? ""] : []);
  }
});

async function sync(tokens: Tokens, now: Date) {
  const access = await freshAccess(fetch, {
    tokens, now, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    save: (pair: Record<string, string>) => db("rpc/oura_token_save", { method: "POST", body: JSON.stringify(pair) }),
  });
  const [settings] = await db("settings?select=time_zone");
  const tz = settings.time_zone;
  const range = syncRange(now, tz, !tokens.synced_at);
  const [sleepDocs, readinessDocs] = await Promise.all([
    ouraDocs(fetch, "sleep", range, access),
    ouraDocs(fetch, "daily_readiness", range, access),
  ]);
  const times = sleepTimeRows(await ouraDocs(fetch, "sleep_time", range, access).catch(() => []));
  const nights = sleepRows(sleepDocs);
  // The day's other numbers for /plan; like sleep_time, a refused read is skipped.
  const [dailySleep, activity, stress] = await Promise.all(["daily_sleep", "daily_activity", "daily_stress"]
    .map((c) => ouraDocs(fetch, c, range, access).catch(() => [])));
  const days = dayRows(sleepDocs, readinessDocs, { dailySleep, activity, stress });

  // Today's wake against today's newest revision, from every night kept (the 14-night medians
  // aren't needed for it, but wakeProfile picks the main sleep the same way).
  const today = localNow(now, tz).day;
  const kept = await db("sleep_nights?select=oura_id,day,type,bedtime_start,bedtime_end&order=bedtime_end");
  const byId = new Map(kept.map((r: { oura_id: string }) => [r.oura_id, r]));
  for (const n of nights) byId.set(n.oura_id, n);
  const profile = wakeProfile([...byId.values()], now, tz);
  const [revision = null] = await db(`proposals?select=day,rev,status,window_from,read_at,created_at&day=eq.${today}&order=rev.desc&limit=1`);
  // The ref is the wake's instant, written one way, so the same wake is logged once.
  const change = wokeLate(profile, revision, now, tz) ? changeRow("woke_late", new Date(profile.woke_at_iso).toISOString()) : null;

  const workouts = await ouraDocs(fetch, "workout", range, access).then(workoutRows)
    .catch((e: { status?: number }) => (e.status === 401 || e.status === 403 ? null : []));
  const rest = restRows(await ouraDocs(fetch, "rest_mode_period", range, access).catch(() => []));
  const low = ringLow(await ouraLatest(fetch, "ring_battery_level", access).catch(() => []));
  const extra = { workouts, rest, ...(low === null ? {} : { ring_low: low }) };

  await db("rpc/oura_sync_save", { method: "POST", body: JSON.stringify({ nights, days, change, times, extra }) });
  const gym = workouts?.length ? await tickGym(workouts, tz, today) : 0;
  return { items: nights.length, days: days.length, times: times.length, workouts: workouts?.length ?? null, gym, woke_late: Boolean(change) };
}

// The Gym habit blocks of yesterday and today that a ring workout finished, ended or dropped as
// a Done tap does (nudges.mjs): the block by its id, and its Google event through gcal_pending,
// which /plan applies when it opens.
async function tickGym(workouts: unknown[], tz: string, today: string) {
  const from = new Date(Date.parse(`${addDays(today, -1)}T00:00:00Z`) - 86_400_000).toISOString();
  const to = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  const [habits, blocks] = await Promise.all([
    db("habits?select=id,name"),
    db(`blocks?select=id,habit_id,starts_at,ends_at,proposed,gcal_id&habit_id=not.is.null&starts_at=gte.${from}&starts_at=lt.${to}`),
  ]);
  const matches = gymMatches(workouts, blocks, habits, tz);
  for (const m of matches) {
    if (m.action === "shrink") await db(`blocks?id=eq.${m.block_id}`, { method: "PATCH", body: JSON.stringify({ ends_at: m.ends_at }) });
    else await db(`blocks?id=eq.${m.block_id}`, { method: "DELETE" });
    if (m.gcal_id) {
      await db("gcal_pending?on_conflict=gcal_id", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ gcal_id: m.gcal_id, ends_at: m.action === "shrink" ? m.ends_at : null }),
      });
    }
  }
  return matches.length;
}
