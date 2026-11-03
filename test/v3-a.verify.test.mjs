// Verification tests for ticket A (issue 22): the shared iCal reader, `parseIcs` in
// src/sheet/ical.mjs, as docs/sheet-sources.md "Contracts" describes it:
//   parseIcs(text, { from, to }) -> [{ uid, summary, description, location, url, categories,
//                                      start, end, allDay }]
// for the events overlapping [from, to). Written before the code, from the contract. Every test
// is `todo` until the module exists; the implementer removes `todo` and must not change the
// expectations. Expected values are worked out by hand from the iCal lines, not recomputed.
//
// Choices the contract leaves open, made here (see the ticket's verification report):
// - `from` and `to` are passed as Date objects.
// - Timed `start`/`end` are `Date#toISOString()` strings ("2026-11-04T18:00:00.000Z"), the form
//   the rest of src/sheet uses.
// - All-day `start`/`end` are the DTSTART and DTEND dates as "YYYY-MM-DD", `end` exclusive as in
//   RFC 5545 (D2L's Valence calendar docs also treat the end day as exclusive).
// - Each CATEGORIES value is split on unescaped commas, every CATEGORIES line in order. Values are
//   compared trimmed, since the contract does not say whether the reader trims them.
// - Absent text fields (no DESCRIPTION, LOCATION or URL) are not pinned to null or "".
// - Results are compared by UID, not by order.
//
// Fixtures:
// - test/fixtures/brightspace-sample.ics is written by hand. D2L does not document the iCal
//   feed's lines; its shape follows the Brightspace Calendar API (D2L Valence docs,
//   https://docs.valence.desire2learn.com/res/calendar.html: DueDate / AvailabilityEnds events,
//   all-day events with an exclusive end day, a per-event view URL) and RFC 5545, with
//   Stony Brook's mycourses.stonybrook.edu host. Check it against a real feed once one is in hand.
// - test/fixtures/sbengaged-sample.ics is 22 VEVENTs cut unchanged (CRLF kept) from
//   https://sbengaged.stonybrook.edu/ical/stonybrook/ical_stonybrook.ics, fetched 2026-11-03.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const mod = () => import("../src/sheet/ical.mjs");
const at = (iso) => new Date(iso);
const range = (from, to) => ({ from: at(from), to: at(to) });

// A calendar around some VEVENT lines, with CRLF line ends like both real feeds.
const cal = (...lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
const vevent = (uid, ...props) => ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261102T120000Z", ...props, "END:VEVENT"];

const byUid = (events) => Object.fromEntries(events.map((e) => [e.uid, e]));
const uids = (events) => events.map((e) => e.uid).sort();
const times = (e) => ({ start: e.start, end: e.end, allDay: e.allDay });
const trimmed = (list) => list.map((s) => s.trim());

const wide = range("2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z");

// --- The contract's shape ----------------------------------------------------------------------

test("shape: each event has exactly the contract's fields", async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("a@x", "DTSTART:20261104T180000Z", "DTEND:20261104T190000Z", "SUMMARY:Office hours")), wide);
  assert.deepEqual(Object.keys(ev).sort(),
    ["allDay", "categories", "description", "end", "location", "start", "summary", "uid", "url"]);
  assert.equal(ev.uid, "a@x");
  assert.equal(ev.summary, "Office hours");
});

test("shape: an event with every field filled comes back whole", async () => {
  const { parseIcs } = await mod();
  const text = cal(...vevent("full@x",
    "DTSTART:20261104T180000Z",
    "DTEND:20261104T193000Z",
    "SUMMARY:Robotics demo",
    "DESCRIPTION:Bring a laptop.",
    "LOCATION:Light Engineering 152",
    "URL:https://example.edu/events/42",
    "CATEGORIES:Engineering,Demo"));
  assert.deepEqual(parseIcs(text, wide), [{
    uid: "full@x", summary: "Robotics demo", description: "Bring a laptop.", location: "Light Engineering 152",
    url: "https://example.edu/events/42", categories: ["Engineering", "Demo"],
    start: "2026-11-04T18:00:00.000Z", end: "2026-11-04T19:30:00.000Z", allDay: false,
  }]);
});

// --- Times ---------------------------------------------------------------------------------------

