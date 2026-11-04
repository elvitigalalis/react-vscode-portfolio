// The academic calendar where it reaches Lisul and the planner (docs/sheet-v5.md, SRC3):
// read_planner's `academic` (proposal.mjs, planSnapshot) and the brief on an empty day
// (nudges.mjs). The entries and the brief's line are pinned in test/v5-ical.verify.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSnapshot } from "../src/sheet/proposal.mjs";
import { whatToSend } from "../src/sheet/nudges.mjs";

const TZ = "America/New_York";
const settings = { id: true, time_zone: TZ, interests: null, busy_as_of: null };
const rows = (extra = {}) => ({ settings, tasks: [], blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [], ...extra });
const sixOhSeven = new Date("2026-11-04T11:07:00Z");
const academic = [{ title: "No classes", all_day: true }];

test("planSnapshot: academic is plan_day's entries as given, [] without them", () => {
  assert.deepEqual(planSnapshot(rows({ academic }), sixOhSeven).academic, academic);
  assert.deepEqual(planSnapshot(rows(), sixOhSeven).academic, []);
});

test("brief: an empty day still gets the calendar line", () => {
  const snap = { settings: { time_zone: TZ, telegram_chat_id: 42, nudges_on: true }, day: null, tasks: [], blocks: [], log: [], academic };
  const brief = whatToSend(snap, new Date("2026-11-04T13:00:00Z")).find((m) => m.kind === "brief");
  assert.equal(brief.text, "Nothing on today.\nCalendar: No classes.");
});

// --- /plan Settings, the enrollment time ------------------------------------------------------

test("enrollment input: the stored instant as local date and time, and back", async () => {
  const { enrollmentInput, enrollmentFromInput } = await import("../src/sheet/sources.mjs");
  assert.equal(enrollmentInput("2026-11-13T03:30:00Z", TZ), "2026-11-12T22:30");
  assert.equal(enrollmentInput(null, TZ), "");
  assert.equal(enrollmentFromInput("2026-11-12T22:30", TZ), "2026-11-13T03:30:00.000Z");
  assert.equal(enrollmentFromInput("2027-04-06T09:00", TZ), "2027-04-06T13:00:00.000Z"); // EDT
  assert.equal(enrollmentFromInput("  ", TZ), null);
  assert.equal(enrollmentFromInput("2026-13-01T09:00", TZ), undefined);
  assert.equal(enrollmentFromInput("tomorrow", TZ), undefined);
});
