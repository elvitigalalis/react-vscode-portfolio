// Extra cases for the shared iCal reader (src/sheet/ical.mjs) beyond test/v3-a.verify.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcs } from "../src/sheet/ical.mjs";

const cal = (...lines) => ["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR", ""].join("\r\n");
const wide = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2028-01-01T00:00:00Z") };

test("ical: the window may be given as ISO strings", () => {
  const text = cal("BEGIN:VEVENT", "UID:s@x", "DTSTART:20261104T180000Z", "END:VEVENT");
  assert.equal(parseIcs(text, { from: "2026-11-04T00:00:00.000Z", to: "2026-11-05T00:00:00.000Z" }).length, 1);
  assert.equal(parseIcs(text, { from: "2026-11-05T00:00:00.000Z", to: "2026-11-06T00:00:00.000Z" }).length, 0);
});

test("ical: a VALARM's lines don't leak into its event", () => {
  const [ev] = parseIcs(cal("BEGIN:VEVENT", "UID:al@x", "DTSTART:20261104T180000Z", "SUMMARY:Exam",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT15M", "END:VALARM", "END:VEVENT"), wide);
  assert.equal(ev.summary, "Exam");
  assert.equal(ev.description, "");
});

test("ical: an unknown TZID skips that event only", () => {
  const got = parseIcs(cal(
    "BEGIN:VEVENT", "UID:bad@x", "DTSTART;TZID=Mars/Olympus:20261104T090000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:ok@x", "DTSTART;TZID=\"America/New_York\":20261104T090000", "END:VEVENT"), wide);
  assert.deepEqual(got.map((e) => [e.uid, e.start]), [["ok@x", "2026-11-04T14:00:00.000Z"]]);
});

test("ical: an all-day start with no end lasts one day", () => {
  const [ev] = parseIcs(cal("BEGIN:VEVENT", "UID:d@x", "DTSTART;VALUE=DATE:20261231", "END:VEVENT"), wide);
  assert.deepEqual([ev.start, ev.end, ev.allDay], ["2026-12-31", "2027-01-01", true]);
});

test("ical: organizer is the ORGANIZER line's CN, unquoted; absent when there is none", () => {
  const got = Object.fromEntries(parseIcs(cal(
    "BEGIN:VEVENT", "UID:o@x", "DTSTART:20261104T180000Z",
    "ORGANIZER;CN=\"University & Medicine: Community Relations\":mailto:noreply@sbengaged.stonybrook.edu", "END:VEVENT",
    "BEGIN:VEVENT", "UID:n@x", "DTSTART:20261104T180000Z", "END:VEVENT"), wide).map((e) => [e.uid, e]));
  assert.equal(got["o@x"].organizer, "University & Medicine: Community Relations");
  assert.equal("organizer" in got["n@x"], false);
});

test("ical: contact is the CONTACT line's value; absent when there is none", () => {
  const got = Object.fromEntries(parseIcs(cal(
    "BEGIN:VEVENT", "UID:c@x", "DTSTART:20261104T180000Z",
    "CONTACT:https://sbengaged.stonybrook.edu/toscaniniresidencehall/rsvp_boot?id=391210#event_host", "END:VEVENT",
    "BEGIN:VEVENT", "UID:n@x", "DTSTART:20261104T180000Z", "END:VEVENT"), wide).map((e) => [e.uid, e]));
  assert.equal(got["c@x"].contact, "https://sbengaged.stonybrook.edu/toscaniniresidencehall/rsvp_boot?id=391210#event_host");
  assert.equal("contact" in got["n@x"], false);
});

test("parseIcs: STATUS comes through, upper-cased, only when the feed gives one", () => {
  const ics = (extra) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261110T133000Z\r\nSUMMARY:Exam 2\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
  const win = { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" };
  assert.equal(parseIcs(ics("STATUS:cancelled\r\n"), win)[0].status, "CANCELLED");
  assert.equal("status" in parseIcs(ics(""), win)[0], false);
});
