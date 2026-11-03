// /plan's side of the morning plan (src/sheet/morning.mjs; docs/sheet-morning.md, "/plan"): which
// Google events become busy times, how Needs you is grouped, and which links open Gmail. Tuesday
// 2026-11-03 in New York (EST, UTC-5). Events have the shape api.mjs calendarEvents returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { busyRows, needsGroups, gmailLink, planNotes } from "../src/sheet/morning.mjs";

const NOW = new Date("2026-11-03T15:20:00Z");
const ev = (starts_at, ends_at, extra = {}) =>
  ({ title: "CSE 320 Lecture", allDay: false, busy: true, starts_at, ends_at, link: "https://calendar.google.com/x", calendar: "primary", ...extra });

// ---------------------------------------------------------------- busyRows

test("busyRows: a timed busy event is saved as its start and end in UTC, nothing else", () => {
  assert.deepEqual(busyRows([ev("2026-11-03T14:00:00-05:00", "2026-11-03T15:20:00-05:00")], NOW, "tb"),
    [{ starts_at: "2026-11-03T19:00:00.000Z", ends_at: "2026-11-03T20:20:00.000Z" }]);
});

test("busyRows: all-day events, free events and the Time blocks calendar are left out", () => {
  const events = [
    { ...ev("2026-11-03", "2026-11-04"), title: "Election Day", allDay: true },
    ev("2026-11-03T12:00:00-05:00", "2026-11-03T13:00:00-05:00", { title: "Office hours (optional)", busy: false }),
    ev("2026-11-03T16:00:00-05:00", "2026-11-03T17:00:00-05:00", { title: "OS homework", calendar: "tb" }),
    ev("2026-11-04T09:00:00-05:00", "2026-11-04T10:00:00-05:00", { calendar: "classes@group.calendar.google.com" }),
  ];
  assert.deepEqual(busyRows(events, NOW, "tb"), [{ starts_at: "2026-11-04T14:00:00.000Z", ends_at: "2026-11-04T15:00:00.000Z" }]);
});

test("busyRows: only now through 7 days ahead; an event under way at now is kept whole", () => {
  const events = [
    ev("2026-11-03T08:00:00-05:00", "2026-11-03T09:15:00-05:00"),   // ended at 9:15 am, before now (10:20)
    ev("2026-11-03T10:00:00-05:00", "2026-11-03T11:00:00-05:00"),   // under way
    ev("2026-11-10T10:00:00-05:00", "2026-11-10T11:00:00-05:00"),   // starts before now + 7 days: in
    ev("2026-11-10T10:20:00-05:00", "2026-11-10T11:00:00-05:00"),   // starts at now + 7 days: out
  ];
  assert.deepEqual(busyRows(events, NOW, "tb"), [
    { starts_at: "2026-11-03T15:00:00.000Z", ends_at: "2026-11-03T16:00:00.000Z" },
    { starts_at: "2026-11-10T15:00:00.000Z", ends_at: "2026-11-10T16:00:00.000Z" },
  ]);
});

test("busyRows: the same times on two calendars are saved once, earliest first", () => {
  const events = [
    ev("2026-11-05T09:00:00-05:00", "2026-11-05T10:20:00-05:00"),
    ev("2026-11-04T13:00:00-05:00", "2026-11-04T13:53:00-05:00"),
    ev("2026-11-05T14:00:00Z", "2026-11-05T15:20:00Z", { calendar: "classes" }),
  ];
  assert.deepEqual(busyRows(events, NOW, "tb"), [
    { starts_at: "2026-11-04T18:00:00.000Z", ends_at: "2026-11-04T18:53:00.000Z" },
    { starts_at: "2026-11-05T14:00:00.000Z", ends_at: "2026-11-05T15:20:00.000Z" },
  ]);
});

// ---------------------------------------------------------------- needsGroups

const SBU = "lisul.elvitigala@stonybrook.edu";
const need = (id, kind, extra = {}) => ({
  id, day: "2026-11-03", account: SBU, message_id: `19a4f2c3b5d6e7f${id}`, link: "https://mail.google.com/mail/?authuser=x#all/19a4f2c3b5d6e7f8",
  sender: "Ana Ruiz", subject: "Demo moved", why: "Reply by Thursday.", kind, due: null, done: false, created_at: "2026-11-03T11:07:00Z", ...extra,
});

