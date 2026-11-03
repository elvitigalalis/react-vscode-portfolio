// Verification tests for v3 ticket C, campus events sync (issue 24; contracts in
// docs/sheet-sources.md). Written before the code, from the contract and from real SB Engaged
// VEVENTs. They start as `todo`; the implementer removes `todo` and must not change what they expect.
//
// Input to campusRows is parseIcs output (`{ uid, summary, description, location, url, categories,
// start, end, allDay }`). Two choices the contract leaves open are pinned here:
// - Group: parseIcs adds `organizer`, the ORGANIZER line's CN without quotes. With no organizer,
//   group_name falls back to the `club_acronym:` category.
// - Categories: SB Engaged writes `CATEGORIES;X-CG-CATEGORY=event_type:Meeting` and
//   `CATEGORIES;X-CG-CATEGORY=event_tags: Free Food & Refreshments,Health & Wellness`. A category
//   string starting `club_acronym:` or `event_type:` is that field; `event_tags:` is stripped; every
//   other string is a tag. So `categories` may hold one string per line, or the line split on
//   commas: both give the same row. Tags are trimmed, kept in feed order.
// - Location: "Sign in to download the location" and "Register to receive location details!…"
//   (each may carry a leading space or ", United States") mean hidden, stored as null.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const FIELDS = ["uid", "title", "starts_at", "ends_at", "all_day", "group_name", "event_type", "tags",
  "description", "url", "location"];
// Only the contract's columns, sorted by uid (updated_at may be set by the row or the database).
const pick = (rows) => rows.map((r) => Object.fromEntries(FIELDS.map((k) => [k, r[k]])))
  .sort((a, b) => (a.uid < b.uid ? -1 : 1));

const NOW = new Date("2026-11-03T15:00:00.000Z"); // 10:00 in Stony Brook

// --- Real events from the public feed (2026-11-02), as parseIcs returns them -----------------

const toscanini = {
  uid: "3c7e18f7e27835ac9be3b8959ac75c7b10262026_3:15:42_PM@campusgroups.com",
  summary: "Take To: RSST Bodega",
  description: "Join RA Christina and RA David for Take To to RSST Bodega, which will be held at the Tabler Center for Arts, Culture, and Humanities!\nDress Code: Casual (jeans ok)\n---\nEvent Details: https://sbengaged.stonybrook.edu/rsvp?id=391210",
  location: " Sign in to download the location",
  url: "https://sbengaged.stonybrook.edu/rsvp?id=391210",
  organizer: "Toscanini Residence Hall",
  categories: ["club_acronym:TOSCANINIRESIDENCEHALL", "event_type:Trip/Excursion",
    "event_tags: Free Food & Refreshments,Health & Wellness"],
  start: "2026-11-04T00:00:00.000Z",
  end: "2026-11-04T01:00:00.000Z",
  allDay: false,
};

const bayGull = {
  uid: "076fa3b4926f8db7176a2aec2293b0d98182026_10:15:47_PM@campusgroups.com",
  summary: "The Bay Gull Weekly GBM (New Members Always Welcome!)",
  description: "The Bay Gull is Stony Brook University's 100% satire satirical newspaper.\n---\nEvent Details: https://sbengaged.stonybrook.edu/rsvp?id=378132",
  location: "Melville Library - N4000 , United States",
  url: "https://sbengaged.stonybrook.edu/rsvp?id=378132",
  organizer: "The Bay Gull",
  categories: ["club_acronym:THEBAYGULL", "event_type:Meeting", "event_tags:Games & Entertainment,Arts & Creativity"],
  start: "2026-11-04T00:00:00.000Z",
  end: "2026-11-04T01:00:00.000Z",
  allDay: false,
};

const greenDot = {
  uid: "924c71875e7a4fc1b405f7b6851b0cf98132026_12:14:31_PM@campusgroups.com",
  summary: "Green Dot Training",
  description: "Part of the CPO Upstander program.\n---\nEvent Details: https://sbengaged.stonybrook.edu/rsvp?id=377072",
  location: "Register to receive location details!, United States",
  url: "https://sbengaged.stonybrook.edu/rsvp?id=377072",
  organizer: "Center for Prevention and Outreach",
  categories: ["club_acronym:CENTERFORPREVENTIONANDOUTREACH", "event_type:Training", "event_tags:Health & Wellness"],
  start: "2026-11-04T21:30:00.000Z",
  end: "2026-11-04T23:30:00.000Z",
  allDay: false,
};

