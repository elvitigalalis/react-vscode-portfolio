// Progress on /plan (docs/sheet.md, "Progress"): counts that say what got done, never points,
// levels or anything a miss takes away. /now shows none of it. Pure, so node --test covers it.
import { localNow, formatMinutes } from "./logic.mjs";

// Today's tasks done out of all of today's, and the minutes focus sessions logged today
// (actuals rows: { day, minutes }).
export function dayProgress(tasks, today, actuals = []) {
  const list = [...tasks].filter((t) => t.day === today);
  const focused = actuals.filter((a) => a.day === today).reduce((n, a) => n + (a.minutes ?? 0), 0);
  return { done: list.filter((t) => t.done).length, total: list.length, focused };
}

// "3 of 7 done · 1h40 focused"; the focused half only when there is some, nothing for an empty day.
export function progressText({ done, total, focused }) {
  const parts = [total ? `${done} of ${total} done` : null, focused ? `${formatMinutes(focused)} focused` : null];
  return parts.filter(Boolean).join(" · ");
}

// How many tasks were finished during the week of `days` (by done_at on his clock), wherever
// they sit now: a Someday task done this week counts too. A finish with no done_at is left out.
export function weekDone(tasks, days, timeZone) {
  const [from, to] = [days[0], days.at(-1)];
  let n = 0;
  for (const t of tasks) {
    if (!t.done || !t.done_at) continue;
    const d = localNow(new Date(t.done_at), timeZone).day;
    if (d >= from && d <= to) n++;
  }
  return n;
}

// "Week of Nov 9 · 14 done", or just "Week of Nov 9" before anything is.
export const weekTitle = (date, done) => `Week of ${date}${done ? ` · ${done} done` : ""}`;
