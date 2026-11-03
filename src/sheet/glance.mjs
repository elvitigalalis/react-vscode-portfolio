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
