// feed_state's last good read (src/sheet/feed-state.mjs): what a sync writes, where Slack's and
// Gmail's catch-up start from, and the Settings rows for sources never set up. Expected values are
// worked out by hand. Friday 2026-11-06 in New York, EST (UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedStateRow, slackSince, mailSweepDue, feedRows } from "../src/sheet/feed-state.mjs";

const NOW = new Date("2026-11-06T15:00:00Z"); // 10:00 am
const TZ = "America/New_York";

test("feedStateRow: a good read also sets last_ok_at; a failed or skipped one leaves it alone", () => {
  assert.deepEqual(feedStateRow("slack", { fetched_at: "2026-11-06T15:00:00Z", ok: true, error: null, items: 3 }),
    { source: "slack", fetched_at: "2026-11-06T15:00:00Z", ok: true, error: null, items: 3, last_ok_at: "2026-11-06T15:00:00Z" });
  assert.deepEqual(feedStateRow("slack", { fetched_at: "2026-11-06T15:00:00Z", ok: false, error: "slack: HTTP 500" }),
    { source: "slack", fetched_at: "2026-11-06T15:00:00Z", ok: false, error: "slack: HTTP 500" });
  assert.deepEqual(feedStateRow("slack", { fetched_at: "2026-11-06T15:00:00Z", ok: null, error: "not connected" }),
    { source: "slack", fetched_at: "2026-11-06T15:00:00Z", ok: null, error: "not connected" });
  // A row with no ok at all (campus saving its ETag) isn't a read.
  assert.deepEqual(feedStateRow("campus", { etag: "x" }), { source: "campus", etag: "x" });
});

test("slackSince: from the last good read, even when the latest read failed; a day back with none", () => {
  // Three days of failures after a good read on Tuesday: the search still starts at Tuesday's read.
  assert.equal(slackSince({ ok: false, fetched_at: "2026-11-06T14:42:00Z", last_ok_at: "2026-11-03T14:42:00Z" }, NOW).toISOString(), "2026-11-03T14:42:00.000Z");
  assert.equal(slackSince({ ok: true, fetched_at: "2026-11-06T14:42:00Z", last_ok_at: "2026-11-06T14:42:00Z" }, NOW).toISOString(), "2026-11-06T14:42:00.000Z");
  // A row from before last_ok_at existed: its fetched_at counts when that read was good.
  assert.equal(slackSince({ ok: true, fetched_at: "2026-11-06T13:42:00Z" }, NOW).toISOString(), "2026-11-06T13:42:00.000Z");
  assert.equal(slackSince({ ok: false, fetched_at: "2026-11-06T13:42:00Z" }, NOW).toISOString(), "2026-11-05T15:00:00.000Z");
  assert.equal(slackSince(undefined, NOW).toISOString(), "2026-11-05T15:00:00.000Z");
});

test("mailSweepDue: on the first good read of the local day, after a failed read, or with no good read", () => {
  // A good read earlier today: no sweep.
  assert.equal(mailSweepDue({ ok: true, fetched_at: "2026-11-06T14:57:00Z", last_ok_at: "2026-11-06T14:57:00Z" }, NOW, TZ), false);
  // The last good read was yesterday evening (11:57 pm local): a sweep.
  assert.equal(mailSweepDue({ ok: true, fetched_at: "2026-11-06T04:57:00Z", last_ok_at: "2026-11-06T04:57:00Z" }, NOW, TZ), true);
  // The latest read failed: a sweep.
  assert.equal(mailSweepDue({ ok: false, fetched_at: "2026-11-06T14:57:00Z", last_ok_at: "2026-11-06T14:52:00Z" }, NOW, TZ), true);
  // No row, or not connected yet: a sweep.
  assert.equal(mailSweepDue(undefined, NOW, TZ), true);
  assert.equal(mailSweepDue({ ok: null, fetched_at: "2026-11-06T14:57:00Z", error: "not connected" }, NOW, TZ), true);
  // A row from before last_ok_at existed, read well today: no sweep.
  assert.equal(mailSweepDue({ ok: true, fetched_at: "2026-11-06T14:57:00Z" }, NOW, TZ), false);
});

test("feedRows: every known source has a row, a missing one marked not set up, in the given order", () => {
  const rows = [{ source: "slack", ok: true, fetched_at: "2026-11-06T14:42:00Z" }, { source: "gmail", ok: true, fetched_at: "x" }];
  assert.deepEqual(feedRows(rows, ["gmail", "handshake", "slack"]), [
    { source: "gmail", ok: true, fetched_at: "x" },
    { source: "handshake", missing: true },
    { source: "slack", ok: true, fetched_at: "2026-11-06T14:42:00Z" },
  ]);
  // A row for a source not in the list still shows, after the known ones.
  assert.deepEqual(feedRows([{ source: "new", ok: true }], ["slack"]), [{ source: "slack", missing: true }, { source: "new", ok: true }]);
});
