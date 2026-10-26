// The Telegram messages (docs/sheet-nudges.md, "Messages"): which are due at a given minute, and
// what a Done or Snooze tap on one changes.
// Kept free of the network so node --test covers it; the `telegram` Edge Function
// (supabase/functions/telegram) imports it, so the rules live only here.
//
// Nothing is booked ahead: each run works the messages out again from a snapshot of the day,
// and the nudges log is what stops one going out twice.
import { ORIGIN, SHEET } from "../site.mjs";
import { localNow, zonedIso, minutesOn, atRisk, dueLabel, formatClock, telegramOn, blockOnComplete } from "./logic.mjs";

// Quiet hours run from 11 pm to 8 am; the brief opens the day.
export const QUIET_FROM = 23 * 60;
export const BRIEF_AT = 8 * 60;
// The nudge budget: nudges, repeats and snoozes a day, not counting the brief or the check-in.
export const BUDGET = 6;
// The repeat follows a nudge Lisul hasn't acted on by this long after.
export const REPEAT_AFTER = 10 * 60_000;
// A Snooze tap logs the nudge again for this long after the tap, unsent: { block_id,
// kind: "snooze", day, send_at, sent_at: null }. That row is all whatToSend needs to send it.
export const SNOOZE_FOR = 10 * 60_000;

const PLAN_URL = `${ORIGIN}/plan/`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A snapshot of the day, as the Edge Function reads it:
//   settings  the settings row (time_zone, telegram_chat_id, nudges_on)
//   day       today's days row, or null
//   tasks     today's tasks, plus every undone task with a due date
//   blocks    today's blocks, plus every block of those tasks
//   log       today's rows of the nudges log, including snoozes logged by taps and not yet sent
// Returns the messages due at `now`: { kind, block_id, day, send_at, text, buttons }, where
// send_at is the minute the message belongs to (it may be earlier than `now` if a run was late)
// and a button has either a url or callback data ("done:<block id>", "snooze:<block id>").
export function whatToSend(snapshot, now) {
  if (!telegramOn(snapshot.settings)) return [];
  const day = dayOf(snapshot, now);
  if (day.minutes < BRIEF_AT || day.minutes >= QUIET_FROM) return [];
  // Each kind of message is one rule over the same day.
  const due = [brief(day), ...starts(day), ...repeats(day), ...snoozes(day), ...checkin(day)]
    .filter((m) => Date.parse(m.send_at) <= now.getTime() && !logged(snapshot.log, m))
    .sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
  // The brief and check-in are outside the budget, and a snooze took its slot when it was tapped.
  let { kept, used, held } = budget(day);
  return due.filter((m) => {
    if (!BUDGETED.includes(m.kind) || m.kind === "snooze") return true;
    if (m.kind === "start" && kept.has(m.block_id)) held--;
    if (used + held >= BUDGET) return false;
    used++;
    return true;
  });
}

// The day as the rules see it. Proposed blocks aren't part of the plan until approved: they
// count for nothing here.
function dayOf(snapshot, now) {
  const tz = snapshot.settings.time_zone;
  const { day: today, minutes } = localNow(now, tz);
  return { ...snapshot, blocks: snapshot.blocks.filter((b) => !b.proposed), today, minutes, tz, now: now.getTime() };
}

const BUDGETED = ["start", "repeat", "snooze"];

// The budget, kept predictable: the nudges at the start of the day's first six blocks that can
// be nudged are kept for them, and repeats, snoozes and later blocks' nudges get only the slots
// left. Returns the blocks whose nudges are kept, the slots used (sent, or a snooze waiting) and
// the slots held for kept nudges still to go out.
function budget(day) {
  const kept = new Set(live(day).slice(0, BUDGET).map(({ b }) => b.id));
  const used = day.log.filter((n) => BUDGETED.includes(n.kind)).length;
  const held = running(day).filter(({ b }) => kept.has(b.id) && !startSent(day.log, b)).length;
  return { kept, used, held };
}
const freeSlots = (day) => { const { used, held } = budget(day); return BUDGET - used - held; };

