// The Sheet's own health (docs/sheet-nudges.md, "Health"; research/plan-reliability.md R1): what
// is broken right now, worked out from rows the telegram tick reads, for one "Sheet:" line in the
// brief and one Telegram alert per incident (nudges.mjs, healthMessage). Every failure surface
// before this was in /plan only (the Feed failed chip, Settings), and Telegram is where Lisul
// looks each day. Alerts follow the symptom, not the cause, and only when it is actionable
// (Google SRE book, "Monitoring Distributed Systems": sre.google/sre-book/monitoring-distributed-systems/).
// Kept free of the network so node --test covers it.
import { formatClock, localNow, weekdayName } from "./logic.mjs";

// Feed names as Settings shows them (feed-status.mjs), with the two it doesn't list.
const NAMES = { brightspace: "Brightspace", campus: "Campus events", weather: "Weather", freebusy: "Calendar busy times", handshake: "Handshake", academic: "Academic calendar", github: "GitHub", jira: "Jira", slack: "Slack", gmail: "Gmail", oura: "Oura", hevy: "Hevy" };
// Each source's cron interval in minutes (supabase/schema.sql's cron.schedule lines): busy every
// 10, mail every 5, Oura every 10, the rest hourly. A feed is stale after 3 intervals, and never
// before 30 minutes, so one slow run is not an incident.
const EVERY = { freebusy: 10, gmail: 5, oura: 10 };
const staleAfter = (source) => Math.max(3 * (EVERY[source] ?? 60), 30) * 60_000;
// A feed whose account has its own issue is that issue, said once.
// Hevy's connected account owns its feed outright: hevy_account says both a refused key and a sync
// that stopped (synced_at), so its feed_state row adds nothing while it is connected.
const ACCOUNT_OF = { gmail: "mail", freebusy: "calendar", oura: "oura", hevy: "hevy" };
// Hevy syncs every 15 minutes; a connected account not synced for this long is broken. Longer than
// three intervals, so a few failed polls in a row (Hevy's 429s and 5xx) are not an incident.
const HEVY_STALE = 2 * 60 * 60_000;
// Telegram's webhook: updates waiting past this, or a delivery error this recent, means taps
// aren't arriving (getWebhookInfo's pending_update_count and last_error_date, Unix seconds:
// core.telegram.org/bots/api#webhookinfo).
const HOOK_PENDING = 10;
const HOOK_ERROR_RECENT = 30 * 60_000;

const RECONNECT = "reconnect in Settings";

// "9:25 am" today, "Sun 9:25 am" before.
function when(iso, now, tz) {
  const t = localNow(new Date(iso), tz), today = localNow(now, tz).day;
  return `${t.day === today ? "" : `${weekdayName(t.day)} `}${formatClock(t.minutes)}`;
}

