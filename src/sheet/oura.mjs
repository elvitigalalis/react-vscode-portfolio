// Oura's API for The Sheet (docs/sheet-v5.md, "Oura"): the consent URL with PKCE, the token
// refresh, and what a sync keeps. Kept free of Deno so node --test covers it; oura-connect and
// oura-sync import it, and pass in fetch.
//   Auth: cloud.ouraring.com/docs/authentication (authorize and token URLs, scopes, PKCE, "The
//     refresh token is single-use, meaning it is invalidated after being used", and "All requests
//     to the Oura API must include a non-empty User-Agent header").
//   Data: cloud.ouraring.com/v2/docs (spec 1.43): /v2/usercollection/sleep, daily_readiness and
//     sleep_time (PublicSleepTime: day, optimal_bedtime { day_tz, start_offset, end_offset } "offset
//     from midnight in second", status), paged by next_token; "the dates are interpreted in the user's local timezone".
import { addDays, localNow } from "./logic.mjs";

export const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const API_URL = "https://api.ouraring.com/v2/usercollection";
// "daily": "Daily summaries of sleep, activity and readiness", the only scope sleep needs.
export const SCOPE = "daily";
export const USER_AGENT = "TheSheet/1.0 (+https://lisul-elvi.com/privacy/)";

export const ouraAuthUrl = ({ clientId, redirectUri, state, challenge }) => `${AUTHORIZE_URL}?${new URLSearchParams({
  response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPE, state,
  code_challenge: challenge, code_challenge_method: "S256",
})}`;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A PKCE pair (RFC 7636): a random verifier and its S256 challenge, "hash it with SHA256 and
// encode the digest in base64url format without padding".
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

// POST the token endpoint with `fields` (a code or a refresh token) and the client's credentials.
// `grant` holds Oura's reply, whose error never contains a token.
export async function ouraToken(fetch, fields, { clientId, clientSecret }) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ ...fields, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const grant = await res.json().catch(() => ({}));
  return { ok: res.ok && Boolean(grant.access_token), status: res.status, grant };
}

// A refused refresh: the grant is broken, and Reconnect in Settings fixes it.
export class Refused extends Error {}

// Refresh this far ahead of the access token's expiry.
const AHEAD_MS = 60 * 60_000;

// An access token for this run. One still good for an hour is used as it is. Otherwise the
// refresh token is spent, and the new pair must be saved before the access token is used: the old
// refresh token is dead now, so a lost new one means reconnecting. `save({ refresh, access,
// expires_at, old_refresh })` stores it only over `old_refresh` and says whether it did (false:
// another run rotated first). A save that throws is tried once more; if it fails again, or the
// pair can't be kept, this throws and nothing uses the access token. A 400 or 401 is Refused.
export async function freshAccess(fetch, { tokens, now, save, clientId, clientSecret }) {
  if (tokens.access && Date.parse(tokens.expires_at) - now.getTime() > AHEAD_MS) return tokens.access;
  const { ok, status, grant } = await ouraToken(fetch, { grant_type: "refresh_token", refresh_token: tokens.refresh }, { clientId, clientSecret });
  if (!ok) {
    const why = /^[\w-]{1,40}$/.test(grant.error ?? "") ? grant.error : `HTTP ${status}`;
    if (status === 400 || status === 401) throw new Refused(`token refresh refused: ${why}`);
    throw new Error(`token refresh failed: ${why}`);
  }
  if (!grant.refresh_token) throw new Error("token refresh: no new refresh token");
  const pair = {
    refresh: grant.refresh_token, access: grant.access_token,
    expires_at: new Date(now.getTime() + Number(grant.expires_in ?? 0) * 1000).toISOString(), old_refresh: tokens.refresh,
  };
  let saved = null;
  for (let i = 0; i < 2 && saved === null; i++) saved = await save(pair).catch(() => null);
  if (saved === null) throw new Error("token refresh: couldn't save the new token; reconnect if the next run is refused");
  if (!saved) throw new Error("token refresh: another run rotated the token first");
  return pair.access;
}

// The dates a run reads: the last 2 days, or 21 on the first sync, through tomorrow (end_date
// is the last day read), in his time zone.
export function syncRange(now, tz, first) {
  const today = localNow(now, tz).day;
  return { start_date: addDays(today, first ? -21 : -2), end_date: addDays(today, 1) };
}

