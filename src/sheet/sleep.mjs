// Lisul's wake time from his Oura ring (docs/sheet-v5.md, "Oura"): his typical wake on weekdays
// and on weekends, today's actual wake, the plan window's start that follows them, and whether
// he woke late enough after a plan was made that the rest of today needs a replan. The rows are
// sleep_nights' ({ oura_id, day, type, bedtime_start, bedtime_end }), which oura-sync keeps from
// Oura's /v2/usercollection/sleep. Kept free of the network so node --test covers it; /plan,
// planner-mcp and oura-sync import it.
import { localNow } from "./logic.mjs";

// How many nights of each kind the medians use, and the fewest they need.
const NIGHTS = 14;
const MIN_NIGHTS = 3;
// Oura's long_sleep is a sleep "long enough (>3h) to automatically contribute to daily scores"
// (cloud.ouraring.com/v2/docs, PublicSleepType); the fallback holds other types to the same.
const LONG_MS = 3 * 3_600_000;
const NOT_SLEEP = new Set(["deleted", "rest"]);

const isoWeekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
export const isWeekend = (day) => [0, 6].includes(isoWeekday(day));
const length = (r) => Date.parse(r.bedtime_end) - Date.parse(r.bedtime_start);

// Each wake day's main sleep, by the local day its bedtime_end falls on: its long_sleep (the
// latest-ending when there are several), or when Oura labelled none that day, its longest sleep
// of over 3 hours. Naps, rest and deleted periods never count. { day, minutes, at } per day.
function wakes(nights, now, tz) {
  const byDay = new Map();
  for (const r of nights ?? []) {
    if (!r?.bedtime_end || Date.parse(r.bedtime_end) > now.getTime() || NOT_SLEEP.has(r.type)) continue;
    const long = r.type === "long_sleep";
    if (!long && !(length(r) > LONG_MS)) continue;
    const { day, minutes } = localNow(new Date(r.bedtime_end), tz);
    const best = byDay.get(day);
    const better = !best || (long && !best.long)
      || (long === best.long && (long ? Date.parse(r.bedtime_end) > Date.parse(best.at) : length(r) > best.len));
    if (better) byDay.set(day, { day, minutes, at: r.bedtime_end, long, len: length(r) });
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

const median = (xs) => {
  if (xs.length < MIN_NIGHTS) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// { weekday, weekend, woke_at, woke_at_iso }: the median local wake (minutes past midnight in
// `tz`) of the newest 14 weekday and 14 weekend wakes up to `now`, each null with fewer than 3;
// and today's actual wake, null until a main sleep ending today has synced.
export function wakeProfile(nights, now, tz) {
  const all = wakes(nights, now, tz);
  const of = (weekend) => median(all.filter((w) => isWeekend(w.day) === weekend).slice(0, NIGHTS).map((w) => w.minutes));
  const today = all.find((w) => w.day === localNow(now, tz).day) ?? null;
  return { weekday: of(false), weekend: of(true), woke_at: today?.minutes ?? null, woke_at_iso: today?.at ?? null };
}

// The plan window's default start, his old fixed 07:00, and its latest.
export const DEFAULT_START = 7 * 60;
const LATEST = 12 * 60;
const AFTER_WAKE = 30;
const quarter = (m) => Math.ceil(m / 15) * 15;

// When the plan window opens on `day` (minutes past midnight in `tz`), from a wakeProfile:
// today's actual wake + 30 minutes on today, else the day's kind's typical wake + 30, else
// `fallback` (07:00); rounded up to the quarter hour and never after 12:00. On today it is never
// before now rounded up, so a replan never plans the past.
export function windowStart(day, now, tz, profile, fallback = DEFAULT_START) {
  const here = localNow(now, tz);
  const today = here.day === day;
  const wake = (today ? profile?.woke_at : null) ?? (isWeekend(day) ? profile?.weekend : profile?.weekday) ?? null;
  const m = Math.min(quarter(wake == null ? fallback : wake + AFTER_WAKE), LATEST);
  return today ? Math.max(m, quarter(Math.floor(here.minutes))) : m;
}

// "HH:MM" for minutes past midnight.
export const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Whether he woke late enough after today's plan was made that the rest of today needs a
// replan: today's actual wake is 45 minutes or more after the window start its newest pending
// or approved revision was planned with. A revision saved without window_from (before Oura) was
// planned from 07:00, or from when its run read the day when that was today. Without a revision
// there is nothing to replan: the morning run reads the wake itself.
const LATE = 45;
export function wokeLate(profile, revision, now, tz) {
  if (profile?.woke_at == null || !revision || !["pending", "approved"].includes(revision.status)) return false;
  if (revision.day !== localNow(now, tz).day) return false;
  let from = revision.window_from ? Number(revision.window_from.slice(0, 2)) * 60 + Number(revision.window_from.slice(3, 5)) : null;
  if (from == null) {
    const read = localNow(new Date(revision.read_at ?? revision.created_at), tz);
    from = read.day === revision.day ? Math.max(DEFAULT_START, quarter(read.minutes)) : DEFAULT_START;
  }
  return profile.woke_at - from >= LATE;
}
