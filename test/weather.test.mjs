// Weather where it reaches Lisul and the planner (docs/sheet-v5.md, W1): read_planner's `weather`
// (proposal.mjs, planSnapshot) and the brief's weather line (nudges.mjs). The line and the hours
// themselves are pinned in test/v5-weather.verify.test.mjs. Wednesday 2026-11-04 in New York, EST.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planSnapshot } from "../src/sheet/proposal.mjs";
import { whatToSend } from "../src/sheet/nudges.mjs";
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

// --- The brief ---------------------------------------------------------------------------------

const nudgeSettings = { time_zone: TZ, telegram_chat_id: 42, nudges_on: true };
const snapshot = (extra = {}) => ({ settings: nudgeSettings, day: null, tasks: [], blocks: [], log: [], ...extra });
const eight = new Date("2026-11-04T13:00:00Z");
const briefText = (snap) => whatToSend(snap, eight).find((m) => m.kind === "brief").text;
const LINE = "Weather: Rain 2–5 pm (70%), Rain 8–9 pm (40%), 41–54°F.";

// Since the brief folds its tail (research/plan-phone.md P7), the weather line comes after the lines to act on.
test("brief: the weather line folds under the at-risk and plan lines", () => {
  const tasks = [
    { id: "t1", title: "OS homework", day: DAY, done: false, due: null, public: true },
    { id: "t2", title: "Essay", day: null, done: false, due: "2026-11-05", public: true },
  ];
  assert.equal(briefText(snapshot({ tasks, weather: cache })),
    `Today: 1 task, 0 blocks.\nAt risk: Essay (due Thu).\nNothing planned yet: say "plan my day" to Claude.\n${LINE}`);
});

test("brief: an empty day still gets the weather", () => {
  assert.equal(briefText(snapshot({ weather: cache })), `Nothing on today.\n${LINE}`);
});

test("brief: no cache, or one with no periods, adds no line", () => {
  assert.equal(briefText(snapshot()), "Nothing on today.");
  assert.equal(briefText(snapshot({ weather: { ...cache, periods: [] } })), "Nothing on today.");
});

// --- The weather function ------------------------------------------------------------------------

test("weather function: a generic User-Agent on every NWS request, with no email", () => {
  const src = readFileSync(new URL("../supabase/functions/weather/index.ts", import.meta.url), "utf8");
  const ua = src.match(/"User-Agent": "([^"]+)"/)?.[1];
  assert.ok(ua, "sets a User-Agent");
  assert.doesNotMatch(ua, /@|lisul|elvitigala/i);
  // Every fetch goes through getJson, which sends the headers.
  assert.equal(src.match(/\bfetch\(/g).length, 1);
  assert.match(src, /fetch\(url, \{ headers: HEADERS \}\)/);
});

test("schema: weather_cache is owner-only and written only by the server", () => {
  const sql = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists weather_cache/);
  assert.match(sql, /revoke all on weather_cache from anon;/);
  assert.match(sql, /revoke insert, update, delete on weather_cache from authenticated;/);
  assert.match(sql, /cron\.schedule\('sheet-weather', '50 \* \* \* \*'/);
});
