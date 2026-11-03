// Verification tests for ticket D (issue 25): the Campus list in /plan and "Add to my day".
// Written from the contract in docs/sheet-sources.md ("Pure modules: campus.mjs" and "/plan")
// before the code exists. Each test is `todo`: the implementer removes `todo` and must not change
// what a test expects.
//
// Rules these tests pin where the contract leaves room:
// - An event belongs to the local day (America/New_York) it starts on, and only that day. An
//   event from 11 pm to 1 am, or one that runs for days, shows on its start day only.
// - "Free food" means the event carries a tag containing "free food" (any case, any surrounding
//   spaces). SB Engaged's own tag is " Free Food & Refreshments", with a leading space.
// - "Routine" means `event_type` or the title contains "practice", "meeting" or "general body
//   meeting", in any case. "Meet & Greet" is not a meeting.
// - Sorting is free food first, then by start time.
// - With `tags`, an event stays if it carries any one of them. An empty or missing `tags` keeps
//   every event. The routine filter still applies.
// - `campusTags` returns `[{ tag, count }]`, by count (highest first) then by name (A to Z).
// - `eventToTask` returns exactly the fields of a task on a day:
//   `{ title, day, list: null, at_time, est_min, tag: "campus", public: false }`. The planner adds
//   `position`, as it does for any task it inserts. `est_min` is whole minutes, capped at 240, and
//   null for all-day events (so is `at_time`). The title fits the tasks table (1 to 500 chars).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const tz = "America/New_York";
const DAY = "2026-11-04"; // a Wednesday, EST (UTC-5): local midnight is 05:00Z

// A campus_events row, shaped as in the contract's schema.
const ev = (uid, starts_at, ends_at, extra = {}) => ({
  uid, title: `Event ${uid}`, starts_at, ends_at, all_day: false, group_name: "IEEE", event_type: "Social",
  tags: [], description: "", url: `https://sbengaged.stonybrook.edu/rsvp?id=${uid}`, location: null,
  updated_at: "2026-11-03T12:00:00Z", ...extra,
});
const uids = (events) => events.map((e) => e.uid);

// --- campusDay ---------------------------------------------------------------------------

test("campusDay: only events that start on that local day, including one at 11:30 pm", { todo: true }, async () => {
  const { campusDay } = await import("../src/sheet/campus.mjs");
  const events = [
    ev("noon", "2026-11-04T17:00:00Z", "2026-11-04T18:00:00Z"),        // 12 pm Nov 4
    ev("late", "2026-11-05T04:30:00Z", "2026-11-05T05:30:00Z"),        // 11:30 pm Nov 4 (Nov 5 in UTC)
    ev("early", "2026-11-04T05:00:00Z", "2026-11-04T06:00:00Z"),       // 12 am Nov 4
    ev("before", "2026-11-04T04:59:00Z", "2026-11-04T05:30:00Z"),      // 11:59 pm Nov 3
    ev("next", "2026-11-05T05:00:00Z", "2026-11-05T06:00:00Z"),        // 12 am Nov 5
    ev("utcsame", "2026-11-04T02:00:00Z", "2026-11-04T03:00:00Z"),     // 9 pm Nov 3 (Nov 4 in UTC)
  ];
  assert.deepEqual(uids(campusDay(events, DAY, tz, {})), ["early", "noon", "late"]);
});

test("campusDay: an event spanning midnight belongs to the day it starts", { todo: true }, async () => {
  const { campusDay } = await import("../src/sheet/campus.mjs");
  const span = ev("span", "2026-11-04T04:00:00Z", "2026-11-04T06:00:00Z"); // 11 pm Nov 3 to 1 am Nov 4
  const long = ev("long", "2026-11-02T15:00:00Z", "2026-11-30T22:00:00Z"); // runs for weeks
  assert.deepEqual(uids(campusDay([span, long], "2026-11-03", tz, {})), ["span"]);
  assert.deepEqual(uids(campusDay([span, long], DAY, tz, {})), []);
  assert.deepEqual(uids(campusDay([span, long], "2026-11-02", tz, {})), ["long"]);
});

