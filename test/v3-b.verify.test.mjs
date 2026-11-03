// Verification tests for v3 ticket B, course tasks from Brightspace (issue 23), written from the
// contracts in docs/sheet-sources.md before the code. They start as `todo`; the implementer removes
// `todo` and makes them pass without changing what they expect.
//
// Choices where the contract leaves a shape open (pinned here, so the code follows them):
// - `seen` going in is an array of UID strings (feed_seen rows for source 'brightspace').
// - `seen` coming out lists the UIDs to add to feed_seen: exactly the UIDs of `insert`. Either
//   strings or `{ source, uid }` rows are accepted.
// - Each `update` entry is `{ id, title, due }`: the task's id and its new title and due date.
// - A course task's title is the item's SUMMARY without D2L's type suffix ("Lab 5 - Due" ->
//   "Lab 5"); items that aren't a due date (class meetings, start dates) are skipped. A timed
//   item's due date is the local date of its start (Brightspace due items start and end at the
//   due time). (Changed with the Brightspace noise fix: the titles below lost their " - Due".)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const readIf = (f) => (existsSync(new URL(`../${f}`, import.meta.url)) ? read(f) : "");
const TZ = "America/New_York";

// A parseIcs event (src/sheet/ical.mjs) as Brightspace sends it: due items start and end at the
// due instant; all-day items carry dated strings.
const timed = (uid, summary, at) => ({ uid, summary, description: "", location: "CSE 416.01 - Fall 2026", url: "", categories: [], start: at, end: at, allDay: false });
const allDay = (uid, summary, day, next) => ({ uid, summary, description: "", location: "CSE 416.01 - Fall 2026", url: "", categories: [], start: day, end: next, allDay: true });
// An existing course task, as /plan or the function reads it back from `tasks`.
const task = (id, uid, title, due, done = false) => ({ id, title, day: null, list: "Brightspace", position: 0, due, done, public: false, source: "brightspace", source_uid: uid });

// The columns of `tasks` in schema.sql (create table body plus `add column` lines), so an insert
// row may carry only real columns.
function columns(sql) {
  const tables = {};
  for (const [, name, body] of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
    tables[name] = new Set(body.split("\n").map((l) => l.trim().match(/^(\w+) /)?.[1]).filter((c) => c && !["check", "primary", "unique", "constraint"].includes(c)));
  }
  for (const [, name, col] of sql.matchAll(/alter table (\w+) add column if not exists (\w+)/g)) (tables[name] ??= new Set()).add(col);
  return tables;
}

// A new course task row: the fields the contract fixes, and nothing that isn't a tasks column.
function assertInsertRow(row, { uid, title, due }) {
  const expected = { title, day: null, list: "Brightspace", due, public: false, source: "brightspace", source_uid: uid };
  const got = Object.fromEntries(Object.keys(expected).map((k) => [k, row[k]]));
  assert.deepEqual(got, expected);
  assert.equal(row.id, undefined, "the database makes the id");
  if ("done" in row) assert.equal(row.done, false);
  const cols = columns(read("supabase/schema.sql")).tasks;
  for (const k of Object.keys(row)) assert.ok(cols.has(k), `insert row key ${k} is not a tasks column`);
}

const seenUids = (seen) => seen.map((s) => (typeof s === "string" ? s : s.uid)).sort();

// --- courseTaskChanges (src/sheet/feeds.mjs) -------------------------------------------------

test("course tasks: a new UID becomes a private task in the Brightspace list, due that local day", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  // 18:00 UTC on Nov 9 is 1 pm EST on Nov 9.
  const out = courseTaskChanges([timed("6606-1@d2l", "Lab 5 - Due", "2026-11-09T18:00:00.000Z")], { tasks: [], seen: [], timeZone: TZ });
  assert.equal(out.insert.length, 1);
  assertInsertRow(out.insert[0], { uid: "6606-1@d2l", title: "Lab 5", due: "2026-11-09" });
  assert.deepEqual(out.update, []);
  assert.deepEqual(seenUids(out.seen), ["6606-1@d2l"]);
  if (out.seen[0] && typeof out.seen[0] === "object") assert.equal(out.seen[0].source, "brightspace");
});

