// The Sheet's decisions, kept free of the DOM and the network so node --test can cover them
// (docs/sheet.md). Days are local date strings ("2026-10-20"), never timestamps.

// --- Dates -------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const toDate = (day) => new Date(`${day}T12:00:00Z`);
const fromDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function addDays(day, n) {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fromDate(d);
}

// Monday of the week holding `day`.
export function weekStart(day) {
  const dow = (toDate(day).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

export const weekDays = (day) => Array.from({ length: 7 }, (_, i) => addDays(weekStart(day), i));

// The date and minutes past midnight at `now` in `timeZone`.
export function localNow(now, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const dayDiff = (a, b) => Math.round((toDate(a) - toDate(b)) / 86_400_000);

// The instant (ISO) when the clock in `timeZone` reads `minutes` past midnight on `day`.
// Correct across daylight-saving changes: it refines a UTC guess by the zone's offset.
export function zonedIso(day, minutes, timeZone) {
  const [y, m, d] = day.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d, 0, minutes);
  for (let i = 0; i < 2; i++) {
    const at = localNow(new Date(t), timeZone);
    t -= (dayDiff(at.day, day) * 1440 + at.minutes - minutes) * 60_000;
  }
  return new Date(t).toISOString();
}

// Minutes past midnight of `day` in `timeZone` at an ISO instant (negative or past 1440 when
// the instant falls on another day).
export function minutesOn(iso, day, timeZone) {
  const at = localNow(new Date(iso), timeZone);
  return dayDiff(at.day, day) * 1440 + at.minutes;
}

export function dayLabel(day) {
  const d = toDate(day);
  return {
    weekday: d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toUpperCase(),
    date: d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
  };
}

// --- Typed details -----------------------------------------------------------------------

const EST = /(?:^|\s)~(?:(\d+)h)?(?:(\d+)m?)?(?=\s|$)/i;
const AT = /(?:^|\s)@(\d{1,2})(?::(\d{2}))?\s?(am|pm)?(?=\s|$)/i;
const TAG = /(?:^|\s)#([a-z0-9][\w-]*)(?=\s|$)/i;
const VIS = /(?:^|\s)!(public|private|p)(?=\s|$)/i;
const DUE = /(?:^|\s)\^(\S+)(?=\s|$)/;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// The date a "^..." due date names, counted from `day` (the task's day), or null if it names none.
// A weekday ("fri", "thurs", "friday") is its next occurrence on or after `day`; so is a
// month/day ("10/30"), which may fall next year (or, for 2/29, the next leap year).
function dueDate(word, day) {
  const w = word.toLowerCase();
  if (w === "tomorrow") return addDays(day, 1);
  const dow = w.length >= 3 ? WEEKDAYS.findIndex((d) => d.startsWith(w)) : -1;
  if (dow >= 0) return addDays(day, (dow - toDate(day).getUTCDay() + 7) % 7);
  const md = w.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!md) return null;
  for (let y = Number(day.slice(0, 4)); y < Number(day.slice(0, 4)) + 8; y++) {
    const date = `${y}-${pad(Number(md[1]))}-${pad(Number(md[2]))}`;
    // Impossible dates ("2/30", "13/1") never survive the round trip through Date.
    if (fromDate(toDate(date)) === date && date >= day) return date;
  }
  return null;
}

// "Ship auth ~45m #workit ^fri" → { title: "Ship auth", est_min: 45, tag: "workit", due: "2026-10-30", ... }.
// Tasks are public unless marked "!p" (or "!private"). A due date counts from `day`, the task's
// day. A detail that does not parse stays in the title.
export function parseEntry(text, day) {
  let title = ` ${text.trim()} `;
  const out = { est_min: null, at_time: null, tag: null, public: true, due: null };

  const est = title.match(EST);
  if (est && (est[1] || est[2])) {
    const h = Number(est[1] ?? 0);
    // "~1h30" means 1 h 30 min; a bare "~90" means 90 minutes.
    const mins = h * 60 + Number(est[2] ?? 0);
    if (mins > 0 && mins <= 24 * 60) { out.est_min = mins; title = title.replace(est[0], " "); }
  }
  const at = title.match(AT);
  if (at) {
    let h = Number(at[1]);
    const m = Number(at[2] ?? 0);
    const ap = at[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 24 && m < 60 && (ap || at[2])) { out.at_time = `${pad(h)}:${pad(m)}`; title = title.replace(at[0], " "); }
  }
  const tag = title.match(TAG);
  if (tag) { out.tag = tag[1].toLowerCase(); title = title.replace(tag[0], " "); }
  const vis = title.match(VIS);
  if (vis) { out.public = vis[1].toLowerCase() === "public"; title = title.replace(vis[0], " "); }
  const due = title.match(DUE);
  const date = due && dueDate(due[1], day);
  if (date) { out.due = date; title = title.replace(due[0], " "); }

  out.title = title.replace(/\s+/g, " ").trim();
  return out;
}

export function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${m ? pad(m) : ""}` : `${m}m`;
}

export function formatClock(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "am" : "pm"}`;
}

// An event's time on the day, short: "8–9:20 am", "11:30 am–1 pm". Parts past midnight are cut.
export function formatSpan(start, end) {
  const [a, b] = [Math.max(0, start), Math.min(1440, end)].map((m) => formatClock(m).replace(":00", ""));
  const [ta, ma] = a.split(" ");
  return ma === b.split(" ")[1] && end < 1440 ? `${ta}–${b}` : `${a}–${b}`;
}

// --- The week grid -----------------------------------------------------------------------

export const byPosition = (a, b) => a.position - b.position;

