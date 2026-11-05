// Wind-down (docs/sheet-v5.md, "Oura", "Wind-down"): tonight's bedtime, from the target he set in
// Settings (eased in 15 minutes a night from his typical bedtime, or as it is), else from Oura's
// optimal bedtime window (sleep_times), else none. The hour before it is wind-down: no block or
// habit is planned in it, and Telegram says when it starts and when it's bedtime.
//
// A night is the evening of its day. A time from noon to the next noon belongs to it, counted in
// minutes from that day's midnight, so 11:30 pm is 1410 and 00:30 or 02:00 the next morning are
// 1470 and 1560. Kept free of the network so node --test covers it; /plan, planner-mcp and the
// telegram function import it.
import { addDays, formatClock, localNow, zonedIso } from "./logic.mjs";

const NOON = 12 * 60;
// Wind-down is the hour before bedtime; easing moves bedtime this much earlier a night.
export const WIND_DOWN = 60;
const STEP = 15;
// His typical bedtime: the median of this many newest long sleeps, needing at least MIN.
const NIGHTS = 7;
const MIN = 3;

// Clock minutes (0-1439) as night minutes (720-2159).
const evening = (m) => (m < NOON ? m + 1440 : m);
const quarter = (m) => Math.round(m / 15) * 15;
const days = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

// The night an instant belongs to, and its night minutes, in `tz`.
export function nightOf(date, tz) {
  const { day, minutes } = localNow(date, tz);
  return minutes < NOON ? { night: addDays(day, -1), minutes: minutes + 1440 } : { night: day, minutes };
}

// The instant of `minutes` on `night`, as an ISO string (zonedIso handles DST).
export const nightAt = (night, minutes, tz) => zonedIso(addDays(night, Math.floor(minutes / 1440)), minutes % 1440, tz);

// The median night minutes of the newest 7 long_sleep starts, of nights before `before` when it is
// given; null with fewer than 3.
export function typicalBedtime(sleep, tz, before = null) {
  const starts = (sleep ?? []).filter((r) => r?.type === "long_sleep" && r.bedtime_start)
    .map((r) => nightOf(new Date(r.bedtime_start), tz))
    .filter((s) => before == null || s.night < before)
    .sort((a, b) => (a.night < b.night ? 1 : -1)).slice(0, NIGHTS).map((s) => s.minutes).sort((a, b) => a - b);
  if (starts.length < MIN) return null;
  const mid = starts.length >> 1;
  return starts.length % 2 ? starts[mid] : Math.round((starts[mid - 1] + starts[mid]) / 2);
}

// "HH:MM[:SS]" as night minutes, or null.
const targetOf = (t) => (typeof t === "string" && /^\d{2}:\d{2}/.test(t) ? evening(Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))) : null);

// Oura's optimal bedtime window for `night`: the newest sleep_times row up to the next day, its
// offsets from that day's midnight read as clock times (Oura gives evening ones as negative
// offsets), as night minutes, with its recommendation; or null.
const clockOf = (secs) => evening((((Math.round(secs / 60)) % 1440) + 1440) % 1440);
export function ouraWindow(night, sleepTimes) {
  const row = (sleepTimes ?? []).filter((r) => r?.day && r.day <= addDays(night, 1) && Number.isFinite(r.start_offset))
    .sort((a, b) => (a.day < b.day ? 1 : -1))[0];
  if (!row) return null;
  const start = clockOf(row.start_offset);
  const end = Number.isFinite(row.end_offset) ? clockOf(row.end_offset) : start;
  return { start, end: end < start ? start : end, hint: row.hint ?? null };
}
const ouraBedtime = (night, sleepTimes) => ouraWindow(night, sleepTimes)?.start ?? null;

// Oura's recommendation in words.
const HINT_WORDS = {
  earlier_bedtime: "earlier bedtime", later_bedtime: "later bedtime", improve_efficiency: "improve efficiency",
  earlier_wake_up_time: "wake earlier", later_wake_up_time: "wake later", follow_optimal_bedtime: "keep to it",
};
// "Oura: 12:15–12:45 am, earlier bedtime", or null without a window.
export function ouraWindowLine(w) {
  if (!w) return null;
  const [a, b] = [clock(w.start), clock(w.end)];
  const span = a === b ? a : a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
  return `Oura: ${span}${HINT_WORDS[w.hint] ? `, ${HINT_WORDS[w.hint]}` : ""}`;
}

// Tonight's bedtime for `night`: { minutes, wind_down, source, target } in night minutes, source
// "target", "easing" (still stepping toward the target) or "oura"; or null. settings holds
// wind_down_on, bedtime_target ("HH:MM:SS" or null), bedtime_ease and bedtime_set_on (the night
// the target was set, which fixes where easing starts).
export function bedtimeFor(night, { settings, sleep, sleepTimes, tz }) {
  if (!settings || settings.wind_down_on === false) return null;
  const target = targetOf(settings.bedtime_target);
  const out = (minutes, source) => ({ minutes, wind_down: minutes - WIND_DOWN, source, target });
  if (target == null) {
    const m = ouraBedtime(night, sleepTimes);
    return m == null ? null : out(m, "oura");
  }
  if (settings.bedtime_ease === false) return out(target, "target");
  const setOn = settings.bedtime_set_on ?? night;
  const typical = typicalBedtime(sleep, tz, setOn);
  if (typical == null) return out(target, "target");
  const m = Math.max(target, quarter(typical) - STEP * (Math.max(0, days(setOn, night)) + 1));
  return out(m, m > target ? "easing" : "target");
}

const clock = (m) => formatClock(m % 1440);

// Settings' line: "Tonight: bed 2:15 am, easing 15 min earlier a night toward 12:30 am".
export function bedtimeStatus(b, settings) {
  if (!b) {
    if (settings?.wind_down_on === false) return "Wind-down is off";
    if (!settings?.bedtime_target) return "No bedtime set, and Oura hasn't suggested one yet";
    return "No bedtime tonight";
  }
  const why = b.source === "easing" ? `easing ${STEP} min earlier a night toward ${clock(b.target)}`
    : b.source === "oura" ? "Oura's suggested bedtime" : `wind down from ${clock(b.wind_down)}`;
  return `Tonight: bed ${clock(b.minutes)}, ${why}`;
}

// The day header's marker: "Wind down 11:30 pm · Bed 12:30 am", and Oura's window when it has
// one and it isn't already what set bedtime ("· Oura: 12:15–12:45 am, earlier bedtime").
export const bedtimeMarker = (b, w = null) => [`Wind down ${clock(b.wind_down)}`, `Bed ${clock(b.minutes)}`, b.source === "oura" && !w?.hint ? null : ouraWindowLine(w)].filter(Boolean).join(" · ");

// Today's night: the evening of today, or before noon the night still going.
export const tonight = (now, tz) => nightOf(now, tz).night;
