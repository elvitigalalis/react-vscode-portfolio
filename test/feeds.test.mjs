// Extra cases for the feed mappers (src/sheet/feeds.mjs) beyond the v3 verification tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { campusRows } from "../src/sheet/feeds.mjs";

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
