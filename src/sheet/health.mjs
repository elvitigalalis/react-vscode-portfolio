// The Sheet's own health (docs/sheet-nudges.md, "Health"; research/plan-reliability.md R1): what
// is broken right now, worked out from rows the telegram tick reads, for one "Sheet:" line in the
// brief and one Telegram alert per incident (nudges.mjs, healthMessage). Every failure surface
// before this was in /plan only (the Feed failed chip, Settings), and Telegram is where Lisul
// looks each day. Alerts follow the symptom, not the cause, and only when it is actionable
// (Google SRE book, "Monitoring Distributed Systems": sre.google/sre-book/monitoring-distributed-systems/).
// Kept free of the network so node --test covers it.
import { formatClock, localNow, weekdayName } from "./logic.mjs";

// Feed names as Settings shows them (feed-status.mjs), with the two it doesn't list.
const NAMES = { brightspace: "Brightspace", campus: "Campus events", weather: "Weather", freebusy: "Calendar busy times", handshake: "Handshake", academic: "Academic calendar", github: "GitHub", jira: "Jira", slack: "Slack", gmail: "Gmail", oura: "Oura" };
// Each source's cron interval in minutes (supabase/schema.sql's cron.schedule lines): busy every
// 10, mail every 5, Oura every 10, the rest hourly. A feed is stale after 3 intervals, and never
// before 30 minutes, so one slow run is not an incident.
const EVERY = { freebusy: 10, gmail: 5, oura: 10 };
const staleAfter = (source) => Math.max(3 * (EVERY[source] ?? 60), 30) * 60_000;
// A feed whose account has its own issue is that issue, said once.
const ACCOUNT_OF = { gmail: "mail", freebusy: "calendar", oura: "oura" };
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
//   hook        getWebhookInfo's result { url, pending_update_count, last_error_date? }
//   replans     today's replans rows { at, result }
//   replanHold  { hold, weighty, used } from the replan tick: why it didn't fire
//   unsent      messages to Claude whose one re-fire failed too ({ id })
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
  if (newest?.result === "failed") add("replan", "a replan didn't start");
  if (newest?.result === "rate_limited") add("replan", "Claude is rate limited");
  const hold = input.replanHold;
  if (hold?.hold === "daily_cap" && hold.weighty) add(`paused:${localNow(now, tz).day}`, `replans paused for today (${hold.used} used)`, "adjust in /plan");
  for (const m of input.unsent ?? []) add(`message:${m.id}`, "a message to Claude didn't go through", "send it again");
  return { green: !issues.length, issues };
}

// "Sheet: all green." or "Sheet: Gmail sync failing (see Settings); a replan didn't start."
export const healthLine = (h, issues = h.issues) => (h.green ? "Sheet: all green."
  : `Sheet: ${issues.map((i) => (i.fix ? `${i.words} (${i.fix})` : i.words)).join("; ")}.`);

// settings.health_told after a tick: the keys told before or just now (sentKeys) that are still
// open. A key that cleared is forgotten, so if it comes back it is a new incident, told again.
export function nextTold(told, issues, sentKeys) {
  const open = new Set(issues.map((i) => i.key));
  return [...new Set([...(told ?? []), ...sentKeys])].filter((k) => open.has(k));
}