test("times: a UTC `Z` time is that instant", async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("z@x", "DTSTART:20261107T045900Z", "DTEND:20261107T061500Z", "SUMMARY:Quiz")), wide);
  assert.deepEqual(times(ev), { start: "2026-11-07T04:59:00.000Z", end: "2026-11-07T06:15:00.000Z", allDay: false });
});

test("times: TZID local times in New York, before and after the change back to EST", async () => {
  const { parseIcs } = await mod();
  const text = cal(
    ...vevent("edt@x", "DTSTART;TZID=America/New_York:20261030T235900", "DTEND;TZID=America/New_York:20261031T010000", "SUMMARY:EDT"),
    ...vevent("est@x", "DTSTART;TZID=America/New_York:20261104T090000", "DTEND;TZID=America/New_York:20261104T101500", "SUMMARY:EST"),
  );
  const got = byUid(parseIcs(text, wide));
  // Fri Oct 30 is EDT (UTC-4): 23:59 local is 03:59Z the next day.
  assert.deepEqual(times(got["edt@x"]), { start: "2026-10-31T03:59:00.000Z", end: "2026-10-31T05:00:00.000Z", allDay: false });
  // Wed Nov 4 is EST (UTC-5): 09:00 local is 14:00Z.
  assert.deepEqual(times(got["est@x"]), { start: "2026-11-04T14:00:00.000Z", end: "2026-11-04T15:15:00.000Z", allDay: false });
});

test("times: an event across the fall-back change (Sun 2026-11-01) gets each end's own offset", async () => {
  const { parseIcs } = await mod();
  // 00:30 EDT (UTC-4) to 03:30 EST (UTC-5): three clock hours, four real hours.
  const [ev] = parseIcs(cal(...vevent("dst@x",
    "DTSTART;TZID=America/New_York:20261101T003000",
    "DTEND;TZID=America/New_York:20261101T033000",
    "SUMMARY:Overnight hackathon shift")), wide);
  assert.deepEqual(times(ev), { start: "2026-11-01T04:30:00.000Z", end: "2026-11-01T08:30:00.000Z", allDay: false });
});

test("times: DST edge cases follow RFC 5545 3.3.5 (repeated hour: first; skipped hour: offset before the gap)", async () => {
  const { parseIcs } = await mod();
  const text = cal(
    // 01:30 happens twice on 2026-11-01; the first is EDT, 05:30Z.
    ...vevent("twice@x", "DTSTART;TZID=America/New_York:20261101T013000", "SUMMARY:Repeated hour"),
    // 02:30 never happens on 2027-03-14; read with the offset before the gap (EST), 07:30Z.
    ...vevent("gap@x", "DTSTART;TZID=America/New_York:20270314T023000", "SUMMARY:Skipped hour"),
  );
  const got = byUid(parseIcs(text, wide));
  assert.equal(got["twice@x"].start, "2026-11-01T05:30:00.000Z");
  assert.equal(got["gap@x"].start, "2027-03-14T07:30:00.000Z");
});

test("times: TZID is not hard-wired to New York", async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("la@x",
    "DTSTART;TZID=America/Los_Angeles:20261104T090000",
    "DTEND;TZID=America/Los_Angeles:20261104T100000",
    "SUMMARY:West coast interview")), wide);
  // PST (UTC-8) on Nov 4.
  assert.deepEqual(times(ev), { start: "2026-11-04T17:00:00.000Z", end: "2026-11-04T18:00:00.000Z", allDay: false });
});

test("times: VALUE=DATE is an all-day event with dated strings, end exclusive", async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("break@x",
    "DTSTART;VALUE=DATE:20261125",
    "DTEND;VALUE=DATE:20261130",
    "SUMMARY:Thanksgiving Break - No Classes")), wide);
  assert.deepEqual(times(ev), { start: "2026-11-25", end: "2026-11-30", allDay: true });
});

test("times: no DTEND but a DURATION: the end is start plus the duration", async () => {
  const { parseIcs } = await mod();
  const text = cal(
    ...vevent("dur@x", "DTSTART;TZID=America/New_York:20261112T203000", "DURATION:PT1H20M", "SUMMARY:Midterm 2"),
    ...vevent("durz@x", "DTSTART:20261104T180000Z", "DURATION:PT45M", "SUMMARY:Short"),
  );
  const got = byUid(parseIcs(text, wide));
  // Thu Nov 12, 20:30 EST is 01:30Z on the 13th; 80 minutes later is 02:50Z.
  assert.deepEqual(times(got["dur@x"]), { start: "2026-11-13T01:30:00.000Z", end: "2026-11-13T02:50:00.000Z", allDay: false });
  assert.deepEqual(times(got["durz@x"]), { start: "2026-11-04T18:00:00.000Z", end: "2026-11-04T18:45:00.000Z", allDay: false });
});

