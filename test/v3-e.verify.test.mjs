// Verification tests for v3 ticket E (interest profile and campus picks), written from the
// contracts in docs/sheet-sources.md before the code. They start as `todo`; the implementer
// removes `todo` and must not change what they expect.
import { test } from "node:test";

const load = async () => {
  const { readFileSync } = await import("node:fs");
  const assert = (await import("node:assert/strict")).default;
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  return { assert, read, readFileSync };
};

// table → its columns, from `create table` bodies and `alter table … add column` lines
// (the same reading as test/sheet-claude.test.mjs).
function columns(sql) {
  const tables = {};
  for (const [, name, body] of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
    tables[name] = new Set(body.split("\n").map((l) => l.trim().match(/^(\w+) /)?.[1]).filter((c) => c && c !== "check"));
  }
  for (const [, name, col] of sql.matchAll(/alter table (\w+) add column if not exists (\w+)/g)) (tables[name] ??= new Set()).add(col);
  return tables;
}

// The "Campus picks" step of docs/sheet-claude.md: its heading through the next heading of the
// same or a higher level.
function campusSection(doc) {
  const m = doc.match(/^(#{2,4}) [^\n]*campus picks[^\n]*$/im);
  if (!m) return null;
  const rest = doc.slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`^#{1,${m[1].length}} `, "m"));
  return m[0] + (end < 0 ? rest : rest.slice(0, end));
}

// ---- Schema ---------------------------------------------------------------------------------

test("v3-e schema: settings.interests is added as text, safe to re-run", async () => {
  const { assert, read } = await load();
  const schema = read("supabase/schema.sql");
  assert.match(schema, /alter table settings add column if not exists interests text\b/);
  // Null until Lisul writes one: no default profile and no NOT NULL.
  const line = schema.match(/alter table settings add column if not exists interests text[^;]*;/)[0];
  assert.doesNotMatch(line, /not null|default/i, line);
  assert.equal(columns(schema).settings.has("interests"), true);
});

test("v3-e schema: settings stays owner-only, and no view exposes interests", async () => {
  const { assert, read } = await load();
  const schema = read("supabase/schema.sql");
  assert.match(schema, /alter table settings enable row level security;/);
  assert.match(schema, /create policy owner_all on settings for all using \(is_owner\(\)\) with check \(is_owner\(\)\);/);
  assert.match(schema, /revoke all on settings\b[^;]* from anon;/);
  const views = [...schema.matchAll(/create (?:or replace )?view (\w+) as([\s\S]*?);/g)];
  assert.ok(views.some(([, name]) => name === "public_now"), "views not found");
  for (const [, name, body] of views) {
    assert.doesNotMatch(body, /\binterests\b/, `${name} names interests`);
    assert.doesNotMatch(body, /\bselect\s+(\w+\.)?\*/, `${name} selects *`);
  }
  // Nothing grants settings itself to visitors.
  assert.doesNotMatch(schema, /grant [^;]*\bon (table )?([\w, ]*\b)?settings\b[^;]*\bto [^;]*\banon\b/);
});

test("v3-e schema: the seed row carries no interest profile", async () => {
  const { assert, read } = await load();
  const schema = read("supabase/schema.sql");
  for (const [stmt] of schema.matchAll(/(insert into settings|update settings)[^;]*;/g)) {
    assert.doesNotMatch(stmt, /\binterests\b/, stmt);
  }
});

// ---- /plan Settings -------------------------------------------------------------------------

// /plan's markup: the page source and every .astro file it imports, followed recursively.
async function planMarkup() {
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const root = new URL("..", import.meta.url).pathname;
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return "";
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const front = src.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const kids = [...front.matchAll(/import\s+\w+\s+from\s+"(\.[^"]+\.astro)"/g)]
      .map(([, p]) => resolve(dirname(file), p))
      .filter((p) => !/\/layouts\//.test(p));
    return src + "\n" + kids.map(walk).join("\n");
  };
  return walk(resolve(root, "src/pages/plan/index.astro"));
}

test("v3-e /plan: Settings has a labelled Interests textarea", async () => {
  const { assert } = await load();
  const html = await planMarkup();
  const areas = [...html.matchAll(/<textarea\b([^>]*)>/g)].map(([, attrs]) => ({
    attrs,
    id: attrs.match(/\bid="([^"]+)"/)?.[1],
  }));
  const labelled = areas.filter(({ attrs, id }) => {
    if (/\baria-label="[^"]*interest/i.test(attrs)) return true;
    if (!id) return false;
    return new RegExp(`<label\\b[^>]*\\bfor="${id}"[^>]*>[^<]*interest`, "i").test(html);
  });
  assert.equal(labelled.length, 1, "exactly one textarea labelled Interests");
  // Keyboard-reachable: not taken out of the tab order.
  assert.doesNotMatch(labelled[0].attrs, /tabindex="-1"/);
  assert.doesNotMatch(labelled[0].attrs, /\bdisabled\b/);
});

