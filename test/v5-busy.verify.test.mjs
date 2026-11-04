// Verification tests for v5 S1, busy times saved by the server: the pure side of the busy sync,
// src/sheet/freebusy.mjs (freeBusyRequest, freeBusyRows). Written before the code from
// docs/sheet-v5.md "Contracts" and spec 47. Every test starts as `todo`; the implementer removes
// `todo` and must not change an expectation. Expected values are written out by hand. The module
// is imported inside each test, so this file loads before it exists.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5). The sync runs at 10:02 am, 15:02 UTC, so its
// window is 2026-11-04T15:02Z to 2026-11-11T15:02Z.
//
// The response is Google's freebusy.query shape
// (https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query):
// { kind, timeMin, timeMax, calendars: { <id>: { busy: [{ start, end }], errors?: [{ domain, reason }] } } }.
//
// Readings chosen where the contract leaves room (closest to its words):
// - "Overlaps now to now + 7 days" is strict: a span ending exactly at now, or starting exactly at
//   now + 7 days, is left out.
// - A span given with an offset ("-05:00") is the same instant in UTC.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("../src/sheet/freebusy.mjs");
const todo = { todo: true };

const OWNER = "elvitigalalis@gmail.com";
const CLASSES = "c_classes@group.calendar.google.com";
const HOLIDAYS = "en.usa#holiday@group.v.calendar.google.com";
const BLOCKS = "tb@group.calendar.google.com"; // "Time blocks"
const BROKEN = "broken@group.calendar.google.com";
const now = new Date("2026-11-04T15:02:00Z");

const settings = (extra = {}) => ({
  id: true, owner_email: OWNER, time_zone: "America/New_York", gcal_calendar_id: BLOCKS, calendars: [], ...extra,
});

// =============================================================================================
// freeBusyRequest
// =============================================================================================

test("freeBusyRequest: his main calendar and the ones he shows, from now to 7 days ahead", async () => {
  const { freeBusyRequest } = await load();
  assert.deepEqual(freeBusyRequest(settings({ calendars: [CLASSES, HOLIDAYS] }), now), {
    timeMin: "2026-11-04T15:02:00.000Z",
    timeMax: "2026-11-11T15:02:00.000Z",
    items: [{ id: OWNER }, { id: CLASSES }, { id: HOLIDAYS }],
  });
});

test("freeBusyRequest: Time blocks is never asked for, and each calendar is asked once", async () => {
  const { freeBusyRequest } = await load();
  const s = settings({ calendars: [CLASSES, BLOCKS, OWNER, HOLIDAYS, CLASSES] });
  assert.deepEqual(freeBusyRequest(s, now).items, [{ id: OWNER }, { id: CLASSES }, { id: HOLIDAYS }]);
});

test("freeBusyRequest: with no extra calendars, only his main one", async () => {
  const { freeBusyRequest } = await load();
  assert.deepEqual(freeBusyRequest(settings(), now).items, [{ id: OWNER }]);
  // Before "Time blocks" exists there is nothing to leave out.
  assert.deepEqual(freeBusyRequest(settings({ gcal_calendar_id: null, calendars: [CLASSES] }), now).items, [{ id: OWNER }, { id: CLASSES }]);
});

// =============================================================================================
// freeBusyRows
// =============================================================================================

