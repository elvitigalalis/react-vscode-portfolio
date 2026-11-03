// Read-only sources for the planner (docs/sheet-v5.md, "sources.mjs"): what the sync functions
// turn each outside feed into. Pure, so node --test covers it; the Edge Functions import it.
import { formatSpan, minutesOn } from "./logic.mjs";
import { linkish } from "./proposal.mjs";

// --- Weather (W1) ----------------------------------------------------------------------------
// The NWS API (https://www.weather.gov/documentation/services-web-api): /points/{lat},{lon} names
// the grid's forecastHourly URL; that and /alerts/active?point= are GeoJSON.

const iso = (s) => new Date(s).toISOString();

// A forecastHourly response to [{ start, end, temp_f, pop, short }].
export function weatherPeriods(geojson) {
  return (geojson?.properties?.periods ?? []).map((p) => ({
    start: iso(p.startTime),
    end: iso(p.endTime),
    temp_f: p.temperatureUnit === "C" ? Math.round(p.temperature * 9 / 5 + 32) : p.temperature,
    pop: p.probabilityOfPrecipitation?.value ?? 0,
    short: p.shortForecast,
  }));
}

// /alerts/active features to [{ event, starts, ends }].
export function weatherAlerts(geojson) {
  return (geojson?.features ?? []).map(({ properties: a }) => ({
    event: a.event,
    starts: iso(a.onset ?? a.effective),
    ends: iso(a.ends ?? a.expires),
  }));
}
