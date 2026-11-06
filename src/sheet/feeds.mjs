// Feed sync (docs/sheet-sources.md, "Contracts"): what the brightspace and campus Edge Functions
// write, worked out from parsed feed events (src/sheet/ical.mjs). Pure: no network, so /plan's
// tests cover it and the functions only fetch and write what it says.
import { addDays, cutTitle, localNow } from "./logic.mjs";
import { routine } from "./campus.mjs";
import { changeRow } from "./replan.mjs";

// --- Course tasks (Brightspace) -----------------------------------------------------------

// A feed item's due date in the owner's zone. An all-day item is due on its date; a timed one
// on the local date of its start (Brightspace due items start and end at the due time).
const dueDay = (e, timeZone) => (e.allDay ? String(e.start).slice(0, 10) : localNow(new Date(e.start), timeZone).day);

// An item the feed marks STATUS:CANCELLED (RFC 5545 3.8.1.11) is off: it becomes no task.
const cancelled = (e) => e?.status === "CANCELLED";

// D2L names each calendar item after its activity and the date's role: "Quiz 6 - Due",
// "Quiz 6 - Availability Starts", "Quiz 6 - Availability Ends", and "- Start Date" / "- End Date"
// for discussions. The roles are the Calendar API's event types (DueDate, AvailabilityStarts,
// AvailabilityEnds: https://docs.valence.desire2learn.com/res/calendar.html, EVENTTYPE_T), and
// availability dates show as separate events when the instructor ticks "Add availability dates to
// Calendar" (Vanderbilt's Brightspace notes, December 2023). Items with no suffix are class
// meetings, holidays and the instructor's own events.
const ROLE = /^(.*\S)\s+-\s+(Due|Availability Ends|End Date|Availability Starts|Start Date)$/;

// The feed's due dates: each item's base title and whether it is one. A "- Due" item is; an end
// date stands in only when no "- Due" item has the same base title; start dates and items with no
// role are not.
function dueItems(events) {
  const read = events.filter((e) => !cancelled(e)).map((e) => {
    const m = ROLE.exec(String(e?.summary ?? "").trim());
    return { e, base: m?.[1], role: m?.[2] };
  });
  const hasDue = new Set(read.filter((r) => r.role === "Due").map((r) => r.base));
  return read.filter((r) => r.role === "Due" || ((r.role === "Availability Ends" || r.role === "End Date") && !hasDue.has(r.base)));
}