test("campusDay: free food first, then by start time", { todo: true }, async () => {
  const { campusDay } = await import("../src/sheet/campus.mjs");
  const events = [
    ev("b", "2026-11-04T16:00:00Z", "2026-11-04T17:00:00Z"),
    ev("food-late", "2026-11-04T23:00:00Z", "2026-11-05T00:00:00Z", { tags: ["Games", " Free Food & Refreshments"] }),
    ev("a", "2026-11-04T14:00:00Z", "2026-11-04T15:00:00Z"),
    ev("food-early", "2026-11-04T18:00:00Z", "2026-11-04T19:00:00Z", { tags: ["free food & refreshments"] }),
    ev("c", "2026-11-04T20:00:00Z", "2026-11-04T21:00:00Z", { tags: ["Games"] }),
  ];
  assert.deepEqual(uids(campusDay(events, DAY, tz, {})), ["food-early", "food-late", "a", "b", "c"]);
});

test("campusDay: practices, meetings and general body meetings are hidden unless showRoutine", { todo: true }, async () => {
  const { campusDay } = await import("../src/sheet/campus.mjs");
  const at = (h) => [`2026-11-04T${h}:00:00Z`, `2026-11-04T${h}:30:00Z`];
  const events = [
    ev("practice-type", ...at(14), { event_type: "Rehearsal/Practice" }),
    ev("meeting-type", ...at(15), { event_type: "Meeting" }),
    ev("gbm-title", ...at(16), { title: "Fall GENERAL BODY MEETING", event_type: "Social" }),
    ev("practice-title", ...at(17), { title: "Club soccer practice", event_type: "Other" }),
    ev("meeting-title", ...at(18), { title: "Weekly Meeting", event_type: "Social" }),
    ev("social", ...at(19), { title: "Meet & Greet", event_type: "Social" }),
    ev("workshop", ...at(20), { title: "Resume Workshop", event_type: "Workshop" }),
  ];
  assert.deepEqual(uids(campusDay(events, DAY, tz, {})), ["social", "workshop"]);
  assert.deepEqual(uids(campusDay(events, DAY, tz, { showRoutine: false })), ["social", "workshop"]);
  assert.deepEqual(uids(campusDay(events, DAY, tz, { showRoutine: true })),
    ["practice-type", "meeting-type", "gbm-title", "practice-title", "meeting-title", "social", "workshop"]);
});

test("campusDay: with no options, routine events are hidden and nothing else is filtered", { todo: true }, async () => {
  const { campusDay } = await import("../src/sheet/campus.mjs");
  const events = [
    ev("m", "2026-11-04T14:00:00Z", "2026-11-04T15:00:00Z", { event_type: "Meeting" }),
    ev("s", "2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z", { tags: ["Games"] }),
    ev("n", "2026-11-04T16:00:00Z", "2026-11-04T17:00:00Z", { tags: null }),
  ];
  assert.deepEqual(uids(campusDay(events, DAY, tz)), ["s", "n"]);
});

test("campusDay: a tag filter keeps events carrying any listed tag, and routine stays hidden", { todo: true }, async () => {
  const { campusDay } = await import("../src/sheet/campus.mjs");
  const events = [
    ev("games", "2026-11-04T14:00:00Z", "2026-11-04T15:00:00Z", { tags: ["Games"] }),
    ev("career", "2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z", { tags: ["Arts & Creativity", "Career & Professional Development"] }),
    ev("arts", "2026-11-04T16:00:00Z", "2026-11-04T17:00:00Z", { tags: ["Arts & Creativity"] }),
    ev("none", "2026-11-04T17:00:00Z", "2026-11-04T18:00:00Z", { tags: [] }),
    ev("null", "2026-11-04T18:00:00Z", "2026-11-04T19:00:00Z", { tags: null }),
    ev("practice", "2026-11-04T19:00:00Z", "2026-11-04T20:00:00Z", { tags: ["Games"], event_type: "Rehearsal/Practice" }),
  ];
  const tags = ["Games", "Career & Professional Development"];
  assert.deepEqual(uids(campusDay(events, DAY, tz, { tags })), ["games", "career"]);
  assert.deepEqual(uids(campusDay(events, DAY, tz, { tags, showRoutine: true })), ["games", "career", "practice"]);
  assert.deepEqual(uids(campusDay(events, DAY, tz, { tags: [] })), ["games", "career", "arts", "none", "null"]);
});

