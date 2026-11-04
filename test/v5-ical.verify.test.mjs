// Verification tests for v5 SRC3, Handshake, the academic calendar and enrollment time:
// handshakeBusy, academicEntries and enrollmentTask (src/sheet/sources.mjs) on parseIcs output
// (src/sheet/ical.mjs) from test/fixtures/handshake.ics and test/fixtures/academic.ics, and the
// brief's "Calendar:" line (src/sheet/nudges.mjs). Written before the code from docs/sheet-v5.md
// "Contracts" and spec 47. Every test starts as `todo`; the implementer removes `todo` and must
// not change an expectation. Expected values are written out by hand. Modules are imported inside
// each test, so this file loads before the code exists.
//
// November 2026 in New York is EST (UTC-5): daylight time ended on November 1.
//
// The fixtures are hand-written in each feed's shape (RFC 5545, CRLF lines):
// - handshake.ics: a career fair (an event), an interview at 10:00-10:45 am on Nov 6 (TZID), an
//   appointment at 19:00-19:30 UTC on Nov 9, an info session whose title holds "interview" but
//   doesn't start with it, a lowercase "appointment:" on Nov 11 at 9:00 am, and an uppercase
//   "INTERVIEW" on Nov 12 with a DURATION and an alarm.
// - academic.ics: all-day entries on Nov 4 (one with no DTEND, one 90 characters long, one whose
//   title is a web address), a timed entry late on Nov 3 New York time that is Nov 4 in UTC, a
//   timed one on Nov 4 at 8 pm that is Nov 5 in UTC, one on Nov 5, and Thanksgiving break, all
//   day Nov 25 to 29 (DTEND Nov 30).
//
// Readings chosen where the contract leaves room (closest to its words):
// - Busy rows and academic entries keep the feed's order; both fixtures are in time order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sources = () => import("../src/sheet/sources.mjs");
const ical = () => import("../src/sheet/ical.mjs");
const nudges = () => import("../src/sheet/nudges.mjs");
const todo = { todo: true };

