// Focus notes (docs/sheet-focus.md, "Stop and where I left off"): Stop ends a focus session
// without finishing the task, crediting its minutes to the task and keeping a one-line note that
// the next Start on it shows (a ready-to-resume plan, Leroy & Glomb 2018). The plain logic, with
// no DOM and no network; rows are focus_log's (supabase/schema.sql).
import { localNow, formatMinutes } from "./logic.mjs";

export const NOTE_MAX = 280;

// Whole minutes from Start to now, held to focus_log's 0–960.
export const sessionMinutes = (s, now) => Math.min(960, Math.max(0, Math.round((now.getTime() - s.started_at) / 60_000)));

// Stop's row: the session's minutes and the note (trimmed, one line, cut to NOTE_MAX), on the
// day the session started. `id` comes from the page so a retried write is a duplicate. Under a
// minute with no note there is nothing worth keeping: null.
export function stopRow(s, note, now, timeZone, id) {
  // Cut by code point, so an emoji at the limit is never split into half a pair.
  const text = Array.from(String(note ?? "").replace(/\s+/g, " ").trim()).slice(0, NOTE_MAX).join("") || null;
  const minutes = sessionMinutes(s, now);
  if (!minutes && !text) return null;
  return { id, at: now.toISOString(), day: localNow(new Date(s.started_at), timeZone).day, task_id: s.task_id, block_id: s.block_id, minutes, note: text, done: false };
}

// A closing row (done = true): it closes exactly the rows in `closes`, the ones whose minutes the
// page counted, so a Stop written on another device that this page never read stays open.
export const closingRow = ({ task_id, block_id = null, day, minutes = 0, closes }, now, id) =>
  ({ id, at: now.toISOString(), day, task_id, block_id, minutes, note: null, done: true, closes: [...closes] });

// Done's closing row: the session's own minutes, closing `closes` (none by default). Its actuals
// row carries these plus those rows' credit.
export const doneRow = (s, now, timeZone, id, closes = []) => closingRow({ task_id: s.task_id, block_id: s.block_id, day: localNow(new Date(s.started_at), timeZone).day, minutes: sessionMinutes(s, now), closes }, now, id);

// Closing rows for tasks finished outside focus (the week's ✓, Telegram) that still have open
// rows, so a reopened task doesn't bring back old credit and notes: no session, so no minutes.
export const closeFinished = (progress, tasks, day, now, makeId) => [...progress]
  .filter(([id]) => tasks.get(id)?.done)
  .map(([task_id, p]) => closingRow({ task_id, day, closes: p.ids }, now, makeId()));

// Per task, its open rows (not done, closed by no closing row): { minutes, note, ids }, with the
// newest note among them (or null) and their ids, which a closing row lists.
export function progressByTask(rows) {
  const closed = new Set(rows.flatMap((r) => (r.done ? r.closes ?? [] : [])));
  const out = new Map();
  for (const r of [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (r.done || closed.has(r.id)) continue;
    const p = out.get(r.task_id) ?? { minutes: 0, note: null, ids: [] };
    out.set(r.task_id, { minutes: p.minutes + r.minutes, note: r.note ?? p.note, ids: [...p.ids, r.id] });
  }
  return out;
}

// The row's line: "40m focused of 1h30", or "40m focused" without an estimate. Null under a minute.
export function progressText(p, est) {
  if (!p?.minutes) return null;
  return `${formatMinutes(p.minutes)} focused${est ? ` of ${formatMinutes(est)}` : ""}`;
}
