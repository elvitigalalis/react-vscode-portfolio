// The Sheet's own health (src/sheet/health.mjs; research/plan-reliability.md R1, R7, R8, R9): what
// counts as broken, the brief's "Sheet:" line, and the one alert per incident the telegram tick
// sends (nudges.mjs). Monday 2026-10-26 in New York (EDT, UTC-4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { health, healthLine, hookAction, nextTold } from "../src/sheet/health.mjs";
import { whatToSend } from "../src/sheet/nudges.mjs";

const tz = "America/New_York";
const now = new Date("2026-10-26T14:00:00Z"); // 10:00 am
const feed = (source, fetched_at, extra = {}) => ({ source, fetched_at, ok: true, error: null, items: 1, ...extra });
const fresh = [feed("gmail", "2026-10-26T13:57:00Z"), feed("freebusy", "2026-10-26T13:50:00Z"), feed("brightspace", "2026-10-26T13:20:00Z")];
const keys = (h) => h.issues.map((i) => i.key);

// ---------------------------------------------------------------- health

test("health: fresh feeds, no account errors and a working webhook are all green", () => {
  const h = health({ tz, feeds: fresh, hook: { url: "https://x.supabase.co/functions/v1/telegram", pending_update_count: 0 } }, now);
  assert.deepEqual(h, { green: true, issues: [] });
  assert.equal(healthLine(h), "Sheet: all green.");
});

test("health: a failed feed is an issue, with where to look", () => {
  const h = health({ tz, feeds: [...fresh.slice(1), feed("gmail", "2026-10-26T13:57:00Z", { ok: false, error: "401" })] }, now);
  assert.deepEqual(h.issues, [{ key: "feed:gmail", words: "Gmail sync failing", fix: "see Settings" }]);
  assert.equal(healthLine(h), "Sheet: Gmail sync failing (see Settings).");
});

test("health: a feed that stopped running is stale after 3 of its intervals (30 min at least)", () => {
  const h = health({ tz, feeds: [feed("gmail", "2026-10-26T13:25:00Z"), feed("freebusy", "2026-10-26T13:31:00Z"), feed("brightspace", "2026-10-26T10:50:00Z")] }, now);
  assert.deepEqual(h.issues, [
    { key: "feed:gmail", words: "Gmail not synced since 9:25 am", fix: "see Settings" },
    { key: "feed:brightspace", words: "Brightspace not synced since 6:50 am", fix: "see Settings" },
  ]);
});

test("health: a feed not set up (ok null) is not an issue", () => {
  const h = health({ tz, feeds: [feed("handshake", "2026-10-20T10:00:00Z", { ok: null, error: "not connected" })] }, now);
  assert.equal(h.green, true);
});

test("health: an account that needs reconnecting replaces its failing feed", () => {
  const h = health({
    tz,
    feeds: [feed("gmail", "2026-10-26T13:57:00Z", { ok: false }), feed("freebusy", "2026-10-26T13:50:00Z", { ok: false })],
    mail: [{ email: "me@x.edu", label: "SBU", last_error: "invalid_grant" }, { email: "me@gmail.com", label: null, last_error: null }],
    calendar: { last_error: "invalid_grant" },
    oura: { last_error: "refused" },
  }, now);
  assert.deepEqual(h.issues, [
    { key: "mail:me@x.edu", words: "Gmail (SBU) needs reconnecting", fix: "reconnect in Settings" },
    { key: "calendar", words: "Google Calendar needs reconnecting", fix: "reconnect in Settings" },
    { key: "oura", words: "Oura needs reconnecting", fix: "reconnect in Settings" },
  ]);
});

