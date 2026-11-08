// The hevy-sync Edge Function (docs/sheet-hevy.md): every 15 minutes (supabase/schema.sql,
// "sheet-hevy", at :09/:24/:39/:54 since Hevy asks callers to stay off :00) it copies Lisul's Hevy
// workouts into hevy_workouts and hevy_sets, then ends the day's Gym habit block that a workout
// finished, as a ring workout does (_shared/gym-tick.ts). src/sheet/hevy.mjs, which the tests
// cover, decides the rows; this file does the calls and records the run in feed_state as 'hevy'.
//
// Hevy's side (api.hevyapp.com/docs, v0.0.1, header api-key): the first run (events_since null)
// reads GET /v1/user/info (weight_unit, is_pro) and every page of GET /v1/workouts; later runs
// read GET /v1/workouts/events?since=, which exists to keep a local copy up to date. pageSize is
// at most 10.
//
// POST /hook is Hevy's webhook (undocumented; set in Hevy's developer settings with the header
// "Authorization: Bearer <SHEET_HEVY_HOOK_TOKEN>"). Hevy wants a 200 within 5 seconds, so it
// answers at once and syncs in the background. It is only a "sync now" hint: the payload is not
// read, and the 15-minute poll works without it. Two runs at once are safe: every write is an
// upsert or a delete by id.
//
// Deploy from the repo root:
//   npx supabase functions deploy hevy-sync --use-api --no-verify-jwt
// --no-verify-jwt because neither the cron job nor Hevy has a Supabase sign-in; they prove
// themselves with the secrets below.
//
// Secrets: SHEET_CRON_SECRET, and SHEET_HEVY_HOOK_TOKEN (optional; /hook answers 404 without it).
// The API key comes from Vault (hevy_key) each run and is never logged or written anywhere else.
import { applyEvents, asRingWorkouts, workoutRows } from "../../../src/sheet/hevy.mjs";
import { addDays, localNow } from "../../../src/sheet/logic.mjs";
import { db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";
import { tickGym } from "../_shared/gym-tick.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const CRON_SECRET = env("SHEET_CRON_SECRET");
const HOOK_TOKEN = env("SHEET_HEVY_HOOK_TOKEN");
const API = "https://api.hevyapp.com";
const SOURCE = "hevy";
const OVERLAP_MS = 10 * 60_000;
const MAX_PAGES = 1000;

type Account = { key: string; events_since: string | null } | null;

// A refused or failed Hevy call, by its path and status only (never the key or the body).
class HevyError extends Error {
  constructor(path: string, readonly status: number) { super(`hevy ${path}: ${status}`); }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (new URL(req.url).pathname.endsWith("/hook")) {
    if (!HOOK_TOKEN) return new Response("not found", { status: 404 });
    if (!secretMatches(req.headers.get("authorization") ?? "", `Bearer ${HOOK_TOKEN}`)) return new Response("forbidden", { status: 403 });
    console.log("hevy: webhook hint");
    EdgeRuntime.waitUntil(run().catch(() => {}));
    return new Response("ok");
  }
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  return run();
});

async function run() {
  const now = new Date();
  const fetched_at = now.toISOString();
  let account: Account = null;
  try {
    account = await db("rpc/hevy_key", { method: "POST", body: "{}" });
    // Nothing connected yet: nothing to do, and nothing has failed.
    if (!account?.key) {
      await saveFeedState(SOURCE, { fetched_at, ok: null, error: "not connected", items: null });
      return Response.json({ ok: true, skipped: "not connected" });
    }
    const out = await sync(account, now);
    await saveFeedState(SOURCE, { fetched_at, ok: true, error: null, items: out.items });
    return Response.json({ ok: true, ...out });
  } catch (e) {
    const why = e instanceof HevyError && (e.status === 401 || e.status === 403) ? "key refused" : e instanceof NotPro ? "not pro" : null;
    if (why) await db("rpc/hevy_broken", { method: "POST", body: JSON.stringify({ why }) }).catch(() => {});
    return feedFailed(SOURCE, e, fetched_at, account?.key ? [account.key] : []);
  }
}

class NotPro extends Error {
  constructor() { super("hevy: not pro"); }
}

async function hevy(key: string, path: string) {
  const res = await fetch(`${API}${path}`, { headers: { "api-key": key, accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HevyError(path.split("?")[0], res.status);
  }
  return res.json();
}

// Every page of a paged list (page 1 up to page_count), each page's `field`.
async function allPages(key: string, path: string, field: string) {
  const out: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await hevy(key, `${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=10`);
    out.push(...(body?.[field] ?? []));
    if (!(page < (body?.page_count ?? 0))) break;
  }
  return out;
}

async function sync(account: NonNullable<Account>, now: Date) {
  const { key, events_since } = account;
  let unit: string | null = null;
  let updated: unknown[];
  let deleted: string[] = [];
  if (!events_since) {
    // First run (or a new key): check the plan, then read everything.
    const info = (await hevy(key, "/v1/user/info"))?.data ?? {};
    if (info.is_pro === false) throw new NotPro();
    unit = info.weight_unit === "kg" || info.weight_unit === "lbs" ? info.weight_unit : null;
    updated = await allPages(key, "/v1/workouts", "workouts");
  } else {
    // Later runs: what changed since the last run, with a little overlap (upserts are idempotent).
    const since = new Date(Date.parse(events_since) - OVERLAP_MS).toISOString();
    const events = await allPages(key, `/v1/workouts/events?since=${encodeURIComponent(since)}`, "events");
    ({ updated, deleted } = applyEvents([events]));
  }

  const [settings] = await db("settings?select=time_zone");
  const tz = settings.time_zone;
  const { workouts, sets } = workoutRows(updated, tz);
  await db("rpc/hevy_sync_save", {
    method: "POST",
    body: JSON.stringify({ workouts, sets, deleted, since: now.toISOString(), unit }),
  });

  // Yesterday's and today's workouts, as kept, against the Gym habit blocks.
  const today = localNow(now, tz).day;
  const recent = await db(`hevy_workouts?select=id,day,starts_at,ends_at&day=gte.${addDays(today, -1)}`);
  const gym = recent?.length ? await tickGym(asRingWorkouts(recent), tz, today) : 0;
  return { items: workouts.length, sets: sets.length, deleted: deleted.length, gym, full: !events_since };
}
