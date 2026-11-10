// Student load (docs/sheet-glance.md, "School load"): the week's school hours due next to the
// free hours left before each day's shutdown, so a crunch week shows before it lands (Shovel's
// "time cushion", Sunsama's workload threshold). Pure: no DOM, no network, so node --test covers it.
import { addDays, freeMinutes } from "./logic.mjs";
import { loadShare } from "./glance.mjs";

// --- Which tasks are school work -----------------------------------------------------------

// His courses, as an allow-list of codes ("ams261"): the code the feed puts first in each
// Brightspace event's title (feeds.mjs, eventTitle: "AMS 261 Exam 2", from the item's LOCATION),
// and any a Brightspace due item's title starts with. A course-shaped tag that isn't one of his
// courses ("kan-329" for Jira, "ieee101") is not school.
const COURSE_CODE = /^\s*([A-Za-z]{2,4})[\s-]?(\d{3})\b/;
const code = (s) => { const m = COURSE_CODE.exec(String(s ?? "")); return m ? `${m[1]}${m[2]}`.toLowerCase() : null; };
export const courseCodes = (tasks) => new Set([...tasks].filter((t) => t.source === "brightspace").map((t) => code(t.title)).filter(Boolean));

// A tag that names one of his courses ("cse316", "AMS 261", "ams-261"), or says school.
const SCHOOL_TAGS = new Set(["school", "class", "course", "hw", "homework"]);
export const isSchoolTag = (tag, codes = new Set()) => {
  const t = String(tag ?? "").trim();
  if (!t) return false;
  if (SCHOOL_TAGS.has(t.toLowerCase())) return true;
  const c = code(t);
  return Boolean(c) && c.length === t.replace(/[\s-]/g, "").length && codes.has(c);
};

// School: everything the Brightspace feed made (pace.mjs calls it "course"), or a task tagged
// with one of his course codes or #school.
export const isSchool = (t, codes) => t.source === "brightspace" || isSchoolTag(t.tag, codes);

// School work is school that is not at a fixed time. From Brightspace, only items with a due
// date count (feeds.mjs, courseTaskChanges: the "- Due" items). The feed's other items are
// calendar events (courseEventChanges: no due, a day): a timed one (an exam, a class meeting) is
// something he goes to, so it takes free time instead; an untimed one (a holiday, Reading Day)
// is no work at all.
export const isSchoolWork = (t, codes) => !t.at_time && (t.source === "brightspace" ? Boolean(t.due) : isSchool(t, codes));

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
// In the week holding `today`, work overdue by up to OVERDUE_DAYS counts too: it still needs doing
// this week. Older overdue work is taken as let go, so it doesn't weigh on every week after.
// Earliest due first.
export const OVERDUE_DAYS = 14;
export function schoolDue(tasks, days, today, codes = courseCodes(tasks)) {
  const [first, last] = [days[0], days[days.length - 1]];
  const thisWeek = first <= today && today <= last;
  const since = addDays(today, -OVERDUE_DAYS);
  return [...tasks]
    .filter((t) => !t.done && isSchoolWork(t, codes) && !t.project_id)
    .map((t) => ({ task: t, due: dueOf(t), ...schoolMinutes(t) }))
    .filter(({ due }) => due && due <= last && (due >= first || (thisWeek && due < today && due >= since)))
    .sort((a, b) => a.due.localeCompare(b.due) || String(a.task.title).localeCompare(String(b.task.title), "en", { numeric: true }));
}

// A day's free minutes: the gaps between his busy calendar events (`dayEvents`, eventsOnDay's
// minutes) from `from` to `to` (the day's start, or now on today, to its shutdown line), less the
// fixed-time tasks on that day (undone tasks in `dayTasks` with an at_time, their est_min long, 30
// without one) where no event already covers them, held to `cap` (the Settings workload cap,
// as the day chips are: planner.mjs dayCapacity). The day's other planned work comes off after
// the cap: the estimates of its undone, untimed tasks that aren't school work. Never below 0.
export function freeOn(dayEvents, dayTasks, from, to, cap = Infinity, codes = new Set()) {
  if (!(to > from)) return 0;
  const clock = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
  const open = dayTasks.filter((t) => !t.done);
  const spans = open.filter((t) => t.at_time).map((t) => {
    const start = clock(t.at_time);
    return { busy: true, allDay: false, start, end: start + (t.est_min > 0 ? t.est_min : 30) };
  });
  const other = open.filter((t) => !t.at_time && !isSchoolWork(t, codes)).reduce((s, t) => s + (t.est_min > 0 ? t.est_min : 0), 0);
  return Math.max(0, Math.min(cap, freeMinutes([...dayEvents, ...spans], from, to)) - other);
}

// The week's load: { need, free, guessed, items, level, pct, short, crunch }, or null for a week
// that is over. `free` is `freeByDay` summed over the days from today on; `need` is schoolDue's
// minutes. level and pct are loadShare's (the day load's rule): over when need > free, near from
// 85%. A crunch week is an over week; `short` is by how much.
export function weekLoad(tasks, days, today, freeByDay, codes = courseCodes(tasks)) {
  if (days[days.length - 1] < today) return null;
  const items = schoolDue(tasks, days, today, codes);
  const need = items.reduce((s, i) => s + i.minutes, 0);
  const free = days.filter((d) => d >= today).reduce((s, d) => s + Math.max(0, freeByDay[d] ?? 0), 0);
  const { pct, level } = loadShare(need, free);
  return { need, free, guessed: items.filter((i) => i.guess).length, items, level, pct, short: Math.max(0, need - free), crunch: level === "over" };
}