// A course item's page, for tasks.link (https only, like its check): the event's URL (RFC 5545
// 3.8.4.6, Brightspace's "detailsview" page), else the first https link in its description, else
// null. A feed without a link never clears one already stored (linkChange).
export function courseLink(e) {
  const ok = (u) => (typeof u === "string" && /^https:\/\/[^\s"<>]+$/.test(u) && u.length <= 2000 ? u : null);
  return ok(e?.url?.trim()) ?? ok(String(e?.description ?? "").match(/https:\/\/[^\s"<>)]+/)?.[0]) ?? null;
}
const linkChange = (t, link) => (link && t.link !== link ? { link } : {});

// The changes one Brightspace fetch makes to the planner. `seen` is the feed_seen UIDs for
// 'brightspace'. Returns { insert, update, seen }:
// - only due dates count (dueItems above), titled without D2L's suffix ("Quiz 6 - Due" -> "Quiz 6");
// - a UID never seen becomes a private task with that due date in the "Brightspace" Someday list,
//   and its UID goes into feed_seen (`seen` out lists exactly those);
// - a seen UID whose task is still undone gets its title and due date updated;
// - a done task, a deleted one (seen, no task) and an item gone from the feed are left alone.
// Sync never deletes. Items with no UID, no title or an unreadable start are skipped.
export function courseTaskChanges(events, { tasks, seen, timeZone }) {
  const mine = new Map(tasks.filter((t) => t.source === "brightspace" && t.source_uid).map((t) => [t.source_uid, t]));
  // A task already holding the UID counts as seen too, should its feed_seen row be missing.
  const known = new Set([...seen.map((s) => (typeof s === "string" ? s : s.uid)), ...mine.keys()]);
  const insert = [], update = [], added = [];
  const done = new Set();
  for (const { e, base } of dueItems(events)) {
    const uid = e.uid, title = cutTitle(base);
    if (!uid || !title || done.has(uid)) continue;
    let due;
    try { due = dueDay(e, timeZone); } catch { continue; } // a bad date or zone
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;
    done.add(uid);
    if (!known.has(uid)) {
      insert.push({ title, day: null, list: "Brightspace", due, public: false, source: "brightspace", source_uid: uid, link: courseLink(e) });
      added.push({ source: "brightspace", uid });
      continue;
    }
    const t = mine.get(uid);
    const link = t ? linkChange(t, courseLink(e)) : {};
    if (t && !t.done && (t.title !== title || t.due !== due || link.link)) update.push({ id: t.id, title, due, ...link });
  }
  return { insert, update, seen: added };
}

// v5 R1 (docs/sheet-v5.md, "replan.mjs"): the changes rows for one Brightspace fetch's inserts and
// updates (courseTaskChanges' output), one per task, ref its UID. A due date today, tomorrow or the
// day after is course_due_soon (weight 8); anything else course_change (3).
// An event task (courseEventChanges) counts by its day; a removal (courseRemovals) is a course_change.
export function courseChanges({ insert, update, removed = [] }, tasks, today) {
  const soon = (due) => due != null && due >= today && due <= addDays(today, 2);
  const uid = new Map(tasks.map((t) => [t.id, t.source_uid]));
  return [...insert.map((r) => [r.due ?? r.day, r.source_uid]), ...update.map((u) => [u.due ?? u.day, uid.get(u.id)]),
    ...removed.map((r) => [null, r.uid])]
    .map(([due, ref]) => changeRow(soon(due) ? "course_due_soon" : "course_change", ref ?? null));
}

// --- Course events (Brightspace) ----------------------------------------------------------

// The rest of the feed: items with no D2L role suffix, which are the instructor's calendar events
// (exams, in-class quizzes, review sessions) and the school's (holidays). D2L puts them in the
// same subscription as the due dates ("subscribe to a calendar feed for individual or all your
// courses ... D2L Brightspace class events", PCC's D2L help, "Subscribing to a D2L Class
// Calendar"); LOCATION carries the course offering's name ("AMS 261.01 - Fall 2026").

// "AMS 261.01 - Fall 2026" -> "AMS 261"; a location with no course code (the school's) -> null.
const courseCode = (location) => {
  const m = /^\s*([A-Z]{2,4})\s?(\d{3})\b/.exec(String(location ?? ""));
  return m ? `${m[1]} ${m[2]}` : null;
};

// "AMS 261 Exam 2": the course code first, unless the title already names it ("AMS261 review").
function eventTitle(e) {
  const summary = cutTitle(e.summary);
  const code = courseCode(e.location);
  if (!summary || !code) return summary;
  const bare = (s) => s.replace(/\s+/g, "").toUpperCase();
  return bare(summary).includes(bare(code)) ? summary : cutTitle(`${code} ${summary}`);
}

const pad2 = (n) => String(n).padStart(2, "0");

// An event's day, fixed time and estimate in the owner's zone. All day: its first date, no time.
// Timed: the local day and clock time of its start, and its length in minutes as the estimate
// (at most 4 hours, like campus.mjs's eventToTask; none for a zero-length item).
function eventSlot(e, timeZone) {
  if (e.allDay) return { day: String(e.start).slice(0, 10), at_time: null, est_min: null };
  const s = Date.parse(e.start), len = Math.round((Date.parse(e.end) - s) / 60_000);
  if (!Number.isFinite(s)) throw new Error("bad start");
  const { day, minutes } = localNow(new Date(s), timeZone);
  return { day, at_time: `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`, est_min: len > 0 ? Math.min(240, len) : null };
}

// The changes the feed's events make to the planner, beside courseTaskChanges' due dates. Returns
// { insert, update, seen } like it:
// - an item with no role suffix, not cancelled, on today or later, is an event;
// - a UID never seen becomes a private task on the event's day at its time ({ day, at_time,
//   est_min }), titled with its course; at_time keeps it on its day (it never rolls) and a plan
//   must start its block then (proposal.mjs), so plans work around it;
// - a seen UID whose task is still undone follows the feed's title, day, time and length;
// - a done task, a deleted one (seen, no task) and past events are left alone.
export function courseEventChanges(events, { tasks, seen, timeZone, today }) {
  const mine = new Map(tasks.filter((t) => t.source === "brightspace" && t.source_uid).map((t) => [t.source_uid, t]));
  const known = new Set([...seen.map((s) => (typeof s === "string" ? s : s.uid)), ...mine.keys()]);
  const insert = [], update = [], added = [];
  const done = new Set();
  for (const e of events) {
    if (!e || cancelled(e) || ROLE.exec(String(e.summary ?? "").trim())) continue;
    const uid = e.uid, title = eventTitle(e);
    if (!uid || !title || done.has(uid)) continue;
    let slot;
    try { slot = eventSlot(e, timeZone); } catch { continue; } // a bad date or zone
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slot.day) || slot.day < today) continue;
    done.add(uid);
    if (!known.has(uid)) {
      insert.push({ title, ...slot, list: null, due: null, public: false, source: "brightspace", source_uid: uid, link: courseLink(e) });
      added.push({ source: "brightspace", uid });
      continue;
    }
    const t = mine.get(uid);
    if (!t || t.done) continue;
    const at = t.at_time ? String(t.at_time).slice(0, 5) : null;
    const link = linkChange(t, courseLink(e));
    if (t.title !== title || t.day !== slot.day || t.list != null || at !== slot.at_time || (t.est_min ?? null) !== slot.est_min || link.link) {
      update.push({ id: t.id, title, ...slot, list: null, ...link });
    }
  }
  return { insert, update, seen: added };
}

// The undone Brightspace tasks whose item is cancelled or gone from the feed, as { id, uid }, so
// the function deletes them and forgets their UID (a reinstated item comes back as new). Only a
// task dated (due, else day) from today to `until`, the far edge of the window the feed was read
// for, counts: earlier ones have simply dropped out of the window. An empty feed removes nothing,
// in case Brightspace sends a blank calendar by mistake.
export function courseRemovals(events, { tasks, today, until }) {
  const listed = events.filter(Boolean);
  if (!listed.length) return [];
  const live = new Set(listed.filter((e) => !cancelled(e)).map((e) => e.uid));
  return tasks.filter((t) => {
    const date = t.due ?? t.day;
    return t.source === "brightspace" && t.source_uid && !t.done && !live.has(t.source_uid) && date && date >= today && date <= until;
  }).map((t) => ({ id: t.id, uid: t.source_uid }));
}


// --- Campus events (SB Engaged) ---------------------------------------------------------------

// v5 R1: one campus_change row when the events left today (ending after `now`, starting before
// local midnight) differ, as uids and times, between the rows before and after a write; else null.
// The rest of the 14-day window doesn't touch today's plan, so it never starts a replan.
export function campusChange(before, after, now, timeZone) {
  const t = +new Date(now);
  const { day } = localNow(new Date(t), timeZone);
  const today = (rows) => new Set(rows.filter((r) => Date.parse(r.ends_at) > t && localNow(new Date(r.starts_at), timeZone).day <= day)
    .map((r) => `${r.uid}|${Date.parse(r.starts_at)}|${Date.parse(r.ends_at)}`));
  const a = today(before), b = today(after);
  return a.size === b.size && [...a].every((k) => b.has(k)) ? null : changeRow("campus_change");
}

const DAY = 86_400_000;
const WINDOW = 14 * DAY;
// SB Engaged is Stony Brook's feed, so its wall clock is New York's.
const CAMPUS_TZ = "America/New_York";

// "Sign in to download the location" and "Register to receive location details!", each with an
// optional leading space or ", United States": the location is hidden behind sign-in.
const HIDDEN_LOCATION = /^\s*(Sign in to download the location|Register to receive location details!.*?)(, United States)?\s*$/;

// The instant of midnight in New York on "YYYY-MM-DD". Midnight is never in a DST gap there
// (the clocks change at 2:00), so one correction from the UTC guess lands on it.
function localMidnight(day) {
  const utc = Date.parse(`${day}T00:00:00Z`);
  const { day: d, minutes } = localNow(new Date(utc), CAMPUS_TZ);
  const shown = Date.parse(`${d}T00:00:00Z`) + minutes * 60_000;
  return utc + (utc - shown);
}
const minutesAt = (t) => localNow(new Date(t), CAMPUS_TZ).minutes;

// Only a link to SB Engaged itself goes to the page as the event's link.
const ENGAGED = "https://sbengaged.stonybrook.edu/";
const engagedUrl = (url) => (typeof url === "string" && url.startsWith(ENGAGED) ? url : null);
// The event's link: the feed's URL (".../rsvp?id=N"), or else its CONTACT, which SB Engaged sets
// to the same page under the group (".../<group>/rsvp_boot?id=N#event_host"), without the anchor.
const eventUrl = (e) => engagedUrl(e.url) ?? engagedUrl(e.contact?.split("#")[0]);

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
      title: cutTitle(e.summary),
      starts_at: new Date(s).toISOString(),
      ends_at: new Date(t).toISOString(),
      all_day: !!e.allDay || (minutesAt(s) === 0 && minutesAt(t) === 23 * 60 + 55),
      group_name: e.organizer || acronym,
      event_type: type,
      tags,
      description: e.description || null,
      url: eventUrl(e),
      location,
      updated_at,
    });
  }
  return rows;
}