// A snooze logged by a tap and not yet sent (see SNOOZE_FOR).
const pending = (n) => n.kind === "snooze" && !n.sent_at;

// One message per block, kind, day and send-at minute: the log's unique key.
const logged = (log, m) => log.some((n) => !pending(n) && n.block_id === m.block_id && n.kind === m.kind && n.day === m.day
  && Date.parse(n.send_at) === Date.parse(m.send_at));

// The morning brief: what today holds, at 8:00. Private tasks show their real titles: the
// messages go only to Lisul.
// "Nudging the first 6" counts only the blocks that can be nudged.
function brief(day) {
  const { tasks, blocks, today, tz } = day;
  const todays = tasks.filter((t) => t.day === today);
  const blocksToday = blocks.filter((b) => { const m = minutesOn(b.starts_at, today, tz); return m >= 0 && m < 1440; });
  const risky = tasks.filter((t) => atRisk(t, blocks, today, tz)).sort((a, b) => a.due.localeCompare(b.due));
  const n = blocksToday.length;
  const lines = [`Today: ${plural(todays.length, "task")}, ${plural(n, "block")}${live(day).length > BUDGET ? `, nudging the first ${BUDGET}` : ""}.`];
  if (risky.length) lines.push(`At risk: ${risky.map((t) => `${t.title} (${dueLabel(t.due, today)})`).join(", ")}.`);
  if (!n) lines.push('Nothing planned yet: say "plan my day" to Claude.');
  const text = todays.length || n || risky.length ? lines.join("\n") : "Nothing on today.";
  return { kind: "brief", block_id: null, day: today, send_at: zonedIso(today, BRIEF_AT, tz), text, buttons: [{ text: "Open /plan", url: PLAN_URL }] };
}

// Done and Snooze carry the block they belong to; the webhook reads them back on a tap.
const tapButtons = (id) => [{ text: "Done", callback_data: `done:${id}` }, { text: "Snooze 10 min", callback_data: `snooze:${id}` }];

// "▶ 2:00 pm · OS homework (45 min)"
const nudgeText = (b, task, { today, tz }) =>
  `▶ ${formatClock(minutesOn(b.starts_at, today, tz))} · ${task.title} (${Math.round((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60_000)} min)`;

// The blocks that can still be nudged, with their tasks: today's, starting outside quiet hours
// (so a block before 8 am never gets one), whose task isn't done; earliest first.
const live = ({ blocks, tasks, today, tz }) => [...blocks].sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at)).flatMap((b) => {
  const start = minutesOn(b.starts_at, today, tz);
  const task = tasks.find((t) => t.id === b.task_id);
  return start >= BRIEF_AT && start < QUIET_FROM && task && !task.done ? [{ b, task }] : [];
});

// A late run still sends a block's nudge or repeat while the block is on; once it's over, they
// are no use.
const running = (day) => live(day).filter(({ b }) => day.now < Date.parse(b.ends_at));

// A nudge at the start of each of today's blocks.
function starts(day) {
  return running(day).map(({ b, task }) => {
    return { kind: "start", block_id: b.id, day: day.today, send_at: new Date(b.starts_at).toISOString(), text: nudgeText(b, task, day), buttons: tapButtons(b.id) };
  });
}

// Whether the nudge at a block's start (at its current start) is in the log.
const startSent = (log, b) => log.some((n) => n.block_id === b.id && n.kind === "start" && Date.parse(n.send_at) === Date.parse(b.starts_at));

// One repeat per nudge that went out, ten minutes after it.
function repeats(day) {
  return running(day).flatMap(({ b, task }) => {
    if (!startSent(day.log, b)) return [];
    // A snooze takes the repeat's place.
    if (day.log.some((n) => n.block_id === b.id && n.kind === "snooze")) return [];
    return [{ kind: "repeat", block_id: b.id, day: day.today, send_at: new Date(Date.parse(b.starts_at) + REPEAT_AFTER).toISOString(), text: `Still on: ${task.title}`, buttons: tapButtons(b.id) }];
  });
}