test("v3-e /plan: the Interests box has a Save button beside it", async () => {
  const { assert } = await load();
  const html = await planMarkup();
  const at = html.search(/<textarea\b[^>]*>/g);
  const id = [...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"[^>]*>[^<]*interest/gi)][0]?.[1];
  const start = id ? html.indexOf(`id="${id}"`) : html.search(/<textarea\b[^>]*aria-label="[^"]*interest/i);
  assert.ok(start >= 0 && at >= 0, "no Interests textarea");
  // From the textarea to the end of its dialog, section, form or details.
  const tail = html.slice(start);
  const end = tail.search(/<\/(dialog|section|form|details|fieldset)>/);
  const box = end < 0 ? tail : tail.slice(0, end);
  assert.match(box, /<button\b[^>]*>\s*Save\b[^<]*<\/button>/, "a Save <button> in the same box");
  assert.doesNotMatch(box.match(/<button\b[^>]*>\s*Save\b/)[0], /tabindex="-1"/);
});

test("v3-e /plan: saving writes settings.interests and says so", async () => {
  const { assert } = await load();
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/sheet/", import.meta.url);
  const sources = readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(new URL(f, dir), "utf8"));
  const code = sources.join("\n");
  // Saved through the existing settings PATCH, under the contract's column name.
  assert.match(code, /saveSettings\(\{[^}]*\binterests\b/, "saveSettings({ interests … })");
  // Loaded back into the box from the settings row.
  assert.match(code, /\.interests\b/, "reads settings.interests");
  // The function that saves it gives feedback (the status line or the toast).
  const save = code.match(/saveSettings\(\{[^}]*\binterests\b/);
  const before = code.slice(0, save.index);
  const fnStart = Math.max(before.lastIndexOf("\nasync function "), before.lastIndexOf("\nfunction "), before.lastIndexOf("\nconst "));
  const fnEnd = code.indexOf("\n}\n", save.index);
  const fn = code.slice(fnStart, fnEnd < 0 ? undefined : fnEnd);
  assert.match(fn, /setStatus\(|toast\(|Saved/, "save feedback");
});

// ---- docs/sheet-claude.md -------------------------------------------------------------------

test("v3-e sheet-claude: may read settings.interests and campus_events, all real columns", { todo: true }, async () => {
  const { assert, read } = await load();
  const doc = read("docs/sheet-claude.md");
  const tables = columns(read("supabase/schema.sql"));
  const rows = Object.fromEntries([...doc.matchAll(/^\| `(\w+)` \| (.+) \|$/gm)]
    .map(([, table, cols]) => [table, [...cols.matchAll(/`(\w+)`/g)].map((m) => m[1])]));
  assert.ok(rows.settings?.includes("interests"), "settings row lists `interests`");
  assert.ok(rows.campus_events?.length, "a `campus_events` row in What you may read");
  for (const c of ["title", "starts_at", "ends_at"]) assert.ok(rows.campus_events.includes(c), `campus_events.${c} readable`);
  for (const [table, cols] of Object.entries(rows)) {
    assert.ok(tables[table], `no table ${table}`);
    for (const c of cols) assert.ok(tables[table].has(c), `${table}.${c} is not in schema.sql`);
  }
  // Every `table.column` the doc names exists.
  for (const [, t, c] of doc.matchAll(/`(\w+)\.(\w+)`/g)) {
    if (tables[t]) assert.ok(tables[t].has(c), `${t}.${c} is not in schema.sql`);
  }
});

test("v3-e sheet-claude: the campus-picks query reads only real columns for day D", { todo: true }, async () => {
  const { assert, read } = await load();
  const section = campusSection(read("docs/sheet-claude.md"));
  assert.ok(section, "a Campus picks step heading");
  const tables = columns(read("supabase/schema.sql"));
  const selects = [...section.matchAll(/select ([\s\S]+?)\s+from (settings|campus_events)\b([\s\S]*?);/g)];
  const from = new Set(selects.map((m) => m[2]));
  assert.ok(from.has("campus_events"), "a select from campus_events");
  assert.ok(selects.some(([s]) => /\binterests\b/.test(s) && / from settings\b/.test(s)), "selects interests from settings");
  for (const [, cols, table, rest] of selects) {
    for (const part of cols.split(",")) {
      const col = part.trim().split(/\s+as\s+|\s+/i)[0].replace(/^\w+\./, "");
      if (/^\w+$/.test(col)) assert.ok(tables[table]?.has(col), `${table}.${col} is not in schema.sql`);
    }
    for (const [, c] of rest.matchAll(/\b(\w+)\s*(?:[<>=]|at time zone|is |::)/g)) {
      if (!/^(time|now|now_local|today|date|timestamp|interval|D|TZ|TODAY|and|or|not)$/i.test(c)) assert.ok(tables[table]?.has(c), `${table}.${c} is not in schema.sql`);
    }
  }
  const events = selects.find((m) => m[2] === "campus_events");
  assert.match(events[0], /starts_at/, "filters on starts_at");
  assert.match(events[0], /<D>/, "for the day being planned");
});

test("v3-e sheet-claude: campus picks name up to 5 events, one line each on why", { todo: true }, async () => {
  const { assert, read } = await load();
  const section = campusSection(read("docs/sheet-claude.md"));
  assert.ok(section, "a Campus picks step heading");
  assert.match(section, /\b(up to|at most|no more than) (5|five)\b/i);
  assert.match(section, /one line/i);
  assert.match(section, /\bwhy\b|\breason\b/i);
  assert.match(section, /settings\.interests|`interests`/);
  assert.match(section, /interest profile/i);
});

test("v3-e sheet-claude: free food and fitting around blocks count for an event", { todo: true }, async () => {
  const { assert, read } = await load();
  const section = campusSection(read("docs/sheet-claude.md"));
  assert.ok(section, "a Campus picks step heading");
  assert.match(section, /free food/i);
  assert.match(section, /\bblocks?\b/);
  assert.match(section, /(fits?|around|between|clash|overlap)/i);
  assert.match(section, /in (an event's|its) favou?r|counts? for|prefer/i);
});

test("v3-e sheet-claude: a campus pick is never written without Lisul's say-so", { todo: true }, async () => {
  const { assert, read } = await load();
  const doc = read("docs/sheet-claude.md");
  const section = campusSection(doc);
  assert.ok(section, "a Campus picks step heading");
  assert.match(section, /\btask\b/);
  assert.match(section, /\bblock\b/);
  assert.match(section, /only when (Lisul|he) says so|never [^.]*without (Lisul|his say)/i);
  // The step itself only reads.
  assert.doesNotMatch(section, /\b(insert into|update \w+ set|delete from)\b/i);
  // The write rules still allow only proposed blocks: nothing new is writable for campus events.
  const write = doc.match(/## What you may write[\s\S]*?(?=\n## )/)[0];
  assert.doesNotMatch(write, /campus_events|interests/);
  assert.doesNotMatch(doc, /(insert into|update|delete from) (campus_events|settings)\b/i);
  // Glossary words: a campus pick, never a suggestion or recommendation.
  assert.doesNotMatch(section, /\b(suggestion|recommendation)s?\b/i);
});

test("v3-e sheet-claude: the reply shows the campus picks", { todo: true }, async () => {
  const { assert, read } = await load();
  const doc = read("docs/sheet-claude.md");
  const reply = doc.slice(doc.search(/^## Reply$/m));
  assert.match(reply, /campus picks?/i);
});

// ---- The draft interest profile stays out of the public repo --------------------------------

test("v3-e: no draft interest profile is committed anywhere in the repo", async () => {
  const { assert } = await load();
  const { readFileSync, statSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const root = new URL("..", import.meta.url).pathname;
  const self = new URL(import.meta.url).pathname;
  const list = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter((f) => f && !f.startsWith("node_modules") && !f.startsWith("dist/"));
  // Built from parts so this file doesn't match itself.
  const words = ["interest", "profile"];
  const markers = [
    new RegExp(`${words.join(" ")}\\s*[(:—-]*\\s*draft`, "i"),
    new RegExp(`draft(ed)?\\s+(of\\s+)?(the\\s+)?${words.join(" ")}`, "i"),
  ];
  const hits = [];
  for (const f of list) {
    const path = join(root, f);
    if (path === self) continue;
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || st.size > 2_000_000) continue;
    const text = readFileSync(path, "utf8");
    if (text.includes("\0")) continue;
    if (markers.some((m) => m.test(text))) hits.push(f);
  }
  assert.deepEqual(hits, []);
});
