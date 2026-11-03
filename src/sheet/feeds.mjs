// Feed sync (docs/sheet-sources.md, "Contracts"): what the brightspace and campus Edge Functions
// write, worked out from parsed feed events (src/sheet/ical.mjs). Pure: no network, so /plan's
// tests cover it and the functions only fetch and write what it says.
import { localNow } from "./logic.mjs";

// --- Course tasks (Brightspace) -----------------------------------------------------------

// A feed item's due date in the owner's zone. An all-day item is due on its date; a timed one
// on the local date of its start (Brightspace due items start and end at the due time).
const dueDay = (e, timeZone) => (e.allDay ? String(e.start).slice(0, 10) : localNow(new Date(e.start), timeZone).day);

// The changes one Brightspace fetch makes to the planner. `seen` is the feed_seen UIDs for
// 'brightspace'. Returns { insert, update, seen }:
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
  for (const e of events) {
    const uid = e?.uid, title = String(e?.summary ?? "").trim();
    if (!uid || !title || done.has(uid)) continue;
    let due;
    try { due = dueDay(e, timeZone); } catch { continue; } // a bad date or zone
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;
    done.add(uid);
    if (!known.has(uid)) {
      insert.push({ title: title.slice(0, 500), day: null, list: "Brightspace", due, public: false, source: "brightspace", source_uid: uid });
      added.push({ source: "brightspace", uid });
      continue;
    }
    const t = mine.get(uid);
    if (t && !t.done && (t.title !== title || t.due !== due)) update.push({ id: t.id, title: title.slice(0, 500), due });
  }
  return { insert, update, seen: added };
}
