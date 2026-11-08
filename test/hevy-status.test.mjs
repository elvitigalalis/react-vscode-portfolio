// Settings' Hevy block (src/sheet/hevy-status.mjs): the status and error lines and the key check.
// Expected values are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hevyError, hevyKey, hevyStatus } from "../src/sheet/hevy-status.mjs";

const TZ = "America/New_York";
const NOW = new Date("2026-11-08T20:00:00Z"); // Sun Nov 8, 3:00 pm EST

test("hevyKey: a UUID, trimmed, in either case; anything else is null", () => {
  assert.equal(hevyKey("  0f8a1c2e-1234-4abc-9def-0123456789AB\n"), "0f8a1c2e-1234-4abc-9def-0123456789AB");
  assert.equal(hevyKey(""), null);
  assert.equal(hevyKey(null), null);
  assert.equal(hevyKey("0f8a1c2e12344abc9def0123456789ab"), null);
  assert.equal(hevyKey("0f8a1c2e-1234-4abc-9def-0123456789ab extra"), null);
});

test("hevyStatus: not connected, waiting for the first sync, synced today, synced before today", () => {
  assert.equal(hevyStatus(null, NOW, TZ), "Not connected");
  assert.equal(hevyStatus({ synced_at: null }, NOW, TZ), "Connected. The first sync runs within 15 minutes.");
  // 14:24Z is 9:24 am EST, the same day.
  assert.equal(hevyStatus({ synced_at: "2026-11-08T14:24:00Z" }, NOW, TZ), "Synced 9:24 am");
  // 03:39Z on Nov 8 is 10:39 pm on Nov 7 in New York.
  assert.equal(hevyStatus({ synced_at: "2026-11-08T03:39:00Z" }, NOW, TZ), "Synced Nov 7, 10:39 pm");
});

test("hevyError: nothing without an error; a refused key asks for a new one; not pro says so", () => {
  assert.equal(hevyError(null), "");
  assert.equal(hevyError({ last_error: null }), "");
  assert.equal(hevyError({ last_error: "key refused" }), "Last error: key refused. Paste a new key.");
  assert.equal(hevyError({ last_error: "not pro" }), "Last error: not pro. The API needs Hevy Pro.");
});
