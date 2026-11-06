// The task details dialog's one decision (research U11): what a save changes. Each field holds what
// the input shows; blank clears that detail, which typed syntax can't do (planner.mjs, editTask).
const same = (a, b) => (a ?? null) === (b ?? null);

export function detailsChange(task, { est, time, due, tag }) {
  const change = {};
  const text = est.trim();
  const est_min = text === "" ? null : Number(text);
  if (est_min !== null && !(Number.isInteger(est_min) && est_min > 0)) return { error: "The estimate is whole minutes, above 0." };
  if (!same(est_min, task.est_min)) change.est_min = est_min;
  // A Someday task has no day for a fixed time to be on (planner.mjs, moveTask, clears it too).
  if (task.day) {
    const at_time = time || null;
    if (!same(at_time, task.at_time?.slice(0, 5))) change.at_time = at_time;
  }
  if (!same(due || null, task.due)) change.due = due || null;
  const name = tag.trim().replace(/^#/, "") || null;
  if (!same(name, task.tag)) change.tag = name;
  return { change };
}