// The SB Engaged feed cut to the VEVENTs that may overlap [from, to), so parseIcs only reads
// those: the feed holds about 7,700 events across the school year, the window about 1,100. Each
// event's DTSTART and DTEND dates are compared as text with a day's slack on each side (a TZID
// time can sit a day off its UTC date); an event whose dates can't be read this way is kept for
// parseIcs to judge. The cut is only a shortcut: parseIcs and campusRows still apply the window.
const DTSTART_DATE = /\nDTSTART[;:][^\n]*?(\d{8})/, DTEND_DATE = /\nDTEND[;:][^\n]*?(\d{8})/;
export function campusWindowIcs(text, from, to) {
  const ymd = (t) => new Date(t).toISOString().slice(0, 10).replaceAll("-", "");
  const lo = ymd(+new Date(from) - DAY), hi = ymd(+new Date(to) + DAY);
  const kept = ["BEGIN:VCALENDAR"];
  // Events are found by their BEGIN and END lines, so a description quoting them can't split one.
  let i = text.indexOf("\nBEGIN:VEVENT");
  while (i >= 0) {
    const j = text.indexOf("\nEND:VEVENT", i);
    if (j < 0) break;
    const chunk = text.slice(i + 1, j + 11);
    const start = DTSTART_DATE.exec(chunk)?.[1], end = DTEND_DATE.exec(chunk)?.[1] ?? start;
    if (!start || (start <= hi && end >= lo)) kept.push(chunk);
    i = text.indexOf("\nBEGIN:VEVENT", j);
  }
  kept.push("END:VCALENDAR", "");
  return kept.join("\r\n");
}

