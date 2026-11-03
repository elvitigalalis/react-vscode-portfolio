// The Campus list's extras beyond the contract (src/sheet/campus.mjs). The contract's own rules
// are pinned in test/v3-d.verify.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allDay, campusDay, campusTags, eventToTask } from "../src/sheet/campus.mjs";

const tz = "America/New_York";
const ev = (starts_at, ends_at, extra = {}) => ({ uid: "u", title: "Fair", starts_at, ends_at, all_day: false, tags: [], ...extra });

test("allDay: SB Engaged's 12 am to 11:55 pm events count as all day, as do all_day rows", () => {
  assert.equal(allDay(ev("2026-11-04T05:00:00Z", "2026-11-05T04:55:00Z"), tz), true);
  assert.equal(allDay(ev("2026-11-04T05:00:00Z", "2026-11-05T05:00:00Z", { all_day: true }), tz), true);
  assert.equal(allDay(ev("2026-11-04T05:00:00Z", "2026-11-04T06:00:00Z"), tz), false);
  assert.equal(allDay(ev("2026-11-04T14:00:00Z", "2026-11-05T14:00:00Z"), tz), false);
});

test("an all-day-looking event added as all day has no time and no estimate", () => {
  const e = ev("2026-11-04T05:00:00Z", "2026-11-05T04:55:00Z");
  const t = eventToTask({ ...e, all_day: allDay(e, tz) }, tz);
  assert.equal(t.at_time, null);
  assert.equal(t.est_min, null);
  assert.equal(t.day, "2026-11-04");
});

test("tags compare trimmed: SB Engaged's leading space doesn't split a tag", () => {
  const events = [
    ev("2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z", { uid: "a", tags: [" Free Food & Refreshments"] }),
    ev("2026-11-04T16:00:00Z", "2026-11-04T17:00:00Z", { uid: "b", tags: ["Free Food & Refreshments", "Games"] }),
  ];
  assert.deepEqual(campusTags(events), [{ tag: "Free Food & Refreshments", count: 2 }, { tag: "Games", count: 1 }]);
  assert.deepEqual(campusDay(events, "2026-11-04", tz, { tags: ["Free Food & Refreshments"] }).map((e) => e.uid), ["a", "b"]);
});

test("eventToTask: a zero-length event still gets a valid estimate", () => {
  assert.equal(eventToTask(ev("2026-11-04T15:00:00Z", "2026-11-04T15:00:00Z"), tz).est_min, 1);
});