test("campusDay: no rows gives an empty list, and the input is left unchanged", { todo: true }, async () => {
  const { campusDay } = await import("../src/sheet/campus.mjs");
  assert.deepEqual(campusDay([], DAY, tz, {}), []);
  assert.deepEqual(campusDay([], DAY, tz, { tags: ["Games"], showRoutine: true }), []);
  const events = [ev("b", "2026-11-04T16:00:00Z", "2026-11-04T17:00:00Z"), ev("a", "2026-11-04T14:00:00Z", "2026-11-04T15:00:00Z")];
  const copy = structuredClone(events);
  campusDay(events, DAY, tz, {});
  assert.deepEqual(events, copy);
});

// --- campusTags --------------------------------------------------------------------------

test("campusTags: each tag in use with its count, by count then by name", { todo: true }, async () => {
  const { campusTags } = await import("../src/sheet/campus.mjs");
  const events = [
    ev("1", "2026-11-04T14:00:00Z", "2026-11-04T15:00:00Z", { tags: ["Games", "Health & Wellness"] }),
    ev("2", "2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z", { tags: ["Games", "Arts & Creativity"] }),
    ev("3", "2026-11-04T16:00:00Z", "2026-11-04T17:00:00Z", { tags: ["Health & Wellness", "Games"] }),
    ev("4", "2026-11-04T17:00:00Z", "2026-11-04T18:00:00Z", { tags: ["Culture & Identity"] }),
    ev("5", "2026-11-04T18:00:00Z", "2026-11-04T19:00:00Z", { tags: [] }),
    ev("6", "2026-11-04T19:00:00Z", "2026-11-04T20:00:00Z", { tags: null }),
  ];
  assert.deepEqual(campusTags(events), [
    { tag: "Games", count: 3 },
    { tag: "Health & Wellness", count: 2 },
    { tag: "Arts & Creativity", count: 1 },
    { tag: "Culture & Identity", count: 1 },
  ]);
});

test("campusTags: no rows, or no tags, gives an empty list", { todo: true }, async () => {
  const { campusTags } = await import("../src/sheet/campus.mjs");
  assert.deepEqual(campusTags([]), []);
  assert.deepEqual(campusTags([ev("1", "2026-11-04T14:00:00Z", "2026-11-04T15:00:00Z", { tags: null })]), []);
});

// --- eventToTask -------------------------------------------------------------------------

test("eventToTask: a private #campus task on the event's day, at its local start, its length as the estimate", { todo: true }, async () => {
  const { eventToTask } = await import("../src/sheet/campus.mjs");
  const e = ev("1", "2026-11-04T23:00:00Z", "2026-11-05T00:30:00Z", { title: "Resume Workshop" }); // 6 pm to 7:30 pm EST
  assert.deepEqual(eventToTask(e, tz),
    { title: "Resume Workshop", day: DAY, list: null, at_time: "18:00", est_min: 90, tag: "campus", public: false });
});

