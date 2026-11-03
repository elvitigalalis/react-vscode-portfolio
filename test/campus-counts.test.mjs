// RSVP counts read from SB Engaged's public event pages (src/sheet/feeds.mjs). The fixtures are
// real pages (2026-11-03), cut to the event's card, with the sign-in form's _csrf emptied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countsDue, rsvpCount } from "../src/sheet/feeds.mjs";

const page = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("rsvpCount: the number over \"Registered\" on an event's page", () => {
  assert.equal(rsvpCount(page("sbengaged-event.html")), 13); // Resident Assistant Info Session
  assert.equal(rsvpCount(page("sbengaged-event-past.html")), 0); // a past event still shows its count
});

test("rsvpCount: a ticket's \"Spots Left\" number is not the count", () => {
  assert.equal(rsvpCount(page("sbengaged-event-spots.html")), 9); // A Taste of the World: 9 registered, 11 left
});

test("rsvpCount: null for a page without one (a sign-in page, an error page, nothing)", () => {
  assert.equal(rsvpCount('<span class="number">4</span> <div>Interested</div>'), null);
  assert.equal(rsvpCount("<html><title>Sign In</title></html>"), null);
  assert.equal(rsvpCount(""), null);
  assert.equal(rsvpCount(undefined), null);
});

test("rsvpCount: thousands separators read as one number", () => {
  assert.equal(rsvpCount('<span class="number">1,204</span>\n\t\t<div>Registered</div>'), 1204);
});

// --- countsDue -------------------------------------------------------------------------------

const NOW = new Date("2026-11-03T15:00:00.000Z");
const h = (n) => new Date(NOW.getTime() + n * 3_600_000).toISOString();
const row = (uid, starts, checked = null, extra = {}) => ({
  uid, title: `Event ${uid}`, event_type: "Social", url: `https://sbengaged.stonybrook.edu/rsvp?id=${uid}`,
  starts_at: h(starts), rsvp_checked_at: checked === null ? null : h(checked), ...extra,
});
const due = (rows, limit) => countsDue(rows, NOW, limit).map((r) => r.uid);

test("countsDue: never-checked events first, soonest first, then stale ones by start", () => {
  const rows = [
    row("stale-soon", 5, -7), row("new-late", 200), row("new-soon", 2), row("stale-later", 100, -25),
  ];
  assert.deepEqual(due(rows, 10), ["new-soon", "new-late", "stale-soon", "stale-later"]);
  assert.deepEqual(due(rows, 2), ["new-soon", "new-late"]);
});

test("countsDue: a count is fresh for 6 hours within 3 days of the event, 24 hours further out", () => {
  const rows = [
    row("soon-5h", 24, -5), row("soon-7h", 24, -7),
    row("far-23h", 100, -23), row("far-25h", 100, -25),
  ];
  assert.deepEqual(due(rows, 10), ["soon-7h", "far-25h"]);
});

test("countsDue: skips events already started, routine ones, and ones without a page", () => {
  const rows = [
    row("started", -1), row("meeting", 3, null, { event_type: "Meeting" }),
    row("practice", 3, null, { title: "Club soccer practice" }), row("no-url", 3, null, { url: null }),
    row("ok", 3),
  ];
  assert.deepEqual(due(rows, 10), ["ok"]);
});