const lgbt = { // no event_tags line
  uid: "2564048e11838da04713dedf95b98e7b8222026_5:41:57_PM@campusgroups.com",
  summary: "LGBT+ Alliance Discussion Meeting - Queer Mythbusting",
  description: "Come have a discussion with the LGBT Alliance as we bust queer myths!\n---\nEvent Details: https://sbengaged.stonybrook.edu/rsvp?id=379344",
  location: "Sign in to download the location",
  url: "https://sbengaged.stonybrook.edu/rsvp?id=379344",
  organizer: "LGBT Alliance",
  categories: ["club_acronym:LGBTALLIANCE", "event_type:Meeting"],
  start: "2026-11-04T00:00:00.000Z",
  end: "2026-11-04T00:50:00.000Z",
  allDay: false,
};

const midterms = { // started in September, still running
  uid: "e2ecd2969efece44878479bb705bb37f922026_9:15:46_AM@campusgroups.com",
  summary: "Midterms Matter Series",
  description: "Campus partners are hosting programs on the 2026 midterm elections.\n---\nEvent Details: https://sbengaged.stonybrook.edu/rsvp?id=382899",
  location: " Sign in to download the location",
  url: "https://sbengaged.stonybrook.edu/rsvp?id=382899",
  organizer: "Center for Civic Justice",
  categories: ["club_acronym:CENTERFORCIVICJUSTICE", "event_type:Info Session/Panel",
    "event_tags:Civic Engagement & Community Service"],
  start: "2026-09-01T17:00:00.000Z",
  end: "2026-11-30T18:00:00.000Z",
  allDay: false,
};

// A small timed event for the window tests, IEEE-shaped.
const ev = (uid, start, end) => ({
  uid, summary: `IEEE ${uid}`, description: "", location: " Sign in to download the location",
  url: "https://sbengaged.stonybrook.edu/rsvp?id=381885", organizer: "Institute of Electrical and Electronics Engineers",
  categories: ["club_acronym:IEEE", "event_type:Workshop"], start, end, allDay: false,
});

// --- campusRows ------------------------------------------------------------------------------

test("v3-c campusRows: maps real SB Engaged events to campus_events rows", async () => {
  const { campusRows } = await import("../src/sheet/feeds.mjs");
  const rows = campusRows([toscanini, bayGull, greenDot, lgbt, midterms], NOW);
  assert.deepEqual(pick(rows), [
    {
      uid: "076fa3b4926f8db7176a2aec2293b0d98182026_10:15:47_PM@campusgroups.com",
      title: "The Bay Gull Weekly GBM (New Members Always Welcome!)",
      starts_at: "2026-11-04T00:00:00.000Z", ends_at: "2026-11-04T01:00:00.000Z", all_day: false,
      group_name: "The Bay Gull", event_type: "Meeting", tags: ["Games & Entertainment", "Arts & Creativity"],
      description: bayGull.description, url: "https://sbengaged.stonybrook.edu/rsvp?id=378132",
      location: "Melville Library - N4000 , United States",
    },
    {
      uid: "2564048e11838da04713dedf95b98e7b8222026_5:41:57_PM@campusgroups.com",
      title: "LGBT+ Alliance Discussion Meeting - Queer Mythbusting",
      starts_at: "2026-11-04T00:00:00.000Z", ends_at: "2026-11-04T00:50:00.000Z", all_day: false,
      group_name: "LGBT Alliance", event_type: "Meeting", tags: [],
      description: lgbt.description, url: "https://sbengaged.stonybrook.edu/rsvp?id=379344", location: null,
    },
    {
      uid: "3c7e18f7e27835ac9be3b8959ac75c7b10262026_3:15:42_PM@campusgroups.com",
      title: "Take To: RSST Bodega",
      starts_at: "2026-11-04T00:00:00.000Z", ends_at: "2026-11-04T01:00:00.000Z", all_day: false,
      group_name: "Toscanini Residence Hall", event_type: "Trip/Excursion",
      tags: ["Free Food & Refreshments", "Health & Wellness"],
      description: toscanini.description, url: "https://sbengaged.stonybrook.edu/rsvp?id=391210", location: null,
    },
    {
      uid: "924c71875e7a4fc1b405f7b6851b0cf98132026_12:14:31_PM@campusgroups.com",
      title: "Green Dot Training",
      starts_at: "2026-11-04T21:30:00.000Z", ends_at: "2026-11-04T23:30:00.000Z", all_day: false,
      group_name: "Center for Prevention and Outreach", event_type: "Training", tags: ["Health & Wellness"],
      description: greenDot.description, url: "https://sbengaged.stonybrook.edu/rsvp?id=377072", location: null,
    },
    {
      uid: "e2ecd2969efece44878479bb705bb37f922026_9:15:46_AM@campusgroups.com",
      title: "Midterms Matter Series",
      starts_at: "2026-09-01T17:00:00.000Z", ends_at: "2026-11-30T18:00:00.000Z", all_day: false,
      group_name: "Center for Civic Justice", event_type: "Info Session/Panel",
      tags: ["Civic Engagement & Community Service"],
      description: midterms.description, url: "https://sbengaged.stonybrook.edu/rsvp?id=382899", location: null,
    },
  ]);
});

