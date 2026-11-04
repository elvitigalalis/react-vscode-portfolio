#!/usr/bin/env node
// The Gym tracker's program, as SQL (docs/sheet-gym.md, "Deploy"). The program and his starting
// numbers are kept off this public repo (a copyrighted sheet and personal data), so this reads
// them from local JSON files and prints SQL for supabase/schema.sql's gym tables:
//   node tools/gym-seed.mjs <program.json> [<baselines.json>] > seed.sql
// then run seed.sql in the Supabase SQL editor (or psql). Re-running adds nothing twice: days are
// matched on (phase, week, day_key), slots on (day, position), exercises on name, and a baseline
// he confirmed is never overwritten.
//
// program.json: { program: "… Phase 2", phase?, weeks: [{ week, days: [{ key, name, exercises:
//   [{ order, name, warmup_sets, working_sets, reps, rpe, rest?, rest_min_s?, rest_max_s?, subs }] }] }] }
// baselines.json: { "<exercise name>": { best_weight_lb, note_on_meaning } }
// Only those fields are read: notes, logged loads and raw cells never reach the SQL.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const nums = (text) => (String(text ?? "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

// A slot's reps, RPE and rest as numbers: "5-7" → 5, 7; RPE "8-9" → 8.5 (the middle); rest
// "~2-3 min" → 120, 180 seconds, unless the file gives the seconds.
export function parseSlot(x) {
  const [rmin, rmax = rmin] = nums(x.reps);
  const rpe = nums(x.rpe);
  const [smin, smax = smin] = nums(x.rest).map((m) => m * 60);
  return {
    rep_min: rmin ?? null,
    rep_max: rmax ?? null,
    rpe_target: rpe.length ? (Math.min(...rpe) + Math.max(...rpe)) / 2 : null,
    rest_min_s: x.rest_min_s ?? smin ?? null,
    rest_max_s: x.rest_max_s ?? smax ?? null,
  };
}

// A 45 lb bar for barbell lifts, for the plate chip; none for dumbbells, machines and the Smith
// machine. He can change it in the table.
export const barFor = (name) =>
  /\b(barbell|bench press|deadlift|pendlay row|squat)\b/i.test(name) && !/\b(db|dumbbell|smith|machine|hack|cable|leg press)\b/i.test(name) ? 45 : null;

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lit = (v, type) => `${v == null || v === "" ? "null" : type === "text" ? q(v) : Number(v)}::${type}`;

export function seedSql(program, baselines = {}) {
  const phase = program.phase ?? nums(String(program.program).match(/phase\s*\d+/i)?.[0]).at(0) ?? 1;
  const days = [];
  const slots = [];
  const names = new Set();
  for (const w of program.weeks) {
    w.days.forEach((d, i) => {
      days.push(`(${phase}, ${Number(w.week)}, ${q(d.key)}, ${q(d.name)}, ${i + 1})`);
      for (const x of d.exercises) {
        const [sub1 = null, sub2 = null] = x.subs ?? [];
        for (const n of [x.name, sub1, sub2]) if (n) names.add(n);
        const p = parseSlot(x);
        slots.push(`(${[lit(w.week, "int"), lit(d.key, "text"), lit(x.order, "int"), lit(x.name, "text"), lit(x.warmup_sets, "text"),
          lit(x.working_sets, "int"), lit(x.reps, "text"), lit(p.rep_min, "int"), lit(p.rep_max, "int"), lit(x.rpe, "text"),
          lit(p.rpe_target, "numeric"), lit(p.rest_min_s, "int"), lit(p.rest_max_s, "int"), lit(sub1, "text"), lit(sub2, "text")].join(", ")})`);
      }
    });
  }
  const base = Object.entries(baselines)
    .filter(([name, b]) => names.has(name) && b?.best_weight_lb != null)
    .map(([name, b]) => `(${lit(name, "text")}, ${lit(b.best_weight_lb, "numeric")}, ${lit(String(b.note_on_meaning ?? "").slice(0, 500), "text")})`);

  const out = ["begin;"];
  out.push(`insert into gym_exercises (name, bar_lb) values\n  ${[...names].map((n) => `(${q(n)}, ${barFor(n) ?? "null"})`).join(",\n  ")}\non conflict (name) do nothing;`);
  out.push(`insert into gym_program_days (phase, week, day_key, name, position) values\n  ${days.join(",\n  ")}\non conflict (phase, week, day_key) do update set name = excluded.name, position = excluded.position;`);
  if (slots.length) out.push(`insert into gym_prescriptions (program_day_id, position, exercise_id, warmup_sets, working_sets, reps, rep_min, rep_max, rpe, rpe_target, rest_min_s, rest_max_s, sub1_exercise_id, sub2_exercise_id)
select d.id, x.position, e.id, x.warmup_sets, x.working_sets, x.reps, x.rep_min, x.rep_max, x.rpe, x.rpe_target, x.rest_min_s, x.rest_max_s, s1.id, s2.id
from (values
  ${slots.join(",\n  ")}
) as x(week, day_key, position, exercise, warmup_sets, working_sets, reps, rep_min, rep_max, rpe, rpe_target, rest_min_s, rest_max_s, sub1, sub2)
join gym_program_days d on d.phase = ${phase} and d.week = x.week and d.day_key = x.day_key
join gym_exercises e on e.name = x.exercise
left join gym_exercises s1 on s1.name = x.sub1
left join gym_exercises s2 on s2.name = x.sub2
where not exists (select 1 from gym_prescriptions p where p.program_day_id = d.id and p.position = x.position);`);
  if (base.length) out.push(`insert into gym_baselines (exercise_id, weight_lb, note)
select e.id, x.weight_lb, x.note
from (values
  ${base.join(",\n  ")}
) as x(name, weight_lb, note)
join gym_exercises e on e.name = x.name
on conflict (exercise_id) do update set weight_lb = excluded.weight_lb, note = excluded.note
where not gym_baselines.confirmed;`);
  out.push("commit;");
  return `${out.join("\n\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [programPath, baselinesPath] = process.argv.slice(2);
  if (!programPath) {
    console.error("usage: node tools/gym-seed.mjs <program.json> [<baselines.json>] > seed.sql");
    process.exit(2);
  }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  process.stdout.write(seedSql(read(programPath), baselinesPath ? read(baselinesPath) : {}));
}