// --- RSVP counts (SB Engaged event pages) ---------------------------------------------------

// How many people have registered for an event, read from its public page (the feed doesn't
// carry it): `<span class="number">13</span> <div>Registered</div>` in the event's card. Null
// when the page shows none (a sign-in or error page). A ticket's "Spots Left" is a badge, not
// this.
const REGISTERED = /<span class="number">\s*([\d,]+)\s*<\/span>\s*<div>\s*Registered\s*<\/div>/;
export function rsvpCount(html) {
  const m = REGISTERED.exec(String(html ?? ""));
  return m ? Number(m[1].replaceAll(",", "")) : null;
}

// The campus_events rows whose count to fetch this run, at most `limit`: events not yet started,
// with a page on SB Engaged, that the list shows by default (not routine). A count is fresh for 6 hours while
// the event is within 3 days, for 24 hours before that. Never-checked events come first, then
// stale ones; each group soonest first.
const HOUR = 3_600_000;
// Only SB Engaged's own pages are fetched, whatever URL a feed item carries.
const sbEngaged = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === "sbengaged.stonybrook.edu"; } catch { return false; } };
export function countsDue(rows, now, limit) {
  const t = +new Date(now);
  const stale = (r) => {
    if (!r.rsvp_checked_at) return true;
    const fresh = Date.parse(r.starts_at) - t <= 72 * HOUR ? 6 * HOUR : 24 * HOUR;
    return t - Date.parse(r.rsvp_checked_at) > fresh;
  };
  return rows
    .filter((r) => sbEngaged(r.url) && Date.parse(r.starts_at) > t && !routine(r) && stale(r))
    .sort((a, b) => (!b.rsvp_checked_at - !a.rsvp_checked_at) || Date.parse(a.starts_at) - Date.parse(b.starts_at))
    .slice(0, limit);
}
