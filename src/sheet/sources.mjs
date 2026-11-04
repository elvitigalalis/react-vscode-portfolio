// Read-only sources for the planner (docs/sheet-v5.md, "sources.mjs"): what the sync functions
// turn each outside feed into. Pure, so node --test covers it; the Edge Functions import it.
import { formatSpan, minutesOn, cutTitle, localNow, zonedIso } from "./logic.mjs";
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

// The periods starting on `day` from `from` to before `to` (minutes past local midnight).
const periodsOn = (periods, day, timeZone, from, to) => periods.filter((p) => {
  const m = minutesOn(p.start, day, timeZone);
  return m >= from && m < to;
});

// read_planner's weather: the day's hours from 07:00 to before 23:00.
export const weatherHours = (periods, day, timeZone) => periodsOn(periods, day, timeZone, 7 * 60, 23 * 60)
  .map((p) => ({ at: p.start, temp_f: p.temp_f, pop: p.pop, short: p.short }));

// The brief's line counts the day from 08:00 to before 23:00, and a chance of 40% or more as wet.
const LINE_FROM = 8 * 60;
const LINE_TO = 23 * 60;
const WET = 40;
const MAX_SPANS = 3;
const MAX_ALERTS = 2;

const kindOf = (span) => (span.some((p) => /snow/i.test(p.short)) ? "Snow"
  : span.some((p) => /thunder/i.test(p.short)) ? "Storms" : "Rain");

// "Weather: Rain 2–5 pm (70%), 41–54°F. Alert: Wind Advisory.", or null with no forecast for `day`.
export function weatherLine(periods, alerts, day, timeZone) {
  const on = periodsOn(periods, day, timeZone, LINE_FROM, LINE_TO);
  if (!on.length) return null;
  // Wet hours, joined while each starts when the last ends.
  const spans = [];
  for (const p of on.filter((x) => x.pop >= WET)) {
    const last = spans.at(-1);
    if (last && Date.parse(last.at(-1).end) === Date.parse(p.start)) last.push(p);
    else spans.push([p]);
  }
  const words = spans.slice(0, MAX_SPANS).map((s) => {
    const when = formatSpan(minutesOn(s[0].start, day, timeZone), minutesOn(s.at(-1).end, day, timeZone));
    return `${kindOf(s)} ${when} (${Math.max(...s.map((p) => p.pop))}%)`;
  });
  const temps = on.map((p) => p.temp_f);
  const [lo, hi] = [Math.min(...temps), Math.max(...temps)];
  const temp = lo === hi ? `${lo}°F` : `${lo}–${hi}°F`;
  let line = `Weather: ${words.length ? words.join(", ") : "dry"}, ${temp}.`;
  // Alerts whose time overlaps the day, each event once.
  const events = [...new Set((alerts ?? [])
    .filter((a) => minutesOn(a.ends, day, timeZone) > 0 && minutesOn(a.starts, day, timeZone) < 1440)
    .map((a) => cutTitle(String(a.event ?? "").replace(/\s+/g, " "))))].filter((e) => e && !linkish(e)).slice(0, MAX_ALERTS);
  if (events.length) line += ` Alert: ${events.join(", ")}.`;
  return line;
}

// --- Handshake, the academic calendar and enrollment (SRC3) ----------------------------------
// Both feeds are iCal links (RFC 5545), read by parseIcs (ical.mjs); ical-sync fetches them.

// Handshake's interviews and appointments, which count as busy; its events (fairs, info sessions)
// don't. The summary has to start with the word, so "Info Session: … interview tips" is left out.
const HANDSHAKE_BUSY = /^(interview|appointment)/i;

// Parsed Handshake events to busy rows, in feed order.
export const handshakeBusy = (events) => events
  .filter((e) => !e.allDay && HANDSHAKE_BUSY.test(e.summary.trim()))
  .map((e) => ({ source: "handshake", starts_at: e.start, ends_at: e.end }));

const ACADEMIC_TITLE = 80;

// Whether a parsed event is on `day`: an all-day one from its start date to before its end date,
// a timed one (UTC from parseIcs) when it overlaps the day in `timeZone`; a zero-length one when
// it starts on the day.
function onDay(e, day, timeZone) {
  if (e.allDay) return e.start <= day && day < e.end;
  const s = minutesOn(e.start, day, timeZone), t = minutesOn(e.end, day, timeZone);
  return s < 1440 && (t > 0 || (s === t && s >= 0));
}

// The brief's and read_planner's academic calendar entries on `day`: [{ title, all_day }], in
// feed order, one-line titles cut to 80, leaving out any that read as a link.
export const academicEntries = (events, day, timeZone) => events
  .filter((e) => onDay(e, day, timeZone) && !linkish(e.summary))
  .map((e) => ({ title: cutTitle(String(e.summary ?? "").replace(/\s+/g, " ")).slice(0, ACADEMIC_TITLE).trim(), all_day: e.allDay }))
  .filter((e) => e.title);

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// The one task for settings.enrollment_at, on its local day at its local time, or null when it
// isn't set. ical-sync upserts it on (source, source_uid), so moving the time moves the task.
export function enrollmentTask(enrollmentAt, timeZone) {
  if (!enrollmentAt) return null;
  const { day, minutes } = localNow(new Date(enrollmentAt), timeZone);
  return { title: "Enrollment opens", day, at_time: hhmm(minutes), est_min: 15, public: false, list: null, source: "enrollment", source_uid: "enrollment" };
}

// /plan Settings' enrollment time: settings.enrollment_at as a datetime-local value
// ("2026-11-12T07:00", local to `timeZone`), and back to an ISO instant. Blank is null; a value
// that isn't a date and time is undefined, so nothing is saved.
export function enrollmentInput(enrollmentAt, timeZone) {
  if (!enrollmentAt) return "";
  const { day, minutes } = localNow(new Date(enrollmentAt), timeZone);
  return `${day}T${hhmm(minutes)}`;
}

export function enrollmentFromInput(value, timeZone) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) return undefined;
  return zonedIso(m[1], Number(m[2]) * 60 + Number(m[3]), timeZone);
}