test("times: no DTEND and no DURATION: zero length, end equals start", async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("due@x", "DTSTART;TZID=America/New_York:20261105T235900", "SUMMARY:Homework 4 - Due")), wide);
  // Thu Nov 5, 23:59 EST is 04:59Z on the 6th.
  assert.deepEqual(times(ev), { start: "2026-11-06T04:59:00.000Z", end: "2026-11-06T04:59:00.000Z", allDay: false });
});

test("times: RRULE is ignored, only the first occurrence is kept", async () => {
  const { parseIcs } = await mod();
  const text = cal(...vevent("weekly@x",
    "DTSTART;TZID=America/New_York:20261104T140000",
    "DTEND;TZID=America/New_York:20261104T150000",
    "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=6",
    "SUMMARY:Recitation"));
  const all = parseIcs(text, wide);
  assert.equal(all.length, 1);
  assert.deepEqual(times(all[0]), { start: "2026-11-04T19:00:00.000Z", end: "2026-11-04T20:00:00.000Z", allDay: false });
  // The second Wednesday (Nov 11) is not produced.
  assert.deepEqual(parseIcs(text, range("2026-11-11T00:00:00Z", "2026-11-12T00:00:00Z")), []);
});

// --- Text --------------------------------------------------------------------------------------

test("text: escapes \\n \\, \\; \\\\ are undone", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("esc@x",
    "DTSTART:20261104T180000Z",
    String.raw`SUMMARY:Exam review\; bring notes`,
    String.raw`DESCRIPTION:Bring a calculator\, pencil\; no notes.\nRoom: Javits 100\\B`,
    String.raw`LOCATION:Javits Lecture Center\, Room 100`)), wide);
  assert.equal(ev.summary, "Exam review; bring notes");
  assert.equal(ev.description, "Bring a calculator, pencil; no notes.\nRoom: Javits 100\\B");
  assert.equal(ev.location, "Javits Lecture Center, Room 100");
});

test("text: an escaped backslash before n stays a backslash and an n, not a newline", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("bs@x", "DTSTART:20261104T180000Z", "SUMMARY:Paths",
    String.raw`DESCRIPTION:Save to C:\\new\\notes.txt`)), wide);
  assert.equal(ev.description, "Save to C:\\new\\notes.txt");
});

test("text: unescaped commas in text (as SB Engaged sends them) are kept", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("comma@x", "DTSTART:20261102T160000Z", "DTEND:20261102T190000Z",
    "SUMMARY;ENCODING=QUOTED-PRINTABLE:Sleep Well, Southampton!",
    "LOCATION:Bauman Center, United States")), wide);
  assert.equal(ev.summary, "Sleep Well, Southampton!");
  assert.equal(ev.location, "Bauman Center, United States");
});

test("text: folded lines (CRLF + space or tab) are joined, including mid-escape and inside parameters", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const text = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:fold@x",
    "DTSTART;TZID=America/New_",
    " York:20261104T090000",
    "SUMMARY:Read chapters 4 an",
    " d 5 before lecture",
    "DESCRIPTION:Part one\\",
    " , part two\\n",
    "\tline two",
    "URL:https://mycourses.stonybrook.edu/d2l/le/calendar/1530087/event/61734/deta",
    " ilsview",
    "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const [ev] = parseIcs(text, wide);
  assert.equal(ev.start, "2026-11-04T14:00:00.000Z");
  assert.equal(ev.summary, "Read chapters 4 and 5 before lecture");
  assert.equal(ev.description, "Part one, part two\nline two");
  assert.equal(ev.url, "https://mycourses.stonybrook.edu/d2l/le/calendar/1530087/event/61734/detailsview");
});

test("text: CATEGORIES split on commas, an escaped comma does not split", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("cat@x", "DTSTART:20261104T180000Z",
    String.raw`CATEGORIES:Labs\, recitations,Exam,Due Date`)), wide);
  assert.deepEqual(trimmed(ev.categories), ["Labs, recitations", "Exam", "Due Date"]);
});

