// /plan at a glance (docs/sheet-glance.md, "Contracts → Pure functions"): what the page draws
// instead of writing out in words. Pure, so node --test covers it.
import { freeFood } from "./campus.mjs";
import { atRisk, minutesOn } from "./logic.mjs";

// --- Sources and due levels (G2) ---------------------------------------------------------

// A task's source, for its edge colour and icon: Brightspace first, then the #campus tag.
export const sourceOf = (task) =>
  task.source === "brightspace" ? "course" : task.tag === "campus" ? "campus" : null;

// The day's campus chip: how many events, and how many with free food.
export const campusSummary = (events) => ({ n: events.length, food: events.filter(freeFood).length });

// How loudly a due date shows: 'overdue' once its day has passed, 'risk' while atRisk holds,
// else null. A done task is neither.
export function dueLevel(task, blocks, today, timeZone) {
  if (task.done || !task.due) return null;
  if (task.due < today) return "overdue";
  return atRisk(task, blocks, today, timeZone) ? "risk" : null;
}

// --- Load and free time, drawn (G3) ------------------------------------------------------

// A day's load as a bar: `pct` of capacity for drawing (capped at 100), and `level` by load's
// rule on the raw minutes.
export function loadShare(minutes, capacity) {
  if (capacity <= 0) return minutes > 0 ? { pct: 100, level: "over" } : { pct: 0, level: "ok" };
  const level = minutes > capacity ? "over" : minutes >= capacity * 0.85 ? "near" : "ok";
  return { pct: Math.min(100, Math.round((100 * minutes) / capacity)), level };
}

// A day's strip: busy events and blocks as percentages of the window `from`–`to` (minutes past
// midnight), rounded to 0.1 and sorted by start. Parts outside the window are clipped and
// anything wholly outside is dropped; all-day and free events are left out. Overlaps stay
// separate segments.
export function stripSegments(events, blocks, day, timeZone, from = 7 * 60, to = 23 * 60) {
  const pct = (m) => Math.round((1000 * (m - from)) / (to - from)) / 10;
  const parts = [
    ...events.filter((e) => !e.allDay && e.busy !== false).map((e) => [e, "busy"]),
    ...blocks.map((b) => [b, b.proposed ? "proposed" : "block"]),
  ];
  return parts.flatMap(([x, kind]) => {
    const a = Math.max(from, minutesOn(x.starts_at, day, timeZone));
    const b = Math.min(to, minutesOn(x.ends_at, day, timeZone));
    return b > a ? [{ from: pct(a), to: pct(b), kind }] : [];
  }).sort((x, y) => x.from - y.from);
}

// --- feedAlert (G4: the top bar's Feed failed chip) ------------------------------------------

// The sources whose last read failed, in row order. ok null means not read yet, not failed.
export const feedAlert = (feedRows) => feedRows.filter((f) => f.ok === false).map((f) => f.source);
