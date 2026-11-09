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
  const text = String(note ?? "").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) || null;
  const minutes = sessionMinutes(s, now);
  if (!minutes && !text) return null;
  return { id, at: now.toISOString(), day: localNow(new Date(s.started_at), timeZone).day, task_id: s.task_id, block_id: s.block_id, minutes, note: text, done: false };
}

// Done's closing row: the session's own minutes, done = true. Its actuals row carries these plus
// the task's earlier credit, so the rows before it no longer count.
export const doneRow = (s, now, timeZone, id) => ({ id, at: now.toISOString(), day: localNow(new Date(s.started_at), timeZone).day, task_id: s.task_id, block_id: s.block_id, minutes: sessionMinutes(s, now), note: null, done: true });

// Per task, what its rows since its last done row add up to: { minutes, note } with the newest
// note in that run (or null). A task whose newest row is a done row has none.
export function progressByTask(rows) {
  const out = new Map();
  for (const r of [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (r.done) { out.delete(r.task_id); continue; }
    const p = out.get(r.task_id) ?? { minutes: 0, note: null };
    out.set(r.task_id, { minutes: p.minutes + r.minutes, note: r.note ?? p.note });
  }
  for (const [id, p] of out) if (!p.minutes && !p.note) out.delete(id);
  return out;
}

// The row's line: "40m focused of 1h30", or "40m focused" without an estimate. Null under a minute.
export function progressText(p, est) {
  if (!p?.minutes) return null;
  return `${formatMinutes(p.minutes)} focused${est ? ` of ${formatMinutes(est)}` : ""}`;
}
