// Verification tests for v5 W1, weather: the NWS forecast to the brief's weather line and to
// read_planner's hourly weather, in src/sheet/sources.mjs (weatherPeriods, weatherAlerts,
// weatherLine, weatherHours). Written before the code from docs/sheet-v5.md "Contracts" and spec
// 47. Every test starts as `todo`; the implementer removes `todo` and must not change an
// expectation. Expected values are written out by hand. The module is imported inside each test,
// so this file loads before it exists.
//
// test/fixtures/nws-hourly.json is a forecastHourly response for Stony Brook
// (https://www.weather.gov/documentation/services-web-api; /gridpoints/OKX/…/forecast/hourly), cut to
// Wednesday 2026-11-04, 6:00 am to 1:00 am, EST (UTC-5). Its hours (local start, °F, chance of
// precipitation %, shortForecast):
//    6 am 38 20 Mostly Cloudy           3 pm 51 70 Light Rain
//    7 am 39 45 Chance Rain Showers     4 pm 50 60 Light Rain
//    8 am 41 30 Mostly Cloudy           5 pm 49 39 Slight Chance Light Rain
//    9 am 44 20 Mostly Cloudy           6 pm 47 30 Mostly Cloudy
//   10 am 47 15 Partly Sunny            7 pm 46 20 Mostly Cloudy
//   11 am 50 15 Partly Sunny            8 pm 45 40 Chance Rain Showers
//   12 pm 52 25 Mostly Cloudy           9 pm 44 10 Mostly Cloudy
//    1 pm 54 35 Mostly Cloudy          10 pm 43 null Mostly Cloudy
//    2 pm 53 50 Chance Light Rain      11 pm 42 10 Mostly Cloudy
//   and Thursday 12 am, 41 °F, 80 %, Rain Likely.
// So, from 8 am to before 11 pm: wet (40 % or more) 2-5 pm, at most 70 %, and 8-9 pm at 40 %;
// 41 °F at the lowest (8 am) and 54 °F at the highest (1 pm).
//
// Readings chosen where the contract leaves room (closest to its words):
// - Spans and temperatures are shown in the owner's time zone; `day` is a local date.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = () => import("../src/sheet/sources.mjs");
const todo = { todo: true };

const TZ = "America/New_York";
const DAY = "2026-11-04";
const forecast = JSON.parse(readFileSync(new URL("./fixtures/nws-hourly.json", import.meta.url), "utf8"));

// A synthetic hour, for the cases the fixture doesn't cover: local hour h on DAY (EST).
const hour = (h, pop, short = "Mostly Cloudy", temp_f = 50) => ({
  start: new Date(Date.UTC(2026, 10, 4, h + 5)).toISOString(),
  end: new Date(Date.UTC(2026, 10, 4, h + 6)).toISOString(),
  temp_f, pop, short,
});

// =============================================================================================
// weatherPeriods and weatherAlerts
// =============================================================================================

test("weatherPeriods: each hour as start, end, °F, chance of precipitation and the short forecast", async () => {
  const { weatherPeriods } = await load();
  const periods = weatherPeriods(forecast);
  assert.equal(periods.length, 19);
  assert.deepEqual(periods[0], { start: "2026-11-04T11:00:00.000Z", end: "2026-11-04T12:00:00.000Z", temp_f: 38, pop: 20, short: "Mostly Cloudy" });
  assert.deepEqual(periods[9], { start: "2026-11-04T20:00:00.000Z", end: "2026-11-04T21:00:00.000Z", temp_f: 51, pop: 70, short: "Light Rain" });
  // 10 pm has no chance given: it reads as 0.
  assert.deepEqual(periods[16], { start: "2026-11-05T03:00:00.000Z", end: "2026-11-05T04:00:00.000Z", temp_f: 43, pop: 0, short: "Mostly Cloudy" });
});

test("weatherPeriods: a temperature in °C is converted to °F, rounded", async () => {
  const { weatherPeriods } = await load();
  const one = {
    properties: {
      periods: [{
        number: 1, startTime: "2026-11-04T14:00:00-05:00", endTime: "2026-11-04T15:00:00-05:00", temperature: 11, temperatureUnit: "C",
        probabilityOfPrecipitation: { unitCode: "wmoUnit:percent", value: 5 }, shortForecast: "Sunny",
      }],
    },
  };
  // 11 °C is 51.8 °F.
  assert.deepEqual(weatherPeriods(one), [{ start: "2026-11-04T19:00:00.000Z", end: "2026-11-04T20:00:00.000Z", temp_f: 52, pop: 5, short: "Sunny" }]);
});

test("weatherAlerts: event, start (onset, else effective) and end (ends, else expires)", async () => {
  const { weatherAlerts } = await load();
  const alerts = {
    type: "FeatureCollection",
    features: [
      { properties: { event: "Wind Advisory", onset: "2026-11-04T12:00:00-05:00", effective: "2026-11-04T04:10:00-05:00", ends: "2026-11-04T21:00:00-05:00", expires: "2026-11-04T13:00:00-05:00", headline: "Wind Advisory issued November 4" } },
      { properties: { event: "Special Weather Statement", onset: null, effective: "2026-11-04T09:00:00-05:00", ends: null, expires: "2026-11-04T11:00:00-05:00" } },
    ],
  };
  assert.deepEqual(weatherAlerts(alerts), [
    { event: "Wind Advisory", starts: "2026-11-04T17:00:00.000Z", ends: "2026-11-05T02:00:00.000Z" },
    { event: "Special Weather Statement", starts: "2026-11-04T14:00:00.000Z", ends: "2026-11-04T16:00:00.000Z" },
  ]);
});