test("needsGroups: rows not done, grouped Reply owed, Deadlines, Meetings, School & admin; empty groups left out", () => {
  const rows = [need(1, "admin"), need(2, "reply"), need(3, "deadline", { done: true }), need(4, "reply"), need(5, "admin")];
  assert.deepEqual(needsGroups(rows).map((g) => [g.kind, g.title, g.rows.map((r) => r.id)]), [
    ["reply", "Reply owed", [2, 4]],
    ["admin", "School & admin", [1, 5]],
  ]);
  assert.deepEqual(needsGroups([need(6, "meeting"), need(7, "deadline")]).map((g) => g.title), ["Deadlines", "Meetings"]);
});

test("needsGroups: within a group the soonest due comes first, and rows with no due date last", () => {
  const rows = [need(1, "deadline"), need(2, "deadline", { due: "2026-11-07" }), need(3, "deadline", { due: "2026-11-04" })];
  assert.deepEqual(needsGroups(rows)[0].rows.map((r) => r.id), [3, 2, 1]);
});

test("needsGroups: nothing open is no groups", () => {
  assert.deepEqual(needsGroups([need(1, "reply", { done: true })]), []);
  assert.deepEqual(needsGroups([]), []);
});

// ---------------------------------------------------------------- gmailLink

test("gmailLink: a Gmail link is kept as it is", () => {
  const link = `https://mail.google.com/mail/?authuser=${encodeURIComponent(SBU)}#all/19a4f2c3b5d6e7f8`;
  assert.equal(gmailLink(link), link);
});

test("gmailLink: anything else is no link", () => {
  for (const link of [
    "http://mail.google.com/mail/#all/19a4",          // not https
    "https://mail.google.com.evil.example/mail/",     // another host
    "https://mail.google.com@evil.example/",          // a user part, then another host
    "javascript:alert(1)//https://mail.google.com/",
    " https://mail.google.com/mail/",                 // doesn't start with it
    "HTTPS://MAIL.GOOGLE.COM/mail/",
    "https://evil.example/?https://mail.google.com/",
    "", null, undefined, 42,
  ]) assert.equal(gmailLink(link), null, String(link));
});

// ---------------------------------------------------------------- planNotes

const TZ = "America/New_York";
const campus = [
  { uid: "c1", title: "Art Club - Oil Pastels", starts_at: "2026-11-04T00:00:00Z", ends_at: "2026-11-04T01:30:00Z", rsvp_count: 22 },
  { uid: "c2", title: "Google Info Session", starts_at: "2026-11-03T21:00:00Z", ends_at: "2026-11-03T22:00:00Z", rsvp_count: null },
];

test("planNotes: the note, then every pick in the brief's words", () => {
  const p = { day: "2026-11-03", status: "pending", note: "Lab 4 (2h) didn't fit before shutdown.", picks: [{ uid: "c1", why: "Art" }, { uid: "c2", why: "Career" }] };
  assert.deepEqual(planNotes(p, campus, TZ), [
    "Didn't fit: Lab 4 (2h) didn't fit before shutdown.",
    "Campus pick: Art Club - Oil Pastels (7:00 pm, 22 going)",
    "Campus pick: Google Info Session (4:00 pm)",
  ]);
});

test("planNotes: the couldn't-fit titles follow the note (v5 D2)", () => {
  const p = { day: "2026-11-03", status: "pending", note: "Gym got squeezed.", picks: [], couldnt_fit: ["t2"] };
  const tasks = [{ id: "t1", title: "OS homework" }, { id: "t2", title: "Lab 4" }];
  assert.deepEqual(planNotes(p, campus, TZ, tasks), ["Didn't fit: Gym got squeezed.", "Couldn't fit: Lab 4."]);
});

test("planNotes: no proposal, a skipped one, or one with nothing to say is no lines; a pick not found is skipped", () => {
  assert.deepEqual(planNotes(null, campus, TZ), []);
  assert.deepEqual(planNotes({ day: "2026-11-03", status: "skipped", note: "x", picks: [{ uid: "c1" }] }, campus, TZ), []);
  assert.deepEqual(planNotes({ day: "2026-11-03", status: "approved", note: null, picks: [{ uid: "gone" }] }, campus, TZ), []);
});