// input (every part optional; a missing part is no issue):
//   tz          the owner's time zone
//   feeds       feed_state rows { source, fetched_at, ok, last_ok_at? }
//   mail        mail_accounts rows { email, label, last_error }
//   calendar    the calendar_account row { last_error }, or null
//   oura        the oura_account row { last_error }, or null
//   hevy        the hevy_account row { last_error, synced_at, connected_at }, or null (not connected)
//   hook        getWebhookInfo's result { url, pending_update_count, last_error_date? }
//   replans     today's replans rows { at, result, reasons }
//   planned     whether today has a plan revision yet
//   replanHold  { hold, weighty, used } or { hold: "fire_failed", until } from the replan tick: why it didn't fire
//   unsent      pending messages to Claude whose one re-fire failed too ({ id }), oldest first
//   expiring    tokens and grants with a known end ({ key, label, at, fix }: expiries)
//   checks      the live check's rows ({ name, status: ok|warn|fail, detail }: sheet_checks())
// Returns { green, issues: [{ key, words, fix }] }. A key names one incident: the same key while
// it lasts, so it is told once (nextTold).
export function health(input, now) {
  const { tz } = input;
  const issues = [];
  const add = (key, words, fix = null) => issues.push({ key, words, fix });
  const accounts = new Set();
  for (const m of input.mail ?? []) if (m.last_error) { accounts.add("mail"); add(`mail:${m.email}`, `Gmail${m.label ? ` (${m.label})` : ""} needs reconnecting`, RECONNECT); }
  if (input.calendar?.last_error) { accounts.add("calendar"); add("calendar", "Google Calendar needs reconnecting", RECONNECT); }
  if (input.oura?.last_error) { accounts.add("oura"); add("oura", "Oura needs reconnecting", RECONNECT); }
  const hevy = input.hevy;
  if (hevy) {
    accounts.add("hevy");
    const last = hevy.synced_at ?? hevy.connected_at;
    // hevy-sync's two errors (hevy_broken): 'key refused' and 'not pro' (the API is Pro only).
    if (hevy.last_error === "not pro") add("hevy", "Hevy's API needs Hevy Pro", "renew Pro, then paste the key again in Settings");
    else if (hevy.last_error) add("hevy", "Hevy needs a new key", "paste one in Settings");
    else if (last && now.getTime() - Date.parse(last) > HEVY_STALE) add("hevy:stale", hevy.synced_at ? `Hevy not synced since ${when(hevy.synced_at, now, tz)}` : "Hevy hasn't synced yet", "see Settings");
  }
  const feeds = [];
  for (const f of input.feeds ?? []) {
    // ok null: not set up, or nothing to read yet; that isn't failing.
    if (f.ok == null || !f.fetched_at || accounts.has(ACCOUNT_OF[f.source])) continue;
    const name = NAMES[f.source] ?? f.source;
    if (f.ok === false) feeds.push([`feed:${f.source}`, `${name} sync failing`]);
    else if (now.getTime() - Date.parse(f.fetched_at) > staleAfter(f.source)) feeds.push([`feed:${f.source}`, `${name} not synced since ${when(f.last_ok_at ?? f.fetched_at, now, tz)}`]);
  }
  for (const [key, words] of feeds) add(key, words, "see Settings");
  const hook = input.hook;
  if (hook && (!hook.url || (hook.pending_update_count ?? 0) > HOOK_PENDING
    || (hook.last_error_date && now.getTime() - hook.last_error_date * 1000 < HOOK_ERROR_RECENT))) {
    add("webhook", "Telegram taps aren't reaching The Sheet");
  }
  const newest = [...(input.replans ?? [])].filter((r) => r.result).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  // The morning plan's one retry (replan.mjs, shouldRetryMorning) failing matters until a plan
  // for today comes in some other way (planned: today has a revision).
  const retry = (newest?.reasons ?? []).includes("morning_retry");
  if (newest?.result === "failed" && retry) { if (!input.planned) add("replan", "no morning plan, and the retry didn't start", 'say "plan my day" to Claude'); }
  else if (newest?.result === "failed") {
    // Backing off (replan.mjs, failedUntil): when the tick tries again. Same key, so told once.
    const until = input.replanHold?.hold === "fire_failed" && input.replanHold.until;
    add("replan", `a replan didn't start${until ? `, next try after ${when(until, now, tz)}` : ""}`);
  }
  if (newest?.result === "rate_limited") add("replan", "Claude is rate limited");
  const hold = input.replanHold;
  if (hold?.hold === "daily_cap" && hold.weighty) add(`paused:${localNow(now, tz).day}`, `replans paused for today (${hold.used} used)`, "adjust in /plan");
  // One incident for the lot, named by the first.
  const unsent = input.unsent ?? [];
  if (unsent.length === 1) add(`message:${unsent[0].id}`, "a message to Claude didn't go through", "send it again");
  if (unsent.length > 1) add(`message:${unsent[0].id}`, `${unsent.length} messages to Claude didn't go through`, "send them again");
  // R5: a token or grant ending within EXPIRY_WARN, keyed by its date, so a renewed one (a new
  // date) is a new incident. The brief repeats it each morning while it is open.
  for (const x of input.expiring ?? []) {
    const left = Date.parse(x.at) - now.getTime();
    if (left > EXPIRY_WARN) continue;
    add(`expiry:${x.key}:${localNow(new Date(x.at), tz).day}`, `${x.label} ${left > 0 ? "expires" : "expired"} ${dateWords(x.at, tz)}`, x.fix ?? "renew it");
  }
  // R10: the live check (sheet_checks(), in the database, so it runs with Lisul's Mac off).
  for (const c of input.checks ?? []) if (c.status === "fail") add(`check:${c.name}`, `live check failed: ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  return { green: !issues.length, issues, ...(input.checks?.length ? { checked: true } : {}) };
}

// --- Expiries (research/plan-reliability.md R5) -------------------------------------------------
// The credentials table holds dates only, never a secret: { name, label, expires_at, fix }. A row
// whose expires_at is null records that the date isn't knowable (the Jira token: Atlassian's API
// doesn't report it) and raises nothing. GitHub's is filled in by work-sync from the
// GitHub-Authentication-Token-Expiration header (github.blog/changelog/2021-07-26-expiration-
// options-for-personal-access-tokens/). The row "google_testing" stands for "the Google OAuth app
// may still be in Testing", where a refresh token ends 7 days after consent
// (developers.google.com/identity/protocols/oauth2, "Refresh token expiration"): each Gmail
// account and the calendar then ends 7 days after its connected_at. Deleting the row (once the
// app is In production) ends those reminders. Whether the app is in Testing can't be read from
// here, so the words say "if".
const EXPIRY_WARN = 14 * 86_400_000;
const TESTING_DAYS = 7;
const GOOGLE_FIX = "if the Google app is still in Testing, publish it In production, then reconnect";
export function expiries({ credentials, mail, calendar }) {
  const out = [];
  const plus7 = (iso) => new Date(Date.parse(iso) + TESTING_DAYS * 86_400_000).toISOString();
  for (const c of credentials ?? []) {
    if (c.name === "google_testing") {
      for (const m of mail ?? []) if (m.connected_at) out.push({ key: `google:${m.email}`, label: `Gmail sign-in (${m.label ?? m.email})`, at: plus7(m.connected_at), fix: GOOGLE_FIX });
      if (calendar?.connected_at) out.push({ key: "google:calendar", label: "Calendar sign-in", at: plus7(calendar.connected_at), fix: GOOGLE_FIX });
    } else if (c.expires_at) {
      out.push({ key: c.name, label: c.label ?? c.name, at: c.expires_at, fix: c.fix ?? null });
    }
  }
  return out;
}

// GitHub-Authentication-Token-Expiration ("2026-12-01 00:00:00 UTC", or with an offset such as
// "-0800"), sent on API calls made with an expiring personal access token
// (github.blog/changelog/2021-07-26-expiration-options-for-personal-access-tokens/), as an ISO
// instant; null with no header (a token with no expiry) or one that doesn't read.
export function githubExpiry(header) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(String(header ?? "").trim());
  if (!m) return null;
  const zone = m[3] === "UTC" ? "Z" : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// "Thu Nov 19", in his zone.
const dateWords = (iso, tz) => new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).replace(",", "");

// "Sheet: all green." or "Sheet: Gmail sync failing (see Settings); a replan didn't start."
export const healthLine = (h, issues = h.issues) => (h.green ? (h.checked ? "Sheet: all green (live check passed)." : "Sheet: all green.")
  : `Sheet: ${issues.map((i) => (i.fix ? `${i.words} (${i.fix})` : i.words)).join("; ")}.`);

// What the minute tick does about the bot's webhook, from getWebhookInfo's result
// (core.telegram.org/bots/api#getwebhookinfo: url "may be empty if webhook is not set up";
// allowed_updates left out means the default, which includes message): "set" it again at `url`
// (the telegram function's own address) when it is gone, "widen" it to taps and texts when it
// asks for less, or null. research/plan-reliability.md R8: before this, a missing webhook was
// only reported, and taps and texts stopped with no sign.
export const HOOK_UPDATES = ["callback_query", "message"];
export function hookAction(info, url) {
  if (!info.url) return url ? "set" : null;
  const allowed = info.allowed_updates;
  return allowed && !HOOK_UPDATES.every((u) => allowed.includes(u)) ? "widen" : null;
}

// settings.health_told after a tick: the keys told before or just now (sentKeys) that are still
// open. A key that cleared is forgotten, so if it comes back it is a new incident, told again.
export function nextTold(told, issues, sentKeys) {
  const open = new Set(issues.map((i) => i.key));
  return [...new Set([...(told ?? []), ...sentKeys])].filter((k) => open.has(k));
}