// The snoozed nudges, as their taps logged them: the nudge again, in the repeat's place.
function snoozes(day) {
  return live(day).flatMap(({ b, task }) => day.log.filter((n) => n.block_id === b.id && pending(n))
    .map((n) => ({ kind: "snooze", block_id: b.id, day: day.today, send_at: new Date(n.send_at).toISOString(), text: nudgeText(b, task, day), buttons: tapButtons(b.id) })));
}

// The check-in: at the day's shutdown line (the default unless he moved it), asking for the
// shutdown. Once the day is shut down, or on a day with no tasks, there's nothing to ask.
function checkin({ tasks, day: row, today, tz }) {
  const todays = tasks.filter((t) => t.day === today);
  if (row?.shutdown || !todays.length) return [];
  const [h, m] = (row?.shutdown_at ?? SHEET.shutdownAt).split(":").map(Number);
  const done = todays.filter((t) => t.done).length;
  return [{ kind: "checkin", block_id: null, day: today, send_at: zonedIso(today, h * 60 + m, tz), text: `Shutdown time. ${done} done, ${todays.length - done} left.`, buttons: [{ text: "Open /plan", url: PLAN_URL }] }];
}

// --- Taps ----------------------------------------------------------------------------------

const DONE = "✓ Done";
const GONE = "That block is no longer on the plan.";

// A tap on a nudge's Done or Snooze, { action: "done" | "snooze", block_id }, at `now`, against
// the same snapshot whatToSend takes. Returns the changes for the Edge Function to make and the
// tapped message's new text:
//   { table, insert: row } | { table, id, update: fields } | { table, id, delete: true }
// Telegram can't edit Google Calendar, so a block whose event changes leaves a gcal_pending row
// ({ gcal_id, ends_at }, ends_at null for a deleted event) for /plan to apply when it opens.
export function handleTap(tap, snapshot, now) {
  const b = snapshot.blocks.find((x) => x.id === tap.block_id);
  const task = b && snapshot.tasks.find((t) => t.id === b.task_id);
  // A block deleted or moved off the plan since its nudge went out: nothing left to act on.
  if (!task) return { changes: [], text: GONE };
  if (task.done) return { changes: [], text: DONE };
  return tap.action === "snooze" ? snooze(b, task, snapshot, now) : done(task, snapshot, now);
}

// Snooze logs the nudge again, unsent, for ten minutes on (from the tap's minute, so a repeated
// tap meets the log's unique key); whatToSend sends it in the repeat's place. It takes a budget
// slot now, so with none free it is refused, and the message says so.
function snooze(b, task, snapshot, now) {
  const day = dayOf(snapshot, now);
  if (freeSlots(day) <= 0) return { changes: [], text: `No nudges left today · ${task.title}` };
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  const send_at = new Date(minute + SNOOZE_FOR).toISOString();
  const row = { block_id: b.id, kind: "snooze", day: day.today, send_at, sent_at: null };
  return { changes: [{ table: "nudges", insert: row }], text: `Snoozed until ${formatClock(minutesOn(send_at, day.today, day.tz))} · ${task.title}` };
}

// Done marks the task done and applies the block rules to each of its blocks, as /plan does.
function done(task, { blocks }, now) {
  const changes = blocks.filter((b) => b.task_id === task.id).flatMap((b) => {
    const r = blockOnComplete(b, now);
    if (r.action === "keep") return [];
    const ends_at = r.action === "shrink" ? r.ends_at : null;
    const pending = b.gcal_id ? [{ table: "gcal_pending", insert: { gcal_id: b.gcal_id, ends_at } }] : [];
    return [r.action === "shrink" ? { table: "blocks", id: b.id, update: { ends_at } } : { table: "blocks", id: b.id, delete: true }, ...pending];
  });
  return { changes: [...changes, { table: "tasks", id: task.id, update: { done: true } }], text: DONE };
}
