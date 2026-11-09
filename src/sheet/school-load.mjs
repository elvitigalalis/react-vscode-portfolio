// Student load (docs/sheet-glance.md, "School load"): the week's school hours due next to the
// free hours left before each day's shutdown, so a crunch week shows before it lands (Shovel's
// "time cushion", Sunsama's workload threshold). Pure: no DOM, no network, so node --test covers it.
import { freeMinutes } from "./logic.mjs";
import { loadShare } from "./glance.mjs";

// --- Which tasks are school work -----------------------------------------------------------

// A tag that names a course: "cse316", "AMS 261", "ams-261". "school" and "class" count too.
const COURSE_TAG = /^[a-z]{2,4}[\s-]?\d{3}$/i;
const SCHOOL_TAGS = new Set(["school", "class", "course", "hw", "homework"]);
export const isSchoolTag = (tag) => Boolean(tag) && (COURSE_TAG.test(tag.trim()) || SCHOOL_TAGS.has(tag.trim().toLowerCase()));

// School: everything the Brightspace feed made (pace.mjs calls it "course"), or a task tagged
// with a course code or #school.
export const isSchool = (t) => t.source === "brightspace" || isSchoolTag(t.tag);

// School work is school that is not at a fixed time. A timed Brightspace item (an exam, a class
// meeting: feeds.mjs, courseEventChanges) is an event he goes to, so it takes free time instead.
export const isSchoolWork = (t) => isSchool(t) && !t.at_time;

// --- Estimates ----------------------------------------------------------------------------

// The one-tap choices for an item with no estimate, in minutes (30m, 1h, 2h, 4h, 8h).
export const QUICK_EST = [30, 60, 120, 240, 480];

// A guess by kind of item, from its title, for one with no est_min. First match wins.
const GUESSES = [
  [/\b(final\s+(project|paper|report)|project|paper|essay|report|presentation)\b/i, 240],
  [/\b(midterm|exam|final|test)s?\b/i, 180],
  [/\b(homework|hw|problem\s+set|pset|assignment|lab|programming|program)\b/i, 120],
  [/\b(quiz|quizzes)\b/i, 60],
  [/\b(discussion|post|reply|reading|read|survey|poll|attendance|check-?in|reflection)\b/i, 30],
];
export const DEFAULT_SCHOOL_EST = 60;
export function guessMinutes(t) {
  for (const [re, min] of GUESSES) if (re.test(t.title ?? "")) return min;
  return DEFAULT_SCHOOL_EST;
}

// An item's minutes for the load: its estimate, or the guess, with whether it is a guess.
export const schoolMinutes = (t) => (t.est_min > 0 ? { minutes: t.est_min, guess: false } : { minutes: guessMinutes(t), guess: true });

// --- The week -----------------------------------------------------------------------------

// When an item is due: its due date, else the day it sits on.
const dueOf = (t) => t.due ?? t.day ?? null;

// The undone school work due in the week of `days` (Monday first), with each one's minutes.
// In the week holding `today`, work already overdue counts too: it still needs doing this week.
// Earliest due first.
export function schoolDue(tasks, days, today) {
  const [first, last] = [days[0], days[days.length - 1]];
  const thisWeek = first <= today && today <= last;
  return [...tasks]
    .filter((t) => !t.done && isSchoolWork(t) && !t.project_id)
    .map((t) => ({ task: t, due: dueOf(t), ...schoolMinutes(t) }))
    .filter(({ due }) => due && due <= last && (due >= first || (thisWeek && due < today)))
    .sort((a, b) => a.due.localeCompare(b.due) || String(a.task.title).localeCompare(String(b.task.title)));
}

// A day's free minutes: the gaps between his busy calendar events (`dayEvents`, eventsOnDay's
// minutes) from `from` to `to` (the day's start, or now on today, to its shutdown line), less the
// fixed-time tasks on that day (`fixed`: undone tasks with an at_time, their est_min long, 30
// without one) where no event already covers them.
export function freeOn(dayEvents, fixed, from, to) {
  const clock = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
  const spans = fixed.filter((t) => !t.done && t.at_time).map((t) => {
    const start = clock(t.at_time);
    return { busy: true, allDay: false, start, end: start + (t.est_min > 0 ? t.est_min : 30) };
  });
  return to > from ? freeMinutes([...dayEvents, ...spans], from, to) : 0;
}

// The week's load: { need, free, guessed, items, level, pct, short, crunch }, or null for a week
// that is over. `free` is `freeByDay` summed over the days from today on; `need` is schoolDue's
// minutes. level and pct are loadShare's (the day load's rule): over when need > free, near from
// 85%. A crunch week is an over week; `short` is by how much.
export function weekLoad(tasks, days, today, freeByDay) {
  if (days[days.length - 1] < today) return null;
  const items = schoolDue(tasks, days, today);
  const need = items.reduce((s, i) => s + i.minutes, 0);
  const free = days.filter((d) => d >= today).reduce((s, d) => s + Math.max(0, freeByDay[d] ?? 0), 0);
  const { pct, level } = loadShare(need, free);
  return { need, free, guessed: items.filter((i) => i.guess).length, items, level, pct, short: Math.max(0, need - free), crunch: level === "over" };
}

