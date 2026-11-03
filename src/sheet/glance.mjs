// /plan at a glance (docs/sheet-glance.md): pure functions for what the page draws, kept free
// of the DOM so node --test can cover them.

import { minutesOn } from "./logic.mjs";

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
