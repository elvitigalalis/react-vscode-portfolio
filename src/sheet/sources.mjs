// Read-only sources for the planner (docs/sheet-v5.md, "sources.mjs"): what the sync functions
// turn each outside feed into. Pure, so node --test covers it; the Edge Functions import it.
import { addDays, formatSpan, minutesOn, cutTitle, localNow, titleDue, zonedIso } from "./logic.mjs";
import { linkish } from "./proposal.mjs";
import { changeRow } from "./replan.mjs";

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

// --- GitHub and Jira (SRC1) ------------------------------------------------------------------
// work-sync fetches both read-only and hands the raw results here. Only titles, links and due
// dates come out: never a body, a description, a milestone's notes or a person.

// The task changes for one source's open items, already shaped as [{ uid, title, link, due }].
// As courseTaskChanges (feeds.mjs): a uid never seen is inserted and goes into feed_seen; a seen
// one updates its undone task; a done or deleted task is left alone. Unlike Brightspace, the
// searches list only open items, so an undone task whose uid is gone is closed: the review was
// done, the issue closed or the ticket finished. One change row per insert, weight 8 when due
// today, tomorrow or the day after.
function workTaskChanges(rows, { tasks, seen, today }, source, list) {
  const mine = tasks.filter((t) => t.source === source && t.source_uid);
  const byUid = new Map(mine.map((t) => [t.source_uid, t]));
  const known = new Set([...seen.map((s) => (typeof s === "string" ? s : s.uid)), ...byUid.keys()]);
  const soon = (due) => due != null && due >= today && due <= addDays(today, 2);
  const insert = [], update = [], added = [], changes = [];
  const open = new Set();
  for (const { uid, title, link, due: given } of rows) {
    if (!uid || !title || open.has(uid)) continue;
    // A deadline written only in the title counts as the due date (logic.mjs, titleDue).
    const due = given ?? titleDue(title, today);
    open.add(uid);
    if (!known.has(uid)) {
      insert.push({ title, day: null, list, due, public: false, source, source_uid: uid, link });
      added.push({ source, uid });
      changes.push(changeRow(`${source}_${soon(due) ? "due_soon" : "change"}`, uid));
      continue;
    }
    const t = byUid.get(uid);
    if (t && !t.done && (t.title !== title || t.due !== due)) update.push({ id: t.id, title, due });
  }
  const close = mine.filter((t) => !t.done && !open.has(t.source_uid)).map((t) => t.id);
  return { insert, update, close, seen: added, changes };
}

const httpsOnly = (u) => (/^https:\/\//.test(String(u ?? "")) ? u : null);
const dayOf = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s ?? "")) ? String(s).slice(0, 10) : null);

// GitHub search/issues items (https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests),
// both searches merged. The owner is read from repository_url
// ("https://api.github.com/repos/<owner>/<repo>"); only repositories in `orgs` count. A pull
// request carries `pull_request`. The milestone's due_on is a UTC instant at the start of its day,
// so its date part is the due date.
export function githubTaskChanges(items, { tasks, seen, orgs, today }) {
  const allowed = new Set((orgs ?? []).map((o) => String(o).toLowerCase()));
  const rows = (items ?? []).filter((it) => {
    const owner = /\/repos\/([^/]+)\//.exec(String(it?.repository_url ?? ""))?.[1];
    return owner && allowed.has(owner.toLowerCase());
  }).map((it) => {
    const title = cutTitle(String(it.title ?? "").replace(/\s+/g, " "));
    const link = httpsOnly(it.html_url);
    return { uid: link, link, title: title && (it.pull_request ? `Review: ${title}` : title), due: dayOf(it.milestone?.due_on) };
  });
  return workTaskChanges(rows, { tasks, seen, today }, "github", "GitHub");
}

// Jira POST /rest/api/3/search/jql issues
// (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/), for
// `assignee = currentUser() AND statusCategory != Done`. Reads key, fields.summary and
// fields.duedate ("YYYY-MM-DD") only; `site` is "<name>.atlassian.net".
export function jiraTaskChanges(issues, { tasks, seen, site, today }) {
  const rows = (issues ?? []).filter((i) => /^[A-Z][A-Z0-9_]*-\d+$/.test(String(i?.key ?? ""))).map((i) => {
    const summary = cutTitle(String(i.fields?.summary ?? "").replace(/\s+/g, " "));
    return { uid: i.key, link: `https://${site}/browse/${i.key}`, title: summary && cutTitle(`${i.key} ${summary}`), due: dayOf(i.fields?.duedate) };
  });
  return workTaskChanges(rows, { tasks, seen, today }, "jira", "Jira");
}

// /plan Settings' GitHub orgs: logins split on commas or spaces, lower case, once each. Anything
// that isn't a GitHub login (letters, digits and inner hyphens, up to 39) is undefined, so nothing
// is saved.
export function githubOrgsFromInput(value) {
  const orgs = [...new Set(String(value ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean))];
  return orgs.every((o) => /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/.test(o)) ? orgs : undefined;
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