test("text: several CATEGORIES lines are read in order into one list", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("cats@x", "DTSTART:20261104T180000Z",
    "CATEGORIES:Talks",
    "CATEGORIES:Free Food,Career")), wide);
  assert.deepEqual(trimmed(ev.categories), ["Talks", "Free Food", "Career"]);
});

test("text: an event without CATEGORIES has an empty list", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("nocat@x", "DTSTART:20261104T180000Z", "SUMMARY:Plain")), wide);
  assert.deepEqual(ev.categories, []);
});

test("text: the URL property is returned as written", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const [ev] = parseIcs(cal(...vevent("url@x", "DTSTART:20261104T180000Z",
    "URL:https://sbengaged.stonybrook.edu/rsvp?id=390781")), wide);
  assert.equal(ev.url, "https://sbengaged.stonybrook.edu/rsvp?id=390781");
});

// --- Line ends ---------------------------------------------------------------------------------

test("line ends: the same feed with LF instead of CRLF reads the same", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const crlf = fixture("brightspace-sample.ics");
  assert.ok(crlf.includes("\r\n"));
  const lf = crlf.replace(/\r\n/g, "\n");
  const window = range("2026-10-26T04:00:00Z", "2026-12-01T05:00:00Z");
  const a = parseIcs(crlf, window), b = parseIcs(lf, window);
  assert.equal(a.length, 6);
  assert.deepEqual(byUid(b), byUid(a));
  // Folding still works with LF: Project 2's description and URL are folded in the fixture.
  const p2 = byUid(b)["61734-1530087@mycourses.stonybrook.edu"];
  assert.equal(p2.url, "https://mycourses.stonybrook.edu/d2l/le/calendar/1530087/event/61734/detailsview");
});

// --- The [from, to) window ---------------------------------------------------------------------

test("window: overlap with [from, to) at the edges", { todo: true }, async () => {
  const { parseIcs } = await mod();
  // One hour, 18:00Z to 19:00Z on Nov 4.
  const text = cal(...vevent("hour@x", "DTSTART:20261104T180000Z", "DTEND:20261104T190000Z", "SUMMARY:Hour"));
  const hits = (from, to) => parseIcs(text, range(from, to)).length;
  assert.equal(hits("2026-11-04T19:00:00Z", "2026-11-04T20:00:00Z"), 0, "ends exactly at from");
  assert.equal(hits("2026-11-04T17:00:00Z", "2026-11-04T18:00:00Z"), 0, "starts exactly at to");
  assert.equal(hits("2026-11-04T18:59:00Z", "2026-11-04T20:00:00Z"), 1, "last minute inside");
  assert.equal(hits("2026-11-04T17:00:00Z", "2026-11-04T18:01:00Z"), 1, "first minute inside");
  assert.equal(hits("2026-11-04T18:15:00Z", "2026-11-04T18:30:00Z"), 1, "window inside the event");
  assert.equal(hits("2026-11-04T00:00:00Z", "2026-11-05T00:00:00Z"), 1, "event inside the window");
  assert.equal(hits("2026-11-05T00:00:00Z", "2026-11-06T00:00:00Z"), 0, "the next day");
});

test("window: a zero-length event inside the window is kept, one at `to` is not", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const text = cal(...vevent("due@x", "DTSTART:20261106T045900Z", "SUMMARY:Homework 4 - Due"));
  assert.equal(parseIcs(text, range("2026-11-06T00:00:00Z", "2026-11-07T00:00:00Z")).length, 1);
  assert.equal(parseIcs(text, range("2026-11-05T00:00:00Z", "2026-11-06T04:59:00Z")).length, 0);
});

test("window: an all-day event is kept when the window falls inside its days, dropped when far outside", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const text = cal(...vevent("break@x", "DTSTART;VALUE=DATE:20261125", "DTEND;VALUE=DATE:20261130", "SUMMARY:Break"));
  assert.equal(parseIcs(text, range("2026-11-27T12:00:00Z", "2026-11-27T13:00:00Z")).length, 1);
  assert.equal(parseIcs(text, range("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z")).length, 0);
  assert.equal(parseIcs(text, range("2026-12-05T00:00:00Z", "2026-12-10T00:00:00Z")).length, 0);
});