test("course tasks: a timed item just before midnight New York time is due on its local date, not the UTC one", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const events = [
    timed("a", "Homework 6 - Due", "2026-11-06T04:59:00.000Z"), // 11:59 pm EST, Nov 5
    timed("b", "Essay 2 - Due", "2026-10-30T03:59:00.000Z"), // 11:59 pm EDT, Oct 29
    timed("c", "Reading quiz - Due", "2026-11-06T05:00:00.000Z"), // midnight EST, Nov 6
    timed("d", "Lab 6 - Due", "2026-11-02T04:30:00.000Z"), // 11:30 pm EST, Nov 1 (the day clocks fell back)
  ];
  const out = courseTaskChanges(events, { tasks: [], seen: [], timeZone: TZ });
  const due = Object.fromEntries(out.insert.map((r) => [r.source_uid, r.due]));
  assert.deepEqual(due, { a: "2026-11-05", b: "2026-10-29", c: "2026-11-06", d: "2026-11-01" });
});

test("course tasks: the due date follows the time zone passed in", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const events = [timed("a", "Homework 6 - Due", "2026-11-06T04:59:00.000Z")];
  assert.equal(courseTaskChanges(events, { tasks: [], seen: [], timeZone: "UTC" }).insert[0].due, "2026-11-06");
  assert.equal(courseTaskChanges(events, { tasks: [], seen: [], timeZone: "America/Los_Angeles" }).insert[0].due, "2026-11-05");
});

test("course tasks: an all-day item is due on its date", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const out = courseTaskChanges([allDay("m2", "Project milestone 2 - Due", "2026-11-13", "2026-11-14")], { tasks: [], seen: [], timeZone: TZ });
  assertInsertRow(out.insert[0], { uid: "m2", title: "Project milestone 2", due: "2026-11-13" });
  // The date stays put whatever the zone: it's a date, not an instant.
  assert.equal(courseTaskChanges([allDay("m2", "x - Due", "2026-11-13", "2026-11-14")], { tasks: [], seen: [], timeZone: "Pacific/Auckland" }).insert[0].due, "2026-11-13");
});

test("course tasks: a seen UID with an undone task updates its title and due date", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const tasks = [task("t1", "hw6", "Homework 6", "2026-11-05")];
  // Moved two days later and renamed.
  const out = courseTaskChanges([timed("hw6", "Homework 6 (extended) - Due", "2026-11-08T04:59:00.000Z")], { tasks, seen: ["hw6"], timeZone: TZ });
  assert.deepEqual(out.insert, []);
  assert.deepEqual(out.update, [{ id: "t1", title: "Homework 6 (extended)", due: "2026-11-07" }]);
  assert.deepEqual(out.seen, []);
});

test("course tasks: a seen UID whose task was deleted never comes back", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const out = courseTaskChanges([timed("gone", "Discussion 3 - Due", "2026-11-07T04:59:00.000Z")], { tasks: [], seen: ["gone"], timeZone: TZ });
  assert.deepEqual(out, { insert: [], update: [], seen: [] });
});

test("course tasks: a done task is left alone, even when Brightspace moves it", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const tasks = [task("t2", "q4", "Quiz 4", "2026-11-10", true)];
  const out = courseTaskChanges([timed("q4", "Quiz 4 - retake - Due", "2026-11-12T04:59:00.000Z")], { tasks, seen: ["q4"], timeZone: TZ });
  assert.deepEqual(out, { insert: [], update: [], seen: [] });
});

test("course tasks: an item that drops out of the feed is left alone", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const tasks = [task("t3", "old", "Homework 5 - Due", "2026-10-29")];
  const out = courseTaskChanges([], { tasks, seen: ["old"], timeZone: TZ });
  assert.deepEqual(out, { insert: [], update: [], seen: [] });
  assert.equal(Object.keys(out).length, 3, "no delete list: sync never deletes");
});

test("course tasks: a UID listed twice in one feed is inserted once", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const e = timed("dup", "Lab 7 - Due", "2026-11-14T04:59:00.000Z");
  const out = courseTaskChanges([e, { ...e }], { tasks: [], seen: [], timeZone: TZ });
  assert.equal(out.insert.length, 1);
  assertInsertRow(out.insert[0], { uid: "dup", title: "Lab 7", due: "2026-11-13" });
  assert.deepEqual(seenUids(out.seen), ["dup"]);
});

test("course tasks: hand-made tasks are never touched", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const mine = { id: "h1", title: "Homework 6 - Due", day: "2026-11-04", list: null, position: 1, due: "2026-11-05", done: false, public: true, source: null, source_uid: null };
  const out = courseTaskChanges([timed("hw6", "Homework 6 - Due", "2026-11-06T04:59:00.000Z")], { tasks: [mine], seen: [], timeZone: TZ });
  assert.deepEqual(out.update, []);
  assert.equal(out.insert.length, 1, "the feed item is new; a matching title doesn't make it seen");
});