const TZ = "America/New_York";
const NOVEMBER = { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" };
const fixture = async (name) => {
  const { parseIcs } = await ical();
  return parseIcs(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"), NOVEMBER);
};

// =============================================================================================
// Handshake: interviews and appointments are busy, events aren't
// =============================================================================================

test("handshakeBusy: interviews and appointments become busy rows from Handshake", async () => {
  const { handshakeBusy } = await sources();
  assert.deepEqual(handshakeBusy(await fixture("handshake.ics")), [
    { source: "handshake", starts_at: "2026-11-06T15:00:00.000Z", ends_at: "2026-11-06T15:45:00.000Z" }, // Interview, 10:00-10:45 am
    { source: "handshake", starts_at: "2026-11-09T19:00:00.000Z", ends_at: "2026-11-09T19:30:00.000Z" }, // Appointment with a Career Coach
    { source: "handshake", starts_at: "2026-11-11T14:00:00.000Z", ends_at: "2026-11-11T14:30:00.000Z" }, // appointment: resume review, 9:00 am
    { source: "handshake", starts_at: "2026-11-12T21:00:00.000Z", ends_at: "2026-11-12T22:00:00.000Z" }, // INTERVIEW - Final round, 1 h
  ]);
});

test("handshakeBusy: the summary must start with Interview or Appointment", async () => {
  const { handshakeBusy } = await sources();
  const ev = (summary) => ({ uid: summary, summary, description: "", location: "", url: "", categories: [], start: "2026-11-06T15:00:00.000Z", end: "2026-11-06T16:00:00.000Z", allDay: false });
  assert.equal(handshakeBusy([ev("Fall Career Fair")]).length, 0);
  assert.equal(handshakeBusy([ev("Info Session: Jane Street interview tips")]).length, 0);
  assert.equal(handshakeBusy([ev("Mock appointment practice")]).length, 0);
  assert.equal(handshakeBusy([ev("Interview")]).length, 1);
  assert.equal(handshakeBusy([ev("appointment")]).length, 1);
  assert.deepEqual(handshakeBusy([]), []);
});

// =============================================================================================
// The academic calendar
// =============================================================================================

test("academicEntries: a day's entries, all-day and timed, by New York time", async () => {
  const { academicEntries } = await sources();
  assert.deepEqual(academicEntries(await fixture("academic.ics"), "2026-11-04", TZ), [
    { title: "No classes", all_day: true },
    { title: "Last day to withdraw from a course", all_day: true },
    { title: "Fall open house", all_day: false }, // 8 pm on Nov 4, 01:00 UTC on Nov 5
    { title: "Last day for undergraduates to change a course's grading basis to G/P/NC for the", all_day: true }, // cut to 80
    // "Details at www.stonybrook.edu/registrar" is a web address: left out.
  ]);
});

test("academicEntries: a timed entry late in the evening belongs to its New York day", async () => {
  const { academicEntries } = await sources();
  // Late registration closes at 10 pm on Nov 3 (03:00 UTC on Nov 4).
  assert.deepEqual(academicEntries(await fixture("academic.ics"), "2026-11-03", TZ), [{ title: "Late registration closes", all_day: false }]);
});

test("academicEntries: a several-day entry is on each of its days, up to its end", async () => {
  const { academicEntries } = await sources();
  const events = await fixture("academic.ics");
  const thanksgiving = [{ title: "Thanksgiving break", all_day: true }];
  assert.deepEqual(academicEntries(events, "2026-11-25", TZ), thanksgiving);
  assert.deepEqual(academicEntries(events, "2026-11-29", TZ), thanksgiving);
  assert.deepEqual(academicEntries(events, "2026-11-30", TZ), []);
  assert.deepEqual(academicEntries(events, "2026-11-24", TZ), []);
});

test("academicEntries: the next day has its own entries only", async () => {
  const { academicEntries } = await sources();
  assert.deepEqual(academicEntries(await fixture("academic.ics"), "2026-11-05", TZ), [{ title: "Advising week begins", all_day: true }]);
});

// --- The brief's calendar line ----------------------------------------------------------------

const DAY = "2026-11-04";
const settings = { time_zone: TZ, telegram_chat_id: 42, nudges_on: true, morning_on: false };
const B1 = "0b0b0b0b-0000-4000-8000-000000000001";
const tasks = [{ id: "t1", title: "OS homework", day: DAY, done: false, due: null, public: true, est_min: 45 }];
const approved = { id: B1, task_id: "t1", starts_at: "2026-11-04T15:00:00Z", ends_at: "2026-11-04T15:45:00Z", proposed: false, gcal_id: null };
const snapshot = (extra = {}) => ({ settings, day: null, tasks, blocks: [approved], log: [], proposal: null, needsOpen: [], campus: [], ...extra });
const at8 = new Date("2026-11-04T13:00:00Z");
const ENTRIES = [
  { title: "No classes", all_day: true },
  { title: "Last day to withdraw", all_day: true },
  { title: "Fall open house", all_day: false },
  { title: "Advising week", all_day: true },
];
const briefOf = (out) => out.find((m) => m.kind === "brief");

test("brief: today's academic entries, at most 3", todo, async () => {
  const { whatToSend } = await nudges();
  assert.equal(briefOf(whatToSend(snapshot({ academic: ENTRIES }), at8)).text, [
    "Today: 1 task, 1 block.",
    "Calendar: No classes, Last day to withdraw, Fall open house.",
  ].join("\n"));
  assert.equal(briefOf(whatToSend(snapshot({ academic: ENTRIES.slice(0, 1) }), at8)).text, "Today: 1 task, 1 block.\nCalendar: No classes.");
});

test("brief: no academic entries, no calendar line", todo, async () => {
  const { whatToSend } = await nudges();
  assert.equal(briefOf(whatToSend(snapshot({ academic: [] }), at8)).text, "Today: 1 task, 1 block.");
  assert.equal(briefOf(whatToSend(snapshot(), at8)).text, "Today: 1 task, 1 block.");
});

test("brief: the calendar line comes before the plan's lines", todo, async () => {
  const { whatToSend } = await nudges();
  const proposed = { ...approved, id: "0b0b0b0b-0000-4000-8000-000000000002", starts_at: "2026-11-04T14:30:00Z", ends_at: "2026-11-04T15:15:00Z", proposed: true };
  const proposal = { day: DAY, rev: 1, status: "pending", created_at: "2026-11-04T11:09:00Z", note: null, picks: [], couldnt_fit: [], suggested: [], run_trigger: "morning", reasons: [], blocks: [] };
  const snap = snapshot({ blocks: [proposed], proposal, academic: ENTRIES.slice(0, 1) });
  assert.equal(briefOf(whatToSend(snap, at8)).text, [
    "Today: 1 task, 0 blocks.",
    "Calendar: No classes.",
    "Morning plan: 1 block, 9:30–10:15 am.",
    "9:30 am · OS homework (45 min)",
  ].join("\n"));
});

// =============================================================================================
// Enrollment time
// =============================================================================================

const enrollment = (day, at_time) => ({
  title: "Enrollment opens", day, at_time, est_min: 15, public: false, list: null, source: "enrollment", source_uid: "enrollment",
});

test("enrollmentTask: one private task on the local day, at the local time", async () => {
  const { enrollmentTask } = await sources();
  assert.deepEqual(enrollmentTask("2026-11-12T12:00:00Z", TZ), enrollment("2026-11-12", "07:00"));
  assert.deepEqual(enrollmentTask("2026-11-12T12:00:00.000Z", TZ), enrollment("2026-11-12", "07:00"));
});

test("enrollmentTask: an evening time stays on its New York day", async () => {
  const { enrollmentTask } = await sources();
  // 03:30 UTC on Nov 13 is 10:30 pm on Nov 12.
  assert.deepEqual(enrollmentTask("2026-11-13T03:30:00Z", TZ), enrollment("2026-11-12", "22:30"));
});

test("enrollmentTask: in daylight time too", async () => {
  const { enrollmentTask } = await sources();
  // April 6, 2027 is EDT (UTC-4).
  assert.deepEqual(enrollmentTask("2027-04-06T13:00:00Z", TZ), enrollment("2027-04-06", "09:00"));
});

test("enrollmentTask: no enrollment time, no task", async () => {
  const { enrollmentTask } = await sources();
  assert.equal(enrollmentTask(null, TZ), null);
});
