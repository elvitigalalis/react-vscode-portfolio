// Hevy's side of the Sheet (docs/sheet-hevy.md): the rows hevy-sync keeps from Hevy's API, a
// workout as a "ring workout" for the Gym habit block (ring.mjs gymMatches), PRs worked out from
// the synced history (Hevy's API marks none), the "Nice lift" text and the next routine. No
// network and no Deno, so node --test covers it; hevy-sync and telegram import it.
//
// Hevy's API (api.hevyapp.com/docs, v0.0.1): a Workout is { id, title, routine_id, start_time,
// end_time, updated_at, exercises: [{ index, title, exercise_template_id, sets: [{ index, type,
// weight_kg, reps, rpe }] }] }. Weights are always kg. Notes and descriptions are never kept.
import { localNow } from "./logic.mjs";
import { e1rm, E1RM_PR_MAX } from "./gym.mjs";

const SET_TYPES = ["normal", "warmup", "dropset", "failure"];
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const iso = (t) => {
  const ms = Date.parse(t ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
const id = (x) => (typeof x === "string" && x && x.length <= 64 ? x : null);

// Hevy's workouts as hevy_workouts and hevy_sets rows. `day` is his local day of the start. A
// workout missing its id, start or end (or ending before it starts) is skipped, as is a set with
// no exercise template; values outside the table's checks are dropped to null.
export function workoutRows(apiWorkouts, tz) {
  const workouts = [];
  const sets = [];
  for (const w of apiWorkouts ?? []) {
    const starts_at = iso(w?.start_time);
    const ends_at = iso(w?.end_time);
    if (!id(w?.id) || !starts_at || !ends_at || ends_at < starts_at) continue;
    workouts.push({
      id: w.id, title: clip(w.title, 200) || "Workout", routine_id: id(w.routine_id),
      day: localNow(new Date(starts_at), tz).day, starts_at, ends_at, updated_at: iso(w.updated_at) ?? ends_at,
    });
    for (const [ei, ex] of (w.exercises ?? []).entries()) {
      const template_id = id(ex?.exercise_template_id);
      if (!template_id) continue;
      for (const [si, s] of (ex.sets ?? []).entries()) {
        const weight = num(s?.weight_kg);
        const reps = num(s?.reps);
        const rpe = num(s?.rpe);
        sets.push({
          workout_id: w.id, exercise_index: Number.isInteger(ex.index) ? ex.index : ei, set_index: Number.isInteger(s?.index) ? s.index : si,
          template_id, exercise: clip(ex.title, 120) || "Exercise", set_type: SET_TYPES.includes(s?.type) ? s.type : "normal",
          weight_kg: weight != null && weight >= 0 && weight < 1000 ? weight : null,
          reps: reps != null && Number.isInteger(reps) && reps >= 0 && reps <= 1000 ? reps : null,
          rpe: rpe != null && rpe >= 1 && rpe <= 10 ? rpe : null,
        });
      }
    }
  }
  return { workouts, sets };
}

// The events endpoint's pages (each { events } or a plain list of events), flattened: each
// workout id once, as its newest event says. Events come newest first, so the first seen wins,
// and a delete beats an older update.
export function applyEvents(pages) {
  const seen = new Set();
  const updated = [];
  const deleted = [];
  for (const e of (pages ?? []).flatMap((p) => (Array.isArray(p) ? p : p?.events ?? []))) {
    const key = e?.type === "deleted" ? e.id : e?.workout?.id;
    if (typeof key !== "string" || seen.has(key)) continue;
    seen.add(key);
    if (e.type === "deleted") deleted.push(key);
    else if (e.type === "updated") updated.push(e.workout);
  }
  return { updated, deleted };
}

// hevy_workouts rows as the ring workouts gymMatches takes: every Hevy workout is lifting.
export const asRingWorkouts = (rows) => (rows ?? []).map((r) => ({ oura_id: r.id, day: r.day, starts_at: r.starts_at, ends_at: r.ends_at, activity: "strength" }));

// Kilograms in pounds, to the nearest half pound: 102.058 kg reads as 225.
export const toLb = (kg) => Math.round(kg * 2.20462 * 2) / 2;

// A weight in his unit ('kg' or 'lbs'; pounds unless he set kg), to a half pound or a tenth of a kg.
const inUnit = (kg, unit) => (unit === "kg" ? Math.round(kg * 10) / 10 : toLb(kg));
const prText = (p, unit) => {
  const w = inUnit(p.weight_kg, unit);
  const head = `${p.exercise} ${w} × ${p.reps}`;
  return p.kind === "e1rm" ? `${head} (e1RM ${Math.round(e1rm(w, p.reps).value)})` : head;
};

// Sets a record can come from (gym.mjs's rule): normal and failure sets of 1 to 12 reps with a weight.
const counts = (s) => (s.set_type === "normal" || s.set_type === "failure") && s.reps >= 1 && s.reps <= E1RM_PR_MAX && s.weight_kg > 0;
const e1rmKg = (s) => s.weight_kg * (1 + s.reps / 30);

// The PRs a workout set, one per exercise, in the workout's order: an e1RM above every earlier
// workout's best for that exercise template, else a heavier weight at a rep count done before.
// `sets` are the workout's hevy_sets rows, `historySets` the sets of the workouts before it (any
// of this workout's own are ignored). An exercise's first time is no PR. `unit` sets the text's.
export function prs(workout, sets, historySets, unit = "lbs") {
  const before = (historySets ?? []).filter((s) => s.workout_id !== workout?.id && counts(s));
  const mine = (sets ?? []).filter((s) => (s.workout_id == null || s.workout_id === workout?.id) && counts(s))
    .sort((a, b) => a.exercise_index - b.exercise_index || a.set_index - b.set_index);
  const out = [];
  for (const template of [...new Set(mine.map((s) => s.template_id))]) {
    const prior = before.filter((s) => s.template_id === template);
    if (!prior.length) continue;
    const here = mine.filter((s) => s.template_id === template);
    const best = here.reduce((a, s) => (e1rmKg(s) > e1rmKg(a) ? s : a));
    let pr = null;
    if (e1rmKg(best) > Math.max(...prior.map(e1rmKg)) + 1e-9) pr = { kind: "e1rm", set: best };
    else {
      for (const s of here) {
        const atReps = prior.filter((p) => p.reps === s.reps);
        if (atReps.length && s.weight_kg > Math.max(...atReps.map((p) => p.weight_kg)) && (!pr || s.weight_kg > pr.set.weight_kg)) pr = { kind: "weight", set: s };
      }
    }
    if (!pr) continue;
    const p = { exercise: pr.set.exercise, kind: pr.kind, weight_kg: pr.set.weight_kg, reps: pr.set.reps };
    out.push({ ...p, text: prText(p, unit) });
  }
  return out;
}

const length = (ms) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

// The Telegram text for a finished workout: "Nice lift · Push #2 · 1h 05m · 18 sets" (working
// sets, so not warm-ups), then "PRs: Bench Press 185 × 6 (e1RM 222)", at most 4.
export function workoutText(workout, sets, prList, unit = "lbs") {
  const working = (sets ?? []).filter((s) => s.set_type !== "warmup").length;
  const head = ["Nice lift", workout.title, length(Date.parse(workout.ends_at) - Date.parse(workout.starts_at)), `${working} set${working === 1 ? "" : "s"}`].join(" · ");
  const top = (prList ?? []).slice(0, 4);
  return top.length ? `${head}\nPRs: ${top.map((p) => (p.weight_kg != null ? prText(p, unit) : p.text)).join(", ")}` : head;
}

// The routine to do next: the one done right after the last time the last workout's routine was
// done before. Null when the last workout had no routine or that routine has no earlier time
// followed by a routine.
export function nextRoutine(workouts) {
  const w = [...(workouts ?? [])].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const last = w.at(-1);
  if (!last?.routine_id) return null;
  for (let i = w.length - 2; i >= 0; i--) {
    if (w[i].routine_id !== last.routine_id) continue;
    const next = w.slice(i + 1).find((x) => x.routine_id);
    return next ? { routine_id: next.routine_id, title: next.title } : null;
  }
  return null;
}