test("v3-c campusRows: categories split on commas give the same tags", async () => {
  const { campusRows } = await import("../src/sheet/feeds.mjs");
  const split = { ...toscanini, categories: ["club_acronym:TOSCANINIRESIDENCEHALL", "event_type:Trip/Excursion",
    "event_tags: Free Food & Refreshments", "Health & Wellness"] };
  const [row] = campusRows([split], NOW);
  assert.deepEqual(row.tags, ["Free Food & Refreshments", "Health & Wellness"]);
  assert.equal(row.event_type, "Trip/Excursion");
  assert.equal(row.group_name, "Toscanini Residence Hall");
});

test("v3-c campusRows: group falls back to the club acronym; no categories give null type and no tags", async () => {
  const { campusRows } = await import("../src/sheet/feeds.mjs");
  const noOrganizer = { ...bayGull, organizer: undefined };
  const bare = { ...lgbt, uid: "bare@campusgroups.com", organizer: undefined, categories: [] };
  const rows = campusRows([noOrganizer, bare], NOW);
  const byUid = Object.fromEntries(rows.map((r) => [r.uid, r]));
  assert.equal(byUid[bayGull.uid].group_name, "THEBAYGULL");
  assert.equal(byUid[bayGull.uid].event_type, "Meeting");
  assert.equal(byUid["bare@campusgroups.com"].group_name, null);
  assert.equal(byUid["bare@campusgroups.com"].event_type, null);
  assert.deepEqual(byUid["bare@campusgroups.com"].tags, []);
});

test("v3-c campusRows: location is kept when present, null when hidden or blank", async () => {
  const { campusRows } = await import("../src/sheet/feeds.mjs");
  const at = (uid, location) => ({ ...ev(uid, "2026-11-05T18:00:00.000Z", "2026-11-05T19:00:00.000Z"), location });
  const rows = campusRows([
    at("a", "Student Activities Center - Ballroom A, United States"),
    at("b", " Sign in to download the location"),
    at("c", "Sign in to download the location"),
    at("d", "Register to receive location details!, United States"),
    at("e", ""),
    at("f", null),
  ], NOW);
  assert.deepEqual(pick(rows).map((r) => [r.uid, r.location]), [
    ["a", "Student Activities Center - Ballroom A, United States"],
    ["b", null], ["c", null], ["d", null], ["e", null], ["f", null],
  ]);
});

test("v3-c campusRows: keeps events overlapping now to 14 days ahead", async () => {
  const { campusRows } = await import("../src/sheet/feeds.mjs");
  const rows = campusRows([
    ev("ended-earlier", "2026-11-02T22:00:00.000Z", "2026-11-03T00:00:00.000Z"), // yesterday evening
    ev("ends-at-now", "2026-11-03T13:00:00.000Z", "2026-11-03T15:00:00.000Z"),   // ended exactly now
    ev("running", "2026-11-03T14:00:00.000Z", "2026-11-03T16:00:00.000Z"),       // started before, ends after
    ev("later-today", "2026-11-03T22:00:00.000Z", "2026-11-04T00:00:00.000Z"),
    ev("last-minute", "2026-11-17T14:59:00.000Z", "2026-11-17T16:00:00.000Z"),   // starts 1 min before +14 d
    ev("at-boundary", "2026-11-17T15:00:00.000Z", "2026-11-17T16:00:00.000Z"),   // starts exactly at +14 d
    ev("too-far", "2026-11-20T15:00:00.000Z", "2026-11-20T16:00:00.000Z"),
  ], NOW);
  assert.deepEqual(rows.map((r) => r.uid).sort(), ["last-minute", "later-today", "running"]);
  const running = rows.find((r) => r.uid === "running");
  assert.equal(running.starts_at, "2026-11-03T14:00:00.000Z");
  assert.equal(running.ends_at, "2026-11-03T16:00:00.000Z");
});

