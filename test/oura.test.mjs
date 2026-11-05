// Oura's API side (src/sheet/oura.mjs): the consent URL, PKCE, the token rotation with a fake
// fetch, and the rows kept from a sync. Expected values are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dayRows, freshAccess, ouraAuthUrl, pkce, Refused, sleepRows, sleepTimeRows, syncRange } from "../src/sheet/oura.mjs";

test("ouraAuthUrl: Oura's authorize URL, scope daily, with the state and an S256 challenge", () => {
  const url = new URL(ouraAuthUrl({ clientId: "cid", redirectUri: "https://x.supabase.co/functions/v1/oura-connect/callback", state: "st", challenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://cloud.ouraring.com/oauth/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: "code", client_id: "cid", redirect_uri: "https://x.supabase.co/functions/v1/oura-connect/callback",
    scope: "daily", state: "st", code_challenge: "ch", code_challenge_method: "S256",
  });
});

test("pkce: the challenge is the verifier's SHA-256, base64url with no padding", async () => {
  const { verifier, challenge } = await pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual((await pkce()).verifier, verifier);
});

// --- freshAccess: Oura's refresh tokens are single-use ---------------------------------------

const NOW = new Date("2026-11-04T15:00:00Z");
const tokens = { refresh: "r-old", access: "a-old", expires_at: "2026-11-04T15:30:00Z" };
const creds = { clientId: "cid", clientSecret: "secret" };
// A fake fetch answering the token endpoint, recording what was sent.
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return Object.assign(fn, { calls });
}

test("freshAccess: an access token good for over an hour is used as it is, with no refresh", async () => {
  const fetch = fakeFetch(500, {});
  const save = async () => assert.fail("saved");
  assert.equal(await freshAccess(fetch, { ...creds, tokens: { ...tokens, expires_at: "2026-11-05T15:00:00Z" }, now: NOW, save }), "a-old");
  assert.equal(fetch.calls.length, 0);
});

test("freshAccess: a refresh saves the new pair over the old token before the access token is used", async () => {
  const fetch = fakeFetch(200, { token_type: "bearer", access_token: "a-new", refresh_token: "r-new", expires_in: 86400 });
  const saved = [];
  const access = await freshAccess(fetch, { ...creds, tokens, now: NOW, save: async (pair) => { saved.push(pair); return true; } });
  assert.equal(access, "a-new");
  assert.equal(fetch.calls[0].url, "https://api.ouraring.com/oauth/token");
  assert.deepEqual(fetch.calls[0].form, { grant_type: "refresh_token", refresh_token: "r-old", client_id: "cid", client_secret: "secret" });
  assert.ok(fetch.calls[0].init.headers["User-Agent"]);
  assert.deepEqual(saved, [{ refresh: "r-new", access: "a-new", expires_at: "2026-11-05T15:00:00.000Z", old_refresh: "r-old" }]);
});

test("freshAccess: a refused refresh is Refused (Reconnect); a server error is not", async () => {
  const save = async () => true;
  await assert.rejects(freshAccess(fakeFetch(400, { error: "invalid_grant" }), { ...creds, tokens, now: NOW, save }),
    (e) => e instanceof Refused && e.message === "token refresh refused: invalid_grant");
  await assert.rejects(freshAccess(fakeFetch(401, {}), { ...creds, tokens, now: NOW, save }), (e) => e instanceof Refused && /HTTP 401/.test(e.message));
  await assert.rejects(freshAccess(fakeFetch(503, {}), { ...creds, tokens, now: NOW, save }), (e) => !(e instanceof Refused) && /HTTP 503/.test(e.message));
  // A reply with no new refresh token can't be kept: refusing it would lose the grant, so it's an error.
  await assert.rejects(freshAccess(fakeFetch(200, { access_token: "a" }), { ...creds, tokens, now: NOW, save }), (e) => !(e instanceof Refused));
});

