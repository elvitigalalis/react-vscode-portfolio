// Two things the ring tells the plan beyond sleep (docs/sheet-v5.md, "Oura"): a ring workout that
// ticks the day's Gym habit, and Rest Mode, which cuts the day to essentials and eases back.
// Plain code: the routine only ever sees the cap, the cap_reason words and the habits left
// (docs/adr/0005). Kept free of the network so node --test covers it; oura-sync and planner-mcp
// import it.
import { blockOnComplete, localNow } from "./logic.mjs";

// The Gym habit, as gym-ui.mjs finds it.
export const GYM_HABIT = /\b(gym|lift|workout)/i;
// A workout that is lifting by its activity counts anywhere in the day; a generic one only when it
// overlaps the habit's block.
const LIFTING = /strength|weight|lift|resistance|crossfit|bodybuilding|gym/i;

// The Gym habit blocks the ring's workouts finish, as a finished task's block goes
// (blockOnComplete at the workout's end): [{ block_id, action: "shrink", ends_at } or
// { block_id, action: "delete" }], at most one per block. `blocks` carry habit_id, `habits` id and
// name, `workouts` are ring_workouts rows.
export function gymMatches(workouts, blocks, habits, tz) {
  const gym = new Set((habits ?? []).filter((h) => GYM_HABIT.test(h.name ?? "")).map((h) => h.id));
  const out = new Map();
  for (const b of blocks ?? []) {
    if (!gym.has(b.habit_id) || b.proposed || out.has(b.id)) continue;
    const day = localNow(new Date(b.starts_at), tz).day;
    const w = (workouts ?? []).find((x) => {
      const overlaps = Date.parse(x.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(x.ends_at);
      return overlaps || (x.day === day && LIFTING.test(x.activity ?? ""));
    });
    if (!w) continue;
    const r = blockOnComplete(b, new Date(w.ends_at));
    if (r.action !== "keep") out.set(b.id, { block_id: b.id, ...r });
  }
  return [...out.values()];
}

// Each day's ring workout length for the gym page: "Ring: 1h 12m" for the day's workouts that
// matched (overlapping its session, or lifting that day), summed; null without one.
export function ringLine(workouts, day, session = null) {
  const hits = (workouts ?? []).filter((w) => w.day === day && (LIFTING.test(w.activity ?? "")
    || (session && Date.parse(w.starts_at) < Date.parse(session.finished_at ?? session.started_at) + 3_600_000 && Date.parse(session.started_at) < Date.parse(w.ends_at))));
  if (!hits.length) return null;
  const m = Math.round(hits.reduce((n, w) => n + (Date.parse(w.ends_at) - Date.parse(w.starts_at)), 0) / 60_000);
  return `Ring: ${m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`}`;
}

// Rest Mode on `day` from rest_periods rows ({ start_day, end_day }, end null while on): while it
// is on, { factor: 0.4, firm_only: true, reason: "rest mode" }; for as many days after it as it
// lasted (at most 7), easing back in even steps to the full cap, { factor, firm_only: false,
// reason: "easing back from rest mode" }; otherwise null. Oura eases activity back the same way:
// "lasts as long as Rest Mode was on, or a maximum of seven days" (support.ouraring.com,
// Rest Mode).
export const REST_FACTOR = 0.4;
const days = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
export function restMode(day, periods) {
  let best = null;
  for (const p of periods ?? []) {
    if (!p?.start_day || p.start_day > day) continue;
    if (p.end_day == null || day <= p.end_day) return { factor: REST_FACTOR, firm_only: true, reason: "rest mode" };
    const span = Math.min(7, days(p.start_day, p.end_day) + 1);
    const k = days(p.end_day, day);
    if (k > span) continue;
    const factor = Math.round((REST_FACTOR + ((1 - REST_FACTOR) * k) / (span + 1)) * 100) / 100;
    if (!best || factor < best.factor) best = { factor, firm_only: false, reason: "easing back from rest mode" };
  }
  return best;
}