test("v3-c campusRows: an all-day event in the window is kept as all_day", async () => {
  const { campusRows } = await import("../src/sheet/feeds.mjs");
  const allDay = { ...ev("all-day", "2026-11-06", "2026-11-07"), allDay: true };
  const [row] = campusRows([allDay], NOW);
  assert.equal(row.uid, "all-day");
  assert.equal(row.all_day, true);
  assert.ok(String(row.starts_at).startsWith("2026-11-06"), row.starts_at);
  assert.ok(String(row.ends_at).startsWith("2026-11-07"), row.ends_at);
});

test("v3-c campusRows: no events give no rows", async () => {
  const { campusRows } = await import("../src/sheet/feeds.mjs");
  assert.deepEqual(campusRows([], NOW), []);
});

// --- Schema (supabase/schema.sql) --------------------------------------------------------------

const tableBody = (sql, name) => sql.match(new RegExp(`create table if not exists ${name} \\(([\\s\\S]*?)\\n\\);`))?.[1];

test("v3-c schema: campus_events has the contract's columns and uid primary key", { todo: true }, async () => {
  const sql = read("supabase/schema.sql");
  const body = tableBody(sql, "campus_events");
  assert.ok(body, "no `create table if not exists campus_events (…\\n);`");
  const cols = [["uid", "text"], ["title", "text"], ["starts_at", "timestamptz"], ["ends_at", "timestamptz"],
    ["all_day", "boolean"], ["group_name", "text"], ["event_type", "text"], ["tags", "text\\[\\]"],
    ["description", "text"], ["url", "text"], ["location", "text"], ["updated_at", "timestamptz"]];
  for (const [c, type] of cols) assert.match(body, new RegExp(`^\\s*${c} ${type}(\\s|,|$)`, "m"), `campus_events.${c} ${type}`);
  assert.match(body, /^\s*uid text[^\n]*primary key/m);
});

test("v3-c schema: campus_events is owner-only under is_owner()", { todo: true }, async () => {
  const sql = read("supabase/schema.sql");
  assert.match(sql, /alter table campus_events enable row level security;/);
  const policy = sql.match(/create policy (\w+) on campus_events for all using \(is_owner\(\)\) with check \(is_owner\(\)\);/);
  assert.ok(policy, "no owner-only policy on campus_events");
  assert.match(sql, new RegExp(`drop policy if exists ${policy[1]} on campus_events;`));
  assert.ok(sql.indexOf(`drop policy if exists ${policy[1]} on campus_events`) < policy.index, "drop before create");
  assert.doesNotMatch(sql, /create policy \w+ on campus_events (?!for all using \(is_owner\(\)\))/);
});

test("v3-c schema: campus_events never reaches the public views or anon", { todo: true }, async () => {
  const sql = read("supabase/schema.sql");
  const views = [...sql.matchAll(/create or replace view (public_\w+) as([\s\S]*?);/g)];
  assert.ok(views.length >= 3);
  for (const [, name, body] of views) assert.doesNotMatch(body, /campus_events/, `${name} reads campus_events`);
  assert.doesNotMatch(sql, /grant [^;]*on [^;]*campus_events[^;]*;/);
});

test("v3-c schema: the campus_events part is safe to re-run", { todo: true }, async () => {
  const sql = read("supabase/schema.sql");
  assert.doesNotMatch(sql, /create table (?!if not exists )campus_events/);
  assert.doesNotMatch(sql, /create (unique )?index (?!if not exists )\w* ?on campus_events/);
  const unschedule = sql.indexOf("select cron.unschedule(jobid) from cron.job where jobname = 'sheet-campus';");
  const schedule = sql.indexOf("select cron.schedule('sheet-campus'");
  assert.ok(unschedule >= 0 && schedule > unschedule, "sheet-campus is unscheduled before it is scheduled");
});

