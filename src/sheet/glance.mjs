// /plan at a glance (docs/sheet-glance.md, "Contracts → Pure functions"): what the page draws
// instead of writing out in words. Pure, so node --test covers it.
import { freeFood } from "./campus.mjs";
import { atRisk, minutesOn } from "./logic.mjs";

// --- Sources and due levels (G2) ---------------------------------------------------------

// A task's source, for its edge colour and icon: Brightspace, GitHub and Jira (v5 SRC1) first,
// then the #campus tag.
const SOURCE_KINDS = { brightspace: "course", github: "github", jira: "jira" };
export const sourceOf = (task) => SOURCE_KINDS[task.source] ?? (task.tag === "campus" ? "campus" : null);

// The day's campus chip: how many events, and how many with free food.
export const campusSummary = (events) => ({ n: events.length, food: events.filter(freeFood).length });

// How loudly a due date shows: 'overdue' once its day has passed, 'risk' while atRisk holds,
// else null. A done task is neither. `horizon` is its horizon_state row, if any (atRisk).
export function dueLevel(task, blocks, today, timeZone, horizon = null) {
  if (task.done || !task.due) return null;
  if (task.due < today) return "overdue";
  return atRisk(task, blocks, today, timeZone, horizon) ? "risk" : null;
}

// --- Load and free time, drawn (G3) ------------------------------------------------------

// A day's load as a bar: `pct` of capacity for drawing (capped at 100), and `level` by load's
// rule on the raw minutes.
export function loadShare(minutes, capacity) {
  if (capacity <= 0) return minutes > 0 ? { pct: 100, level: "over" } : { pct: 0, level: "ok" };
  const level = minutes > capacity ? "over" : minutes >= capacity * 0.85 ? "near" : "ok";
  return { pct: Math.min(100, Math.round((100 * minutes) / capacity)), level };
}

// A day's strip: busy events and blocks as percentages of the window `from`–`to` (minutes past
// midnight), rounded to 0.1 and sorted by start. Parts outside the window are clipped and
// anything wholly outside is dropped; all-day and free events are left out. Overlaps stay
// separate segments.
export function stripSegments(events, blocks, day, timeZone, from = 7 * 60, to = 23 * 60) {
  const pct = (m) => Math.round((1000 * (m - from)) / (to - from)) / 10;
  const parts = [
    ...events.filter((e) => !e.allDay && e.busy !== false).map((e) => [e, "busy"]),
    ...blocks.map((b) => [b, b.proposed ? "proposed" : "block"]),
  ];
  return parts.flatMap(([x, kind]) => {
    const a = Math.max(from, minutesOn(x.starts_at, day, timeZone));
    const b = Math.min(to, minutesOn(x.ends_at, day, timeZone));
    return b > a ? [{ from: pct(a), to: pct(b), kind }] : [];
  }).sort((x, y) => x.from - y.from);
}

// A day's window for the strip and Plan today's timeline, in minutes past midnight on whole
// hours: from `open` (when his day starts, after his wake) to an hour past `shutdown`, grown to
// hold every span already on the day ({ start, end }, a block or a timed event), so nothing on
// the day is ever out of sight. Kept within 0 and 2 am the next day.
export function dayWindow(open, shutdown, spans = []) {
  const from = Math.min(open, ...spans.map((s) => s.start));
  const to = Math.max(shutdown + 60, ...spans.map((s) => s.end));
  return { from: Math.max(0, Math.floor(from / 60) * 60), to: Math.min(26 * 60, Math.ceil(to / 60) * 60) };
}

// --- feedAlert (G4: the top bar's Feed failed chip) ------------------------------------------

// How often each feed's cron job reads it, in minutes (supabase/schema.sql: sheet-mail every 5,
// sheet-busy and sheet-oura every 10, the rest hourly).
const FEED_EVERY = { gmail: 5, freebusy: 10, oura: 10 };
const STALE_AFTER = 3; // missed reads before a feed counts as stuck (research R6)

// The sources whose last read failed, in row order. ok null means not read yet (or not
// connected), not failed. Given `now` (ms), a feed whose last read worked but is over 3× its
// interval old counts too: a sync that stops running stays "ok" forever otherwise.
export const feedAlert = (feedRows, now = null) => feedRows.filter((f) => f.ok === false
  || (now != null && f.ok === true && f.fetched_at
    && now - new Date(f.fetched_at).getTime() > STALE_AFTER * (FEED_EVERY[f.source] ?? 60) * 60_000)).map((f) => f.source);
