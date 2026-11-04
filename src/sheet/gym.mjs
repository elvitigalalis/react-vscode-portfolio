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

// --- The suggestion -------------------------------------------------------------------------

export const range = (text) => String(text ?? "").replace(/-/g, "–");
export const roundTo = (x, step) => Math.round(x / step) * step;
const GAP_DAYS = 14;

// An exercise's sessions, newest first, each { id, day_key, started_at, sets } with its working
// sets in order. `dayKeys` maps a program day's id to its key ('push1'); `skip` leaves out one
// session (today's).
export function historyFor(exerciseId, sessions, sets, dayKeys, skip = null) {
  const by = new Map();
  for (const s of sets) {
    if (s.exercise_id !== exerciseId || s.warmup || s.session_id === skip) continue;
    (by.get(s.session_id) ?? by.set(s.session_id, []).get(s.session_id)).push(s);
  }
  return sessions.filter((x) => by.has(x.id))
    .map((x) => ({ id: x.id, day_key: dayKeys[x.program_day_id] ?? null, started_at: x.started_at, sets: by.get(x.id).sort((a, b) => a.set_index - b.set_index) }))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

// Double progression with an RPE check (docs/sheet-gym.md, "Suggestion rule"), from the last
// session the exercise was done in, on the same program day if it has one:
//   every working set at rep_max and RPE ≤ target + 0.5 → + step_lb;
//   any set under rep_min, or RPE ≥ target + 1.5 → hold (− step_lb when the one before was short too);
//   otherwise the same weight, one more rep on the weakest set.
// No history: only the target (and the sheet's number). 14+ days since it was last done: about
// 90% of the last weight. Returns { kind, weight_lb, reps, reason }.
export function suggest(rx, exercise, history, { dayKey, now = new Date(), baseline = null }) {
  const step = Number(exercise.step_lb) || 5;
  const target = rx.rpe_target ?? 10;
  if (!history.length) {
    const sheet = baseline?.weight_lb != null ? ` · From your sheet: ${baseline.weight_lb} lb` : "";
    return { kind: "first", weight_lb: null, reps: rx.rep_min, reason: `First time: ${range(rx.reps)} @ RPE ${range(rx.rpe)}${sheet}` };
  }
  const same = history.filter((h) => h.day_key === dayKey);
  const [last, before] = same.length ? same : history;
  const top = (h) => Math.max(...h.sets.map((s) => Number(s.weight_lb) || 0));
  const days = (now - new Date(history[0].started_at)) / 864e5;
  if (days >= GAP_DAYS) {
    return { kind: "gap", weight_lb: roundTo(top(history[0]) * 0.9, step), reps: rx.rep_min, reason: `Back after ${Math.floor(days / 7)} weeks` };
  }
  const weight = top(last);
  const reps = last.sets.map((s) => s.reps);
  const short = (h) => h.sets.some((s) => s.reps < rx.rep_min || (s.rpe != null && s.rpe >= target + 1.5));
  if (last.sets.every((s) => s.reps >= rx.rep_max && (s.rpe == null || s.rpe <= target + 0.5))) {
    const n = reps.length;
    const sets = n === 1 ? "your set" : n === 2 ? "both sets" : `all ${n} sets`;
    return { kind: "up", weight_lb: weight + step, reps: rx.rep_min, reason: `You hit ${reps.join("/")} on ${sets}, +${step} lb` };
  }
  if (short(last)) {
    if (before && short(before)) return { kind: "down", weight_lb: weight - step, reps: rx.rep_min, reason: `Short two sessions in a row: ${weight - step} lb (−${step})` };
    const hard = last.sets.find((s) => s.rpe != null && s.rpe >= target + 1.5);
    const why = hard && !reps.some((r) => r < rx.rep_min) ? `RPE ${hard.rpe} last time, over ${target}` : `${reps.join("/")} last time, under ${rx.rep_min}`;
    return { kind: "hold", weight_lb: weight, reps: rx.rep_min, reason: `${why}: hold ${weight} lb` };
  }
  const aim = Math.min(rx.rep_max, Math.min(...reps) + 1);
  return { kind: "same", weight_lb: weight, reps: aim, reason: `Same weight, aim for ${aim}` };
}
