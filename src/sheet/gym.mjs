// The Gym tracker's logic (docs/sheet-gym.md): e1RM and records, the next-weight suggestion,
// the session order and plate math. No DOM and no network, so it runs the same in the browser,
// offline, and in the tests.

// --- e1RM and records ------------------------------------------------------------------------

const tenth = (x) => Math.round(x * 10) / 10;

// Epley, w × (1 + r/30). Above 10 reps it is shown with a "~" (approx); above 12 it never counts
// toward a record (research: the formulas drift past 10 and break down past 12).
export const E1RM_EXACT_MAX = 10;
export const E1RM_PR_MAX = 12;
export const e1rm = (weight, reps) => (reps >= 1 ? { value: tenth(weight * (1 + reps / 30)), approx: reps > E1RM_EXACT_MAX } : null);
const e1rmValue = (s) => (s.reps >= 1 && s.reps <= E1RM_PR_MAX ? weightOf(s) * (1 + s.reps / 30) : 0);
const weightOf = (s) => Number(s.weight_lb) || 0;

// The sets records are built from: working sets, plus each confirmed sheet baseline as one set
// (reps unknown counts as 1).
function counted(sets, baselines = []) {
  return [
    ...sets.filter((s) => !s.warmup && s.reps >= 1),
    ...baselines.filter((b) => b.confirmed && b.weight_lb != null)
      .map((b) => ({ exercise_id: b.exercise_id, weight_lb: b.weight_lb, reps: b.reps ?? 1, warmup: false, done_at: null, sheet: true })),
  ];
}

// Per exercise id: { heaviest, e1rm: { value, set }, byReps: [{ reps, weight_lb, set, beaten }] }.
// byReps holds the best weight at each rep count; a record is beaten (faded, as in FitNotes)
// when a set at least as heavy went for more reps.
export function records(sets, baselines = []) {
  const out = new Map();
  for (const s of counted(sets, baselines)) {
    let r = out.get(s.exercise_id);
    if (!r) out.set(s.exercise_id, (r = { heaviest: null, e1rm: null, reps: new Map() }));
    if (!r.heaviest || weightOf(s) > weightOf(r.heaviest)) r.heaviest = s;
    const v = e1rmValue(s);
    if (v && (!r.e1rm || v > r.e1rm.value)) r.e1rm = { value: tenth(v), set: s };
    const at = r.reps.get(s.reps);
    if (!at || weightOf(s) > weightOf(at)) r.reps.set(s.reps, s);
  }
  for (const r of out.values()) {
    const rows = [...r.reps.entries()].sort((a, b) => a[0] - b[0]).map(([reps, s]) => ({ reps, weight_lb: weightOf(s), set: s, beaten: false }));
    for (const row of rows) row.beaten = rows.some((o) => o.reps > row.reps && o.weight_lb >= row.weight_lb);
    r.byReps = rows;
    delete r.reps;
  }
  return out;
}

// The records `s` sets against the earlier sets, most important first: e1RM, then heaviest
// weight, then most reps at this weight or heavier. A warm-up, or an exercise's first log, sets
// none.
export function prsFor(s, before, baselines = []) {
  if (s.warmup || !(s.reps >= 1)) return [];
  const prior = counted(before, baselines).filter((p) => p.exercise_id === s.exercise_id);
  if (!prior.length) return [];
  const prs = [];
  const v = e1rmValue(s);
  const best = Math.max(...prior.map(e1rmValue));
  if (v && v > best + 1e-9) prs.push({ type: "e1rm", value: tenth(v), was: tenth(best) });
  const heaviest = Math.max(...prior.map(weightOf));
  if (weightOf(s) > heaviest) prs.push({ type: "weight", weight_lb: weightOf(s), was: heaviest });
  const atOrAbove = prior.filter((p) => weightOf(p) >= weightOf(s));
  if (atOrAbove.length) {
    const most = Math.max(...atOrAbove.map((p) => p.reps));
    if (s.reps > most) prs.push({ type: "reps", weight_lb: weightOf(s), reps: s.reps, was: most });
  }
  return prs;
}
