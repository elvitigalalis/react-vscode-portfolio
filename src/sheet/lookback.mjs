// The look-back (docs/sheet-lookback.md): what Lisul's own history can honestly say, as pure
// numbers and plain lines. Every insight has a sample gate and returns null below it, so the
// screen shows nothing rather than a weak claim. The words are facts about tasks and estimates,
// compared only with his own past: no scores, percentages or streaks, and moved work is "moved".
// Oura stays out of all of it (ADR 0005).
import { addDays, blockMinutes, dayLabel, formatMinutes, localNow, weekStart, weekdayName } from "./logic.mjs";
import { PACE_KINDS, paceKind, pacedMinutes } from "./pace.mjs";

// A week compares once it has this many days with approved task blocks.
export const WEEK_MIN_DAYS = 3;
// The due look-back and the On track look-back wait for this many settled tasks.
export const DUE_MIN = 5;
export const CALL_MIN = 10;
const DUE_WINDOW = 28;
const MOVING_WINDOW = 14;
const TREND_EACH = 5;
const NAMES = { course: "Course tasks", campus: "Campus tasks", github: "GitHub tasks", jira: "Jira tasks", other: "Tasks" };

const localDay = (iso, timeZone) => localNow(new Date(iso), timeZone).day;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// One week's approved task blocks: minutes planned and done by day. A block counts as done when
// its task is done, unless its Finished? check said it never started or moved to tomorrow.
function weekNumbers(blocks, doneTasks, unstarted, from, cap, timeZone) {
  const days = Array.from({ length: 7 }, (_, i) => ({ day: addDays(from, i), planned_min: 0, done_min: 0, cap_min: cap }));
  for (const b of blocks) {
    if (b.proposed || !b.task_id || b.habit_id) continue;
    const row = days.find((d) => d.day === localDay(b.starts_at, timeZone));
    if (!row) continue;
    row.planned_min += blockMinutes(b);
    if (doneTasks.has(b.task_id) && !unstarted.has(b.id)) row.done_min += blockMinutes(b);
  }
  const sum = (k) => days.reduce((n, d) => n + d[k], 0);
  return { days, planned_min: sum("planned_min"), done_min: sum("done_min"), planned_days: days.filter((d) => d.planned_min).length };
}

// The week before this one (Monday to Sunday in his zone), or null below WEEK_MIN_DAYS. `rolled`
// isn't here: tasks.rolls has no date, so it can't be split by week.
export function weekReview({ blocks, tasks, feedback, days, cap, today, timeZone }) {
  const from = addDays(weekStart(today), -7);
  const to = addDays(from, 6);
  const doneTasks = new Set(tasks.filter((t) => t.done).map((t) => t.id));
  const unstarted = new Set(feedback.filter((f) => f.action === "nostart" || f.action === "tomorrow").map((f) => f.ref?.block_id).filter(Boolean));
  const week = weekNumbers(blocks, doneTasks, unstarted, from, cap, timeZone);
  if (week.planned_days < WEEK_MIN_DAYS) return null;
  const before = weekNumbers(blocks, doneTasks, unstarted, addDays(from, -7), cap, timeZone);
  const answered = feedback.filter((f) => { const d = localDay(f.at, timeZone); return d >= from && d <= to; });
  return {
    from, to, days: week.days, planned_min: week.planned_min, done_min: week.done_min,
    prior: before.planned_days < WEEK_MIN_DAYS ? null : { planned_min: before.planned_min, done_min: before.done_min },
    moved: new Set(answered.filter((f) => f.action === "tomorrow").map((f) => f.ref?.task_id)).size,
    nostart: answered.filter((f) => f.action === "nostart").length,
    reflections: days.filter((d) => d.day >= from && d.day <= to && d.reflection?.trim())
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((d) => ({ day: d.day, weekday: weekdayName(d.day), text: d.reflection.trim() })),
  };
}

export const weekLine = (w) => `Done ${formatMinutes(w.done_min)} of ${formatMinutes(w.planned_min)} planned${w.prior ? ` · the week before ${formatMinutes(w.prior.done_min)} of ${formatMinutes(w.prior.planned_min)}` : ""}`;
export const weekTitle = (w) => `${dayLabel(w.from).date} – ${dayLabel(w.to).date}`;

// His own history beside an estimate, once the kind has its pace (pace.mjs's sample gate): what
// tasks like it took, scaled to this estimate and rounded to 5 minutes, and the block it means.
export function estimateHint(task, paces) {
  if (!task.est_min) return null;
  const kind = paceKind(task);
  const { pace, n } = paces?.[kind] ?? {};
  if (pace == null) return null;
  const took = Math.round((task.est_min * pace) / 5) * 5;
  return `${NAMES[kind]} like this took about ${formatMinutes(took)} for a ${formatMinutes(task.est_min)} estimate (median of ${n}) · blocks will be ${formatMinutes(pacedMinutes(task, paces))}`;
}