// Every column gets as many rows as the busiest day, plus one empty row to type into.
export function rowCount(tasksByDay) {
  return Math.max(0, ...Object.values(tasksByDay).map((t) => t.length)) + 1;
}

// A position between two neighbours (either may be missing), so a move writes one row only.
export function positionBetween(before, after) {
  if (before == null && after == null) return 1;
  if (before == null) return after - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

// --- Plan today --------------------------------------------------------------------------

export const DEFAULT_EST = 30;

export function load(tasks, capacity) {
  const total = tasks.filter((t) => !t.done).reduce((s, t) => s + (t.est_min ?? 0), 0);
  const level = total > capacity ? "over" : total >= capacity * 0.85 ? "near" : "ok";
  return { total, capacity, level };
}

// When today's remaining estimates would be done if started now (minutes past midnight).
export const finishAt = (nowMinutes, total) => nowMinutes + total;

// Planning after 3 pm plans tomorrow.
export const planningDay = ({ day, minutes }) => (minutes >= 15 * 60 ? addDays(day, 1) : day);

export const snap = (mins, step = 15) => Math.round(mins / step) * step;

// What completing a task does to one of its blocks (Sunsama's rules). A proposed block is
// turned down: nothing is left to approve.
export function blockOnComplete(block, now) {
  if (block.proposed) return { action: "delete" };
  const start = new Date(block.starts_at);
  const end = new Date(block.ends_at);
  if (now < start) return { action: "delete" };
  if (now < end) return { action: "shrink", ends_at: now.toISOString() };
  return { action: "keep" };
}

// --- Proposals ---------------------------------------------------------------------------

// A day's proposed blocks (docs/sheet-nudges.md), earliest first. They are Claude's until
// approved, and lapse at the day's shutdown or the nightly rollover.
export const proposedOn = (blocks, day, timeZone) => blocks
  .filter((b) => b.proposed && localNow(new Date(b.starts_at), timeZone).day === day)
  .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

// What moving or resizing a block does in Google. A proposed block has no event: changing it
// approves it, so its event is made then, as when a task is dragged on.
export const googleStep = (block) => (block.proposed ? "create" : block.gcal_id ? "patch" : null);

// --- Due dates --------------------------------------------------------------------------

// A task is at risk when it is due within two days (or already past due), not done, and has no
// block that starts before its due date is over (midnight after it, in the owner's time zone).
// Proposed blocks are not planned time yet, so they don't count.
export function atRisk(task, blocks, today, timeZone) {
  if (!task.due || task.done || dayDiff(task.due, today) > 2) return false;
  const end = Date.parse(zonedIso(addDays(task.due, 1), 0, timeZone));
  return !blocks.some((b) => b.task_id === task.id && !b.proposed && Date.parse(b.starts_at) < end);
}

// --- Calendar events in the week ---------------------------------------------------------

// A day's events from Google, as minutes past that day's midnight. All-day events cover every
// day from their start date up to (not including) their end date. All-day first, then by start.
export function eventsOnDay(events, day, timeZone) {
  return events.flatMap((e) => {
    if (e.allDay) return e.starts_at <= day && day < e.ends_at ? [{ ...e, start: 0, end: 1440 }] : [];
    const start = minutesOn(e.starts_at, day, timeZone);
    const end = minutesOn(e.ends_at, day, timeZone);
    return end > 0 && start < 1440 ? [{ ...e, start, end }] : [];
  }).sort((a, b) => (b.allDay - a.allDay) || a.start - b.start);
}

// Minutes between `from` and `to` that no busy event covers. All-day and "free" events don't count.
export function freeMinutes(dayEvents, from, to) {
  const spans = dayEvents.filter((e) => e.busy && !e.allDay)
    .map((e) => [Math.max(from, e.start), Math.min(to, e.end)]).filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let busy = 0;
  let upTo = from;
  for (const [a, b] of spans) {
    if (b <= upTo) continue;
    busy += b - Math.max(a, upTo);
    upTo = b;
  }
  return Math.max(0, to - from - busy);
}

// The busy event a fixed-time task ("@3:45" → 225 minutes) lands in, if any.
export const clashWith = (atMin, dayEvents) =>
  dayEvents.find((e) => e.busy && !e.allDay && atMin >= e.start && atMin < e.end) ?? null;

// Which events a column shows when it has more than `max`: events that have ended (before
// `nowMin`, on today only) give way first, oldest first, then the latest ones. Order is kept.
export function visibleEvents(dayEvents, max, nowMin = null) {
  if (dayEvents.length <= max) return { shown: dayEvents, hidden: 0 };
  const ended = (e) => nowMin != null && !e.allDay && e.end <= nowMin;
  const keep = new Set([...dayEvents.filter((e) => !ended(e)), ...dayEvents.filter(ended).reverse()].slice(0, max));
  return { shown: dayEvents.filter((e) => keep.has(e)), hidden: dayEvents.length - max };
}

// --- Rollover display --------------------------------------------------------------------

export const ROLL_MARKS = ["", "②", "③"];
export const rollMark = (rolls) => (rolls >= 1 && rolls <= 2 ? ROLL_MARKS[rolls] : "");
// Ink fades a step per roll.
export const rollOpacity = (rolls) => [1, 0.8, 0.6][Math.min(rolls, 2)];

// --- The public view ---------------------------------------------------------------------

// Bar width in ch for a private task of `len` characters: never empty, never past the column.
export const barWidth = (len) => Math.max(4, Math.min(len ?? 8, 24));

// The "Right now" line from the public_now row.
export function rightNow(row) {
  if (!row || row.public == null) return null;
  return row.public ? row.title : "Heads down";
}
