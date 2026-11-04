// tools/gym-seed.mjs (docs/sheet-gym.md, "Deploy"): a program JSON and a baselines JSON, kept off
// the repo, become SQL for the gym tables. The fixtures are made up; tools/test-schema.sh runs
// the same SQL on a real Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { seedSql, parseSlot, barFor } from "../tools/gym-seed.mjs";

const fixture = (f) => JSON.parse(readFileSync(new URL(`fixtures/gym/${f}`, import.meta.url), "utf8"));
const sql = seedSql(fixture("program.json"), fixture("baselines.json"));

test("gym-seed: a slot's ranges become numbers", () => {
  assert.deepEqual(parseSlot({ reps: "5-7", rpe: "8-9", rest: "~2-3 min" }), { rep_min: 5, rep_max: 7, rpe_target: 8.5, rest_min_s: 120, rest_max_s: 180 });
  assert.deepEqual(parseSlot({ reps: "6", rpe: "10", rest: "~3 min" }), { rep_min: 6, rep_max: 6, rpe_target: 10, rest_min_s: 180, rest_max_s: 180 });
  assert.deepEqual(parseSlot({ reps: "AMRAP", rpe: "", rest: "", rest_min_s: 90, rest_max_s: 90 }), { rep_min: null, rep_max: null, rpe_target: null, rest_min_s: 90, rest_max_s: 90 });
});

test("gym-seed: barbell lifts get a 45 lb bar, others none", () => {
  assert.equal(barFor("Barbell Thing Row"), 45);
  assert.equal(barFor("Bench Press"), 45);
  assert.equal(barFor("DB Bench Press"), null);
  assert.equal(barFor("Smith Machine Squat"), null);
  assert.equal(barFor("Widget Press"), null);
});

test("gym-seed: every exercise and substitute, every day, every slot", () => {
  for (const name of ["'Widget Press'", "'Gadget Press'", "'O''Brien Machine Press'", "'Barbell Thing Row'", "'Gizmo Pulldown'"])
    assert.ok(sql.includes(name), name);
  assert.match(sql, /insert into gym_program_days[^;]*\(3, 1, 'push1', 'Push #1', 1\)[^;]*\(3, 2, 'pull1', 'Pull #1', 2\)/);
  assert.equal(sql.match(/\(1::int, 'push1'::text, 1::int, 'Widget Press'/g).length, 1);
  assert.match(sql, /\(2::int, 'push1'::text, 1::int, 'Widget Press'::text, '2-3'::text, 2::int, '5-7'::text, 5::int, 7::int, '8-9'::text, 8.5::numeric, 120::int, 180::int, 'Gadget Press'::text, 'O''Brien Machine Press'::text\)/);
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\n$/);
});

test("gym-seed: baselines only with a number, for exercises in the program, never overwriting a confirmed one", () => {
  assert.match(sql, /\('Widget Press'::text, 125::numeric, 'Read as 125 total\.'::text\)/);
  assert.doesNotMatch(sql, /Gizmo Pulldown'::text, null/);
  assert.doesNotMatch(sql, /Not In The Program/);
  assert.match(sql, /where not gym_baselines\.confirmed/);
});

test("gym-seed: no notes, raw cells or his logged numbers in the output", () => {
  assert.doesNotMatch(sql, /SECRET/);
});

test("gym-seed: the command line prints the SQL, and says how to use it without arguments", () => {
  const cmd = (...args) => spawnSync(process.execPath, [new URL("../tools/gym-seed.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" });
  const ok = cmd(new URL("fixtures/gym/program.json", import.meta.url).pathname, new URL("fixtures/gym/baselines.json", import.meta.url).pathname);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, sql);
  const none = cmd();
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /usage/i);
});