// --- Malformed input ---------------------------------------------------------------------------

test("malformed: bad events are skipped, the good ones around them kept, nothing thrown", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const text = cal(
    ...vevent("good1@x", "DTSTART:20261104T180000Z", "DTEND:20261104T190000Z", "SUMMARY:Good one"),
    ...vevent("baddate@x", "DTSTART;TZID=America/New_York:2026-11-09", "SUMMARY:Lab 5 - Due"),
    ...vevent("nostart@x", "DTEND:20261104T190000Z", "SUMMARY:No start"),
    ...vevent("junk@x", "DTSTART:tomorrow-ish", "SUMMARY:Junk"),
    ...vevent("good2@x", "DTSTART;VALUE=DATE:20261125", "DTEND;VALUE=DATE:20261126", "SUMMARY:Good two"),
  );
  assert.deepEqual(uids(parseIcs(text, wide)), ["good1@x", "good2@x"]);
});

test("malformed: an unterminated VEVENT at the end of the text is skipped", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const text = [
    "BEGIN:VCALENDAR",
    ...vevent("ok@x", "DTSTART:20261104T180000Z", "SUMMARY:Fine"),
    "BEGIN:VEVENT", "UID:cut@x", "DTSTART:20261104T200000Z", "SUMMARY:Cut off mid-downl",
  ].join("\r\n");
  assert.deepEqual(uids(parseIcs(text, wide)), ["ok@x"]);
});

test("malformed: empty text or not a calendar at all gives no events, no throw", { todo: true }, async () => {
  const { parseIcs } = await mod();
  assert.deepEqual(parseIcs("", wide), []);
  assert.deepEqual(parseIcs("<html><head><title>302 Found</title></head></html>", wide), []);
});

// --- Brightspace-shaped fixture ----------------------------------------------------------------

test("brightspace: the sample feed reads into its six good events", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const got = byUid(parseIcs(fixture("brightspace-sample.ics"), range("2026-10-26T04:00:00Z", "2026-12-01T05:00:00Z")));
  assert.deepEqual(Object.keys(got).sort(), [
    "61734-1530087@mycourses.stonybrook.edu",
    "61902-1530112@mycourses.stonybrook.edu",
    "62011-1530087@mycourses.stonybrook.edu",
    "62240-1530112@mycourses.stonybrook.edu",
    "62301-1530087@mycourses.stonybrook.edu",
    "62555-6606@mycourses.stonybrook.edu",
  ]); // Lab 5 (62600) has a malformed DTSTART and is skipped.

  const p2 = got["61734-1530087@mycourses.stonybrook.edu"];
  assert.equal(p2.summary, "Project 2 - Due");
  assert.equal(p2.description, "Submit the repo link and a short write-up, max 2 pages; late work loses 10% per day.\nRubric: see Content > Projects\\Rubrics.");
  assert.equal(p2.location, "CSE 316 - Fall 2026");
  assert.equal(p2.url, "https://mycourses.stonybrook.edu/d2l/le/calendar/1530087/event/61734/detailsview");
  assert.deepEqual(times(p2), { start: "2026-10-31T03:59:00.000Z", end: "2026-10-31T03:59:00.000Z", allDay: false });

  assert.deepEqual(times(got["61902-1530112@mycourses.stonybrook.edu"]),
    { start: "2026-11-06T04:59:00.000Z", end: "2026-11-06T04:59:00.000Z", allDay: false }); // no DTEND
  assert.deepEqual(times(got["62011-1530087@mycourses.stonybrook.edu"]),
    { start: "2026-11-07T04:59:00.000Z", end: "2026-11-07T04:59:00.000Z", allDay: false }); // UTC
  assert.deepEqual(times(got["62240-1530112@mycourses.stonybrook.edu"]),
    { start: "2026-11-13T01:30:00.000Z", end: "2026-11-13T02:50:00.000Z", allDay: false }); // DURATION
  assert.deepEqual(times(got["62301-1530087@mycourses.stonybrook.edu"]),
    { start: "2026-11-04T19:00:00.000Z", end: "2026-11-04T20:00:00.000Z", allDay: false }); // RRULE ignored
  assert.deepEqual(times(got["62555-6606@mycourses.stonybrook.edu"]),
    { start: "2026-11-25", end: "2026-11-30", allDay: true });
  assert.equal(got["62555-6606@mycourses.stonybrook.edu"].summary, "Thanksgiving Break - No Classes");
});

