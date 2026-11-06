// Brightspace links (src/sheet/feeds.mjs, courseLink): each course task keeps its page in
// tasks.link, so /plan and Telegram open the assignment in one tap. Expected values are by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { courseLink, courseTaskChanges, courseEventChanges } from "../src/sheet/feeds.mjs";

const TZ = "America/New_York";
const PAGE = "https://mycourses.stonybrook.edu/d2l/le/calendar/1530087/event/61734/detailsview";
const due = (extra = {}) => ({ uid: "61734-1530087@mycourses.stonybrook.edu", summary: "Project 2 - Due", description: "", url: PAGE,
  start: "2026-11-10T04:59:00.000Z", end: "2026-11-10T04:59:00.000Z", allDay: false, categories: [], ...extra });

test("courseLink: the event's URL, else the first https link in its description, else null", () => {
  assert.equal(courseLink({ url: PAGE }), PAGE);
  assert.equal(courseLink({ url: "", description: `Read the brief.\nView event: ${PAGE} (opens Brightspace)` }), PAGE);
  assert.equal(courseLink({ url: "http://mycourses.stonybrook.edu/x" }), null);
  assert.equal(courseLink({ url: "javascript:alert(1)", description: "" }), null);
  assert.equal(courseLink({}), null);
});

test("a new course task carries its link; a known one gets its link filled in or changed", () => {
  const fresh = courseTaskChanges([due()], { tasks: [], seen: [], timeZone: TZ });
  assert.equal(fresh.insert[0].link, PAGE);
  const known = { id: "t1", title: "Project 2", due: "2026-11-09", done: false, source: "brightspace", source_uid: due().uid, link: null };
  assert.deepEqual(courseTaskChanges([due()], { tasks: [known], seen: [], timeZone: TZ }).update, [{ id: "t1", title: "Project 2", due: "2026-11-09", link: PAGE }]);
  assert.deepEqual(courseTaskChanges([due()], { tasks: [{ ...known, link: PAGE }], seen: [], timeZone: TZ }).update, []);
  // A feed without a link never clears one.
  assert.deepEqual(courseTaskChanges([due({ url: "" })], { tasks: [{ ...known, link: PAGE }], seen: [], timeZone: TZ }).update, []);
});

test("course events carry their link too", () => {
  const exam = due({ uid: "e1@x", summary: "Exam 2", start: "2026-11-12T15:00:00.000Z", end: "2026-11-12T16:20:00.000Z" });
  const out = courseEventChanges([exam], { tasks: [], seen: [], timeZone: TZ, today: "2026-11-06" });
  assert.equal(out.insert[0].link, PAGE);
});

test("courseChanges: an update that only adds a link asks for no replan", async () => {
  const { courseChanges } = await import("../src/sheet/feeds.mjs");
  const t = { id: "t1", title: "Project 2", due: "2026-11-09", day: null, source_uid: "u1", at_time: null };
  assert.deepEqual(courseChanges({ insert: [], update: [{ id: "t1", title: "Project 2", due: "2026-11-09", link: PAGE }] }, [t], "2026-11-06"), []);
  assert.equal(courseChanges({ insert: [], update: [{ id: "t1", title: "Project 2", due: "2026-11-10", link: PAGE }] }, [t], "2026-11-06").length, 1);
  // An event's "19:15" against the row's "19:15:00" is the same time.
  const ev = { id: "t2", title: "Exam 2", day: "2026-11-12", at_time: "19:15:00", est_min: 80, list: null, source_uid: "u2" };
  assert.deepEqual(courseChanges({ insert: [], update: [{ id: "t2", title: "Exam 2", day: "2026-11-12", at_time: "19:15", est_min: 80, list: null, link: PAGE }] }, [ev], "2026-11-06"), []);
});