test("eventToTask: an 11:30 pm start keeps its local day, and a midnight-spanning event its start day", { todo: true }, async () => {
  const { eventToTask } = await import("../src/sheet/campus.mjs");
  const late = eventToTask(ev("late", "2026-11-05T04:30:00Z", "2026-11-05T05:15:00Z", { title: "Late Night Trivia" }), tz);
  assert.deepEqual(late, { title: "Late Night Trivia", day: DAY, list: null, at_time: "23:30", est_min: 45, tag: "campus", public: false });
  const span = eventToTask(ev("span", "2026-11-04T04:00:00Z", "2026-11-04T06:00:00Z", { title: "Midnight Movie" }), tz);
  assert.deepEqual(span, { title: "Midnight Movie", day: "2026-11-03", list: null, at_time: "23:00", est_min: 120, tag: "campus", public: false });
  // Summer time: 10 am EDT is 14:00Z.
  assert.equal(eventToTask(ev("edt", "2026-10-20T14:00:00Z", "2026-10-20T15:00:00Z"), tz).at_time, "10:00");
});

test("eventToTask: the estimate is capped at 240 minutes", { todo: true }, async () => {
  const { eventToTask } = await import("../src/sheet/campus.mjs");
  assert.equal(eventToTask(ev("5h", "2026-11-04T15:00:00Z", "2026-11-04T20:00:00Z"), tz).est_min, 240);
  assert.equal(eventToTask(ev("4h", "2026-11-04T15:00:00Z", "2026-11-04T19:00:00Z"), tz).est_min, 240);
  assert.equal(eventToTask(ev("weeks", "2026-11-02T15:00:00Z", "2026-11-30T22:00:00Z"), tz).est_min, 240);
  assert.equal(eventToTask(ev("1m", "2026-11-04T15:00:00Z", "2026-11-04T15:01:00Z"), tz).est_min, 1);
});

test("eventToTask: an all-day event has no time and no estimate", { todo: true }, async () => {
  const { eventToTask } = await import("../src/sheet/campus.mjs");
  const e = ev("allday", "2026-11-04T05:00:00Z", "2026-11-05T05:00:00Z", { all_day: true, title: "Homecoming Week" });
  assert.deepEqual(eventToTask(e, tz),
    { title: "Homecoming Week", day: DAY, list: null, at_time: null, est_min: null, tag: "campus", public: false });
});

test("eventToTask: the title fits the tasks table (1 to 500 characters, trimmed)", { todo: true }, async () => {
  const { eventToTask } = await import("../src/sheet/campus.mjs");
  const long = "A".repeat(600);
  const t = eventToTask(ev("long", "2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z", { title: long }), tz);
  assert.ok(t.title.length >= 1 && t.title.length <= 500, `title length ${t.title.length}`);
  assert.ok(long.startsWith(t.title.replace(/…$/, "")));
  assert.equal(eventToTask(ev("pad", "2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z", { title: "  Board Game Night  " }), tz).title, "Board Game Night");
});

// --- /plan and /now ----------------------------------------------------------------------
// The Campus row is drawn in the browser, so these read the source a page loads: the page itself
// and every module it imports, followed through relative imports.