// A task that keeps moving: two rolls, a park in Inbox in the last 14 days (a park resets its
// rolls), or two Tomorrow answers in 14 days. It earns a prompt; the screen shows no count.
export function keepsMoving(task, feedback, today, timeZone) {
  if (task.done) return false;
  if ((task.rolls ?? 0) >= 2) return true;
  const since = addDays(today, -MOVING_WINDOW);
  if (task.parked_on && task.parked_on >= since) return true;
  return feedback.filter((f) => f.action === "tomorrow" && f.ref?.task_id === task.id && localDay(f.at, timeZone) >= since).length >= 2;
}

// Tasks due in the last 4 weeks. A finished task with no done_at (finished before the column
// existed) has no known finish day, so it is left out rather than guessed from updated_at.
export function dueLookback({ tasks, today, timeZone }) {
  const since = addDays(today, -DUE_WINDOW);
  let on_time = 0;
  const after = [], open = [];
  for (const t of tasks) {
    if (!t.due || t.due < since || t.due >= today) continue;
    if (!t.done) open.push(t.title);
    else if (!t.done_at) continue;
    else if (localDay(t.done_at, timeZone) <= t.due) on_time++;
    else after.push(t.title);
  }
  const n = on_time + after.length + open.length;
  return n < DUE_MIN ? null : { n, on_time, after, open };
}

const names = (xs) => (xs.length <= 3 ? xs.join(", ") : `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more`);
export function dueLine(d) {
  const parts = [`Due in the last 4 weeks: ${d.n} ${d.n === 1 ? "task" : "tasks"}`, `${d.on_time} done by the due date`];
  if (d.after.length) parts.push(`${d.after.length} after (${names(d.after)})`);
  if (d.open.length) parts.push(`${d.open.length} still open (${names(d.open)}): give it a new date, or let it go`);
  return parts.join(" · ");
}

// Did "On track" hold? Each horizon_calls row is the state a task had about a week before its
// due date. A call holds when the task finished by that date, whatever its due date says now, so
// moving the date doesn't turn a late finish into a kept one. A finish with no done_at is left out.
export function callLookback({ calls, tasks, today, timeZone }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let n = 0, held = 0;
  for (const c of calls) {
    if (c.state !== "on_track" || c.due >= today) continue;
    const t = byId.get(c.task_id);
    if (!t || (t.done && !t.done_at)) continue;
    n++;
    if (t.done && localDay(t.done_at, timeZone) <= c.due) held++;
  }
  return n < CALL_MIN ? null : { n, held };
}
export const callLine = (c) => `Marked On track about a week out: ${c.held} of ${c.n} finished by that date. The states aim for about 4 in 5.`;

// The newest 5 estimated rows of a kind against the 5 before them; the kind with the most rows
// that has 10. Null below that, or when the two round to the same pace.
export function paceTrend(actuals) {
  const rows = [...actuals].filter((a) => a.est_min > 0).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const kind = PACE_KINDS.map((k) => [k, rows.filter((a) => a.kind === k)]).sort((a, b) => b[1].length - a[1].length)[0];
  if (kind[1].length < TREND_EACH * 2) return null;
  const pace = (xs) => Math.round(median(xs.map((a) => a.minutes / a.est_min)) * 10) / 10;
  const now = pace(kind[1].slice(0, TREND_EACH)), then = pace(kind[1].slice(TREND_EACH, TREND_EACH * 2));
  if (now === then) return null;
  return `${NAMES[kind[0]]} lately took ${now.toFixed(1)}× the estimate, ${now < then ? "down" : "up"} from ${then.toFixed(1)}×`;
}

// Shutdown's one line from what is already logged. A zero is left out.
export function shutdownLine({ done, moving, turned_down, trend = null }) {
  const parts = [done && `${done} done`, moving && `${moving} moving to tomorrow`, turned_down && `${turned_down} ${turned_down === 1 ? "suggestion" : "suggestions"} turned down`].filter(Boolean);
  const today = parts.length ? `Today: ${parts.join(" · ")}.` : null;
  return [today, trend && `${trend}.`].filter(Boolean).join(" ") || null;
}

// Tomorrow's load against its room; over it, the next move.
export function tomorrowLine(total, room) {
  const line = `${formatMinutes(total)} planned, room for ${formatMinutes(room)}.`;
  return total > room ? `${line} Move something to another day, or raise the cap in Settings.` : line;
}