const response = {
  kind: "calendar#freeBusy",
  timeMin: "2026-11-04T15:02:00.000Z",
  timeMax: "2026-11-11T15:02:00.000Z",
  calendars: {
    [OWNER]: {
      busy: [
        { start: "2026-11-04T19:00:00Z", end: "2026-11-04T20:20:00Z" },           // 2:00-3:20 pm
        { start: "2026-11-05T14:00:00-05:00", end: "2026-11-05T15:15:00-05:00" }, // Thu 2:00-3:15 pm, with an offset
        { start: "2026-11-04T19:00:00Z", end: "2026-11-04T19:30:00Z" },           // same start, earlier end
      ],
    },
    [CLASSES]: {
      busy: [
        { start: "2026-11-04T19:00:00Z", end: "2026-11-04T20:20:00Z" }, // the same span on a second calendar
        { start: "2026-11-04T14:00:00Z", end: "2026-11-04T15:30:00Z" }, // 9:00-10:30 am, running now: kept whole
        { start: "2026-11-04T13:00:00Z", end: "2026-11-04T14:00:00Z" }, // ended before now
        { start: "2026-11-04T14:02:00Z", end: "2026-11-04T15:02:00Z" }, // ends exactly now
        { start: "2026-11-11T15:00:00Z", end: "2026-11-11T16:00:00Z" }, // starts just before the window ends
        { start: "2026-11-11T15:02:00Z", end: "2026-11-11T16:00:00Z" }, // starts exactly as it ends
      ],
    },
    [BLOCKS]: { busy: [{ start: "2026-11-04T21:00:00Z", end: "2026-11-04T22:00:00Z" }] }, // his own block
    [BROKEN]: {
      errors: [{ domain: "global", reason: "notFound" }],
      busy: [{ start: "2026-11-06T15:00:00Z", end: "2026-11-06T16:00:00Z" }],
    },
  },
};

test("freeBusyRows: start and end only, in UTC, once each, earliest first; Time blocks and failed calendars add nothing", async () => {
  const { freeBusyRows } = await load();
  assert.deepEqual(freeBusyRows(response, now, BLOCKS), {
    rows: [
      { starts_at: "2026-11-04T14:00:00.000Z", ends_at: "2026-11-04T15:30:00.000Z" },
      { starts_at: "2026-11-04T19:00:00.000Z", ends_at: "2026-11-04T19:30:00.000Z" },
      { starts_at: "2026-11-04T19:00:00.000Z", ends_at: "2026-11-04T20:20:00.000Z" },
      { starts_at: "2026-11-05T19:00:00.000Z", ends_at: "2026-11-05T20:15:00.000Z" },
      { starts_at: "2026-11-11T15:00:00.000Z", ends_at: "2026-11-11T16:00:00.000Z" },
    ],
    failed: [BROKEN],
  });
});

test("freeBusyRows: the rows hold no titles or other fields, whatever the response carries", async () => {
  const { freeBusyRows } = await load();
  const withExtras = { calendars: { [OWNER]: { busy: [{ start: "2026-11-04T19:00:00Z", end: "2026-11-04T20:20:00Z", summary: "Therapy" }] } } };
  assert.deepEqual(freeBusyRows(withExtras, now, BLOCKS).rows, [{ starts_at: "2026-11-04T19:00:00.000Z", ends_at: "2026-11-04T20:20:00.000Z" }]);
});

test("freeBusyRows: Time blocks is left out even when Google returns it", async () => {
  const { freeBusyRows } = await load();
  const only = { calendars: { [BLOCKS]: response.calendars[BLOCKS] } };
  assert.deepEqual(freeBusyRows(only, now, BLOCKS), { rows: [], failed: [] });
  // With no Time blocks calendar yet, every calendar counts.
  assert.deepEqual(freeBusyRows(only, now, null).rows, [{ starts_at: "2026-11-04T21:00:00.000Z", ends_at: "2026-11-04T22:00:00.000Z" }]);
});

test("freeBusyRows: failed calendars are listed in response order", async () => {
  const { freeBusyRows } = await load();
  const r = {
    calendars: {
      "a@group.calendar.google.com": { errors: [{ domain: "calendar", reason: "notFound" }], busy: [] },
      [OWNER]: { busy: [] },
      "b@group.calendar.google.com": { errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }] },
    },
  };
  assert.deepEqual(freeBusyRows(r, now, BLOCKS), { rows: [], failed: ["a@group.calendar.google.com", "b@group.calendar.google.com"] });
});

test("freeBusyRows: an empty response gives no rows and no failures", async () => {
  const { freeBusyRows } = await load();
  assert.deepEqual(freeBusyRows({ kind: "calendar#freeBusy", calendars: {} }, now, BLOCKS), { rows: [], failed: [] });
});