test("brightspace: a one-week window keeps only that week's items", { todo: true }, async () => {
  const { parseIcs } = await mod();
  // Mon Nov 2 to Mon Nov 9, New York (EST, UTC-5).
  const got = parseIcs(fixture("brightspace-sample.ics"), range("2026-11-02T05:00:00Z", "2026-11-09T05:00:00Z"));
  assert.deepEqual(uids(got), [
    "61902-1530112@mycourses.stonybrook.edu",
    "62011-1530087@mycourses.stonybrook.edu",
    "62301-1530087@mycourses.stonybrook.edu",
  ]);
});

// --- SB Engaged sample (22 events trimmed from the public feed, fetched 2026-11-03) -------------

const SB = {
  artWalk: "a6b581395375f95214b387cd8f7b4c3f10162026_1:48:23_AM@campusgroups.com",
  archery: "9b04f2e8486934f5ca08d809be3ad5b010162026_1:18:16_AM@campusgroups.com",
  fallFest: "6deafe625715a7063acd3837b9ba577010212026_3:25:40_PM@campusgroups.com",
  sleepWell: "c09823dd2d1e003af70c631dc4b7d0c210222026_11:45:34_PM@campusgroups.com",
  meetRubo: "b1c6a7d9abd089715a367fefa43b548110212026_9:57:27_AM@campusgroups.com",
  pina: "3aa723747b7634c485764148a650031b10152026_9:33:52_PM@campusgroups.com",
  scioly: "f1c1dee86ae5669c1a2945b6cc4f2f589202026_2:29:03_PM@campusgroups.com",
  chocolate: "829761545edb173a48bb75865e4cf9129162026_2:08:17_PM@campusgroups.com",
  ivgcf: "fd69637e4e25753c8d91aa15b0da8ced10192026_7:58:44_PM@campusgroups.com",
  tasteOfWorld: "080e2b670689696857c16d8c9972c7ba10182026_11:16:03_PM@campusgroups.com",
  suturing: "a3f7a7eb3a0ee4ed128b39ca952476739162026_8:23:54_PM@campusgroups.com",
  dirt: "f31dd0b9610d405ac57499e8e1bb311610272026_7:00:39_PM@campusgroups.com",
  thetaTau: "fa1db19ce7b493380e21f0cbcb9a504910162026_1:07:31_AM@campusgroups.com",
  lyrical: "41659f313023149b1cbed6f3d8dfe6a610162026_1:22:03_AM@campusgroups.com",
};

test("sb engaged: all 22 sample events read in their week", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const got = parseIcs(fixture("sbengaged-sample.ics"), range("2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z"));
  assert.equal(got.length, 22);
  assert.ok(got.every((e) => e.allDay === false), "SB Engaged sends only UTC date-times");
});

test("sb engaged: Fall Fest, a free-food event with three tags, reads field by field", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const ev = byUid(parseIcs(fixture("sbengaged-sample.ics"), range("2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z")))[SB.fallFest];
  assert.equal(ev.summary, "Fall Fest"); // SUMMARY;ENCODING=QUOTED-PRINTABLE:Fall Fest
  // Sun Nov 1 is EST: 3-5 PM local, matching the description.
  assert.deepEqual(times(ev), { start: "2026-11-01T20:00:00.000Z", end: "2026-11-01T22:00:00.000Z", allDay: false });
  assert.equal(ev.location, "Bauman Center, United States");
  assert.equal(ev.url, "https://sbengaged.stonybrook.edu/rsvp?id=390781");
  assert.equal(ev.description,
    "H community is proud to announce that Fall Fest, our annual fall festiveal will be taking place on Sunday, " +
    "November 1, Join us from 3 - 5:00 PM in the Bauman Center, where there will be food, drinks, entertainment and games" +
    "\n---\nEvent Details: https://sbengaged.stonybrook.edu/rsvp?id=390781");
  // Three CATEGORIES lines; the third is "event_tags: Free Food & Refreshments,Games & Entertainment,Arts & Creativity".
  assert.deepEqual(trimmed(ev.categories), [
    "club_acronym:BENEDICTSOUTHRESIDENCEHALL",
    "event_type:Social",
    "event_tags: Free Food & Refreshments",
    "Games & Entertainment",
    "Arts & Creativity",
  ]);
});

