// /plan at a glance (docs/sheet-glance.md, "Contracts → Pure functions"): what the page draws
// instead of writing out in words. Pure, so node --test covers it.
import { freeFood } from "./campus.mjs";
import { atRisk } from "./logic.mjs";

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
