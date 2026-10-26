// The Telegram messages (docs/sheet-nudges.md, "Messages"): which are due at a given minute.
// Kept free of the network so node --test covers it; the `telegram` Edge Function
// (supabase/functions/telegram) imports it, so the rules live only here.
//
// Nothing is booked ahead: each run works the messages out again from a snapshot of the day,
// and the nudges log is what stops one going out twice.
import { ORIGIN, SHEET } from "../site.mjs";
import { localNow, zonedIso, minutesOn, atRisk, dueLabel, formatClock, telegramOn } from "./logic.mjs";

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
  const tz = snapshot.settings.time_zone;
  const { day: today, minutes } = localNow(now, tz);
  if (minutes < BRIEF_AT || minutes >= QUIET_FROM) return [];
  // Proposed blocks aren't part of the plan until approved: they count for nothing here.
  const day = { ...snapshot, blocks: snapshot.blocks.filter((b) => !b.proposed), today, tz, now: now.getTime() };
  // Each kind of message is one rule over the same day.
  const due = [brief(day), ...starts(day), ...repeats(day), ...snoozes(day), ...checkin(day)]
    .filter((m) => Date.parse(m.send_at) <= now.getTime() && !logged(snapshot.log, m))
    .sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
  // The budget goes to the first nudges by time; the brief and check-in are outside it.
  let used = snapshot.log.filter((n) => BUDGETED.includes(n.kind) && !pending(n)).length;
  return due.filter((m) => !BUDGETED.includes(m.kind) || used++ < BUDGET);
}

const BUDGETED = ["start", "repeat", "snooze"];

// A snooze logged by a tap and not yet sent (see SNOOZE_FOR).
const pending = (n) => n.kind === "snooze" && !n.sent_at;

// One message per block, kind, day and send-at minute: the log's unique key.
const logged = (log, m) => log.some((n) => !pending(n) && n.block_id === m.block_id && n.kind === m.kind && n.day === m.day
  && Date.parse(n.send_at) === Date.parse(m.send_at));

// The morning brief: what today holds, at 8:00. Private tasks show their real titles: the
// messages go only to Lisul.
function brief({ tasks, blocks, today, tz }) {
  const todays = tasks.filter((t) => t.day === today);
  const blocksToday = blocks.filter((b) => { const m = minutesOn(b.starts_at, today, tz); return m >= 0 && m < 1440; });
  const risky = tasks.filter((t) => atRisk(t, blocks, today, tz)).sort((a, b) => a.due.localeCompare(b.due));
  const n = blocksToday.length;
  const lines = [`Today: ${plural(todays.length, "task")}, ${plural(n, "block")}${n > BUDGET ? `, nudging the first ${BUDGET}` : ""}.`];
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
// (so a block before 8 am never gets one), whose task isn't done.
const live = ({ blocks, tasks, today, tz }) => blocks.flatMap((b) => {
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

// One repeat per nudge that went out, ten minutes after it.
function repeats(day) {
  return running(day).flatMap(({ b, task }) => {
    const start = new Date(b.starts_at).toISOString();
    if (!day.log.some((n) => n.block_id === b.id && n.kind === "start" && Date.parse(n.send_at) === Date.parse(start))) return [];
    // A snooze takes the repeat's place.
    if (day.log.some((n) => n.block_id === b.id && n.kind === "snooze")) return [];
    return [{ kind: "repeat", block_id: b.id, day: day.today, send_at: new Date(Date.parse(start) + REPEAT_AFTER).toISOString(), text: `Still on: ${task.title}`, buttons: tapButtons(b.id) }];
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