// =============================================================================================
// weatherLine
// =============================================================================================

test("weatherLine: wet spans from 8 am to 11 pm, each with its highest chance, then the day's range", todo, async () => {
  const { weatherPeriods, weatherLine } = await load();
  // 7 am (45 %) is before 8 am, 5 pm (39 %) is under 40 %, and Thursday's midnight rain is another day.
  assert.equal(weatherLine(weatherPeriods(forecast), [], DAY, TZ), "Weather: Rain 2–5 pm (70%), Rain 8–9 pm (40%), 41–54°F.");
});

test("weatherLine: a dry day says so", todo, async () => {
  const { weatherPeriods, weatherLine } = await load();
  const dry = weatherPeriods(forecast).map((p) => ({ ...p, pop: 10 }));
  assert.equal(weatherLine(dry, [], DAY, TZ), "Weather: dry, 41–54°F.");
});

test("weatherLine: snow, then storms, win over rain in a span's word", todo, async () => {
  const { weatherPeriods, weatherLine } = await load();
  const shorts = { "2026-11-04T19:00:00.000Z": "Rain And Snow Likely", "2026-11-05T01:00:00.000Z": "Chance Showers And Thunderstorms" };
  const mixed = weatherPeriods(forecast).map((p) => ({ ...p, short: shorts[p.start] ?? p.short }));
  assert.equal(weatherLine(mixed, [], DAY, TZ), "Weather: Snow 2–5 pm (70%), Storms 8–9 pm (40%), 41–54°F.");
});

test("weatherLine: a span runs to 11 pm at the latest", todo, async () => {
  const { weatherLine } = await load();
  // Wet from 8 pm on, 11 pm included: only 8-11 pm counts.
  const periods = [hour(19, 0), hour(20, 40), hour(21, 80), hour(22, 60), hour(23, 90)];
  // Every hour is 50 °F, so the range is one number.
  assert.equal(weatherLine(periods, [], DAY, TZ), "Weather: Rain 8–11 pm (80%), 50°F.");
});

test("weatherLine: at most 3 spans, the earliest", todo, async () => {
  const { weatherLine } = await load();
  const periods = [8, 9, 10, 11, 12, 13, 14].map((h, i) => hour(h, i % 2 ? 0 : 50, "Light Rain", 40 + i));
  // Wet at 8, 10, 12 and 2 pm, each one hour; 40-46 °F.
  assert.equal(weatherLine(periods, [], DAY, TZ), "Weather: Rain 8–9 am (50%), Rain 10–11 am (50%), Rain 12–1 pm (50%), 40–46°F.");
});

test("weatherLine: no forecast for the day gives no line", todo, async () => {
  const { weatherPeriods, weatherLine } = await load();
  assert.equal(weatherLine(weatherPeriods(forecast), [], "2026-11-06", TZ), null);
  assert.equal(weatherLine([], [], DAY, TZ), null);
  // Only 6 and 7 am: nothing from 8 am on.
  assert.equal(weatherLine([hour(6, 90), hour(7, 90)], [], DAY, TZ), null);
});

test("weatherLine: alerts on the day are named once each, at most 2", todo, async () => {
  const { weatherPeriods, weatherLine } = await load();
  const alerts = [
    { event: "Wind Advisory", starts: "2026-11-04T17:00:00.000Z", ends: "2026-11-05T02:00:00.000Z" },
    { event: "Wind Advisory", starts: "2026-11-04T18:00:00.000Z", ends: "2026-11-05T02:00:00.000Z" },
    { event: "Winter Storm Watch", starts: "2026-11-06T05:00:00.000Z", ends: "2026-11-07T05:00:00.000Z" }, // Friday
    { event: "Coastal Flood Statement", starts: "2026-11-03T20:00:00.000Z", ends: "2026-11-04T06:00:00.000Z" }, // into 1 am today
    { event: "Gale Warning", starts: "2026-11-04T20:00:00.000Z", ends: "2026-11-04T23:00:00.000Z" },
  ];
  assert.equal(weatherLine(weatherPeriods(forecast), alerts, DAY, TZ),
    "Weather: Rain 2–5 pm (70%), Rain 8–9 pm (40%), 41–54°F. Alert: Wind Advisory, Coastal Flood Statement.");
});

test("weatherLine: an alert name that could become a link is left out", todo, async () => {
  const { weatherPeriods, weatherLine } = await load();
  const alerts = [{ event: "See weather.gov now", starts: "2026-11-04T17:00:00.000Z", ends: "2026-11-04T20:00:00.000Z" }];
  assert.equal(weatherLine(weatherPeriods(forecast), alerts, DAY, TZ), "Weather: Rain 2–5 pm (70%), Rain 8–9 pm (40%), 41–54°F.");
});

// =============================================================================================
// weatherHours (read_planner's weather)
// =============================================================================================

test("weatherHours: the day's hours from 7 am to before 11 pm, for the planner", todo, async () => {
  const { weatherPeriods, weatherHours } = await load();
  const hours = weatherHours(weatherPeriods(forecast), DAY, TZ);
  assert.equal(hours.length, 16);
  assert.deepEqual(hours[0], { at: "2026-11-04T12:00:00.000Z", temp_f: 39, pop: 45, short: "Chance Rain Showers" });
  assert.deepEqual(hours[7], { at: "2026-11-04T19:00:00.000Z", temp_f: 53, pop: 50, short: "Chance Light Rain" });
  assert.deepEqual(hours[15], { at: "2026-11-05T03:00:00.000Z", temp_f: 43, pop: 0, short: "Mostly Cloudy" });
});
