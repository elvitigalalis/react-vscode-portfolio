// Extra cases for the feed mappers (src/sheet/feeds.mjs) beyond the v3 verification tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { campusRows, campusWindowIcs } from "../src/sheet/feeds.mjs";
import { parseIcs } from "../src/sheet/ical.mjs";

const NOW = new Date("2026-11-03T15:00:00.000Z"); // 10:00 in Stony Brook
const ev = (uid, start, end) => ({
  uid, summary: "Commuter Appreciation Month - Explore Seawolves Country ", description: "", location: "",
  url: "", organizer: "Commuter Student Services", categories: ["event_type:Social"], start, end, allDay: false,
});

test("campusRows: SB Engaged's 00:00 to 23:55 local is all-day, at its real instants", () => {
  const [row] = campusRows([ev("a", "2026-11-05T05:00:00.000Z", "2026-11-06T04:55:00.000Z")], NOW);
  assert.equal(row.all_day, true);
  assert.equal(row.starts_at, "2026-11-05T05:00:00.000Z");
  assert.equal(row.ends_at, "2026-11-06T04:55:00.000Z");
  assert.equal(row.title, "Commuter Appreciation Month - Explore Seawolves Country");
});

test("campusRows: a several-day 00:00 to 23:55 event is all-day too, across the DST change", () => {
  // Hispanic Heritage Month 2026: Sep 15 00:00 EDT to Nov 8 23:55 EST.
  const [row] = campusRows([ev("b", "2026-09-15T04:00:00.000Z", "2026-11-09T04:55:00.000Z")], NOW);
  assert.equal(row.all_day, true);
});

test("campusRows: other times are not all-day", () => {
  const rows = campusRows([
    ev("midnight-to-1", "2026-11-05T05:00:00.000Z", "2026-11-05T06:00:00.000Z"),
    ev("utc-midnight", "2026-11-05T00:00:00.000Z", "2026-11-05T23:55:00.000Z"),
  ], NOW);
  assert.deepEqual(rows.map((r) => r.all_day), [false, false]);
});

test("campusRows: a dated all-day event runs from New York midnight to New York midnight", () => {
  const [row] = campusRows([{ ...ev("c", "2026-11-06", "2026-11-07"), allDay: true }], NOW);
  assert.equal(row.starts_at, "2026-11-06T05:00:00.000Z");
  assert.equal(row.ends_at, "2026-11-07T05:00:00.000Z");
});

test("campusRows: blank fields are null, and updated_at is now", () => {
  const [row] = campusRows([ev("d", "2026-11-05T18:00:00.000Z", "2026-11-05T19:00:00.000Z")], NOW);
  assert.equal(row.description, null);
  assert.equal(row.url, null);
  assert.equal(row.location, null);
  assert.equal(row.updated_at, "2026-11-03T15:00:00.000Z");
});

// --- campusWindowIcs ---------------------------------------------------------------------

const cal = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
const vevent = (uid, ...lines) => ["BEGIN:VEVENT", `UID:${uid}`, ...lines, "END:VEVENT"];
const TO = new Date(+NOW + 14 * 86_400_000);
const uids = (text) => parseIcs(text, { from: "2026-01-01", to: "2028-01-01" }).map((e) => e.uid);

test("campusWindowIcs: keeps the events near the window, drops the far ones", () => {
  const text = cal(
    vevent("august", "DTSTART:20260804T160000Z", "DTEND:20260804T200000Z"),
    vevent("running-since-september", "DTSTART:20260901T170000Z", "DTEND:20261130T180000Z"),
    vevent("ended-last-night", "DTSTART:20261102T220000Z", "DTEND:20261103T000000Z"), // a day's slack
    vevent("today", "DTSTART;TZID=America/New_York:20261103T190000", "DTEND;TZID=America/New_York:20261103T200000"),
    vevent("all-day", "DTSTART;VALUE=DATE:20261110", "DTEND;VALUE=DATE:20261111"),
    vevent("day-after-edge", "DTSTART:20261118T120000Z", "DTEND:20261118T130000Z"),     // a day's slack
    vevent("december", "DTSTART:20261205T120000Z", "DTEND:20261205T130000Z"),
    vevent("no-end", "DTSTART:20261104T120000Z"),
    vevent("no-end-far", "DTSTART:20270104T120000Z"),
  );
  assert.deepEqual(uids(campusWindowIcs(text, NOW, TO)),
    ["running-since-september", "ended-last-night", "today", "all-day", "day-after-edge", "no-end"]);
});

test("campusWindowIcs: an event whose start it can't read is left for parseIcs", () => {
  const text = cal(vevent("folded", "DTSTART;TZID=America/New_Y", " ork:20261104T120000", "DTEND:20261104T180000Z"));
  assert.deepEqual(uids(campusWindowIcs(text, NOW, TO)), ["folded"]);
});

test("campusWindowIcs: a description quoting END:VEVENT doesn't cut its event", () => {
  const text = cal(vevent("quoted", "DESCRIPTION:say END:VEVENT here", "DTSTART:20261104T120000Z", "DTEND:20261104T130000Z"));
  assert.deepEqual(uids(campusWindowIcs(text, NOW, TO)), ["quoted"]);
});

test("campusWindowIcs: no events give an empty calendar", () => {
  assert.deepEqual(parseIcs(campusWindowIcs(cal(), NOW, TO), { from: NOW, to: TO }), []);
  assert.deepEqual(parseIcs(campusWindowIcs("", NOW, TO), { from: NOW, to: TO }), []);
});
