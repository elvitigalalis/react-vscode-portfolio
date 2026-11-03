// The Campus list's extras beyond the contract (src/sheet/campus.mjs). The contract's own rules
// are pinned in test/v3-d.verify.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { campusDay, campusTags, eventToTask, isAdded, activeTags, tagsOf } from "../src/sheet/campus.mjs";

const tz = "America/New_York";
const ev = (starts_at, ends_at, extra = {}) => ({ uid: "u", title: "Fair", starts_at, ends_at, all_day: false, tags: [], ...extra });

test("eventToTask: all day is the row's all_day, which the feed read sets (feeds.mjs), not a guess from the times", () => {
  // SB Engaged's 12 am to 11:55 pm shape: the feed read stores it with all_day true.
  const e = ev("2026-11-04T05:00:00Z", "2026-11-05T04:55:00Z");
  const t = eventToTask({ ...e, all_day: true }, tz);
  assert.equal(t.at_time, null);
  assert.equal(t.est_min, null);
  assert.equal(t.day, "2026-11-04");
  // The same times with all_day false are taken as given: a timed task, capped at 4 hours.
  assert.deepEqual([eventToTask(e, tz).at_time, eventToTask(e, tz).est_min], ["00:00", 240]);
});

test("tagsOf: an event's tags trimmed, blanks dropped", () => {
  assert.deepEqual(tagsOf(ev("2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z", { tags: [" Free Food & Refreshments", "  ", "Games"] })),
    ["Free Food & Refreshments", "Games"]);
  assert.deepEqual(tagsOf({}), []);
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

test("isAdded: true once a #campus task with the event's title is on its day", () => {
  const t = eventToTask(ev("2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z", { title: "Robotics Expo" }), tz);
  const task = (extra) => ({ id: "1", title: "Robotics Expo", day: "2026-11-04", tag: "campus", ...extra });
  assert.equal(isAdded([], t), false);
  assert.equal(isAdded([task()], t), true);
  assert.equal(isAdded([task({ day: "2026-11-05" })], t), false); // another day
  assert.equal(isAdded([task({ tag: null })], t), false);          // his own task, same name
  assert.equal(isAdded([task({ title: "Robotics" })], t), false);
});

test("activeTags: only picked tags that are on screen filter, so another day's pick never empties this one", () => {
  const onScreen = [{ tag: "Games", count: 2 }, { tag: "Free Food & Refreshments", count: 1 }];
  assert.deepEqual(activeTags(["Games", "Robotics"], onScreen), ["Games"]);
  assert.deepEqual(activeTags(["Robotics"], onScreen), []);
  assert.deepEqual(activeTags([], onScreen), []);
  assert.deepEqual(activeTags(["Games"], []), []);
});
