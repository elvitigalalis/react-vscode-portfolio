// The wake alarm /plan offers to set on his iPhone (src/sheet/alarm.mjs), from Oura sleep_nights
// rows. Expected values are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alarmFor, alarmUrl } from "../src/sheet/alarm.mjs";

const TZ = "America/New_York";
// One night ending at `wake`, "YYYY-MM-DDTHH:MM" local in New York (EST from 2026-11-01).
let n = 0;
const night = (wake) => {
  const end = new Date(`${wake}:00${wake < "2026-11-01T02" ? "-04:00" : "-05:00"}`);
  return { oura_id: `n${++n}`, day: wake.slice(0, 10), type: "long_sleep", bedtime_start: new Date(+end - 8 * 3_600_000).toISOString(), bedtime_end: end.toISOString() };
};
const WEEKDAYS = [night("2026-11-02T09:30"), night("2026-11-03T09:52"), night("2026-11-04T09:41")]; // Mon-Wed
const WEEKENDS = [night("2026-10-31T11:00"), night("2026-11-01T10:40"), night("2026-10-25T10:50")]; // Sat, Sun, Sun
// Wednesday 2026-11-04, 8:00 pm EST.
const WED_EVENING = new Date("2026-11-05T01:00:00Z");

test("alarmFor: a weekday morning takes his typical weekday wake, rounded down to 5 minutes", () => {
  assert.deepEqual(alarmFor(WED_EVENING, [...WEEKDAYS, ...WEEKENDS], TZ), { day: "2026-11-05", time: "09:40", source: "typical" });
});

test("alarmFor: Friday night sets Saturday's alarm from his weekend wake", () => {
  const FRI_EVENING = new Date("2026-11-07T02:00:00Z"); // Fri 2026-11-06, 9:00 pm EST
  assert.deepEqual(alarmFor(FRI_EVENING, [...WEEKDAYS, ...WEEKENDS], TZ), { day: "2026-11-07", time: "10:50", source: "typical" });
});

test("alarmFor: at 1 am the alarm is for this morning, not tomorrow's", () => {
  const THU_1AM = new Date("2026-11-05T06:00:00Z"); // Thu 2026-11-05, 1:00 am EST
  assert.equal(alarmFor(THU_1AM, WEEKDAYS, TZ).day, "2026-11-05");
});

test("alarmFor: without 3 wakes of the kind, 30 minutes before the plan's default start (9:30)", () => {
  assert.deepEqual(alarmFor(WED_EVENING, WEEKENDS, TZ), { day: "2026-11-05", time: "09:00", source: "default" });
});

test("alarmUrl: runs the Sheet Alarm shortcut with the time as text input (Apple's run-shortcut format)", () => {
  assert.equal(alarmUrl("07:05"), "shortcuts://run-shortcut?name=Sheet%20Alarm&input=text&text=07%3A05");
});
