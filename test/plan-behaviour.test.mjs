// /plan behaviour (work package B): the pure parts in src/sheet/glance.mjs. Expected values are
// written out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedAlert } from "../src/sheet/glance.mjs";

// ---------------------------------------------------------------- feedAlert staleness

const at = (iso) => new Date(iso).getTime();
const row = (source, fetched_at, ok = true) => ({ source, fetched_at, ok, error: null, items: 3 });

test("feedAlert: a connected feed not read for over 3x its interval is flagged", () => {
  const now = at("2026-11-06T15:00:00Z");
  const rows = [
    row("gmail", "2026-11-06T14:44:00Z"),       // 16 min, every 5 min: stale
    row("freebusy", "2026-11-06T14:31:00Z"),    // 29 min, every 10: fine
    row("brightspace", "2026-11-06T11:59:00Z"), // 3h01, hourly: stale
    row("campus", "2026-11-06T12:01:00Z"),      // 2h59, hourly: fine
  ];
  assert.deepEqual(feedAlert(rows, now), ["gmail", "brightspace"]);
});

test("feedAlert: a not-connected feed (ok null) is never stale; a failed one is still named", () => {
  const now = at("2026-11-06T15:00:00Z");
  assert.deepEqual(feedAlert([row("slack", "2026-11-01T00:00:00Z", null), row("oura", "2026-11-06T14:59:00Z", false)], now), ["oura"]);
});

test("feedAlert: without a now, only failed reads count (the old contract)", () => {
  assert.deepEqual(feedAlert([row("gmail", "2020-01-01T00:00:00Z")]), []);
});