test("health: the webhook missing, or Telegram failing to deliver taps, is an issue", () => {
  assert.deepEqual(keys(health({ tz, hook: { url: "", pending_update_count: 0 } }, now)), ["webhook"]);
  assert.deepEqual(keys(health({ tz, hook: { url: "u", pending_update_count: 14 } }, now)), ["webhook"]);
  assert.deepEqual(keys(health({ tz, hook: { url: "u", pending_update_count: 1, last_error_date: now.getTime() / 1000 - 600 } }, now)), ["webhook"]);
  assert.deepEqual(keys(health({ tz, hook: { url: "u", pending_update_count: 0, last_error_date: now.getTime() / 1000 - 7200 } }, now)), []);
  assert.equal(health({ tz, hook: { url: "" } }, now).issues[0].words, "Telegram taps aren't reaching The Sheet");
});

test("health: today's newest replan failing or rate limited is an issue; one that started since clears it", () => {
  const failed = { at: "2026-10-26T13:00:00Z", result: "failed" };
  assert.deepEqual(health({ tz, replans: [failed] }, now).issues, [{ key: "replan", words: "a replan didn't start", fix: null }]);
  assert.deepEqual(health({ tz, replans: [{ at: "2026-10-26T13:00:00Z", result: "rate_limited" }] }, now).issues[0].words, "Claude is rate limited");
  assert.equal(health({ tz, replans: [failed, { at: "2026-10-26T13:30:00Z", result: "started" }] }, now).green, true);
});

test("health: the morning plan's retry failing says so", () => {
  const h = health({ tz, replans: [{ at: "2026-10-26T10:40:00Z", result: "failed", reasons: ["morning_retry"] }] }, now);
  assert.deepEqual(h.issues, [{ key: "replan", words: "no morning plan, and the retry didn't start", fix: 'say "plan my day" to Claude' }]);
  assert.equal(health({ tz, planned: true, replans: [{ at: "2026-10-26T10:40:00Z", result: "failed", reasons: ["morning_retry"] }] }, now).green, true);
});

test("health: replans paused at the daily cap with a weighty change waiting says so", () => {
  const h = health({ tz, replanHold: { hold: "daily_cap", weighty: true, used: 8 } }, now);
  assert.deepEqual(h.issues, [{ key: "paused:2026-10-26", words: "replans paused for today (8 used)", fix: "adjust in /plan" }]);
  assert.equal(health({ tz, replanHold: { hold: "daily_cap", weighty: false, used: 8 } }, now).green, true);
});

test("health: a message to Claude whose retry failed too is an issue", () => {
  const h = health({ tz, unsent: [{ id: "m1" }] }, now);
  assert.deepEqual(h.issues, [{ key: "message:m1", words: "a message to Claude didn't go through", fix: "send it again" }]);
  assert.deepEqual(health({ tz, unsent: [{ id: "m1" }, { id: "m2" }] }, now).issues,
    [{ key: "message:m1", words: "2 messages to Claude didn't go through", fix: "send them again" }]);
});

// ---------------------------------------------------------------- hookAction

test("hookAction: a missing webhook is set again; one without texts is widened; a good one is left", () => {
  const url = "https://ref.supabase.co/functions/v1/telegram";
  assert.equal(hookAction({ url: "" }, url), "set");
  assert.equal(hookAction({ url, allowed_updates: ["callback_query"] }, url), "widen");
  assert.equal(hookAction({ url }, url), null);                                        // the default includes message
  assert.equal(hookAction({ url, allowed_updates: ["callback_query", "message"] }, url), null);
  assert.equal(hookAction({ url: "" }, null), null);                                    // nowhere to point it
});

// ---------------------------------------------------------------- nextTold

test("nextTold: what was told stays told while open, and forgets an issue once it clears", () => {
  const issues = [{ key: "feed:gmail" }, { key: "webhook" }];
  assert.deepEqual(nextTold(["feed:gmail", "oura"], issues, ["webhook"]), ["feed:gmail", "webhook"]);
  assert.deepEqual(nextTold([], [], []), []);
});

// ---------------------------------------------------------------- alerts (nudges.mjs)