test("sb engaged: an event with no event_tags line has just its club and type", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const ev = byUid(parseIcs(fixture("sbengaged-sample.ics"), range("2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z")))[SB.scioly];
  assert.equal(ev.summary, "Science Olympiad Weekly GBM");
  assert.deepEqual(trimmed(ev.categories), ["club_acronym:STONYBROOKSCIOLY", "event_type:Meeting"]);
  // Tue Nov 3, 7-8 PM EST.
  assert.deepEqual(times(ev), { start: "2026-11-04T00:00:00.000Z", end: "2026-11-04T01:00:00.000Z", allDay: false });
});

test("sb engaged: text with commas and non-ASCII letters comes through untouched", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const got = byUid(parseIcs(fixture("sbengaged-sample.ics"), range("2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z")));
  assert.equal(got[SB.sleepWell].summary, "Sleep Well, Southampton!");
  assert.equal(got[SB.pina].summary, "Piña & Paint Night");
  assert.equal(got[SB.chocolate].summary, "Chocolate de abuelita, con cookies");
  assert.equal(got[SB.archery].summary.trim(), "Indoor Archery Practice"); // the feed has a trailing space
});

test("sb engaged: a midnight-to-23:55 event across the DST change keeps its UTC times", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const ev = byUid(parseIcs(fixture("sbengaged-sample.ics"), range("2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z")))[SB.artWalk];
  assert.equal(ev.summary, "Explore Port Jefferson - Art Walk");
  // 00:00 EDT Sun Nov 1 to 23:55 EST the same day.
  assert.deepEqual(times(ev), { start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T04:55:00.000Z", allDay: false });
});

test("sb engaged: Wednesday Nov 4 in New York holds six events", { todo: true }, async () => {
  const { parseIcs } = await mod();
  // 00:00 to 24:00 EST on Nov 4. The Tue-evening events ending before 05:00Z are out, and
  // "Dirt and Destress" (Nov 5 00:00Z, 7 PM Wed local) is in.
  const got = parseIcs(fixture("sbengaged-sample.ics"), range("2026-11-04T05:00:00Z", "2026-11-05T05:00:00Z"));
  assert.deepEqual(uids(got), [SB.meetRubo, SB.chocolate, SB.ivgcf, SB.tasteOfWorld, SB.suturing, SB.dirt].sort());
});

test("sb engaged: a zero-length event and the multi-day ones around it", { todo: true }, async () => {
  const { parseIcs } = await mod();
  const got = parseIcs(fixture("sbengaged-sample.ics"), range("2026-11-06T17:00:00Z", "2026-11-06T19:00:00Z"));
  assert.deepEqual(uids(got), [SB.meetRubo, SB.thetaTau, SB.lyrical].sort());
  const lyrical = byUid(got)[SB.lyrical];
  assert.deepEqual(times(lyrical), { start: "2026-11-06T18:00:00.000Z", end: "2026-11-06T18:00:00.000Z", allDay: false });
});

// --- The full feed's speed (recorded, not a gate) -----------------------------------------------

test("speed: the full SB Engaged feed's parse time is recorded", { todo: true }, async (t) => {
  const { parseIcs } = await mod();
  // The 8.4 MB feed is not committed. Save it and point SHEET_FULL_ICS at it to measure:
  //   curl -sL -o /tmp/sbengaged.ics https://sbengaged.stonybrook.edu/ical/stonybrook/ical_stonybrook.ics
  const path = process.env.SHEET_FULL_ICS;
  if (!path || !existsSync(path)) {
    t.diagnostic("SHEET_FULL_ICS not set; full-feed timing not measured");
    return;
  }
  const text = readFileSync(path, "utf8");
  const before = process.cpuUsage();
  const events = parseIcs(text, range("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"));
  const cpu = process.cpuUsage(before);
  const ms = (cpu.user + cpu.system) / 1000;
  t.diagnostic(`full feed: ${(text.length / 1e6).toFixed(1)} MB, ${events.length} events, ${ms.toFixed(0)} ms CPU (target under 1000)`);
  assert.ok(events.length > 1000);
});
