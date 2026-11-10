// Shutdown that closes loops (docs/sheet.md, "Shutdown"): the day's wins, filled in from what is
// already logged, and one decision for every unfinished task. Pure, so node --test covers it;
// shutdown-view.mjs draws it.
//
// Why a decision for each: an unfinished goal keeps pulling at attention until it is done or has
// a specific plan (Masicampo & Baumeister 2011), and a specific to-do list for the next days
// before bed sped sleep onset (Scullin et al. 2018). Wins are counts and names, never points.
import { addDays, formatMinutes, laterThisWeek, localNow, moveChange, plural } from "./logic.mjs";

// Done today, wherever the task sits now: by done_at on his clock, or, with no done_at, a task on
// today that is done.
export const doneToday = (t, today, tz) => Boolean(t.done) && (t.done_at ? localNow(new Date(t.done_at), tz).day === today : t.day === today);

const WORK = new Set(["github", "jira"]);

// What the wins list is made of. `focused` is today's focus minutes as /plan's progress line counts
// them (progress.mjs dayProgress); `workouts` are today's hevy_workouts rows; `habits` the names of
// habits ticked today (habit_done).
export function winsOf({ tasks, today, tz, focused = 0, workouts = [], habits = [] }) {
  const done = [...tasks].filter((t) => doneToday(t, today, tz));
  return {
    tasks: done.filter((t) => !WORK.has(t.source)),
    github: done.filter((t) => t.source === "github"),
    jira: done.filter((t) => t.source === "jira"),
    focused,
    workouts,
    habits,
  };
}

// "A, B, C and 2 more": the first three titles.
export const someTitles = (items, n = 3) => {
  const titles = items.map((t) => t.title);
  return titles.length > n ? `${titles.slice(0, n).join(", ")} and ${titles.length - n} more` : titles.join(", ");
};

const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

// The wins as lines: { key, text, detail }. Nothing for a part with nothing in it.
export function winLines(w) {
  const lines = [];
  if (w.tasks.length) lines.push({ key: "tasks", text: `${plural(w.tasks.length, "task")} done`, detail: someTitles(w.tasks) });
  if (w.focused > 0) lines.push({ key: "focus", text: `${formatMinutes(w.focused)} focused`, detail: null });
  if (w.github.length) lines.push({ key: "github", text: `${w.github.length} done on GitHub`, detail: someTitles(w.github) });
  if (w.jira.length) lines.push({ key: "jira", text: `${plural(w.jira.length, "Jira ticket")} done`, detail: someTitles(w.jira) });
  for (const x of w.workouts) {
    const min = x.starts_at && x.ends_at ? minutesBetween(x.starts_at, x.ends_at) : 0;
    lines.push({ key: `lift-${x.id ?? x.title}`, text: `Lifted: ${x.title}`, detail: min > 0 ? formatMinutes(min) : null });
  }
  if (w.habits.length) lines.push({ key: "habits", text: `${plural(w.habits.length, "habit")} ticked`, detail: w.habits.join(", ") });
  return lines;
}

// --- Decisions ----------------------------------------------------------------------------------

// The places an unfinished task can go, in order. This week is the week's last day (logic.mjs,
// laterThisWeek, as the carried-over menu), hidden when that is not past tomorrow. Done is for a
// task finished but not ticked.
export function choicesFor(today) {
  return [
    { kind: "done", label: "Done" },
    { kind: "tomorrow", label: "Tomorrow" },
    laterThisWeek(today) ? { kind: "week", label: "This week" } : null,
    { kind: "someday", label: "Someday" },
  ].filter(Boolean);
}

// Where a decision sends a task: { day } or { list }, or null for Done.
export function targetOf(kind, today) {
  if (kind === "tomorrow") return { day: addDays(today, 1) };
  if (kind === "week") return { day: laterThisWeek(today) ?? addDays(today, 1) };
  if (kind === "someday") return { list: "Inbox" };
  return null;
}

// The patch a decision saves. Tomorrow counts as a roll, as the nightly rollover's move does, so
// the carried-over tag and the look-back's "keeps moving" still see it; This week and Someday are
// moves as the task menu makes them (logic.mjs, moveChange: Someday clears the time and the rolls).
export function decisionChange(t, kind, today, position) {
  if (kind === "done") return { done: true };
  const { change } = moveChange(t, targetOf(kind, today), position);
  return kind === "tomorrow" ? { ...change, rolls: (t.rolls ?? 0) + 1 } : change;
}

// A Tomorrow that the day's shut_down makes itself (supabase/schema.sql, roll_tasks): an untimed
// task under three rolls moves to tomorrow as a roll in the same request, so Finish needs no write
// of its own for it. A timed task, or one the roll would park in Inbox, is moved by a write.
export const ROLLS_BEFORE_INBOX = 3;
export const rollsOnServer = (t, kind) => kind === "tomorrow" && !t.at_time && (t.rolls ?? 0) < ROLLS_BEFORE_INBOX;

// Today's unfinished tasks that still need a decision.
export const undecided = (open, decisions) => open.filter((t) => !decisions.has(t.id));

// The "Day closed" line: where the day's open tasks went. Null when there were none.
export function closedLine(decisions) {
  const n = (k) => [...decisions.values()].filter((v) => v === k).length;
  const parts = [
    n("done") && `${n("done")} more done`,
    n("tomorrow") && `${n("tomorrow")} on tomorrow`,
    n("week") && `${n("week")} later this week`,
    n("someday") && `${n("someday")} in Someday`,
  ].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}.` : null;
}

// What the "Day closed" screen hands him: tomorrow's first task, the specific next step.
export const firstUp = (tomorrowTasks) => tomorrowTasks.find((t) => !t.done)?.title ?? null;