const settings = { time_zone: tz, telegram_chat_id: 42, nudges_on: true, health_told: [] };
const day = "2026-10-26";
const briefSent = { block_id: null, kind: "brief", day, send_at: "2026-10-26T12:00:00.000Z", sent_at: "2026-10-26T12:00:01Z" };
const snap = (extra = {}) => ({ settings, day: null, tasks: [], blocks: [], log: [briefSent], ...extra });
const failedFeed = health({ tz, feeds: [feed("gmail", "2026-10-26T13:57:00Z", { ok: false })] }, now);

test("brief: the Sheet line folds when all green, and stays in view with an issue", () => {
  const green = whatToSend({ ...snap({ log: [] }), health: { green: true, issues: [] } }, new Date("2026-10-26T12:00:00Z"))[0];
  assert.equal(green.text, 'Nothing on today.\nSheet: all green.');
  assert.deepEqual(green.entities, [{ type: "expandable_blockquote", offset: 18, length: 17 }]);
  const sick = whatToSend({ ...snap({ log: [] }), health: failedFeed }, new Date("2026-10-26T12:00:00Z"))[0];
  assert.equal(sick.text, "Nothing on today.\nSheet: Gmail sync failing (see Settings).");
  assert.deepEqual(sick.health, ["feed:gmail"]);
});

test("alert: a new issue after the brief sends one health message, at this minute", () => {
  assert.deepEqual(whatToSend(snap({ health: failedFeed }), now), [{
    kind: "health", block_id: null, day, send_at: "2026-10-26T14:00:00.000Z",
    text: "Sheet: Gmail sync failing (see Settings).",
    buttons: [{ text: "Open /plan", url: "https://www.lisul-elvi.com/plan/" }],
    health: ["feed:gmail"],
  }]);
});

test("alert: exactly one per incident: none once told, none again while it lasts", () => {
  const told = { ...settings, health_told: ["feed:gmail"] };
  assert.deepEqual(whatToSend(snap({ settings: told, health: failedFeed }), now), []);
  assert.deepEqual(whatToSend(snap({ settings: told, health: failedFeed }), new Date("2026-10-26T20:00:00Z")), []);
});

test("alert: none before the brief went out, after 11 pm or before 8 am", () => {
  assert.ok(!whatToSend(snap({ log: [], health: failedFeed }), new Date("2026-10-26T12:00:00Z")).some((m) => m.kind === "health"));
  assert.deepEqual(whatToSend(snap({ health: failedFeed }), new Date("2026-10-27T03:30:00Z")), []); // 11:30 pm
  assert.deepEqual(whatToSend(snap({ health: failedFeed }), new Date("2026-10-26T11:30:00Z")), []); // 7:30 am
});

test("alert: at most two a day, beside the nudge budget", () => {
  const sentHealth = (m) => ({ block_id: null, kind: "health", day, send_at: `2026-10-26T1${m}:00:00.000Z`, sent_at: `2026-10-26T1${m}:00:01Z` });
  assert.deepEqual(whatToSend(snap({ log: [briefSent, sentHealth(3), sentHealth(4)], health: failedFeed }), new Date("2026-10-26T15:00:00Z")), []);
  // A start nudge still goes: health messages take no budget slot.
  const out = whatToSend(snap({
    health: failedFeed,
    tasks: [{ id: "t1", title: "OS homework", day, done: false, due: null }],
    blocks: [{ id: "b1", task_id: "t1", starts_at: "2026-10-26T14:00:00Z", ends_at: "2026-10-26T15:00:00Z", proposed: false }],
  }), now);
  assert.deepEqual(out.map((m) => m.kind), ["start", "health"]);
});

test("health: a failed replan backing off says when the next try is, under the same key", () => {
  const failed = { at: "2026-10-26T13:50:00Z", result: "failed" };
  const h = health({ tz, replans: [failed], replanHold: { hold: "fire_failed", until: "2026-10-26T14:05:00.000Z" } }, now);
  assert.deepEqual(h.issues, [{ key: "replan", words: "a replan didn't start, next try after 10:05 am", fix: null }]);
});
