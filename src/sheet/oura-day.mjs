// A day's Oura numbers on /plan (docs/sheet-v5.md, "Oura", "Day numbers"): the quiet chip line in
// each past day's and today's header, and the full set its dialog shows, each with a 7-day
// sparkline. Only Lisul sees them: never /now, never Claude (docs/adr/0005). Kept free of the DOM
// so node --test covers it; planner.mjs draws the chips and oura-popover.mjs the dialog.
import { addDays, dayLabel, formatClock, localNow } from "./logic.mjs";
import { nightOf } from "./bedtime.mjs";

// Oura's score bands (ouraring.com/blog/sleep-score, /readiness-score): 85+ optimal, 70-84 good,
// under 70 pay attention.
export function band(score) {
  if (score == null) return null;
  return score >= 85 ? { key: "optimal", word: "optimal" } : score >= 70 ? { key: "good", word: "good" } : { key: "attention", word: "pay attention" };
}

// Seconds as "7h 40m", "45m".
export function hm(s) {
  if (s == null) return null;
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

const score = (key, icon, name, v) => {
  const b = band(v);
  return { key, icon, text: String(v), band: b.key, label: `${name} ${v}, ${b.word}` };
};

// The header's chips for a sleep_days row: sleep score, readiness and total sleep, each left out
// when Oura gave none. [] without a row.
export function dayChips(row) {
  if (!row) return [];
  return [
    row.sleep_score != null && score("sleep", "moon", "Sleep score", row.sleep_score),
    row.readiness != null && score("readiness", "zap", "Readiness", row.readiness),
    row.sleep_s != null && { key: "total", icon: null, text: hm(row.sleep_s), band: null, label: `Total sleep ${hm(row.sleep_s)}` },
  ].filter(Boolean);
}

// The chip button's accessible name: "Oura for Wed Nov 4: Sleep score 82, good; …".
export const chipsLabel = (chips, when) => `Oura for ${when}: ${chips.map((c) => c.label).join("; ")}. Open details`;

// Bed → wake for a wake day: its main sleep (the longest long_sleep whose end falls on the day),
// "1:10 am → 9:40 am", or null.
export function bedWake(nights, day, tz) {
  const main = (nights ?? []).filter((r) => r.type === "long_sleep" && localNow(new Date(r.bedtime_end), tz).day === day)
    .sort((a, b) => (Date.parse(b.bedtime_end) - Date.parse(b.bedtime_start)) - (Date.parse(a.bedtime_end) - Date.parse(a.bedtime_start)))[0];
  if (!main) return null;
  const t = (iso) => formatClock(localNow(new Date(iso), tz).minutes);
  return `${t(main.bedtime_start)} → ${t(main.bedtime_end)}`;
}

const signed = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} °C`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const ROWS = [
  ["sleep_score", "Sleep", (v) => String(v), true],
  ["readiness", "Readiness", (v) => String(v), true],
  ["sleep_s", "Total", hm],
  ["efficiency", "Efficiency", (v) => `${v}%`],
  ["deep_s", "Deep", hm],
  ["rem_s", "REM", hm],
  ["bed", "Bedtime", null],
  ["rhr_low", "Resting HR", (v) => `${v} bpm`],
  ["hrv_avg", "HRV", (v) => `${v} ms`],
  ["temp_dev", "Temperature", signed],
  ["activity_score", "Activity", (v) => String(v), true],
  ["steps", "Steps", (v) => v.toLocaleString("en-US")],
  ["stress", "Stress", cap],
];

// The dialog's rows for `day`: { key, label, value, band, aria, spark } each, value "–" when Oura
// gave none. spark is the 7 days to `day`, oldest first (null where none), for the numeric ones.
// rows are sleep_days rows, nights sleep_nights rows.
export function dayMetrics(day, rows, nights, tz) {
  const byDay = new Map((rows ?? []).map((r) => [r.day, r]));
  const row = byDay.get(day) ?? {};
  const week = Array.from({ length: 7 }, (_, i) => byDay.get(addDays(day, i - 6)) ?? null);
  return ROWS.map(([key, label, fmt, scored]) => {
    if (key === "bed") {
      const v = bedWake(nights, day, tz);
      return { key, label, value: v ?? "–", band: null, aria: `${label} ${v ?? "none"}`, spark: null };
    }
    const v = row[key] ?? null;
    const b = scored ? band(v) : null;
    const value = v == null ? "–" : fmt(v);
    const numeric = key !== "stress";
    return {
      key, label, value, band: b?.key ?? null,
      aria: v == null ? `${label}: none` : `${label} ${value}${b ? `, ${b.word}` : ""}`,
      spark: numeric ? week.map((r) => (r?.[key] ?? null)) : null,
    };
  });
}

// An SVG path for a sparkline of `values` (nulls break the line) in a w × h box, 1 unit of
// padding; "" with fewer than 2 numbers. Higher values sit higher.
export function sparkPath(values, w = 48, h = 14) {
  const nums = values.filter((v) => v != null);
  if (nums.length < 2) return "";
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const x = (i) => Math.round((i * (w - 2)) / (values.length - 1) * 10) / 10 + 1;
  const y = (v) => (hi === lo ? h / 2 : Math.round((1 + ((hi - v) * (h - 2)) / (hi - lo)) * 10) / 10);
  let d = "", pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i)} ${y(v)}`;
    pen = true;
  });
  return d;
}

