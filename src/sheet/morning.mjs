// /plan's side of the morning plan (docs/sheet-morning.md, "/plan"): the busy times it saves for
// the morning task, and how the Needs you list is grouped and linked. Pure, so node --test covers
// it; busy-sync.mjs and needs-you.mjs do the network and the drawing.
import { couldntFitLine, pickedEvents, pickLine } from "./proposal.mjs";

// --- Busy times ----------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (t) => new Date(t).toISOString();

// The busy rows to save from his Google events: start and end only, in UTC, for the timed events
// marked busy that overlap now through 7 days ahead, once each and earliest first. Events on the
// "Time blocks" calendar (`blocksCalendar`) are his own blocks, not busy time, and stay out.
export function busyRows(events, now, blocksCalendar) {
  const from = now.getTime();
  const to = from + 7 * DAY_MS;
  const seen = new Set();
  return events
    .filter((e) => !e.allDay && e.busy !== false && (!blocksCalendar || e.calendar !== blocksCalendar))
    .filter((e) => Date.parse(e.ends_at) > from && Date.parse(e.starts_at) < to)
    .map((e) => ({ starts_at: iso(e.starts_at), ends_at: iso(e.ends_at) }))
    .filter((r) => { const k = `${r.starts_at}|${r.ends_at}`; return !seen.has(k) && seen.add(k); })
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.ends_at.localeCompare(b.ends_at));
}

// --- Needs you -----------------------------------------------------------------------------

// The dialog's groups, in this order, with their headings.
export const NEEDS_GROUPS = [
  ["reply", "Reply owed"],
  ["deadline", "Deadlines"],
  ["meeting", "Meetings"],
  ["admin", "School & admin"],
];

// The rows not done, grouped by kind as [{ kind, title, rows }]. Within a group the soonest due
// date comes first and rows with none come last; ties keep row order. Empty groups are left out.
export function needsGroups(rows) {
  const open = rows.filter((r) => !r.done);
  const byDue = (a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999");
  return NEEDS_GROUPS
    .map(([kind, title]) => ({ kind, title, rows: open.filter((r) => r.kind === kind).sort(byDue) }))
    .filter((g) => g.rows.length);
}

// A row's Open in Gmail link: its link when it starts with https://mail.google.com/, else null
// (then no link is drawn). The mail text is untrusted, so nothing else may become a link.
export const gmailLink = (link) =>
  typeof link === "string" && link.startsWith("https://mail.google.com/") ? link : null;

// v5 M1: a thread's Open in Gmail link, as messageSummary builds it, for an Awaiting reply row;
// null unless the thread id is hex, as Gmail's are.
export const threadLink = (account, thread) => (/^[0-9a-f]{6,32}$/.test(thread)
  ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${thread}` : null);

// v5 SRC2: a Slack row's Open in Slack link: an https:// permalink on a <workspace>.slack.com
// address, else null. slack-sync keeps only these, and /plan checks again before drawing one.
export const slackLink = (link) =>
  typeof link === "string" && /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.slack\.com\//i.test(link) ? link : null;

// --- Plan today ----------------------------------------------------------------------------

// What the day's proposal says above Plan today's timeline: "Didn't fit: …", "Couldn't fit: …"
// (titles from `tasks`), then a "Campus pick: …" line for each pick found in `campus`. A skipped or lapsed proposal says nothing.
export function planNotes(proposal, campus, tz, tasks = []) {
  if (!proposal || proposal.status === "skipped" || proposal.status === "lapsed") return [];
  const picks = pickedEvents(proposal.picks, campus);
  const unfit = couldntFitLine(proposal.couldnt_fit, tasks);
  return [...(proposal.note ? [`Didn't fit: ${proposal.note}`] : []), ...(unfit ? [unfit] : []), ...picks.map((e) => pickLine(e, tz))];
}