test("v3-c schema: sheet-campus runs at :35 hourly through Vault, guarded", { todo: true }, async () => {
  const sql = read("supabase/schema.sql");
  const job = sql.match(/select cron\.schedule\('sheet-campus', '35 \* \* \* \*', \$job\$([\s\S]*?)\$job\$\);/);
  assert.ok(job, "no `cron.schedule('sheet-campus', '35 * * * *', $job$…$job$)`");
  const body = job[1];
  assert.match(body, /net\.http_post\(/);
  assert.match(body, /url := \(select decrypted_secret from vault\.decrypted_secrets where name = 'sheet_campus_url'\)/);
  assert.match(body, /'x-sheet-cron',\s*\(select decrypted_secret from vault\.decrypted_secrets where name = 'sheet_cron_secret'\)/);
  assert.match(body, /where exists \(select 1 from vault\.decrypted_secrets where name = 'sheet_cron_secret'\)/);
  assert.match(body, /exists \(select 1 from vault\.decrypted_secrets where name = 'sheet_campus_url'\)/);
});

// --- The campus Edge Function (supabase/functions/campus/index.ts) ----------------------------

const fn = () => read("supabase/functions/campus/index.ts");

test("v3-c function: refuses calls without the cron secret", { todo: true }, async () => {
  const src = fn();
  assert.match(src, /Deno\.env\.get\(\s*["'`]?SHEET_CRON_SECRET|env\(\s*["'`]SHEET_CRON_SECRET["'`]\s*\)/);
  assert.match(src, /["'`]x-sheet-cron["'`]/);
  assert.match(src, /status:\s*(401|403)/);
});

test("v3-c function: uses parseIcs and campusRows from the shared modules", { todo: true }, async () => {
  const src = fn();
  assert.match(src, /import \{[^}]*\bcampusRows\b[^}]*\} from ["'][./]+\/src\/sheet\/feeds\.mjs["']/);
  assert.match(src, /import \{[^}]*\bparseIcs\b[^}]*\} from ["'][./]+\/src\/sheet\/ical\.mjs["']/);
  assert.match(src, /https:\/\/sbengaged\.stonybrook\.edu\/ical\/stonybrook\/ical_stonybrook\.ics/);
});

test("v3-c function: sends conditional requests from feed_state and stops on 304", { todo: true }, async () => {
  const src = fn();
  assert.match(src, /feed_state/);
  assert.match(src, /["'`]campus["'`]/, "its feed_state source is 'campus'");
  assert.match(src, /["'`]If-None-Match["'`]/i);
  assert.match(src, /["'`]If-Modified-Since["'`]/i);
  assert.match(src, /\betag\b/);
  assert.match(src, /\blast_modified\b/);
  assert.match(src, /headers\.get\(\s*["'`]etag["'`]\s*\)/i);
  assert.match(src, /headers\.get\(\s*["'`]last-modified["'`]\s*\)/i);
  assert.match(src, /status\s*===?\s*304/);
});

test("v3-c function: upserts and deletes ended rows in batches, then writes feed_state", { todo: true }, async () => {
  const src = fn();
  assert.match(src, /campus_events/);
  assert.match(src, /on_conflict=uid|resolution=merge-duplicates|onConflict:\s*["'`]uid["'`]/);
  assert.match(src, /\.slice\(|chunk|batch/i, "rows go up in batches");
  assert.match(src, /campus_events\?[^"'`\n]*ends_at=lte?\.|\.(lt|lte)\(\s*["'`]ends_at["'`]/, "deletes ended rows");
  assert.match(src, /method:\s*["'`]DELETE["'`]|\.delete\(\)/);
  for (const col of ["fetched_at", "ok", "error", "items"]) assert.match(src, new RegExp(`\\b${col}\\b`), `feed_state.${col}`);
  assert.match(src, /ok:\s*false/, "a failed fetch is recorded");
});

test("v3-c function: holds no secret literals", { todo: true }, async () => {
  const src = fn();
  assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{10,}/, "a JWT");
  assert.doesNotMatch(src, /["'`][A-Za-z0-9_+/=-]{32,}["'`]/, "a long token");
  assert.doesNotMatch(src, /(secret|key|token)\s*[:=]\s*["'`][^"'`]{8,}["'`]/i);
  const envs = [...src.matchAll(/env\(\s*["'`](\w+)["'`]\s*\)|Deno\.env\.get\(\s*["'`](\w+)["'`]\s*\)/g)].map((m) => m[1] ?? m[2]);
  for (const name of envs) assert.ok(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SHEET_CRON_SECRET"].includes(name), `reads ${name}`);
});
