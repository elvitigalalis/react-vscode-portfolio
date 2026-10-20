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

// "Ship auth ~45m #workit" → { title: "Ship auth", est_min: 45, tag: "workit", public: true, ... }.
// Tasks are public unless marked "!p" (or "!private"). A detail that does not parse stays in the title.
export function parseEntry(text) {
  let title = ` ${text.trim()} `;
  const out = { est_min: null, at_time: null, tag: null, public: true };

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

// What completing a task does to one of its blocks (Sunsama's rules).
export function blockOnComplete(block, now) {
  const start = new Date(block.starts_at);
  const end = new Date(block.ends_at);
  if (now < start) return { action: "delete" };
  if (now < end) return { action: "shrink", ends_at: now.toISOString() };
  return { action: "keep" };
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