// Every document of a collection over `range`, following next_token.
export async function ouraDocs(fetch, collection, range, access) {
  const docs = [];
  let next = null;
  do {
    const q = new URLSearchParams({ ...range, ...(next ? { next_token: next } : {}) });
    const res = await fetch(`${API_URL}/${collection}?${q}`, { headers: { Authorization: `Bearer ${access}`, "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`oura ${collection}: HTTP ${res.status}`);
    const body = await res.json();
    docs.push(...(body.data ?? []));
    next = body.next_token ?? null;
  } while (next);
  return docs;
}

const TYPES = ["deleted", "sleep", "long_sleep", "late_nap", "rest"];
const iso = (s) => { const t = Date.parse(s ?? ""); return Number.isNaN(t) ? null : new Date(t).toISOString(); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The sleep_nights rows from /sleep documents: { oura_id, day, type, bedtime_start, bedtime_end }
// and nothing else. A document missing any of them is skipped.
export const sleepRows = (docs) => docs.flatMap((d) => {
  const row = { oura_id: d?.id, day: d?.day, type: d?.type, bedtime_start: iso(d?.bedtime_start), bedtime_end: iso(d?.bedtime_end) };
  return typeof row.oura_id === "string" && row.oura_id.length <= 100 && DAY.test(row.day ?? "") && TYPES.includes(row.type)
    && row.bedtime_start && row.bedtime_end ? [row] : [];
});

// The sleep_days rows, by Oura's day, oldest first: readiness's score and temperature_deviation
// (daily_readiness); from the day's main sleep (its longest long_sleep, sleep) total_sleep_duration
// as sleep_s, efficiency, deep and REM seconds, lowest and average heart rate and average HRV; the
// sleep score (daily_sleep); the activity score and steps (daily_activity); and the stress
// day_summary (daily_stress). Each null when Oura gave none or a value out of range, and a day
// appears only with at least one. Field names and types: cloud.ouraring.com/v2/docs (spec 1.43,
// PublicDailyReadiness, PublicModifiedSleepModel, PublicDailySleep, PublicDailyActivity,
// PublicDailyStress). Nothing else in the payloads is kept.
const KEYS = ["readiness", "sleep_s", "sleep_score", "efficiency", "deep_s", "rem_s", "rhr_low", "rhr_avg", "hrv_avg", "temp_dev", "activity_score", "steps", "stress"];
const STRESS = ["restored", "normal", "stressful"];
const int = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null);
export function dayRows(sleepDocs, readinessDocs, { dailySleep = [], activity = [], stress = [] } = {}) {
  const days = new Map();
  const put = (day, key, v) => {
    if (v == null || !DAY.test(day ?? "")) return;
    if (!days.has(day)) days.set(day, { day, ...Object.fromEntries(KEYS.map((k) => [k, null])) });
    days.get(day)[key] = v;
  };
  for (const r of readinessDocs) {
    put(r?.day, "readiness", Number.isInteger(r?.score) ? int(r.score, 0, 100) : null);
    const t = r?.temperature_deviation;
    put(r?.day, "temp_dev", Number.isFinite(t) && Math.abs(t) <= 10 ? Math.round(t * 100) / 100 : null);
  }
  const main = new Map();
  for (const s of sleepDocs) {
    const secs = s?.total_sleep_duration;
    if (s?.type !== "long_sleep" || !DAY.test(s.day ?? "") || !Number.isInteger(secs) || secs < 0 || secs > 86400) continue;
    if (!main.has(s.day) || secs > main.get(s.day).total_sleep_duration) main.set(s.day, s);
  }
  for (const [day, s] of main) {
    put(day, "sleep_s", s.total_sleep_duration);
    put(day, "efficiency", int(s.efficiency, 1, 100));
    put(day, "deep_s", int(s.deep_sleep_duration, 0, 86400));
    put(day, "rem_s", int(s.rem_sleep_duration, 0, 86400));
    put(day, "rhr_low", int(s.lowest_heart_rate, 20, 250));
    put(day, "rhr_avg", int(s.average_heart_rate, 20, 250));
    put(day, "hrv_avg", int(s.average_hrv, 0, 500));
  }
  for (const d of dailySleep) put(d?.day, "sleep_score", int(d?.score, 0, 100));
  for (const a of activity) {
    put(a?.day, "activity_score", int(a?.score, 0, 100));
    put(a?.day, "steps", int(a?.steps, 0, 200000));
  }
  for (const x of stress) put(x?.day, "stress", STRESS.includes(x?.day_summary) ? x.day_summary : null);
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

// Wind-down: the sleep_times rows from /sleep_time documents, { day, start_offset, end_offset }
// and nothing else, only when Oura found a window (status optimal_found or only_recommended_found,
// the two that come with one). Offsets are seconds from the day's midnight, within a day.
const WINDOW_FOUND = ["optimal_found", "only_recommended_found"];
const offset = (s) => Number.isInteger(s) && Math.abs(s) <= 86400;
export const sleepTimeRows = (docs) => docs.flatMap((d) => {
  const w = d?.optimal_bedtime;
  return DAY.test(d?.day ?? "") && WINDOW_FOUND.includes(d.status) && offset(w?.start_offset) && offset(w?.end_offset)
    ? [{ day: d.day, start_offset: w.start_offset, end_offset: w.end_offset }] : [];
});
