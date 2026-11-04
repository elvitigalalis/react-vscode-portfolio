// Weather where it reaches Lisul and the planner (docs/sheet-v5.md, W1): read_planner's `weather`
// (proposal.mjs, planSnapshot) and the brief's weather line (nudges.mjs). The line and the hours
// themselves are pinned in test/v5-weather.verify.test.mjs. Wednesday 2026-11-04 in New York, EST.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planSnapshot } from "../src/sheet/proposal.mjs";
import { weatherPeriods } from "../src/sheet/sources.mjs";

const TZ = "America/New_York";
const DAY = "2026-11-04";
const periods = weatherPeriods(JSON.parse(readFileSync(new URL("./fixtures/nws-hourly.json", import.meta.url), "utf8")));
const cache = { id: true, point: "40.9126,-73.1234", periods, alerts: [], fetched_at: "2026-11-04T10:50:00Z" };

// --- read_planner ------------------------------------------------------------------------------

const settings = { id: true, time_zone: TZ, interests: null, busy_as_of: null };
const rows = (extra = {}) => ({ settings, tasks: [], blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [], ...extra });
const sixOhSeven = new Date("2026-11-04T11:07:00Z");

test("planSnapshot: weather is the cached forecast's hours for plan_day", () => {
  const { weather } = planSnapshot(rows({ weather: cache }), sixOhSeven);
  assert.equal(weather.length, 16);
  assert.deepEqual(weather[0], { at: "2026-11-04T12:00:00.000Z", temp_f: 39, pop: 45, short: "Chance Rain Showers" });
});

test("planSnapshot: no cache, or a cache for another day, gives no weather", () => {
  assert.deepEqual(planSnapshot(rows(), sixOhSeven).weather, []);
  assert.deepEqual(planSnapshot(rows({ weather: null }), sixOhSeven).weather, []);
  // At 3 pm plan_day is tomorrow, which the fixture covers only at midnight.
  assert.deepEqual(planSnapshot(rows({ weather: cache }), new Date("2026-11-04T20:00:00Z")).weather, []);
});
