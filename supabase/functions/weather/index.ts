// The weather Edge Function (docs/sheet-v5.md, "Edge Functions"): caches the National Weather
// Service's hourly forecast and active alerts for settings.weather_point (campus by default) in
// weather_cache, for the brief's weather line and read_planner's weather. pg_cron calls it at :50
// every hour (supabase/schema.sql, "sheet-weather"). src/sheet/sources.mjs, the module the tests
// cover, shapes what comes back; this file only fetches and writes, then records the run in
// feed_state under "weather".
//
// The NWS API (https://www.weather.gov/documentation/services-web-api) needs no key, but every
// request must send a User-Agent naming the application. This one is generic, with no personal
// email. /points/{lat},{lon} gives the grid's forecastHourly URL; the docs say it may be cached
// but that the grid mapping can change, so a failed forecast fetch looks the point up again once.
// /alerts/active takes `point=lat,lon` (the "Specification" tab, https://api.weather.gov/openapi.json).
//
// A failure is quiet: the last good cache stays, nothing reaches Telegram, and feed_state shows it.
// An alerts failure alone keeps the forecast and the last alerts.
//
// Deploy from the repo root, as brightspace:
//   npx supabase functions deploy weather --use-api --no-verify-jwt
//
// Secrets: SHEET_CRON_SECRET only. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read in
// ../_shared/server.ts.
import { weatherAlerts, weatherPeriods } from "../../../src/sheet/sources.mjs";
import { db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
const SOURCE = "weather";
const API = "https://api.weather.gov";
const HEADERS = { "User-Agent": "(the-sheet planner, weather sync)", Accept: "application/geo+json" };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const fetched_at = new Date().toISOString();
  try {
    const items = await sync(fetched_at);
    await saveFeedState(SOURCE, { fetched_at, ok: true, error: null, items });
    return Response.json({ ok: true, items });
  } catch (e) {
    return feedFailed(SOURCE, e, fetched_at);
  }
});

async function getJson(url: string) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`nws: HTTP ${res.status}`);
  return res.json();
}

// The point's forecastHourly link, only ever on api.weather.gov.
async function forecastUrl(point: string) {
  const url = (await getJson(`${API}/points/${point}`))?.properties?.forecastHourly;
  if (typeof url !== "string" || !url.startsWith(`${API}/`)) throw new Error("nws: no hourly forecast for the point");
  return url;
}

async function sync(fetched_at: string) {
  const [settings] = await db("settings?select=weather_point");
  const point = settings?.weather_point ?? "40.9126,-73.1234";
  const [cache = null] = await db("weather_cache?select=point,forecast_url");

  // The cached link while the point is unchanged; looked up again if it fails.
  let url = cache?.point === point ? cache.forecast_url : null;
  let forecast;
  try {
    url ??= await forecastUrl(point);
    forecast = await getJson(url);
  } catch (e) {
    if (url !== cache?.forecast_url || !url) throw e;
    url = await forecastUrl(point);
    forecast = await getJson(url);
  }
  const periods = weatherPeriods(forecast);

  const row: Record<string, unknown> = { id: true, point, forecast_url: url, periods, fetched_at };
  // A new point's alerts start empty, so another place's alerts never outlive a failed fetch.
  if (cache?.point !== point) row.alerts = [];
  try {
    row.alerts = weatherAlerts(await getJson(`${API}/alerts/active?point=${point}`));
  } catch (e) {
    console.error(`${SOURCE}: alerts:`, e instanceof Error ? e.message : String(e));
  }
  await db("weather_cache?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
  return periods.length;
}