// --- Late naps and the week's sleep consistency ---------------------------------------------

const span = (a, b) => {
  const [x, y] = [formatClock(a % 1440), formatClock(b % 1440)];
  return x.slice(-2) === y.slice(-2) ? `${x.slice(0, -3)}–${y}` : `${x}–${y}`;
};

// Today's late nap: Oura's late_nap ("ended after sleep day change (6 pm)") ending today after
// 6 pm, as "late nap 5:10–6:20 pm"; the latest if several, or null.
export function lateNap(nights, day, tz) {
  const nap = (nights ?? []).filter((r) => r.type === "late_nap")
    .map((r) => ({ a: localNow(new Date(r.bedtime_start), tz), b: localNow(new Date(r.bedtime_end), tz) }))
    .filter(({ b }) => b.day === day && b.minutes >= 18 * 60)
    .sort((x, y) => y.b.minutes - x.b.minutes)[0];
  return nap ? `late nap ${span(nap.a.day === day ? nap.a.minutes : 0, nap.b.minutes)}` : null;
}

// The 7 nights to `day`'s morning: per wake day, its main sleep (longest long_sleep ending that
// day) as { day, label, bed, wake } in night minutes of the night before (bedtime.mjs), or bed and
// wake null. spread is each one's standard deviation in minutes (null with under 2 nights).
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.round(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length));
};
export function sleepStrip(nights, day, tz) {
  const rows = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(day, i - 6);
    const main = (nights ?? []).filter((r) => r.type === "long_sleep" && localNow(new Date(r.bedtime_end), tz).day === d)
      .sort((a, b) => (Date.parse(b.bedtime_end) - Date.parse(b.bedtime_start)) - (Date.parse(a.bedtime_end) - Date.parse(a.bedtime_start)))[0];
    const night = addDays(d, -1);
    const bed = main ? nightOf(new Date(main.bedtime_start), tz) : null;
    return {
      day: d, label: dayLabel(d).weekday.slice(0, 1),
      bed: bed && bed.night === night ? bed.minutes : bed ? bed.minutes - 1440 : null,
      wake: main ? localNow(new Date(main.bedtime_end), tz).minutes + 1440 : null,
    };
  });
  const got = rows.filter((r) => r.bed != null);
  return { rows, spread: { bed: sd(got.map((r) => r.bed)), wake: sd(got.map((r) => r.wake)) } };
}

// "Bedtime ±42 min · Wake ±1h 05m", or null with under 2 nights.
export function spreadLine({ bed, wake }) {
  if (bed == null) return null;
  const f = (m) => (m >= 60 ? `±${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `±${m} min`);
  return `Bedtime ${f(bed)} · Wake ${f(wake)}`;
}

// The strip's drawing in a w-wide box, one 12-unit row a night: each bar's x1 (bed) and x2
// (wake), the target's x (or null), and hour ticks, on a time axis from the earliest of bed and
// target to the latest wake, padded 30 minutes and cut to whole hours. Axis labels are clock text.
export function stripLayout(strip, target, w = 280, left = 16) {
  const got = strip.rows.filter((r) => r.bed != null);
  if (!got.length) return null;
  const lo = Math.floor((Math.min(...got.map((r) => r.bed), target ?? Infinity) - 30) / 60) * 60;
  const hi = Math.ceil((Math.max(...got.map((r) => r.wake)) + 30) / 60) * 60;
  const x = (m) => Math.round((left + ((m - lo) * (w - left)) / (hi - lo)) * 10) / 10;
  const ticks = [];
  const step = hi - lo > 12 * 60 ? 240 : 120;
  for (let m = Math.ceil(lo / step) * step; m <= hi; m += step) ticks.push({ x: x(m), label: formatClock(m % 1440).replace(":00", "") });
  return {
    rows: strip.rows.map((r, i) => ({ y: i * 12, label: r.label, x1: r.bed == null ? null : x(r.bed), x2: r.wake == null ? null : x(r.wake) })),
    target: target == null ? null : x(target),
    ticks,
  };
}
