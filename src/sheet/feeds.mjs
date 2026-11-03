// Feed items into planner rows (docs/sheet-sources.md, "Contracts"). Pure: parseIcs output in,
// rows out. The brightspace and campus Edge Functions do the fetching and the writing.

// --- Campus events (SB Engaged) ---------------------------------------------------------------

const DAY = 86_400_000;
const WINDOW = 14 * DAY;
// SB Engaged is Stony Brook's feed, so its wall clock is New York's.
const CAMPUS_TZ = "America/New_York";

// "Sign in to download the location" and "Register to receive location details!", each with an
// optional leading space or ", United States": the location is hidden behind sign-in.
const HIDDEN_LOCATION = /^\s*(Sign in to download the location|Register to receive location details!.*?)(, United States)?\s*$/;

const wall = new Intl.DateTimeFormat("en-US", { timeZone: CAMPUS_TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
// The New York wall clock at instant t, as { day: "YYYY-MM-DD", hm: "HH:MM" }.
function local(t) {
  const p = Object.fromEntries(wall.formatToParts(t).map((x) => [x.type, x.value]));
  const pad = (s) => s.padStart(2, "0");
  return { day: `${p.year}-${pad(p.month)}-${pad(p.day)}`, hm: `${pad(p.hour)}:${pad(p.minute)}` };
}

// The instant of midnight in New York on "YYYY-MM-DD". Midnight is never in a DST gap there
// (the clocks change at 2:00), so one correction from the UTC guess lands on it.
function localMidnight(day) {
  const utc = Date.parse(`${day}T00:00:00Z`);
  const { day: d, hm } = local(utc);
  const shown = Date.parse(`${d}T${hm}:00Z`);
  return utc + (utc - shown);
}

// Splits SB Engaged's categories into the club acronym, the event type and the tags. parseIcs
// gives "club_acronym:X", "event_type:Y" and "event_tags: A,B" (or the tags split on commas);
// any other string is a tag. Tags are trimmed, in feed order, each once.
function readCategories(categories) {
  let acronym = null, type = null;
  const tags = [];
  for (const c of categories ?? []) {
    if (c.startsWith("club_acronym:")) acronym = c.slice(13).trim() || null;
    else if (c.startsWith("event_type:")) type = c.slice(11).trim() || null;
    else {
      for (const t of c.replace(/^event_tags:/, "").split(",").map((s) => s.trim())) {
        if (t && !tags.includes(t)) tags.push(t);
      }
    }
  }
  return { acronym, type, tags };
}

// parseIcs events -> campus_events rows for the ones overlapping [now, now + 14 days). An event
// that ends exactly at now has ended; one that starts exactly at the far edge is left for later.
//
// All-day: SB Engaged has no VALUE=DATE events. It writes an all-day event as 00:00 to 23:55
// New York time (79 of the 7,745 events on 2026-11-02, a few spanning several days), so an
// event starting at local 00:00 and ending at local 23:55 is all_day, kept at its real instants.
// A true VALUE=DATE event (parseIcs's allDay) is all_day too, from local midnight of its first
// day to local midnight of its end date.
export function campusRows(events, now) {
  const lo = +new Date(now), hi = lo + WINDOW;
  const updated_at = new Date(lo).toISOString();
  const rows = [];
  for (const e of events) {
    const s = e.allDay ? localMidnight(e.start) : Date.parse(e.start);
    const t = e.allDay ? localMidnight(e.end) : Date.parse(e.end);
    if (!(s < hi && (t > lo || (t === s && s >= lo)))) continue;
    const { acronym, type, tags } = readCategories(e.categories);
    const location = e.location && !HIDDEN_LOCATION.test(e.location) && e.location.trim() ? e.location : null;
    rows.push({
      uid: e.uid,
      title: (e.summary ?? "").trim(),
      starts_at: new Date(s).toISOString(),
      ends_at: new Date(t).toISOString(),
      all_day: !!e.allDay || (local(s).hm === "00:00" && local(t).hm === "23:55"),
      group_name: e.organizer || acronym,
      event_type: type,
      tags,
      description: e.description || null,
      url: e.url || null,
      location,
      updated_at,
    });
  }
  return rows;
}
