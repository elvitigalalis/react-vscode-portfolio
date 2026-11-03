// The Claude Project's instructions (docs/sheet-claude.md) name only columns the schema has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SHEET } from "../src/site.mjs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const doc = read("docs/sheet-claude.md");
const schema = read("supabase/schema.sql");

// table → its columns, from `create table` bodies and `alter table … add column` lines.
function columns(sql) {
  const tables = {};
  for (const [, name, body] of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
    tables[name] = new Set(body.split("\n").map((l) => l.trim().match(/^(\w+) /)?.[1]).filter((c) => c && c !== "check"));
  }
  for (const [, name, col] of sql.matchAll(/alter table (\w+) add column if not exists (\w+)/g)) tables[name].add(col);
  return tables;
}

test("sheet-claude: every column it may read or write is in the schema", () => {
  const tables = columns(schema);
  const named = [...doc.matchAll(/^\| `(\w+)` \| (.+) \|$/gm)]
    .map(([, table, cols]) => [table, [...cols.matchAll(/`(\w+)`/g)].map((m) => m[1])]);
  const insert = doc.match(/insert into blocks \(([^)]+)\)/g).map((s) => ["blocks", s.match(/\(([^)]+)\)/)[1].split(", ")]);
  assert.ok(named.length >= 4);
  for (const [table, cols] of [...named, ...insert]) {
    assert.ok(tables[table], `no table ${table}`);
    for (const c of cols) assert.ok(tables[table].has(c), `${table}.${c} is not in schema.sql`);
  }
});

test("sheet-claude: its default shutdown time is the planner's", () => {
  assert.match(doc, new RegExp(`or ${SHEET.shutdownAt} when there's no row`));
});
