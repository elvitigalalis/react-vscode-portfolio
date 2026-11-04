// Pace (spec 47, "Finished? and pace"; docs/sheet-v5.md, "pace.mjs"): how long Lisul's tasks
// really take next to their estimates, per kind of task, learned from his Finished? answers.
// Computed here rather than in SQL, so read_planner, Settings and the tests share one function.
import { addDays, localNow, blockMinutes, snap } from "./logic.mjs";

export const PACE_KINDS = ["course", "campus", "github", "jira", "other"];
// A kind's pace counts only after this many finished tasks, over its newest PACE_WINDOW, and is
// held between PACE_LIMITS.
export const PACE_SAMPLES = 5;
export const PACE_WINDOW = 20;
export const PACE_LIMITS = [0.5, 3];
// A paced block is held to 15 minutes – 4 hours.
const BLOCK_LIMITS = [15, 240];

// The kind of a task: course (Brightspace), campus (tagged), GitHub, Jira, or other (mail too).
export function paceKind(task) {
  if (task.source === "brightspace") return "course";
  if (task.tag === "campus") return "campus";
  if (task.source === "github" || task.source === "jira") return task.source;
  return "other";
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));

// Rows of the actuals table → { course, campus, github, jira, other }, each { pace, n }: the
// median of minutes / est_min over the kind's newest PACE_WINDOW rows with an estimate, or a
// null pace below PACE_SAMPLES of them.
export function paceByKind(actuals) {
  const newest = [...actuals].filter((a) => a.est_min > 0).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return Object.fromEntries(PACE_KINDS.map((kind) => {
    const rows = newest.filter((a) => a.kind === kind).slice(0, PACE_WINDOW);
    const pace = rows.length < PACE_SAMPLES ? null
      : Math.round(clamp(median(rows.map((a) => a.minutes / a.est_min)), PACE_LIMITS) * 100) / 100;
    return [kind, { pace, n: rows.length }];
  }));
}

// The minutes a block for `task` must have: its estimate (30 without one), times its kind's pace
// once it has one, rounded to the nearest 15 (half up) and held to 15–240.
export function pacedMinutes(task, paces) {
  const pace = paces?.[paceKind(task)]?.pace;
  const est = (task.est_min ?? 30) * (pace ?? 1);
  return clamp(snap(est), BLOCK_LIMITS);
}

// The 14 days before `day`, oldest first, as { day, planned_min, done_min }: the minutes of
// approved blocks on each, and of those whose task is done. Days with no approved block are left
// out.
export function plannedVsDone(blocks, tasks, day, timeZone) {
  const from = addDays(day, -14);
  const done = new Set(tasks.filter((t) => t.done).map((t) => t.id));
  const byDay = new Map();
  for (const b of blocks) {
    if (b.proposed) continue;
    const d = localNow(new Date(b.starts_at), timeZone).day;
    if (d < from || d >= day) continue;
    const row = byDay.get(d) ?? { day: d, planned_min: 0, done_min: 0 };
    row.planned_min += blockMinutes(b);
    if (done.has(b.task_id)) row.done_min += blockMinutes(b);
    byDay.set(d, row);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// Settings (docs/sheet-v5.md, "/plan"): "Course ×1.4 (12)", or "Course: 3 of 5 needed".
const KIND_NAMES = { course: "Course", campus: "Campus", github: "GitHub", jira: "Jira", other: "Other" };
export const paceLine = (kind, { pace, n }) =>
  pace == null ? `${KIND_NAMES[kind]}: ${Math.min(n, PACE_SAMPLES)} of ${PACE_SAMPLES} needed` : `${KIND_NAMES[kind]} ×${pace} (${n})`;