test("course tasks: one run mixes every case", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const tasks = [
    task("t1", "moved", "Homework 6", "2026-11-05"),
    task("t2", "done", "Quiz 4", "2026-11-10", true),
    task("t3", "dropped", "Homework 5 - Due", "2026-10-29"),
  ];
  const events = [
    timed("moved", "Homework 6 - Due", "2026-11-07T04:59:00.000Z"), // now Nov 6
    timed("done", "Quiz 4 - Due", "2026-11-12T04:59:00.000Z"),
    timed("deleted", "Discussion 3 - Due", "2026-11-07T04:59:00.000Z"),
    timed("new", "Lab 8 - Due", "2026-11-20T04:59:00.000Z"), // Nov 19
  ];
  const out = courseTaskChanges(events, { tasks, seen: ["moved", "done", "dropped", "deleted"], timeZone: TZ });
  assert.equal(out.insert.length, 1);
  assertInsertRow(out.insert[0], { uid: "new", title: "Lab 8", due: "2026-11-19" });
  assert.deepEqual(out.update, [{ id: "t1", title: "Homework 6", due: "2026-11-06" }]);
  assert.deepEqual(seenUids(out.seen), ["new"]);
});

test("course tasks: the Brightspace fixture, parsed, gives four tasks with the right due dates, skipping the rest", async () => {
  const { parseIcs } = await import("../src/sheet/ical.mjs");
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const events = parseIcs(read("test/fixtures/brightspace-b.ics"), { from: "2026-11-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
  const out = courseTaskChanges(events, { tasks: [], seen: [], timeZone: TZ });
  const rows = Object.fromEntries(out.insert.map((r) => [r.source_uid, [r.title, r.due]]));
  assert.deepEqual(rows, {
    "6606-1051234@mycourses.example.edu": ["Homework 6", "2026-11-05"], // 04:59Z = 11:59 pm EST the day before
    "6606-1051235@mycourses.example.edu": ["Quiz 4", "2026-11-10"], // TZID local 11:59 pm; Availability Ends, no Due
    "6606-1051236@mycourses.example.edu": ["Project milestone 2", "2026-11-13"], // VALUE=DATE
    "6606-1051240@mycourses.example.edu": ["Discussion 2", "2026-11-12"], // the Due, not its End Date
  });
  // Skipped: Quiz 4's Availability Starts, Discussion 2's End Date, the recitation and the holiday.
});

test("course tasks: a new course task gets the due chip and the at-risk mark like any task", async () => {
  const { courseTaskChanges } = await import("../src/sheet/feeds.mjs");
  const { atRisk, dueLabel } = await import("../src/sheet/logic.mjs");
  const [row] = courseTaskChanges([timed("hw", "Homework 6 - Due", "2026-11-06T04:59:00.000Z")], { tasks: [], seen: [], timeZone: TZ }).insert;
  const saved = { id: "t9", done: false, ...row };
  assert.equal(dueLabel(saved.due, "2026-11-04"), "due Thu");
  assert.equal(atRisk(saved, [], "2026-11-04", TZ), true);
  assert.equal(atRisk(saved, [{ task_id: "t9", proposed: false, starts_at: "2026-11-05T15:00:00.000Z" }], "2026-11-04", TZ), false);
});

// --- Schema (supabase/schema.sql) --------------------------------------------------------------

const schema = () => read("supabase/schema.sql");
const tableBody = (sql, name) => sql.match(new RegExp(`create table if not exists ${name} \\(([\\s\\S]*?)\\n\\);`))?.[1];

test("schema: tasks gains source and source_uid, unique together, added re-runnably", async () => {
  const sql = schema();
  assert.match(sql, /alter table tasks add column if not exists source text\b/);
  assert.match(sql, /alter table tasks add column if not exists source_uid text\b/);
  const uniqueIndex = /create unique index if not exists \w+ on tasks \(source, source_uid\)/;
  const uniqueConstraint = /alter table tasks[\s\S]{0,200}unique (nulls not distinct )?\(source, source_uid\)/;
  assert.ok(uniqueIndex.test(sql) || uniqueConstraint.test(sql), "a unique index or constraint on (source, source_uid)");
  if (!uniqueIndex.test(sql)) assert.match(sql, /drop constraint if exists|if not exists \(select[\s\S]{0,200}pg_constraint/, "an added constraint must be re-runnable");
});

test("schema: feed_seen keys a UID by its source, and feed_state has one row per feed", async () => {
  const sql = schema();
  const seen = tableBody(sql, "feed_seen");
  assert.ok(seen, "create table if not exists feed_seen");
  assert.match(seen, /\bsource text\b/);
  assert.match(seen, /\buid text\b/);
  assert.match(seen, /\bseen_at timestamptz\b/);
  assert.match(seen, /primary key \(source, uid\)/);
  const state = tableBody(sql, "feed_state");
  assert.ok(state, "create table if not exists feed_state");
  assert.match(state, /\bsource text primary key\b/);
  for (const col of ["etag text", "last_modified text", "fetched_at timestamptz", "ok boolean", "error text", "items int"])
    assert.match(state, new RegExp(`\\b${col}\\b`), `feed_state.${col}`);
});

test("schema: feed_seen and feed_state are owner-only under row-level security", async () => {
  const sql = schema();
  for (const t of ["feed_seen", "feed_state"]) {
    assert.match(sql, new RegExp(`alter table ${t} enable row level security;`), `${t} RLS`);
    const policy = sql.match(new RegExp(`create policy (\\w+) on ${t} for all using \\(is_owner\\(\\)\\) with check \\(is_owner\\(\\)\\);`));
    assert.ok(policy, `${t} has an is_owner() policy`);
    assert.match(sql, new RegExp(`drop policy if exists ${policy[1]} on ${t};`), `${t} policy is dropped before it is made`);
    assert.ok(sql.indexOf(`drop policy if exists ${policy[1]} on ${t};`) < sql.indexOf(policy[0]));
  }
});

test("schema: the whole file stays safe to re-run", async () => {
  const sql = schema();
  assert.equal([...sql.matchAll(/create table (?!if not exists)/g)].length, 0, "every create table has if not exists");
  assert.equal([...sql.matchAll(/create (unique )?index (?!if not exists)/g)].length, 0, "every create index has if not exists");
  assert.equal([...sql.matchAll(/add column (?!if not exists)/g)].length, 0, "every add column has if not exists");
  for (const [stmt, name, table] of sql.matchAll(/create policy (\w+) on (\w+)/g))
    assert.ok(sql.indexOf(`drop policy if exists ${name} on ${table};`) > -1 && sql.indexOf(`drop policy if exists ${name} on ${table};`) < sql.indexOf(stmt), `${stmt} is dropped first`);
  for (const [, job] of sql.matchAll(/cron\.schedule\('([\w-]+)'/g))
    assert.match(sql, new RegExp(`cron\\.unschedule\\(jobid\\) from cron\\.job where jobname = '${job}'`), `${job} is unscheduled first`);
});

test("schema: the public views never select source or source_uid", async () => {
  const sql = schema();
  const views = [...sql.matchAll(/create or replace view (public_\w+) as([\s\S]*?);/g)];
  assert.deepEqual(views.map((v) => v[1]).sort(), ["public_days", "public_now", "public_week"]);
  for (const [, name, body] of views) {
    assert.doesNotMatch(body, /\bsource(_uid)?\b/, `${name} names source`);
    assert.doesNotMatch(body, /\bselect\s+(\w+\.)?\*/, `${name} selects *`);
    assert.doesNotMatch(body, /feed_seen|feed_state/, `${name} reads a feed table`);
  }
});

test("schema: sheet-brightspace runs at minute 20 through Vault, and does nothing until Vault has its entries", async () => {
  const sql = schema();
  const job = sql.match(/select cron\.schedule\('sheet-brightspace', '([^']+)', \$job\$([\s\S]*?)\$job\$\);/);
  assert.ok(job, "a sheet-brightspace cron job");
  assert.equal(job[1], "20 * * * *");
  const body = job[2];
  assert.match(body, /net\.http_post\(/);
  assert.match(body, /url := \(select decrypted_secret from vault\.decrypted_secrets where name = 'sheet_brightspace_url'\)/);
  assert.match(body, /'x-sheet-cron',\s*\(select decrypted_secret from vault\.decrypted_secrets where name = 'sheet_cron_secret'\)/);
  assert.match(body, /where exists \(select 1 from vault\.decrypted_secrets where name = 'sheet_cron_secret'\)/);
  assert.match(body, /exists \(select 1 from vault\.decrypted_secrets where name = 'sheet_brightspace_url'\)/);
  assert.ok(sql.indexOf("jobname = 'sheet-brightspace'") < sql.indexOf(job[0]), "unscheduled before it is scheduled");
});

// --- The brightspace Edge Function (supabase/functions/brightspace/index.ts) -------------------

// The function's source followed by the supabase/functions/_shared helpers it imports, since
// those hold its env reads, secret check and database calls (the shared-helpers fix).
const withShared = (src) => [src, ...[...src.matchAll(/from ["']\.\.\/_shared\/([\w.-]+)["']/g)].map((m) => read(`supabase/functions/_shared/${m[1]}`))].join("\n");
const fn = () => withShared(read("supabase/functions/brightspace/index.ts"));

test("function: it lets in only the cron, comparing the secret in constant time", async () => {
  const src = fn();
  assert.match(src, /["']x-sheet-cron["']/);
  assert.match(src, /["']SHEET_CRON_SECRET["']/);
  // Either a hand-rolled XOR loop (like telegram's secretMatches) or a library timing-safe equal.
  assert.match(src, /timingSafeEqual|\|=\s*\(?[^;\n]*\^/, "a constant-time compare");
  assert.doesNotMatch(src, /(===|!==|==|!=)\s*CRON_SECRET\b|\bCRON_SECRET\s*(===|!==|==|!=)/, "no plain comparison against the secret");
  assert.match(src, /status:\s*403|status:\s*401/, "a wrong secret is refused");
});

test("function: it fetches SHEET_BRIGHTSPACE_ICS and uses the shared pure modules", async () => {
  const src = fn();
  assert.match(src, /["']SHEET_BRIGHTSPACE_ICS["']/);
  assert.match(src, /import\s*\{[^}]*\bparseIcs\b[^}]*\}\s*from\s*["'](\.\.\/)+src\/sheet\/ical\.mjs["']/);
  assert.match(src, /import\s*\{[^}]*\bcourseTaskChanges\b[^}]*\}\s*from\s*["'](\.\.\/)+src\/sheet\/feeds\.mjs["']/);
  assert.match(src, /\bparseIcs\(/);
  assert.match(src, /\bcourseTaskChanges\(/);
});

test("function: it writes tasks, feed_seen and feed_state, recording a failure", async () => {
  const src = fn();
  assert.match(src, /feed_state/);
  assert.match(src, /feed_seen/);
  assert.match(src, /["'`]tasks\b/);
  for (const col of ["fetched_at", "ok", "error", "items"]) assert.match(src, new RegExp(`\\b${col}\\b`), `feed_state.${col} is written`);
  assert.match(src, /catch\s*\(/, "a failure is caught so it can be recorded");
  assert.match(src, /["']brightspace["']/, "rows carry source 'brightspace'");
});

test("function and schema: no secret or feed link is written into the repo", async () => {
  for (const f of ["supabase/functions/brightspace/index.ts", "supabase/schema.sql", "src/sheet/feeds.mjs", "src/sheet/api.mjs"]) {
    const src = readIf(f);
    assert.ok(src, `${f} exists`);
    assert.doesNotMatch(src, /https?:\/\/[^\s"'`]*(d2l|brightspace|mycourses)[^\s"'`]*/i, `${f} holds a Brightspace link`);
    assert.doesNotMatch(src, /[?&]token=[\w-]{8,}/, `${f} holds a feed token`);
    assert.doesNotMatch(src, /\beyJ[\w-]{20,}\.[\w-]{20,}/, `${f} holds a JWT`);
    assert.doesNotMatch(src, /sb_secret_\w+/, `${f} holds a Supabase secret key`);
    assert.doesNotMatch(src, /["'][A-Za-z0-9+/_-]{40,}["']/, `${f} holds a long key-like literal`);
  }
});

// --- /plan Settings: Feeds status ---------------------------------------------------------------

// The planner's client code: the page and every src/sheet module except /now's.
const planSources = () => ["src/pages/plan/index.astro",
  ...readdirSync(new URL("../src/sheet/", import.meta.url)).filter((f) => f.endsWith(".mjs") && f !== "public.mjs").map((f) => `src/sheet/${f}`)]
  .map((f) => [f, read(f)]);

test("/plan: Settings shows a Feeds status read from feed_state", async () => {
  const all = planSources().map(([, s]) => s).join("\n");
  assert.match(read("src/sheet/api.mjs"), /["'`]feed_state\b/, "api.mjs reads feed_state");
  assert.match(all, /Feeds/, "a Feeds heading in Settings");
  // Each row's last fetch, whether it worked, and its item count.
  assert.match(all, /\bfetched_at\b/);
  assert.match(all, /\.ok\b|\bok\b/);
  assert.match(all, /\.error\b/);
  assert.match(all, /\.items\b/);
});

test("/now never reads the feed tables", async () => {
  for (const f of ["src/pages/now/index.astro", "src/sheet/public.mjs"]) assert.doesNotMatch(read(f), /feed_state|feed_seen|source_uid/, f);
});