function closure(entry) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const [, spec] of text.matchAll(/\bimport\s*(?:[^"'()]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+\.(?:mjs|js|astro))["']/g))
      visit(resolve(dirname(file), spec));
  };
  visit(join(root, entry));
  return seen;
}
const planFiles = () => closure("src/pages/plan/index.astro");
const planSource = () => [...planFiles().values()].join("\n");

test("/plan: loads campus.mjs and reads campus_events", { todo: true }, async () => {
  await import("../src/sheet/campus.mjs");
  const files = planFiles();
  assert.ok([...files.keys()].some((f) => f.endsWith("/src/sheet/campus.mjs")), "a module /plan loads imports campus.mjs");
  assert.match(planSource(), /campus_events/);
});

test("/plan: the Campus row has a markup hook, a count, Add to my day and the routine switch", { todo: true }, async () => {
  await import("../src/sheet/campus.mjs");
  const src = planSource();
  assert.match(src, /data-campus/, "a data-campus hook on the row or list");
  assert.match(src, /Campus · /, 'the row reads "Campus · N"');
  assert.match(src, /Add to my day/);
  assert.match(src, /Show practices and meetings/);
  assert.match(src, /Free food/);
  assert.match(src, /campusDay/);
  assert.match(src, /campusTags/);
});

test("/plan: Add to my day goes through eventToTask and the existing task insert, with undo", { todo: true }, async () => {
  await import("../src/sheet/campus.mjs");
  const users = [...planFiles()].filter(([f, text]) => !f.endsWith("/campus.mjs") && /\beventToTask\b/.test(text));
  assert.ok(users.length, "a module /plan loads calls eventToTask");
  for (const [f, text] of users) {
    assert.match(text, /\binsertTask\b/, `${f} inserts through api.insertTask`);
    assert.match(text, /undo/i, `${f} offers undo`);
  }
});

test("/plan: the ? help list names the Campus list", { todo: true }, async () => {
  await import("../src/sheet/campus.mjs");
  const page = readFileSync(join(root, "src/pages/plan/index.astro"), "utf8");
  const help = page.match(/<dialog[^>]*data-help[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(help, "the help dialog");
  assert.match(help, /<dd>[^<]*campus/i, "a help entry for the Campus list");
});

test("/plan: the campus filters use localStorage only inside try/catch", { todo: true }, async () => {
  await import("../src/sheet/campus.mjs");
  const campusFiles = [...planFiles()].filter(([, text]) => /Show practices and meetings/.test(text));
  assert.ok(campusFiles.length, "the module drawing the campus filters");
  let uses = 0;
  for (const [f, text] of campusFiles) {
    for (const m of text.matchAll(/localStorage/g)) {
      uses++;
      const before = text.slice(Math.max(0, m.index - 300), m.index);
      const after = text.slice(m.index, m.index + 300);
      assert.match(before, /\btry\s*\{[^}]*$/, `${f}: localStorage at ${m.index} sits inside a try block`);
      assert.match(after, /\bcatch\b/, `${f}: that try has a catch`);
    }
  }
  assert.ok(uses > 0, "the filters are remembered in localStorage");
});

test("/plan: every event link opens in a new tab with rel=noopener", { todo: true }, async () => {
  await import("../src/sheet/campus.mjs");
  const campusFiles = [...planFiles()].filter(([, text]) => /Add to my day/.test(text));
  assert.ok(campusFiles.length, "the module drawing the campus list");
  let links = 0;
  for (const [f, text] of campusFiles) {
    // An anchor whose href is an event's url, written as el("a", { href: e.url, ... }) or similar.
    for (const m of text.matchAll(/href\s*[:=]\s*[\w$.?]*\burl\b/g)) {
      links++;
      const around = text.slice(Math.max(0, m.index - 200), m.index + 200);
      assert.match(around, /target\s*[:=]\s*["']_blank["']/, `${f}: event link opens a new tab`);
      assert.match(around, /rel\s*[:=]\s*["'][^"']*\bnoopener\b/, `${f}: event link has rel=noopener`);
    }
  }
  assert.ok(links > 0, "the list links each event's page");
});

test("/now: never loads campus.mjs or mentions campus events", { todo: true }, async () => {
  await import("../src/sheet/campus.mjs");
  const files = closure("src/pages/now/index.astro");
  assert.ok(![...files.keys()].some((f) => f.endsWith("/src/sheet/campus.mjs")), "/now never imports campus.mjs");
  for (const f of ["src/pages/now/index.astro", "src/sheet/public.mjs"])
    assert.doesNotMatch(readFileSync(join(root, f), "utf8"), /campus/i, f);
  // The public views /now reads never select from campus_events.
  const schema = readFileSync(join(root, "supabase/schema.sql"), "utf8");
  for (const view of schema.matchAll(/create or replace view (public_\w+)[\s\S]*?;/g))
    assert.doesNotMatch(view[0], /campus/i, view[1]);
});