test("freshAccess: a save that fails is retried once, then nothing uses the new access token", async () => {
  const ok = fakeFetch(200, { access_token: "a-new", refresh_token: "r-new", expires_in: 3600 });
  let tries = 0;
  assert.equal(await freshAccess(ok, { ...creds, tokens, now: NOW, save: async () => { if (++tries === 1) throw new Error("rpc: 503"); return true; } }), "a-new");
  assert.equal(tries, 2);
  const down = fakeFetch(200, { access_token: "a-new", refresh_token: "r-new", expires_in: 3600 });
  await assert.rejects(freshAccess(down, { ...creds, tokens, now: NOW, save: async () => { throw new Error("rpc: 503"); } }),
    (e) => /couldn't save/.test(e.message) && !e.message.includes("r-new") && !e.message.includes("a-new"));
  // Another run rotated first (the stored token is no longer r-old): this run stops too.
  await assert.rejects(freshAccess(fakeFetch(200, { access_token: "a2", refresh_token: "r2", expires_in: 3600 }), { ...creds, tokens, now: NOW, save: async () => false }),
    /another run/);
});

// --- What a sync keeps --------------------------------------------------------------------------

test("syncRange: the last 2 days on each run, 21 on the first, through tomorrow", () => {
  assert.deepEqual(syncRange(NOW, "America/New_York", false), { start_date: "2026-11-02", end_date: "2026-11-05" });
  assert.deepEqual(syncRange(NOW, "America/New_York", true), { start_date: "2026-10-14", end_date: "2026-11-05" });
});

const doc = (extra) => ({
  id: "s1", day: "2026-11-04", type: "long_sleep", bedtime_start: "2026-11-04T00:30:00-05:00", bedtime_end: "2026-11-04T09:40:00-05:00",
  total_sleep_duration: 27000, average_heart_rate: 52, hrv: 40, low_battery_alert: false, period: 0, time_in_bed: 33000, ...extra,
});

test("sleepRows: only id, day, type and the two bedtimes are kept", () => {
  assert.deepEqual(sleepRows([doc(), doc({ id: "s2", type: "sleep" }), { id: "bad" }, doc({ id: "s3", type: "unknown" })]), [
    { oura_id: "s1", day: "2026-11-04", type: "long_sleep", bedtime_start: "2026-11-04T05:30:00.000Z", bedtime_end: "2026-11-04T14:40:00.000Z" },
    { oura_id: "s2", day: "2026-11-04", type: "sleep", bedtime_start: "2026-11-04T05:30:00.000Z", bedtime_end: "2026-11-04T14:40:00.000Z" },
  ]);
});

test("dayRows: per day, readiness's score and the longest long_sleep's total seconds", () => {
  const sleep = [doc(), doc({ id: "s2", total_sleep_duration: 9000, type: "long_sleep" }), doc({ id: "s3", type: "sleep", total_sleep_duration: 30000 }),
    doc({ id: "s4", day: "2026-11-03", total_sleep_duration: 20400 })];
  const readiness = [{ id: "r1", day: "2026-11-04", score: 64, contributors: { hrv_balance: 50 } }, { id: "r2", day: "2026-11-02", score: 88 }, { id: "r3", day: "2026-11-01", score: null }];
  assert.deepEqual(dayRows(sleep, readiness), [
    { day: "2026-11-02", readiness: 88, sleep_s: null },
    { day: "2026-11-03", readiness: null, sleep_s: 20400 },
    { day: "2026-11-04", readiness: 64, sleep_s: 27000 },
  ]);
});

test("sleepTimeRows: only day and the optimal window's offsets, when Oura found one", () => {
  const st = (extra) => ({ id: "t1", day: "2026-11-05", recommendation: "earlier_bedtime", status: "optimal_found", optimal_bedtime: { day_tz: -18000, start_offset: -3600, end_offset: 0 }, ...extra });
  assert.deepEqual(sleepTimeRows([
    st(), st({ day: "2026-11-04", status: "only_recommended_found", optimal_bedtime: { day_tz: -18000, start_offset: 1800, end_offset: 5400 } }),
    st({ day: "2026-11-03", status: "not_enough_nights" }), st({ day: "2026-11-02", optimal_bedtime: null }),
    st({ day: "bad" }), st({ day: "2026-11-01", optimal_bedtime: { start_offset: 99999, end_offset: 0 } }),
  ]), [
    { day: "2026-11-05", start_offset: -3600, end_offset: 0 },
    { day: "2026-11-04", start_offset: 1800, end_offset: 5400 },
  ]);
});
